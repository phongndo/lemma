#include "core/engine.hpp"

#include "core/connection_output.hpp"
#include "core/extension_runtime.hpp"
#include "core/input.hpp"
#include "core/pty_writer.hpp"
#include "lemma/command.hpp"
#include "lemma/id.hpp"
#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"
#include "platform/io.hpp"
#include "platform/pty.hpp"
#include "protocol/single_pane.hpp"
#include "render/single_pane.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <new>
#include <optional>
#include <span>
#include <string_view>
#include <utility>

#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

namespace lemma::core {
namespace {

constexpr auto command_attach = protocol::wire_byte(protocol::ControlCommand::attach);
constexpr auto command_create = protocol::wire_byte(protocol::ControlCommand::create);
constexpr auto command_list = protocol::wire_byte(protocol::ControlCommand::list);
constexpr auto command_list_workspace =
    protocol::wire_byte(protocol::ControlCommand::list_workspace);
constexpr auto command_list_windows = protocol::wire_byte(protocol::ControlCommand::list_windows);
constexpr auto command_kill = protocol::wire_byte(protocol::ControlCommand::kill);
constexpr auto command_kill_all = protocol::wire_byte(protocol::ControlCommand::kill_all);
constexpr auto response_ready = protocol::wire_byte(protocol::ControlResponse::ready);
constexpr auto response_busy = protocol::wire_byte(protocol::ControlResponse::busy);
constexpr auto response_missing = protocol::wire_byte(protocol::ControlResponse::missing);
constexpr auto response_capacity = protocol::wire_byte(protocol::ControlResponse::capacity);
constexpr auto response_failed = protocol::wire_byte(protocol::ControlResponse::failed);
constexpr std::size_t panes_per_workspace_max =
    static_cast<std::size_t>(limits::panes_hard_max / limits::workspaces_hard_max);
constexpr std::size_t windows_per_workspace_max =
    static_cast<std::size_t>(limits::windows_hard_max / limits::workspaces_hard_max);
constexpr std::size_t panes_per_window_max = panes_per_workspace_max;
constexpr std::size_t layout_nodes_per_window_max = (panes_per_window_max * 2U) - 1U;
constexpr std::size_t process_name_bytes_max = 64;
static_assert(panes_per_workspace_max > 0);
static_assert(windows_per_workspace_max > 0);
static_assert(windows_per_workspace_max <= render::status_windows_max);
using platform::close_descriptor;
using platform::set_nonblocking;
using render::ClientOutputState;
using render::flush_frame;
using render::FrameBuffer;

class EndpointReleaseGuard final {
public:
  EndpointReleaseGuard(const EndpointRelease release, void* const context) noexcept
      : release_(release), context_(context) {}

  EndpointReleaseGuard(const EndpointReleaseGuard&) = delete;
  auto operator=(const EndpointReleaseGuard&) -> EndpointReleaseGuard& = delete;
  EndpointReleaseGuard(EndpointReleaseGuard&&) = delete;
  auto operator=(EndpointReleaseGuard&&) -> EndpointReleaseGuard& = delete;

  ~EndpointReleaseGuard() { release(); }

  void release() noexcept {
    if (release_ == nullptr) {
      return;
    }
    release_(context_);
    release_ = nullptr;
  }

private:
  EndpointRelease release_;
  void* context_;
};

[[nodiscard]] auto resize_terminal(const int pty, vt::Terminal& terminal,
                                   const std::uint16_t requested_columns,
                                   const std::uint16_t requested_rows) noexcept -> bool {
  const auto columns = std::clamp(requested_columns, std::uint16_t{1}, protocol::columns_max);
  const auto rows = std::clamp(requested_rows, std::uint16_t{1}, protocol::rows_max);
  return platform::resize_pty(pty, columns, rows) &&
         terminal.resize({.columns = columns, .rows = rows}).has_value();
}

struct PtyDrainResult final {
  bool alive{true};
  bool changed{false};
};

[[nodiscard]] auto drain_pty(const int pty, vt::Terminal& terminal,
                             PanePtyWriteQueue& pending_writes) noexcept -> PtyDrainResult {
  constexpr std::size_t reads_per_turn_max = 4;
  std::array<std::byte, std::size_t{64} * 1'024U> output{};
  PtyDrainResult drain{};
  for (std::size_t read_count = 0; read_count < reads_per_turn_max; ++read_count) {
    const auto bytes_read = ::read(pty, output.data(), output.size());
    if (bytes_read > 0) {
      terminal.write(std::span(output).first(static_cast<std::size_t>(bytes_read)));
      drain.changed = true;
      if (!queue_terminal_responses(pending_writes, terminal)) {
        drain.alive = false;
        return drain;
      }
      continue;
    }
    if (bytes_read == 0) {
      drain.alive = false;
      return drain;
    }
    if (errno == EINTR) {
      continue;
    }
    if (errno != EAGAIN && errno != EWOULDBLOCK) {
      drain.alive = false;
    }
    return drain;
  }
  return drain;
}

struct WorkspaceName final {
  std::array<char, protocol::workspace_name_bytes_max> bytes{};
  std::size_t size{0};

  [[nodiscard]] auto view() const noexcept -> std::string_view { return {bytes.data(), size}; }
};

[[nodiscard]] constexpr auto valid_workspace_name(const std::string_view workspace) noexcept
    -> bool {
  if (workspace.empty() || workspace.size() > protocol::workspace_name_bytes_max) {
    return false;
  }
  return std::ranges::all_of(workspace, [](const char character) {
    return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
           (character >= '0' && character <= '9') || character == '_' || character == '-';
  });
}

struct Pane final {
  explicit Pane(vt::Terminal&& created_terminal) noexcept : terminal(std::move(created_terminal)) {}

  Pane(const Pane&) = delete;
  auto operator=(const Pane&) -> Pane& = delete;
  Pane(Pane&&) = delete;
  auto operator=(Pane&&) -> Pane& = delete;

  ~Pane() {
    if (child > 0) {
      static_cast<void>(::kill(child, SIGHUP));
      child = -1;
    }
    close_descriptor(pty);
  }

  vt::Terminal terminal;
  render::PaneRectangle rectangle{};
  int pty{-1};
  pid_t child{-1};
  std::array<char, process_name_bytes_max> process_name{};
  std::size_t process_name_size{0};
  PanePtyWriteQueue pending_writes;
  bool active{true};
};

enum class SplitAxis : std::uint8_t {
  left_right,
  top_bottom,
};

struct LayoutNode final {
  bool active{false};
  bool leaf{true};
  std::uint16_t pane{0};
  std::int16_t parent{-1};
  std::int16_t first{-1};
  std::int16_t second{-1};
  SplitAxis axis{SplitAxis::left_right};
};

struct Window final {
  Window(const WindowId assigned_id, std::unique_ptr<Pane> first_pane) noexcept : id(assigned_id) {
    panes.front() = std::move(first_pane);
    layout.front() = {.active = true, .leaf = true, .pane = 0};
  }

  Window(const Window&) = delete;
  auto operator=(const Window&) -> Window& = delete;
  Window(Window&&) = delete;
  auto operator=(Window&&) -> Window& = delete;
  ~Window() = default;

  WindowId id;
  std::array<std::unique_ptr<Pane>, panes_per_window_max> panes{};
  std::array<LayoutNode, layout_nodes_per_window_max> layout{};
  // Inactive windows retain their last usable geometry while continuing to process PTY output.
  std::uint16_t layout_columns{80};
  std::uint16_t layout_rows{24};
  std::uint16_t focused_pane{0};
  std::uint16_t previous_pane{0};
  bool zoomed{false};
  bool layout_suspended{false};
};

struct WindowSlot final {
  std::unique_ptr<Window> window;
  std::uint32_t generation{0};
};

struct Workspace final {
  Workspace(const std::string_view workspace_name,
            std::unique_ptr<FrameBuffer> created_frame) noexcept
      : name_size(workspace_name.size()), frame(std::move(created_frame)) {
    std::memcpy(name.data(), workspace_name.data(), workspace_name.size());
  }

  Workspace(const Workspace&) = delete;
  auto operator=(const Workspace&) -> Workspace& = delete;
  Workspace(Workspace&&) = delete;
  auto operator=(Workspace&&) -> Workspace& = delete;

  ~Workspace() { close_descriptor(client); }

  [[nodiscard]] auto workspace_name() const noexcept -> std::string_view {
    return {name.data(), name_size};
  }

  void detach_client() noexcept {
    close_descriptor(client);
    decoder.reset();
    output.reset();
    frame_pending = false;
    force_full_pending = false;
    input_backpressured = false;
  }

  std::array<char, protocol::workspace_name_bytes_max> name{};
  std::size_t name_size{0};
  std::unique_ptr<FrameBuffer> frame;
  std::array<WindowSlot, windows_per_workspace_max> windows{};
  WindowId active_window;
  WindowId previous_window;
  protocol::ClientDecoder decoder;
  ClientOutputState output;
  int client{-1};
  std::uint32_t pending_attach_slot{std::numeric_limits<std::uint32_t>::max()};
  std::uint32_t pending_attach_generation{0};
  std::uint16_t columns{80};
  std::uint16_t rows{24};
  bool active{true};
  bool frame_pending{false};
  bool force_full_pending{false};
  bool status_valid{false};
  bool input_backpressured{false};
  std::uint64_t status_signature{0};
  std::chrono::steady_clock::time_point frame_deadline;
};

[[nodiscard]] constexpr auto pane_rows(const std::uint16_t viewport_rows) noexcept
    -> std::uint16_t {
  return viewport_rows >= 2 ? static_cast<std::uint16_t>(viewport_rows - 1U) : viewport_rows;
}

[[nodiscard]] auto create_pane(const std::uint16_t columns, const std::uint16_t rows) noexcept
    -> std::unique_ptr<Pane> {
  vt::TerminalOptions options;
  options.size = {.columns = columns, .rows = rows};
  auto terminal_result = vt::Terminal::create(options);
  if (!terminal_result.has_value()) {
    return nullptr;
  }
  auto pane = std::unique_ptr<Pane>(new (std::nothrow) Pane(std::move(*terminal_result)));
  if (pane == nullptr) {
    return nullptr;
  }
  pane->child = platform::spawn_login_shell(pane->pty);
  if (pane->child <= 0 || !set_nonblocking(pane->pty) ||
      !platform::resize_pty(pane->pty, columns, rows)) {
    return nullptr;
  }
  pane->rectangle = {.columns = columns, .rows = rows};
  return pane;
}

[[nodiscard]] auto refresh_process_name(Pane& pane) noexcept -> bool {
  std::array<char, process_name_bytes_max> current{};
  const auto size = platform::foreground_process_name(pane.pty, current);
  if (size == 0 ||
      (size == pane.process_name_size &&
       std::ranges::equal(std::span(current).first(size),
                          std::span(pane.process_name).first(pane.process_name_size)))) {
    return false;
  }
  std::ranges::copy(std::span(current).first(size), pane.process_name.begin());
  pane.process_name_size = size;
  return true;
}

[[nodiscard]] constexpr auto next_generation(const std::uint32_t generation) noexcept
    -> std::uint32_t {
  return generation == std::numeric_limits<std::uint32_t>::max() ? 1U : generation + 1U;
}

[[nodiscard]] auto find_window(Workspace& workspace, const WindowId id) noexcept -> Window* {
  if (!id.is_valid() || id.slot() >= workspace.windows.size()) {
    return nullptr;
  }
  auto& slot = std::span(workspace.windows).subspan(id.slot(), 1).front();
  return slot.generation == id.generation() ? slot.window.get() : nullptr;
}

[[nodiscard]] auto find_window(const Workspace& workspace, const WindowId id) noexcept
    -> const Window* {
  if (!id.is_valid() || id.slot() >= workspace.windows.size()) {
    return nullptr;
  }
  const auto& slot = std::span(workspace.windows).subspan(id.slot(), 1).front();
  return slot.generation == id.generation() ? slot.window.get() : nullptr;
}

[[nodiscard]] auto active_window(Workspace& workspace) noexcept -> Window* {
  return find_window(workspace, workspace.active_window);
}

[[nodiscard]] auto active_window(const Workspace& workspace) noexcept -> const Window* {
  return find_window(workspace, workspace.active_window);
}

[[nodiscard]] auto pane_count(const Window& window) noexcept -> std::size_t {
  return static_cast<std::size_t>(
      std::ranges::count_if(window.panes, [](const auto& pane) { return pane != nullptr; }));
}

[[nodiscard]] auto pane_count(const Workspace& workspace) noexcept -> std::size_t {
  std::size_t count = 0;
  for (const auto& slot : workspace.windows) {
    if (slot.window != nullptr) {
      count += pane_count(*slot.window);
    }
  }
  return count;
}

[[nodiscard]] auto window_count(const Workspace& workspace) noexcept -> std::size_t {
  return static_cast<std::size_t>(std::ranges::count_if(
      workspace.windows, [](const WindowSlot& slot) { return slot.window != nullptr; }));
}

[[nodiscard]] auto allocate_window(Workspace& workspace) noexcept -> Window* {
  if (pane_count(workspace) >= panes_per_workspace_max) {
    return nullptr;
  }
  for (std::size_t index = 0; index < workspace.windows.size(); ++index) {
    auto& slot = std::span(workspace.windows).subspan(index, 1).front();
    if (slot.window != nullptr) {
      continue;
    }
    auto first_pane = create_pane(workspace.columns, pane_rows(workspace.rows));
    if (first_pane == nullptr) {
      return nullptr;
    }
    const auto generation = next_generation(slot.generation);
    const auto id = WindowId::from_parts(static_cast<std::uint32_t>(index), generation);
    auto created = std::unique_ptr<Window>(new (std::nothrow) Window(id, std::move(first_pane)));
    if (created == nullptr) {
      return nullptr;
    }
    created->layout_columns = workspace.columns;
    created->layout_rows = pane_rows(workspace.rows);
    slot.generation = generation;
    slot.window = std::move(created);
    workspace.previous_window = workspace.active_window;
    workspace.active_window = id;
    return slot.window.get();
  }
  return nullptr;
}

[[nodiscard]] auto create_workspace(const std::string_view name) noexcept
    -> std::unique_ptr<Workspace> {
  auto frame = std::unique_ptr<FrameBuffer>(new (std::nothrow) FrameBuffer{});
  if (frame == nullptr) {
    return nullptr;
  }
  auto workspace = std::unique_ptr<Workspace>(new (std::nothrow) Workspace(name, std::move(frame)));
  if (workspace == nullptr || allocate_window(*workspace) == nullptr) {
    return nullptr;
  }
  workspace->previous_window = workspace->active_window;
  return workspace;
}

[[nodiscard]] auto empty_pane_slot(Window& window) noexcept -> std::optional<std::size_t> {
  for (std::size_t index = 0; index < window.panes.size(); ++index) {
    if (std::span(window.panes).subspan(index, 1).front() == nullptr) {
      return index;
    }
  }
  return std::nullopt;
}

[[nodiscard]] auto empty_layout_node(Window& window) noexcept -> std::optional<std::size_t> {
  for (std::size_t index = 0; index < window.layout.size(); ++index) {
    if (!std::span(window.layout).subspan(index, 1).front().active) {
      return index;
    }
  }
  return std::nullopt;
}

[[nodiscard]] auto node_for_pane(const Window& window, const std::size_t pane) noexcept
    -> std::optional<std::size_t> {
  for (std::size_t index = 0; index < window.layout.size(); ++index) {
    const auto& node = std::span(window.layout).subspan(index, 1).front();
    if (node.active && node.leaf && node.pane == pane) {
      return index;
    }
  }
  return std::nullopt;
}

[[nodiscard]] auto first_leaf(const Window& window, std::size_t node_index) noexcept
    -> std::uint16_t {
  for (std::size_t depth = 0; depth < limits::layout_depth_hard_max; ++depth) {
    const auto& node = std::span(window.layout).subspan(node_index, 1).front();
    if (node.leaf) {
      return node.pane;
    }
    node_index = static_cast<std::size_t>(node.first);
  }
  return window.focused_pane;
}

[[nodiscard]] auto resize_pane(Pane& pane, const render::PaneRectangle rectangle) noexcept -> bool {
  if (pane.rectangle == rectangle) {
    return true;
  }
  if (!resize_terminal(pane.pty, pane.terminal, rectangle.columns, rectangle.rows)) {
    return false;
  }
  pane.rectangle = rectangle;
  return true;
}

[[nodiscard]] auto layout_fits_node(const Window& window, const std::size_t node_index,
                                    const render::PaneRectangle rectangle,
                                    const std::size_t depth) noexcept -> bool {
  if (depth >= limits::layout_depth_hard_max) {
    return false;
  }
  const auto& node = std::span(window.layout).subspan(node_index, 1).front();
  if (!node.active) {
    return false;
  }
  if (node.leaf) {
    return std::span(window.panes).subspan(node.pane, 1).front() != nullptr;
  }

  auto first_rectangle = rectangle;
  auto second_rectangle = rectangle;
  if (node.axis == SplitAxis::left_right) {
    if (rectangle.columns < 3) {
      return false;
    }
    const auto available = static_cast<std::uint16_t>(rectangle.columns - 1U);
    first_rectangle.columns = static_cast<std::uint16_t>((available + 1U) / 2U);
    second_rectangle.columns = static_cast<std::uint16_t>(available - first_rectangle.columns);
  } else {
    if (rectangle.rows < 3) {
      return false;
    }
    const auto available = static_cast<std::uint16_t>(rectangle.rows - 1U);
    first_rectangle.rows = static_cast<std::uint16_t>((available + 1U) / 2U);
    second_rectangle.rows = static_cast<std::uint16_t>(available - first_rectangle.rows);
  }
  return layout_fits_node(window, static_cast<std::size_t>(node.first), first_rectangle,
                          depth + 1U) &&
         layout_fits_node(window, static_cast<std::size_t>(node.second), second_rectangle,
                          depth + 1U);
}

using PaneRectangles = std::array<render::PaneRectangle, panes_per_window_max>;

[[nodiscard]] auto collect_layout_rectangles(const Window& window, const std::size_t node_index,
                                             const render::PaneRectangle rectangle,
                                             const std::size_t depth,
                                             PaneRectangles& rectangles) noexcept -> bool {
  if (depth >= limits::layout_depth_hard_max) {
    return false;
  }
  const auto& node = std::span(window.layout).subspan(node_index, 1).front();
  if (!node.active) {
    return false;
  }
  if (node.leaf) {
    const auto pane_index = static_cast<std::size_t>(node.pane);
    if (pane_index >= window.panes.size() ||
        std::span(window.panes).subspan(pane_index, 1).front() == nullptr) {
      return false;
    }
    std::span(rectangles).subspan(pane_index, 1).front() = rectangle;
    return true;
  }
  if (node.first < 0 || node.second < 0) {
    return false;
  }

  auto first_rectangle = rectangle;
  auto second_rectangle = rectangle;
  if (node.axis == SplitAxis::left_right) {
    if (rectangle.columns < 3) {
      return false;
    }
    const auto available = static_cast<std::uint16_t>(rectangle.columns - 1U);
    first_rectangle.columns = static_cast<std::uint16_t>((available + 1U) / 2U);
    second_rectangle.column =
        static_cast<std::uint16_t>(rectangle.column + first_rectangle.columns + 1U);
    second_rectangle.columns = static_cast<std::uint16_t>(available - first_rectangle.columns);
  } else {
    if (rectangle.rows < 3) {
      return false;
    }
    const auto available = static_cast<std::uint16_t>(rectangle.rows - 1U);
    first_rectangle.rows = static_cast<std::uint16_t>((available + 1U) / 2U);
    second_rectangle.row = static_cast<std::uint16_t>(rectangle.row + first_rectangle.rows + 1U);
    second_rectangle.rows = static_cast<std::uint16_t>(available - first_rectangle.rows);
  }
  return collect_layout_rectangles(window, static_cast<std::size_t>(node.first), first_rectangle,
                                   depth + 1U, rectangles) &&
         collect_layout_rectangles(window, static_cast<std::size_t>(node.second), second_rectangle,
                                   depth + 1U, rectangles);
}

[[nodiscard]] auto resolve_node(Window& window, const std::size_t node_index,
                                const render::PaneRectangle rectangle,
                                const std::size_t depth) noexcept -> bool {
  if (depth >= limits::layout_depth_hard_max) {
    return false;
  }
  const auto node = std::span(window.layout).subspan(node_index, 1).front();
  if (!node.active) {
    return false;
  }
  if (node.leaf) {
    auto& pane = std::span(window.panes).subspan(node.pane, 1).front();
    return pane != nullptr && resize_pane(*pane, rectangle);
  }

  auto first_rectangle = rectangle;
  auto second_rectangle = rectangle;
  if (node.axis == SplitAxis::left_right) {
    if (rectangle.columns < 3) {
      return false;
    }
    const auto available = static_cast<std::uint16_t>(rectangle.columns - 1U);
    first_rectangle.columns = static_cast<std::uint16_t>((available + 1U) / 2U);
    second_rectangle.column =
        static_cast<std::uint16_t>(rectangle.column + first_rectangle.columns + 1U);
    second_rectangle.columns = static_cast<std::uint16_t>(available - first_rectangle.columns);
  } else {
    if (rectangle.rows < 3) {
      return false;
    }
    const auto available = static_cast<std::uint16_t>(rectangle.rows - 1U);
    first_rectangle.rows = static_cast<std::uint16_t>((available + 1U) / 2U);
    second_rectangle.row = static_cast<std::uint16_t>(rectangle.row + first_rectangle.rows + 1U);
    second_rectangle.rows = static_cast<std::uint16_t>(available - first_rectangle.rows);
  }
  return resolve_node(window, static_cast<std::size_t>(node.first), first_rectangle, depth + 1U) &&
         resolve_node(window, static_cast<std::size_t>(node.second), second_rectangle, depth + 1U);
}

[[nodiscard]] auto resolve_layout(Window& window) noexcept -> bool {
  const render::PaneRectangle viewport{
      .columns = window.layout_columns,
      .rows = window.layout_rows,
  };
  if (window.zoomed) {
    auto& focused = std::span(window.panes).subspan(window.focused_pane, 1).front();
    return focused != nullptr && resize_pane(*focused, viewport);
  }
  return resolve_node(window, 0, viewport, 0);
}

[[nodiscard]] auto resolve_workspace_layout(Workspace& workspace, Window& window) noexcept -> bool {
  // PTY resizing is not transactional: retire the workspace rather than continue after a partial
  // geometry update.
  const bool resolved = resolve_layout(window);
  workspace.active = workspace.active && resolved;
  return resolved;
}

void schedule_frame(Workspace& workspace, const bool force_full,
                    const bool immediate = true) noexcept {
  constexpr auto frame_delay = std::chrono::milliseconds(2);
  const auto deadline =
      immediate ? std::chrono::steady_clock::now() : std::chrono::steady_clock::now() + frame_delay;
  if (!workspace.frame_pending || deadline < workspace.frame_deadline) {
    workspace.frame_deadline = deadline;
  }
  workspace.frame_pending = true;
  workspace.force_full_pending = workspace.force_full_pending || force_full;
}

[[nodiscard]] auto fit_window_to_viewport(Workspace& workspace, Window& window) noexcept -> bool {
  const render::PaneRectangle viewport{
      .columns = workspace.columns,
      .rows = pane_rows(workspace.rows),
  };
  if (!layout_fits_node(window, 0, viewport, 0)) {
    window.layout_suspended = true;
    return true;
  }
  window.layout_suspended = false;
  window.layout_columns = viewport.columns;
  window.layout_rows = viewport.rows;
  return resolve_workspace_layout(workspace, window);
}

[[nodiscard]] auto select_window(Workspace& workspace, const WindowId id) noexcept -> bool {
  auto* const selected = find_window(workspace, id);
  if (selected == nullptr) {
    return false;
  }
  if (workspace.active_window == id) {
    return true;
  }
  workspace.previous_window = workspace.active_window;
  workspace.active_window = id;
  workspace.output.reset();
  if (!fit_window_to_viewport(workspace, *selected)) {
    workspace.active = false;
    return false;
  }
  schedule_frame(workspace, true);
  return true;
}

void cycle_window(Workspace& workspace, const bool forward) noexcept {
  const auto current = static_cast<std::size_t>(workspace.active_window.slot());
  for (std::size_t offset = 1; offset <= workspace.windows.size(); ++offset) {
    const auto candidate =
        forward ? (current + offset) % workspace.windows.size()
                : (current + workspace.windows.size() - (offset % workspace.windows.size())) %
                      workspace.windows.size();
    const auto& slot = std::span(workspace.windows).subspan(candidate, 1).front();
    if (slot.window != nullptr) {
      static_cast<void>(select_window(workspace, slot.window->id));
      return;
    }
  }
}

void remove_window(Workspace& workspace, const WindowId id) noexcept {
  auto* const window = find_window(workspace, id);
  if (window == nullptr) {
    return;
  }
  const auto removed_slot = static_cast<std::size_t>(id.slot());
  std::span(workspace.windows).subspan(removed_slot, 1).front().window.reset();
  if (window_count(workspace) == 0) {
    workspace.active = false;
    return;
  }
  if (workspace.active_window != id) {
    schedule_frame(workspace, false);
    return;
  }
  for (std::size_t offset = 1; offset <= workspace.windows.size(); ++offset) {
    const auto candidate = (removed_slot + offset) % workspace.windows.size();
    const auto& slot = std::span(workspace.windows).subspan(candidate, 1).front();
    if (slot.window != nullptr) {
      workspace.active_window = slot.window->id;
      workspace.previous_window = workspace.active_window;
      workspace.output.reset();
      if (!fit_window_to_viewport(workspace, *slot.window)) {
        workspace.active = false;
        return;
      }
      schedule_frame(workspace, true);
      return;
    }
  }
}

void create_window(Workspace& workspace) noexcept {
  auto* const created = allocate_window(workspace);
  if (created == nullptr) {
    return;
  }
  workspace.output.reset();
  if (!fit_window_to_viewport(workspace, *created)) {
    workspace.active = false;
    return;
  }
  schedule_frame(workspace, true);
}

// Splitting is an explicit bounded topology transaction.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto split_focused_pane(Workspace& workspace, Window& window,
                                      const SplitAxis axis) noexcept -> bool {
  if (window.zoomed) {
    window.zoomed = false;
    if (!resolve_workspace_layout(workspace, window)) {
      return false;
    }
    // Leaving zoom changes both the composed view and pane geometry even if the split is rejected.
    schedule_frame(workspace, true);
  }
  if (pane_count(workspace) >= panes_per_workspace_max) {
    return false;
  }
  const auto focused_index = static_cast<std::size_t>(window.focused_pane);
  const auto& focused = std::span(window.panes).subspan(focused_index, 1).front();
  if (focused == nullptr || (axis == SplitAxis::left_right && focused->rectangle.columns < 3) ||
      (axis == SplitAxis::top_bottom && focused->rectangle.rows < 3)) {
    return false;
  }
  const auto pane_slot = empty_pane_slot(window);
  const auto parent_node = node_for_pane(window, focused_index);
  if (!pane_slot.has_value() || !parent_node.has_value()) {
    return false;
  }
  std::size_t layout_depth = 0;
  auto ancestor = std::span(window.layout).subspan(*parent_node, 1).front().parent;
  while (ancestor >= 0) {
    ++layout_depth;
    ancestor =
        std::span(window.layout).subspan(static_cast<std::size_t>(ancestor), 1).front().parent;
  }
  if (layout_depth + 1U >= limits::layout_depth_hard_max) {
    return false;
  }
  const auto first_node = empty_layout_node(window);
  if (!first_node.has_value()) {
    return false;
  }
  std::span(window.layout).subspan(*first_node, 1).front().active = true;
  const auto second_node = empty_layout_node(window);
  std::span(window.layout).subspan(*first_node, 1).front().active = false;
  if (!second_node.has_value()) {
    return false;
  }

  auto new_columns = focused->rectangle.columns;
  auto new_rows = focused->rectangle.rows;
  if (axis == SplitAxis::left_right) {
    const auto available = static_cast<std::uint16_t>(new_columns - 1U);
    new_columns = static_cast<std::uint16_t>(available - ((available + 1U) / 2U));
  } else {
    const auto available = static_cast<std::uint16_t>(new_rows - 1U);
    new_rows = static_cast<std::uint16_t>(available - ((available + 1U) / 2U));
  }
  auto created = create_pane(new_columns, new_rows);
  if (created == nullptr) {
    return false;
  }

  auto& parent = std::span(window.layout).subspan(*parent_node, 1).front();
  const auto parent_parent = parent.parent;
  parent = {
      .active = true,
      .leaf = false,
      .parent = parent_parent,
      .first = static_cast<std::int16_t>(*first_node),
      .second = static_cast<std::int16_t>(*second_node),
      .axis = axis,
  };
  std::span(window.layout).subspan(*first_node, 1).front() = {
      .active = true,
      .leaf = true,
      .pane = static_cast<std::uint16_t>(focused_index),
      .parent = static_cast<std::int16_t>(*parent_node),
  };
  std::span(window.layout).subspan(*second_node, 1).front() = {
      .active = true,
      .leaf = true,
      .pane = static_cast<std::uint16_t>(*pane_slot),
      .parent = static_cast<std::int16_t>(*parent_node),
  };
  std::span(window.panes).subspan(*pane_slot, 1).front() = std::move(created);
  window.previous_pane = window.focused_pane;
  window.focused_pane = static_cast<std::uint16_t>(*pane_slot);
  if (!resolve_workspace_layout(workspace, window)) {
    return false;
  }
  schedule_frame(workspace, true);
  return true;
}

[[nodiscard]] auto close_pane(Workspace& workspace, Window& window,
                              const std::size_t pane_index) noexcept -> bool {
  auto& pane = std::span(window.panes).subspan(pane_index, 1).front();
  if (pane == nullptr) {
    return false;
  }
  const bool was_focused = pane_index == window.focused_pane;
  if (pane_count(window) == 1) {
    const auto id = window.id;
    remove_window(workspace, id);
    return true;
  }
  const auto leaf_index = node_for_pane(window, pane_index);
  if (!leaf_index.has_value()) {
    return false;
  }
  const auto leaf = std::span(window.layout).subspan(*leaf_index, 1).front();
  if (leaf.parent < 0) {
    return false;
  }
  const auto parent_index = static_cast<std::size_t>(leaf.parent);
  const auto parent = std::span(window.layout).subspan(parent_index, 1).front();
  const auto sibling_index = static_cast<std::size_t>(
      parent.first == static_cast<std::int16_t>(*leaf_index) ? parent.second : parent.first);
  auto replacement = std::span(window.layout).subspan(sibling_index, 1).front();
  replacement.parent = parent.parent;
  std::span(window.layout).subspan(parent_index, 1).front() = replacement;
  if (!replacement.leaf) {
    std::span(window.layout)
        .subspan(static_cast<std::size_t>(replacement.first), 1)
        .front()
        .parent = static_cast<std::int16_t>(parent_index);
    std::span(window.layout)
        .subspan(static_cast<std::size_t>(replacement.second), 1)
        .front()
        .parent = static_cast<std::int16_t>(parent_index);
  }
  std::span(window.layout).subspan(*leaf_index, 1).front() = {};
  std::span(window.layout).subspan(sibling_index, 1).front() = {};
  pane.reset();
  if (was_focused) {
    window.focused_pane = first_leaf(window, parent_index);
  }
  const auto previous_index = static_cast<std::size_t>(window.previous_pane);
  if (previous_index == pane_index || previous_index >= window.panes.size() ||
      std::span(window.panes).subspan(previous_index, 1).front() == nullptr) {
    window.previous_pane = window.focused_pane;
  }
  window.zoomed = false;
  if (!resolve_workspace_layout(workspace, window)) {
    return false;
  }
  schedule_frame(workspace, true);
  return true;
}

void focus_pane(Workspace& workspace, Window& window, const std::uint16_t pane_index) noexcept {
  if (pane_index == window.focused_pane ||
      std::span(window.panes).subspan(pane_index, 1).front() == nullptr) {
    return;
  }
  window.previous_pane = window.focused_pane;
  window.focused_pane = pane_index;
  if (window.zoomed && !resolve_workspace_layout(workspace, window)) {
    return;
  }
  schedule_frame(workspace, window.zoomed);
}

void focus_next(Workspace& workspace, Window& window) noexcept {
  for (std::size_t offset = 1; offset <= window.panes.size(); ++offset) {
    const auto candidate =
        (static_cast<std::size_t>(window.focused_pane) + offset) % window.panes.size();
    if (std::span(window.panes).subspan(candidate, 1).front() != nullptr) {
      focus_pane(workspace, window, static_cast<std::uint16_t>(candidate));
      return;
    }
  }
}

enum class FocusDirection : std::uint8_t {
  left,
  right,
  up,
  down,
};

// Directional scoring handles each axis explicitly and remains bounded by pane capacity.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void focus_direction(Workspace& workspace, Window& window,
                     const FocusDirection direction) noexcept {
  // Zoom resizes focused panes to the viewport, so derive stable tiled geometry from the tree.
  PaneRectangles rectangles{};
  const render::PaneRectangle viewport{
      .columns = window.layout_columns,
      .rows = window.layout_rows,
  };
  if (!collect_layout_rectangles(window, 0, viewport, 0, rectangles)) {
    return;
  }

  const auto& current = std::span(rectangles).subspan(window.focused_pane, 1).front();
  const auto current_right = static_cast<std::uint32_t>(current.column) + current.columns;
  const auto current_bottom = static_cast<std::uint32_t>(current.row) + current.rows;
  const auto current_x = (static_cast<std::uint32_t>(current.column) * 2U) + current.columns;
  const auto current_y = (static_cast<std::uint32_t>(current.row) * 2U) + current.rows;
  std::uint64_t best_score = std::numeric_limits<std::uint64_t>::max();
  std::optional<std::uint16_t> best;
  for (std::size_t index = 0; index < window.panes.size(); ++index) {
    const auto& candidate = std::span(window.panes).subspan(index, 1).front();
    if (candidate == nullptr || index == window.focused_pane) {
      continue;
    }
    const auto& candidate_rectangle = std::span(rectangles).subspan(index, 1).front();
    const auto right =
        static_cast<std::uint32_t>(candidate_rectangle.column) + candidate_rectangle.columns;
    const auto bottom =
        static_cast<std::uint32_t>(candidate_rectangle.row) + candidate_rectangle.rows;
    const auto x =
        (static_cast<std::uint32_t>(candidate_rectangle.column) * 2U) + candidate_rectangle.columns;
    const auto y =
        (static_cast<std::uint32_t>(candidate_rectangle.row) * 2U) + candidate_rectangle.rows;
    bool eligible = false;
    std::uint32_t primary = 0;
    std::uint32_t secondary = 0;
    switch (direction) {
    case FocusDirection::left:
      eligible = right <= current.column;
      primary = eligible ? current.column - right : 0;
      secondary = y > current_y ? y - current_y : current_y - y;
      break;
    case FocusDirection::right:
      eligible = candidate_rectangle.column >= current_right;
      primary = eligible ? candidate_rectangle.column - current_right : 0;
      secondary = y > current_y ? y - current_y : current_y - y;
      break;
    case FocusDirection::up:
      eligible = bottom <= current.row;
      primary = eligible ? current.row - bottom : 0;
      secondary = x > current_x ? x - current_x : current_x - x;
      break;
    case FocusDirection::down:
      eligible = candidate_rectangle.row >= current_bottom;
      primary = eligible ? candidate_rectangle.row - current_bottom : 0;
      secondary = x > current_x ? x - current_x : current_x - x;
      break;
    }
    const auto score = (static_cast<std::uint64_t>(primary) * 4'096U) + secondary;
    if (eligible && score < best_score) {
      best_score = score;
      best = static_cast<std::uint16_t>(index);
    }
  }
  if (best.has_value()) {
    focus_pane(workspace, window, *best);
  }
}

[[nodiscard]] constexpr auto command_status(const bool changed) noexcept -> CommandResult {
  return {.status = changed ? CommandStatus::applied : CommandStatus::no_effect};
}

[[nodiscard]] auto command_from_pane_command(const protocol::PaneCommand pane_command) noexcept
    -> std::optional<Command> {
  Command command{.origin = CommandOrigin::client};
  switch (pane_command) {
  case protocol::PaneCommand::none:
    return std::nullopt;
  case protocol::PaneCommand::split_left_right:
    command.kind = CommandKind::split_left_right;
    break;
  case protocol::PaneCommand::split_top_bottom:
    command.kind = CommandKind::split_top_bottom;
    break;
  case protocol::PaneCommand::focus_left:
    command.kind = CommandKind::focus_left;
    break;
  case protocol::PaneCommand::focus_right:
    command.kind = CommandKind::focus_right;
    break;
  case protocol::PaneCommand::focus_up:
    command.kind = CommandKind::focus_up;
    break;
  case protocol::PaneCommand::focus_down:
    command.kind = CommandKind::focus_down;
    break;
  case protocol::PaneCommand::focus_next:
    command.kind = CommandKind::focus_next;
    break;
  case protocol::PaneCommand::focus_previous:
    command.kind = CommandKind::focus_previous;
    break;
  case protocol::PaneCommand::close:
    command.kind = CommandKind::close_pane;
    break;
  case protocol::PaneCommand::zoom:
    command.kind = CommandKind::toggle_zoom;
    break;
  case protocol::PaneCommand::create_window:
    command.kind = CommandKind::create_window;
    break;
  case protocol::PaneCommand::next_window:
    command.kind = CommandKind::next_window;
    break;
  case protocol::PaneCommand::previous_window:
    command.kind = CommandKind::previous_window;
    break;
  case protocol::PaneCommand::kill_window:
    command.kind = CommandKind::close_window;
    break;
  case protocol::PaneCommand::select_window_0:
  case protocol::PaneCommand::select_window_1:
  case protocol::PaneCommand::select_window_2:
  case protocol::PaneCommand::select_window_3:
  case protocol::PaneCommand::select_window_4:
  case protocol::PaneCommand::select_window_5:
  case protocol::PaneCommand::select_window_6:
  case protocol::PaneCommand::select_window_7:
  case protocol::PaneCommand::select_window_8:
  case protocol::PaneCommand::select_window_9: {
    command.kind = CommandKind::select_window;
    const auto encoded = static_cast<std::uint8_t>(pane_command);
    command.argument = encoded == static_cast<std::uint8_t>('0')
                           ? std::uint16_t{9}
                           : static_cast<std::uint16_t>(encoded - static_cast<std::uint8_t>('1'));
    break;
  }
  }
  return command;
}

// This is the only function that translates validated commands into authoritative mux mutations.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto execute_workspace_command(void* const context, const Command& command) noexcept
    -> CommandResult {
  auto& workspace = *static_cast<Workspace*>(context);
  if (command.target.workspace.is_valid() || command.target.pane.is_valid()) {
    return {.status = CommandStatus::invalid_target};
  }
  if (command.kind == CommandKind::detach_client) {
    return {.status = CommandStatus::detach_requested};
  }
  if (command.kind == CommandKind::stop_workspace) {
    const bool changed = workspace.active;
    workspace.active = false;
    return command_status(changed);
  }

  auto* const window = active_window(workspace);
  if (window == nullptr) {
    workspace.active = false;
    return {.status = CommandStatus::failed};
  }
  if (command.target.window.is_valid() && command.target.window != window->id) {
    return {.status = CommandStatus::invalid_target};
  }

  const auto focus_result = [&](const std::uint16_t previous) {
    return workspace.active ? command_status(window->focused_pane != previous)
                            : CommandResult{.status = CommandStatus::failed};
  };
  switch (command.kind) {
  case CommandKind::none:
  case CommandKind::detach_client:
  case CommandKind::stop_workspace:
    return {.status = CommandStatus::invalid_command};
  case CommandKind::split_left_right:
    if (split_focused_pane(workspace, *window, SplitAxis::left_right)) {
      return {.status = CommandStatus::applied};
    }
    return {.status = workspace.active ? CommandStatus::unavailable : CommandStatus::failed};
  case CommandKind::split_top_bottom:
    if (split_focused_pane(workspace, *window, SplitAxis::top_bottom)) {
      return {.status = CommandStatus::applied};
    }
    return {.status = workspace.active ? CommandStatus::unavailable : CommandStatus::failed};
  case CommandKind::focus_left: {
    const auto previous = window->focused_pane;
    focus_direction(workspace, *window, FocusDirection::left);
    return focus_result(previous);
  }
  case CommandKind::focus_right: {
    const auto previous = window->focused_pane;
    focus_direction(workspace, *window, FocusDirection::right);
    return focus_result(previous);
  }
  case CommandKind::focus_up: {
    const auto previous = window->focused_pane;
    focus_direction(workspace, *window, FocusDirection::up);
    return focus_result(previous);
  }
  case CommandKind::focus_down: {
    const auto previous = window->focused_pane;
    focus_direction(workspace, *window, FocusDirection::down);
    return focus_result(previous);
  }
  case CommandKind::focus_next: {
    const auto previous = window->focused_pane;
    focus_next(workspace, *window);
    return focus_result(previous);
  }
  case CommandKind::focus_previous: {
    const auto previous = window->focused_pane;
    focus_pane(workspace, *window, window->previous_pane);
    return focus_result(previous);
  }
  case CommandKind::close_pane:
    if (close_pane(workspace, *window, window->focused_pane)) {
      return {.status = CommandStatus::applied};
    }
    return {.status = workspace.active ? CommandStatus::unavailable : CommandStatus::failed};
  case CommandKind::toggle_zoom:
    window->zoomed = !window->zoomed;
    if (!resolve_workspace_layout(workspace, *window)) {
      return {.status = CommandStatus::failed};
    }
    schedule_frame(workspace, true);
    return {.status = CommandStatus::applied};
  case CommandKind::create_window: {
    const auto previous = window_count(workspace);
    create_window(workspace);
    if (!workspace.active) {
      return {.status = CommandStatus::failed};
    }
    return previous == window_count(workspace) ? CommandResult{.status = CommandStatus::unavailable}
                                               : CommandResult{.status = CommandStatus::applied};
  }
  case CommandKind::next_window: {
    const auto previous = workspace.active_window;
    cycle_window(workspace, true);
    return workspace.active ? command_status(previous != workspace.active_window)
                            : CommandResult{.status = CommandStatus::failed};
  }
  case CommandKind::previous_window: {
    const auto previous = workspace.active_window;
    cycle_window(workspace, false);
    return workspace.active ? command_status(previous != workspace.active_window)
                            : CommandResult{.status = CommandStatus::failed};
  }
  case CommandKind::close_window:
    remove_window(workspace, window->id);
    return {.status = CommandStatus::applied};
  case CommandKind::select_window: {
    const auto slot_index = static_cast<std::size_t>(command.argument);
    if (slot_index >= workspace.windows.size()) {
      return {.status = CommandStatus::invalid_target};
    }
    const auto& slot = std::span(workspace.windows).subspan(slot_index, 1).front();
    if (slot.window == nullptr) {
      return {.status = CommandStatus::unavailable};
    }
    const auto previous = workspace.active_window;
    if (!select_window(workspace, slot.window->id)) {
      return {.status = workspace.active ? CommandStatus::invalid_target : CommandStatus::failed};
    }
    return command_status(previous != workspace.active_window);
  }
  }
  return {.status = CommandStatus::invalid_command};
}

[[nodiscard]] auto dispatch_workspace_command(Workspace& workspace, const Command& command) noexcept
    -> CommandResult {
  const CommandDispatcher dispatcher(&execute_workspace_command, &workspace);
  return dispatcher.dispatch(command);
}

[[nodiscard]] auto
collect_surfaces(Workspace& workspace,
                 std::array<render::PaneSurface, panes_per_window_max>& storage) noexcept
    -> std::span<const render::PaneSurface> {
  auto* const window = active_window(workspace);
  if (window == nullptr || window->layout_suspended) {
    return std::span<const render::PaneSurface>{};
  }
  std::size_t count = 0;
  for (std::size_t index = 0; index < window->panes.size(); ++index) {
    auto& pane = std::span(window->panes).subspan(index, 1).front();
    if (pane == nullptr || !pane->active || (window->zoomed && index != window->focused_pane)) {
      continue;
    }
    std::span(storage).subspan(count, 1).front() = {
        .terminal = &pane->terminal,
        .rectangle = pane->rectangle,
        .focused = index == window->focused_pane,
        .border_right =
            static_cast<std::uint32_t>(pane->rectangle.column) + pane->rectangle.columns <
            window->layout_columns,
        .border_bottom = static_cast<std::uint32_t>(pane->rectangle.row) + pane->rectangle.rows <
                         window->layout_rows,
    };
    ++count;
  }
  return std::span(storage).first(count);
}

[[nodiscard]] auto resize_workspace(Workspace& workspace,
                                    const protocol::Dimensions dimensions) noexcept -> bool {
  const auto columns = std::clamp(dimensions.columns, std::uint16_t{1}, protocol::columns_max);
  const auto rows = std::clamp(dimensions.rows, std::uint16_t{1}, protocol::rows_max);
  // Record every physical resize and discard any unsent frame composed for the previous viewport.
  // A transiently tiny outer terminal is valid, but pane geometry cannot represent the split tree
  // until it fits again. Preserve that geometry and send a surface-free clear frame constrained to
  // the physical viewport instead of rendering stale rectangles outside it. Checking the unzoomed
  // tree also prevents an undersized viewport from becoming latent while zoomed.
  workspace.columns = columns;
  workspace.rows = rows;
  workspace.output.reset();
  auto* const window = active_window(workspace);
  if (window == nullptr || !fit_window_to_viewport(workspace, *window)) {
    return false;
  }
  schedule_frame(workspace, true);
  return true;
}

enum class ParseResult : std::uint8_t {
  keep,
  backpressure,
  detach,
  error,
};

// Packet dispatch exhaustively maps validated protocol messages to workspace transitions.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto parse_client_packets(Workspace& workspace) noexcept -> ParseResult {
  while (true) {
    const auto decoded = workspace.decoder.next();
    if (!decoded.has_value()) {
      return ParseResult::error;
    }
    if (!decoded->has_value()) {
      return ParseResult::keep;
    }
    const auto& message = **decoded;
    switch (message.kind) {
    case protocol::ClientMessageKind::detach: {
      const Command command{.kind = CommandKind::detach_client, .origin = CommandOrigin::client};
      const auto result = dispatch_workspace_command(workspace, command);
      workspace.decoder.consume();
      return result.status == CommandStatus::detach_requested ? ParseResult::detach
                                                              : ParseResult::error;
    }
    case protocol::ClientMessageKind::resize:
      if (!resize_workspace(workspace, message.dimensions)) {
        return ParseResult::error;
      }
      break;
    case protocol::ClientMessageKind::input: {
      auto* const window = active_window(workspace);
      if (window == nullptr) {
        return ParseResult::error;
      }
      auto& pane = std::span(window->panes).subspan(window->focused_pane, 1).front();
      if (pane == nullptr) {
        return ParseResult::error;
      }
      const auto queued =
          queue_normalized_input(pane->pending_writes, pane->terminal, message.input);
      if (queued == InputQueueResult::full) {
        return ParseResult::backpressure;
      }
      if (queued == InputQueueResult::encoding_failed) {
        return ParseResult::error;
      }
      break;
    }
    case protocol::ClientMessageKind::pane_command: {
      const auto command = command_from_pane_command(message.pane_command);
      if (!command.has_value() || !dispatch_workspace_command(workspace, *command).succeeded()) {
        if (!workspace.active) {
          workspace.decoder.consume();
          return ParseResult::detach;
        }
      }
      break;
    }
    }
    workspace.decoder.consume();
    if (!workspace.active) {
      return ParseResult::detach;
    }
  }
}

[[nodiscard]] auto receive_client(Workspace& workspace) noexcept -> ParseResult {
  const auto buffered = parse_client_packets(workspace);
  if (buffered != ParseResult::keep) {
    return buffered;
  }
  const auto available = workspace.decoder.writable_bytes();
  if (available.empty()) {
    return ParseResult::error;
  }
  const auto bytes_read = ::recv(workspace.client, available.data(), available.size(), 0);
  if (bytes_read == 0) {
    return ParseResult::detach;
  }
  if (bytes_read < 0) {
    return errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK ? ParseResult::keep
                                                                     : ParseResult::detach;
  }
  if (!workspace.decoder.commit(static_cast<std::size_t>(bytes_read)).has_value()) {
    return ParseResult::error;
  }
  return parse_client_packets(workspace);
}

[[nodiscard]] auto window_title(const Window& window) noexcept -> std::string_view {
  const auto& focused = *std::span(window.panes).subspan(window.focused_pane, 1).front();
  if (focused.process_name_size > 0) {
    return {focused.process_name.data(), focused.process_name_size};
  }
  const auto title = focused.terminal.title();
  return title.has_value() && !title->empty() ? *title : std::string_view{"shell"};
}

[[nodiscard]] auto current_status_signature(const Workspace& workspace) noexcept -> std::uint64_t {
  constexpr std::uint64_t offset_basis = 14'695'981'039'346'656'037ULL;
  constexpr std::uint64_t prime = 1'099'511'628'211ULL;
  std::uint64_t signature = offset_basis;
  const auto mix = [&](const std::uint8_t value) {
    signature ^= value;
    signature *= prime;
  };
  for (std::size_t index = 0; index < workspace.windows.size(); ++index) {
    const auto& slot = std::span(workspace.windows).subspan(index, 1).front();
    if (slot.window == nullptr) {
      continue;
    }
    mix(static_cast<std::uint8_t>(index + 1U));
    mix(slot.window->id == workspace.active_window ? 1U : 0U);
    const auto title = window_title(*slot.window);
    for (const char character : std::span(title).first(std::min(title.size(), std::size_t{16}))) {
      mix(static_cast<std::uint8_t>(static_cast<unsigned char>(character)));
    }
    mix(title.size() > 16 ? 1U : 0U);
  }
  return signature;
}

[[nodiscard]] auto
collect_status_line(Workspace& workspace,
                    std::array<render::StatusWindow, render::status_windows_max>& storage) noexcept
    -> render::StatusLine {
  std::size_t count = 0;
  for (std::size_t index = 0; index < workspace.windows.size(); ++index) {
    auto& slot = std::span(workspace.windows).subspan(index, 1).front();
    if (slot.window == nullptr) {
      continue;
    }
    if (!workspace.status_valid) {
      auto& focused = *std::span(slot.window->panes).subspan(slot.window->focused_pane, 1).front();
      static_cast<void>(refresh_process_name(focused));
    }
    std::span(storage).subspan(count, 1).front() = {
        .number = static_cast<std::uint16_t>(index + 1U),
        .title = window_title(*slot.window),
        .active = slot.window->id == workspace.active_window,
    };
    ++count;
  }
  const auto signature = current_status_signature(workspace);
  const bool dirty = !workspace.status_valid || signature != workspace.status_signature;
  workspace.status_signature = signature;
  workspace.status_valid = true;
  return {.windows = std::span(storage).first(count), .dirty = dirty};
}

[[nodiscard]] auto append_listing(ConnectionOutput& output, const Workspace& workspace) noexcept
    -> bool {
  const auto* const window = active_window(workspace);
  if (window == nullptr) {
    return false;
  }
  const auto& focused = *std::span(window->panes).subspan(window->focused_pane, 1).front();
  const auto title_value = window_title(*window);
  return output.append_text("lemma workspace \"") &&
         output.append_title(workspace.workspace_name()) && output.append_text("\": ") &&
         output.append_number(window_count(workspace)) && output.append_text(" window(s), ") &&
         output.append_number(pane_count(workspace)) &&
         output.append_text(" pane(s), focused pid ") &&
         output.append_number(static_cast<std::uint64_t>(focused.child)) &&
         output.append_text(workspace.client >= 0 ? ", attached, " : ", detached, ") &&
         output.append_number(workspace.columns) && output.append_text("x") &&
         output.append_number(workspace.rows) && output.append_text(", title \"") &&
         output.append_title(title_value) && output.append_text("\"\n");
}

[[nodiscard]] auto append_window_listings(ConnectionOutput& output,
                                          const Workspace& workspace) noexcept -> bool {
  for (std::size_t index = 0; index < workspace.windows.size(); ++index) {
    const auto& slot = std::span(workspace.windows).subspan(index, 1).front();
    if (slot.window == nullptr) {
      continue;
    }
    const auto& window = *slot.window;
    const auto title_value = window_title(window);
    if (!output.append_text("lemma window ") || !output.append_number(index + 1U) ||
        !output.append_text(": ") || !output.append_number(pane_count(window)) ||
        !output.append_text(" pane(s), ") ||
        !output.append_text(window.id == workspace.active_window ? "active, title \""
                                                                 : "inactive, title \"") ||
        !output.append_title(title_value) || !output.append_text("\"\n")) {
      return false;
    }
  }
  return true;
}

using Workspaces =
    std::array<std::unique_ptr<Workspace>, static_cast<std::size_t>(limits::workspaces_hard_max)>;

[[nodiscard]] auto find_workspace(Workspaces& workspaces, const std::string_view name) noexcept
    -> Workspace* {
  for (auto& workspace : workspaces) {
    if (workspace != nullptr && workspace->active && workspace->workspace_name() == name) {
      return workspace.get();
    }
  }
  return nullptr;
}

void reclaim_inactive_workspaces(Workspaces& workspaces) noexcept {
  for (auto& workspace : workspaces) {
    if (workspace != nullptr && !workspace->active &&
        workspace->pending_attach_slot == std::numeric_limits<std::uint32_t>::max()) {
      workspace.reset();
    }
  }
}

[[nodiscard]] auto empty_workspace_slot(Workspaces& workspaces) noexcept
    -> std::unique_ptr<Workspace>* {
  for (auto& workspace : workspaces) {
    if (workspace == nullptr) {
      return &workspace;
    }
  }
  return nullptr;
}

[[nodiscard]] auto append_extension_error(ConnectionOutput& output,
                                          const std::string_view error) noexcept -> bool {
  return error.empty() || (output.append_text("lemma configuration error: ") &&
                           output.append_safe(error, protocol::extension::error_bytes_max) &&
                           output.append_text("\n"));
}

[[nodiscard]] auto append_all_listings(ConnectionOutput& output,
                                       const Workspaces& workspaces) noexcept -> bool {
  std::size_t listed = 0;
  for (const auto& workspace : workspaces) {
    if (workspace != nullptr && workspace->active) {
      if (!append_listing(output, *workspace)) {
        return false;
      }
      ++listed;
    }
  }
  return listed > 0 || output.append_text("no lemma workspaces\n");
}

enum class PendingState : std::uint8_t {
  unused,
  read_command,
  read_name_size,
  read_name,
  read_dimensions,
  flush_response,
};

enum class PendingAction : std::uint8_t {
  close,
  attach,
};

struct PendingConnection final {
  [[nodiscard]] auto active() const noexcept -> bool { return state != PendingState::unused; }

  int descriptor{-1};
  std::uint32_t generation{0};
  PendingState state{PendingState::unused};
  PendingAction action{PendingAction::close};
  std::byte command{};
  WorkspaceName workspace;
  std::array<std::byte, protocol::workspace_name_bytes_max> field{};
  std::size_t field_size{0};
  std::size_t field_target{0};
  ConnectionOutput output;
  Workspace* attach_workspace{nullptr};
  std::chrono::steady_clock::time_point deadline;
};

using PendingConnections = std::array<PendingConnection, limits::pending_connections_hard_max>;

constexpr auto setup_progress_timeout = std::chrono::seconds(5);

void begin_pending_field(PendingConnection& pending, const PendingState state,
                         const std::size_t size) noexcept {
  LEMMA_ASSERT(size > 0 && size <= pending.field.size());
  pending.state = state;
  pending.field_size = 0;
  pending.field_target = size;
}

void release_attach_reservation(PendingConnection& pending, const std::size_t slot) noexcept {
  if (pending.attach_workspace != nullptr &&
      pending.attach_workspace->pending_attach_slot == slot &&
      pending.attach_workspace->pending_attach_generation == pending.generation) {
    pending.attach_workspace->pending_attach_slot = std::numeric_limits<std::uint32_t>::max();
    pending.attach_workspace->pending_attach_generation = 0;
  }
  pending.attach_workspace = nullptr;
}

void close_pending(PendingConnection& pending, const std::size_t slot) noexcept {
  release_attach_reservation(pending, slot);
  close_descriptor(pending.descriptor);
  pending.output.reset();
  pending.state = PendingState::unused;
  pending.field_size = 0;
  pending.field_target = 0;
  pending.action = PendingAction::close;
}

void finish_pending_output(PendingConnection& pending,
                           const PendingAction action = PendingAction::close) noexcept {
  pending.action = action;
  pending.state = PendingState::flush_response;
  pending.field_size = 0;
  pending.field_target = 0;
}

void finish_pending_byte(PendingConnection& pending, const std::byte response,
                         const PendingAction action = PendingAction::close) noexcept {
  pending.output.reset();
  const bool appended = pending.output.append(std::span(&response, 1));
  LEMMA_ASSERT(appended);
  finish_pending_output(pending, action);
}

void fail_pending_output(PendingConnection& pending) noexcept {
  finish_pending_byte(pending, response_failed);
}

void prepare_unnamed_command(PendingConnection& pending, Workspaces& workspaces,
                             const ExtensionRuntime& extensions) noexcept {
  bool prepared = true;
  if (pending.command == command_list) {
    prepared = append_extension_error(pending.output, extensions.last_error()) &&
               append_all_listings(pending.output, workspaces);
  } else if (pending.command == command_kill_all) {
    const Command stop{.kind = CommandKind::stop_workspace, .origin = CommandOrigin::cli};
    for (auto& workspace : workspaces) {
      if (workspace != nullptr) {
        static_cast<void>(dispatch_workspace_command(*workspace, stop));
      }
    }
    prepared = pending.output.append_text("all lemma workspaces stopped\n");
  } else {
    pending.state = PendingState::unused;
    return;
  }
  if (!prepared) {
    fail_pending_output(pending);
  } else {
    finish_pending_output(pending);
  }
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void prepare_named_command(PendingConnection& pending, Workspaces& workspaces,
                           const ExtensionRuntime& extensions) noexcept {
  Workspace* workspace = find_workspace(workspaces, pending.workspace.view());
  if (pending.command == command_create) {
    if (workspace != nullptr) {
      finish_pending_byte(pending, response_ready);
      return;
    }
    auto* const slot = empty_workspace_slot(workspaces);
    if (slot == nullptr) {
      finish_pending_byte(pending, response_capacity);
      return;
    }
    auto created = create_workspace(pending.workspace.view());
    if (created == nullptr) {
      finish_pending_byte(pending, response_failed);
      return;
    }
    *slot = std::move(created);
    finish_pending_byte(pending, response_ready);
    return;
  }
  if (workspace == nullptr) {
    finish_pending_byte(pending, response_missing);
    return;
  }
  if (pending.command == command_list_workspace) {
    if (!append_extension_error(pending.output, extensions.last_error()) ||
        !append_listing(pending.output, *workspace)) {
      fail_pending_output(pending);
    } else {
      finish_pending_output(pending);
    }
    return;
  }
  if (pending.command == command_list_windows) {
    if (!append_extension_error(pending.output, extensions.last_error()) ||
        !append_window_listings(pending.output, *workspace)) {
      fail_pending_output(pending);
    } else {
      finish_pending_output(pending);
    }
    return;
  }

  if (!pending.output.append_text("lemma workspace \"") ||
      !pending.output.append_title(workspace->workspace_name()) ||
      !pending.output.append_text("\" stopped\n")) {
    fail_pending_output(pending);
    return;
  }
  const Command stop{.kind = CommandKind::stop_workspace, .origin = CommandOrigin::cli};
  static_cast<void>(dispatch_workspace_command(*workspace, stop));
  finish_pending_output(pending);
}

void prepare_attach(PendingConnection& pending, Workspaces& workspaces,
                    const std::size_t slot) noexcept {
  Workspace* const workspace = find_workspace(workspaces, pending.workspace.view());
  if (workspace == nullptr) {
    finish_pending_byte(pending, response_missing);
    return;
  }
  if (workspace->client >= 0 ||
      workspace->pending_attach_slot != std::numeric_limits<std::uint32_t>::max()) {
    finish_pending_byte(pending, response_busy);
    return;
  }
  const auto dimensions = protocol::decode_dimensions(std::span(pending.field).first<4>());
  if (dimensions.columns == 0 || dimensions.rows == 0 ||
      dimensions.columns > protocol::columns_max || dimensions.rows > protocol::rows_max ||
      !resize_workspace(*workspace, dimensions)) {
    finish_pending_byte(pending, response_failed);
    return;
  }
  workspace->pending_attach_slot = static_cast<std::uint32_t>(slot);
  workspace->pending_attach_generation = pending.generation;
  pending.attach_workspace = workspace;
  finish_pending_byte(pending, response_ready, PendingAction::attach);
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void complete_pending_field(PendingConnection& pending, Workspaces& workspaces,
                            const ExtensionRuntime& extensions, const std::size_t slot) noexcept {
  switch (pending.state) {
  case PendingState::read_command:
    pending.command = pending.field.front();
    if (pending.command == command_list || pending.command == command_kill_all) {
      pending.output.reset();
      prepare_unnamed_command(pending, workspaces, extensions);
    } else if (pending.command == command_attach || pending.command == command_create ||
               pending.command == command_list_workspace ||
               pending.command == command_list_windows || pending.command == command_kill) {
      begin_pending_field(pending, PendingState::read_name_size, 1);
    } else {
      pending.state = PendingState::unused;
    }
    break;
  case PendingState::read_name_size: {
    const auto size = protocol::decode_workspace_name_size(pending.field.front());
    if (size == 0 || size > pending.workspace.bytes.size()) {
      pending.state = PendingState::unused;
    } else {
      begin_pending_field(pending, PendingState::read_name, size);
    }
    break;
  }
  case PendingState::read_name:
    pending.workspace.size = pending.field_target;
    std::ranges::copy(std::span(pending.field).first(pending.workspace.size),
                      std::as_writable_bytes(std::span(pending.workspace.bytes)).begin());
    if (!valid_workspace_name(pending.workspace.view())) {
      pending.state = PendingState::unused;
    } else if (pending.command == command_attach) {
      begin_pending_field(pending, PendingState::read_dimensions, 4);
    } else {
      pending.output.reset();
      prepare_named_command(pending, workspaces, extensions);
    }
    break;
  case PendingState::read_dimensions:
    prepare_attach(pending, workspaces, slot);
    break;
  case PendingState::unused:
  case PendingState::flush_response:
    LEMMA_ASSERT(false);
    break;
  }
}

void process_pending_read(PendingConnection& pending, Workspaces& workspaces,
                          const ExtensionRuntime& extensions, const std::size_t slot) noexcept {
  constexpr std::size_t operations_per_turn_max = 8;
  for (std::size_t operation = 0; operation < operations_per_turn_max && pending.active() &&
                                  pending.state != PendingState::flush_response;
       ++operation) {
    auto available = std::span(pending.field)
                         .subspan(pending.field_size, pending.field_target - pending.field_size);
    const auto received = ::recv(pending.descriptor, available.data(), available.size(), 0);
    if (received > 0) {
      pending.field_size += static_cast<std::size_t>(received);
      pending.deadline = std::chrono::steady_clock::now() + setup_progress_timeout;
      if (pending.field_size == pending.field_target) {
        complete_pending_field(pending, workspaces, extensions, slot);
      }
      continue;
    }
    if (received < 0 && errno == EINTR) {
      continue;
    }
    if (received < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return;
    }
    close_pending(pending, slot);
    return;
  }
  if (!pending.active()) {
    close_pending(pending, slot);
  }
}

void handoff_attached_connection(PendingConnection& pending, const std::size_t slot) noexcept {
  Workspace* const workspace = pending.attach_workspace;
  if (workspace == nullptr || !workspace->active || workspace->pending_attach_slot != slot ||
      workspace->pending_attach_generation != pending.generation) {
    close_pending(pending, slot);
    return;
  }

  const int connection = pending.descriptor;
  pending.descriptor = -1;
  release_attach_reservation(pending, slot);
  pending.output.reset();
  pending.state = PendingState::unused;

  workspace->client = connection;
  workspace->decoder.reset();
  workspace->output.reset();
  workspace->input_backpressured = false;
  workspace->frame_pending = false;
  workspace->force_full_pending = false;
  std::array<render::PaneSurface, panes_per_window_max> surface_storage{};
  std::array<render::StatusWindow, render::status_windows_max> status_storage{};
  const auto surfaces = collect_surfaces(*workspace, surface_storage);
  const auto status = collect_status_line(*workspace, status_storage);
  if (!render::queue_composed_frame(connection, surfaces,
                                    {.columns = workspace->columns, .rows = workspace->rows},
                                    *workspace->frame, workspace->output, true, status)) {
    workspace->detach_client();
  }
}

[[nodiscard]] auto write_pending_output(void* const context,
                                        const std::span<const std::byte> bytes) noexcept
    -> ConnectionWriteAttempt {
  auto& pending = *static_cast<PendingConnection*>(context);
  const auto sent = ::send(pending.descriptor, bytes.data(), bytes.size(), MSG_NOSIGNAL);
  if (sent > 0) {
    pending.deadline = std::chrono::steady_clock::now() + setup_progress_timeout;
  }
  return {.bytes = sent, .error = sent < 0 ? errno : 0};
}

void flush_pending_output(PendingConnection& pending, const std::size_t slot,
                          std::size_t& global_budget) noexcept {
  const auto status =
      flush_connection_output(pending.output, global_budget, &write_pending_output, &pending);
  if (status == ConnectionFlushStatus::hard_error) {
    close_pending(pending, slot);
    return;
  }
  if (!pending.active() || status != ConnectionFlushStatus::drained) {
    return;
  }
  if (pending.action == PendingAction::attach) {
    handoff_attached_connection(pending, slot);
  } else {
    close_pending(pending, slot);
  }
}

[[nodiscard]] auto poll_timeout(const Workspaces& workspaces, const PendingConnections& pending,
                                const ExtensionRuntime& extensions) noexcept -> int {
  const auto now = std::chrono::steady_clock::now();
  auto timeout = extensions.poll_timeout(now);
  for (const auto& connection : pending) {
    if (!connection.active()) {
      continue;
    }
    if (now >= connection.deadline) {
      return 0;
    }
    const auto remaining =
        std::chrono::duration_cast<std::chrono::milliseconds>(connection.deadline - now);
    const auto candidate = static_cast<int>(std::max(remaining.count(), std::int64_t{1}));
    timeout = timeout < 0 ? candidate : std::min(timeout, candidate);
  }
  for (const auto& workspace : workspaces) {
    if (workspace == nullptr || !workspace->active || !workspace->frame_pending ||
        workspace->client < 0 || workspace->output.busy()) {
      continue;
    }
    if (now >= workspace->frame_deadline) {
      return 0;
    }
    const auto remaining =
        std::chrono::duration_cast<std::chrono::milliseconds>(workspace->frame_deadline - now);
    const auto candidate = static_cast<int>(std::max(remaining.count(), std::int64_t{1}));
    timeout = timeout < 0 ? candidate : std::min(timeout, candidate);
  }
  return timeout;
}

void process_pane_events(Workspace& workspace, Window& window, Pane& pane,
                         const pollfd& events) noexcept {
  if ((events.revents & (POLLIN | POLLHUP | POLLERR)) == 0) {
    return;
  }
  const auto drained = drain_pty(pane.pty, pane.terminal, pane.pending_writes);
  pane.active = drained.alive;
  const bool process_changed = refresh_process_name(pane);
  if ((!drained.changed && !process_changed) || workspace.client < 0) {
    return;
  }
  if (window.id == workspace.active_window) {
    schedule_frame(workspace, false, !drained.alive);
  } else if (!workspace.status_valid ||
             current_status_signature(workspace) != workspace.status_signature) {
    schedule_frame(workspace, false);
  }
}

void process_client_events(Workspace& workspace, const pollfd& events) noexcept {
  // Consume resizes before flushing queued output so resize_workspace can discard bytes composed
  // for the previous physical viewport. A decoder-held input message is retried even without new
  // socket readiness after a prior turn made PTY queue capacity available. If its peer has already
  // closed, discard a backpressured message instead of letting it hide EOF indefinitely.
  if (workspace.client >= 0 && workspace.input_backpressured &&
      (events.revents & (POLLHUP | POLLERR)) != 0) {
    workspace.detach_client();
    return;
  }
  if (workspace.client >= 0 &&
      (workspace.input_backpressured || (events.revents & (POLLIN | POLLHUP | POLLERR)) != 0)) {
    const auto received = receive_client(workspace);
    workspace.input_backpressured = received == ParseResult::backpressure;
    if (received == ParseResult::detach || received == ParseResult::error) {
      workspace.detach_client();
      return;
    }
  }
}

[[nodiscard]] auto write_pane_pty(void* const context,
                                  const std::span<const std::byte> bytes) noexcept
    -> PtyWriteAttempt {
  const int descriptor = *static_cast<int*>(context);
  const auto written = ::write(descriptor, bytes.data(), bytes.size());
  return {.bytes = written, .error = written < 0 ? errno : 0};
}

[[nodiscard]] auto flush_pane_writes(Pane& pane, std::size_t& global_budget) noexcept -> bool {
  return flush_pty_write_queue(pane.pending_writes, global_budget, &write_pane_pty, &pane.pty) !=
         PtyFlushStatus::hard_error;
}

void reclaim_dead_panes(Workspace& workspace) noexcept {
  for (auto& slot : workspace.windows) {
    if (slot.window == nullptr || !workspace.active) {
      continue;
    }
    const auto id = slot.window->id;
    for (std::size_t index = 0;; ++index) {
      auto* const window = find_window(workspace, id);
      if (window == nullptr || index >= window->panes.size()) {
        break;
      }
      const auto& pane = std::span(window->panes).subspan(index, 1).front();
      if (pane != nullptr && !pane->active) {
        static_cast<void>(close_pane(workspace, *window, index));
      }
    }
  }
}

void queue_due_frames(Workspaces& workspaces) noexcept {
  const auto now = std::chrono::steady_clock::now();
  for (auto& workspace : workspaces) {
    if (workspace == nullptr || !workspace->active || !workspace->frame_pending ||
        workspace->client < 0 || workspace->output.busy() || now < workspace->frame_deadline) {
      continue;
    }
    std::array<render::PaneSurface, panes_per_window_max> surface_storage{};
    std::array<render::StatusWindow, render::status_windows_max> status_storage{};
    const auto surfaces = collect_surfaces(*workspace, surface_storage);
    const auto status = collect_status_line(*workspace, status_storage);
    if (!render::queue_composed_frame(
            workspace->client, surfaces, {.columns = workspace->columns, .rows = workspace->rows},
            *workspace->frame, workspace->output, workspace->force_full_pending, status)) {
      workspace->detach_client();
    }
    workspace->frame_pending = false;
    workspace->force_full_pending = false;
  }
}

void expire_pending_connections(PendingConnections& pending_connections) noexcept {
  const auto now = std::chrono::steady_clock::now();
  for (std::size_t slot = 0; slot < pending_connections.size(); ++slot) {
    auto& pending = std::span(pending_connections).subspan(slot, 1).front();
    if (pending.active() && now >= pending.deadline) {
      close_pending(pending, slot);
    }
  }
}

[[nodiscard]] auto empty_pending_slot(PendingConnections& pending_connections) noexcept
    -> std::optional<std::size_t> {
  for (std::size_t slot = 0; slot < pending_connections.size(); ++slot) {
    if (!std::span(pending_connections).subspan(slot, 1).front().active()) {
      return slot;
    }
  }
  return std::nullopt;
}

void accept_pending_connections(const int listener,
                                PendingConnections& pending_connections) noexcept {
  constexpr std::size_t accepts_per_turn_max = 8;
  for (std::size_t accepted = 0; accepted < accepts_per_turn_max; ++accepted) {
    int connection = ::accept(listener, nullptr, nullptr);
    if (connection < 0) {
      if (errno == EINTR) {
        continue;
      }
      return;
    }
    if (!set_nonblocking(connection)) {
      close_descriptor(connection);
      continue;
    }
    const auto available = empty_pending_slot(pending_connections);
    if (!available.has_value()) {
      static_cast<void>(::send(connection, &response_capacity, 1, MSG_NOSIGNAL));
      close_descriptor(connection);
      continue;
    }
    auto& pending = std::span(pending_connections).subspan(*available, 1).front();
    pending.descriptor = connection;
    pending.generation = next_generation(pending.generation);
    pending.output.reset();
    pending.workspace = {};
    pending.attach_workspace = nullptr;
    pending.action = PendingAction::close;
    pending.deadline = std::chrono::steady_clock::now() + setup_progress_timeout;
    begin_pending_field(pending, PendingState::read_command, 1);
  }
}

enum class DescriptorKind : std::uint8_t {
  pane,
  client,
  pending,
  extension,
};

struct DescriptorOwner final {
  Workspace* workspace{nullptr};
  Window* window{nullptr};
  Pane* pane{nullptr};
  PendingConnection* pending{nullptr};
  std::size_t pending_slot{0};
  DescriptorKind kind{DescriptorKind::client};
};

// The branches are the explicit bounded stages of the current single-owner reactor.
[[nodiscard]] auto
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
run_server_impl(const int listener, const EndpointRelease release_endpoint,
                void* const release_context, const ExtensionAcquire acquire_extension,
                void* const extension_context, const ExtensionErrorReporter report_extension_error,
                void* const extension_error_context, const StopRequested stop_requested) noexcept
    -> int {
  EndpointReleaseGuard endpoint_release(release_endpoint, release_context);
  Workspaces workspaces;
  auto pending_storage =
      std::unique_ptr<PendingConnections>(new (std::nothrow) PendingConnections{});
  if (pending_storage == nullptr) {
    return 1;
  }
  auto& pending_connections = *pending_storage;
  ExtensionRuntime extensions(acquire_extension, extension_context, report_extension_error,
                              extension_error_context);
  if (!set_nonblocking(listener)) {
    return 1;
  }
  constexpr auto descriptor_count_max = std::size_t{2} + limits::panes_hard_max +
                                        static_cast<std::size_t>(limits::workspaces_hard_max) +
                                        limits::pending_connections_hard_max;
  std::array<pollfd, descriptor_count_max> descriptors{};
  std::array<DescriptorOwner, descriptor_count_max> owners{};
  std::size_t pty_flush_cursor = 0;

  while (true) {
    if (stop_requested != nullptr && stop_requested()) {
      return 0;
    }
    extensions.connect_if_due(std::chrono::steady_clock::now());
    std::size_t descriptor_count = 1;
    descriptors.front() = {.fd = listener, .events = POLLIN, .revents = 0};
    for (const auto& workspace : workspaces) {
      if (workspace == nullptr || !workspace->active) {
        continue;
      }
      for (const auto& window_slot : workspace->windows) {
        if (window_slot.window == nullptr) {
          continue;
        }
        for (const auto& pane : window_slot.window->panes) {
          if (pane == nullptr || !pane->active) {
            continue;
          }
          const auto pane_events = static_cast<short>(
              POLLIN | (!pane->pending_writes.empty() ? static_cast<short>(POLLOUT) : 0));
          std::span(descriptors).subspan(descriptor_count, 1).front() = {
              .fd = pane->pty, .events = pane_events, .revents = 0};
          std::span(owners).subspan(descriptor_count, 1).front() = {.workspace = workspace.get(),
                                                                    .window =
                                                                        window_slot.window.get(),
                                                                    .pane = pane.get(),
                                                                    .kind = DescriptorKind::pane};
          ++descriptor_count;
        }
      }
      if (workspace->client >= 0) {
        const auto client_events =
            static_cast<short>((workspace->input_backpressured ? 0 : POLLIN) |
                               (workspace->output.busy() ? static_cast<short>(POLLOUT) : 0));
        std::span(descriptors).subspan(descriptor_count, 1).front() = {
            .fd = workspace->client, .events = client_events, .revents = 0};
        std::span(owners).subspan(descriptor_count, 1).front() = {.workspace = workspace.get(),
                                                                  .kind = DescriptorKind::client};
        ++descriptor_count;
      }
    }
    for (std::size_t slot = 0; slot < pending_connections.size(); ++slot) {
      auto& pending = std::span(pending_connections).subspan(slot, 1).front();
      if (!pending.active()) {
        continue;
      }
      const auto events =
          static_cast<short>(pending.state == PendingState::flush_response ? POLLOUT : POLLIN);
      std::span(descriptors).subspan(descriptor_count, 1).front() = {
          .fd = pending.descriptor, .events = events, .revents = 0};
      std::span(owners).subspan(descriptor_count, 1).front() = {
          .pending = &pending, .pending_slot = slot, .kind = DescriptorKind::pending};
      ++descriptor_count;
    }
    if (extensions.descriptor() >= 0) {
      std::span(descriptors).subspan(descriptor_count, 1).front() = {
          .fd = extensions.descriptor(), .events = POLLIN, .revents = 0};
      std::span(owners).subspan(descriptor_count, 1).front() = {.kind = DescriptorKind::extension};
      ++descriptor_count;
    }

    const auto poll_result = ::poll(descriptors.data(), static_cast<nfds_t>(descriptor_count),
                                    poll_timeout(workspaces, pending_connections, extensions));
    if (poll_result < 0) {
      if (errno == EINTR) {
        continue;
      }
      return 1;
    }

    // Drain every ready PTY before handling client input, then remove exited panes so input is
    // always routed to a live focused pane selected by close_pane.
    for (std::size_t index = 1; index < descriptor_count; ++index) {
      const auto owner = std::span(owners).subspan(index, 1).front();
      if (owner.kind == DescriptorKind::pane) {
        const auto& events = std::span(descriptors).subspan(index, 1).front();
        process_pane_events(*owner.workspace, *owner.window, *owner.pane, events);
      }
    }
    for (auto& workspace : workspaces) {
      if (workspace != nullptr && workspace->active) {
        reclaim_dead_panes(*workspace);
      }
    }
    for (std::size_t index = 1; index < descriptor_count; ++index) {
      const auto owner = std::span(owners).subspan(index, 1).front();
      if (owner.kind == DescriptorKind::client && owner.workspace->active) {
        const auto& events = std::span(descriptors).subspan(index, 1).front();
        process_client_events(*owner.workspace, events);
      }
    }
    for (std::size_t index = 1; index < descriptor_count; ++index) {
      const auto owner = std::span(owners).subspan(index, 1).front();
      if (owner.kind != DescriptorKind::pending || !owner.pending->active()) {
        continue;
      }
      const auto events = std::span(descriptors).subspan(index, 1).front().revents;
      if (owner.pending->state != PendingState::flush_response &&
          (events & (POLLIN | POLLHUP | POLLERR)) != 0) {
        process_pending_read(*owner.pending, workspaces, extensions, owner.pending_slot);
      }
    }

    // Writes are attempted only from retained queue bytes and are bounded both per pane and across
    // this turn. A hard descriptor error retires the pane; EAGAIN leaves all bytes queued.
    std::size_t pty_write_budget = std::size_t{1} * 1'024U * 1'024U;
    std::array<Pane*, static_cast<std::size_t>(limits::panes_hard_max)> writable_panes{};
    std::size_t writable_pane_count = 0;
    for (auto& workspace : workspaces) {
      if (workspace == nullptr || !workspace->active) {
        continue;
      }
      for (auto& window_slot : workspace->windows) {
        if (window_slot.window == nullptr) {
          continue;
        }
        for (auto& pane : window_slot.window->panes) {
          if (pane != nullptr && pane->active && !pane->pending_writes.empty()) {
            std::span(writable_panes).subspan(writable_pane_count, 1).front() = pane.get();
            ++writable_pane_count;
          }
        }
      }
    }
    if (writable_pane_count > 0) {
      pty_flush_cursor %= writable_pane_count;
      std::size_t visited = 0;
      for (; visited < writable_pane_count && pty_write_budget > 0; ++visited) {
        const auto index = (pty_flush_cursor + visited) % writable_pane_count;
        auto& pane = *std::span(writable_panes).subspan(index, 1).front();
        if (!flush_pane_writes(pane, pty_write_budget)) {
          pane.active = false;
        }
      }
      pty_flush_cursor = (pty_flush_cursor + visited) % writable_pane_count;
    } else {
      pty_flush_cursor = 0;
    }
    for (auto& workspace : workspaces) {
      if (workspace != nullptr && workspace->active) {
        reclaim_dead_panes(*workspace);
      }
    }
    // Capacity may have become available without new client socket readiness.
    const pollfd no_events{.fd = -1, .events = 0, .revents = 0};
    for (auto& workspace : workspaces) {
      if (workspace != nullptr && workspace->active && workspace->client >= 0 &&
          workspace->input_backpressured) {
        process_client_events(*workspace, no_events);
      }
    }

    queue_due_frames(workspaces);
    for (auto& workspace : workspaces) {
      if (workspace != nullptr && workspace->active && workspace->client >= 0 &&
          workspace->output.busy() &&
          !flush_frame(workspace->client, *workspace->frame, workspace->output)) {
        workspace->detach_client();
      }
    }

    std::size_t pending_output_budget = std::size_t{256} * 1'024U;
    for (std::size_t index = 1; index < descriptor_count; ++index) {
      const auto owner = std::span(owners).subspan(index, 1).front();
      if (owner.kind != DescriptorKind::pending || !owner.pending->active() ||
          owner.pending->state != PendingState::flush_response) {
        continue;
      }
      const auto events = std::span(descriptors).subspan(index, 1).front().revents;
      if ((events & (POLLOUT | POLLHUP | POLLERR)) != 0) {
        flush_pending_output(*owner.pending, owner.pending_slot, pending_output_budget);
      }
    }
    expire_pending_connections(pending_connections);
    reclaim_inactive_workspaces(workspaces);

    // Extension work is deliberately last: the reactor never waits for Lua before PTY progress,
    // client input, queued writes, or due frame composition.
    for (std::size_t index = 1; index < descriptor_count; ++index) {
      const auto owner = std::span(owners).subspan(index, 1).front();
      if (owner.kind == DescriptorKind::extension) {
        extensions.process(std::span(descriptors).subspan(index, 1).front().revents);
      }
    }

    if ((descriptors.front().revents & POLLIN) != 0) {
      accept_pending_connections(listener, pending_connections);
    }
    reclaim_inactive_workspaces(workspaces);
  }
}

} // namespace

[[nodiscard]] auto run_server(const int listener, const EndpointRelease release_endpoint,
                              void* const release_context, const ExtensionAcquire acquire_extension,
                              void* const extension_context,
                              const ExtensionErrorReporter report_extension_error,
                              void* const extension_error_context,
                              const StopRequested stop_requested) noexcept -> int {
  return run_server_impl(listener, release_endpoint, release_context, acquire_extension,
                         extension_context, report_extension_error, extension_error_context,
                         stop_requested);
}

} // namespace lemma::core
