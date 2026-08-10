#include "core/engine.hpp"

#include "core/connection_output.hpp"
#include "core/extension_runtime.hpp"
#include "core/frame_scheduler.hpp"
#include "core/input.hpp"
#include "core/pty_writer.hpp"
#include "diagnostic/latency_trace.hpp"
#include "lemma/command.hpp"
#include "lemma/generational_store.hpp"
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
constexpr auto command_create_with_context =
    protocol::wire_byte(protocol::ControlCommand::create_with_context);
constexpr auto command_list = protocol::wire_byte(protocol::ControlCommand::list);
constexpr auto command_list_session = protocol::wire_byte(protocol::ControlCommand::list_session);
constexpr auto command_list_tabs = protocol::wire_byte(protocol::ControlCommand::list_tabs);
constexpr auto command_kill = protocol::wire_byte(protocol::ControlCommand::kill);
constexpr auto command_kill_all = protocol::wire_byte(protocol::ControlCommand::kill_all);
constexpr auto command_shutdown = protocol::wire_byte(protocol::ControlCommand::shutdown);
constexpr auto response_ready = protocol::wire_byte(protocol::ControlResponse::ready);
constexpr auto response_busy = protocol::wire_byte(protocol::ControlResponse::busy);
constexpr auto response_missing = protocol::wire_byte(protocol::ControlResponse::missing);
constexpr auto response_capacity = protocol::wire_byte(protocol::ControlResponse::capacity);
constexpr auto response_failed = protocol::wire_byte(protocol::ControlResponse::failed);
constexpr std::size_t panes_per_session_max =
    static_cast<std::size_t>(limits::panes_hard_max / limits::sessions_hard_max);
constexpr std::size_t tabs_per_session_max =
    static_cast<std::size_t>(limits::tabs_hard_max / limits::sessions_hard_max);
constexpr std::size_t panes_per_tab_max = panes_per_session_max;
constexpr std::size_t layout_nodes_per_tab_max = (panes_per_tab_max * 2U) - 1U;
constexpr std::size_t process_name_bytes_max = 64;
constexpr std::size_t command_trace_entries_max = 256;
static_assert(panes_per_session_max > 0);
static_assert(tabs_per_session_max > 0);
static_assert(tabs_per_session_max <= render::status_tabs_max);
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
  bool render_damage{false};
  bool damage_capture_failed{false};
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  std::uint64_t correlation{0};
#endif
};

[[nodiscard]] auto
trace_pty_output([[maybe_unused]] PtyDrainResult& drain,
                 [[maybe_unused]] diagnostic::LatencyTraceMarkerMatcher* const trace_matcher,
                 [[maybe_unused]] const std::span<const std::byte> bytes) noexcept
    -> std::uint64_t {
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  LEMMA_ASSERT(trace_matcher != nullptr);
  const auto correlation = trace_matcher->observe(bytes);
  if (correlation != 0) {
    drain.correlation = correlation;
  }
  return correlation;
#else
  return 0;
#endif
}

void write_pty_output(vt::Terminal& terminal, const std::span<const std::byte> bytes,
                      bool& capture_damage, PtyDrainResult& drain) noexcept {
  if (!capture_damage) {
    terminal.write(bytes);
    return;
  }
  const auto damage = terminal.write_and_report_damage(bytes);
  if (!damage.has_value()) {
    drain.damage_capture_failed = true;
    capture_damage = false;
    return;
  }
  if (*damage != vt::DirtyState::clean) {
    drain.render_damage = true;
    capture_damage = false;
  }
}

[[nodiscard]] auto
process_pty_output(const int pty, vt::Terminal& terminal, PanePtyWriteQueue& pending_writes,
                   const std::span<const std::byte> bytes, bool& capture_damage,
                   PtyDrainResult& drain,
                   diagnostic::LatencyTraceMarkerMatcher* const trace_matcher) noexcept -> bool {
  const auto trace_correlation = trace_pty_output(drain, trace_matcher, bytes);
  diagnostic::record_latency_trace(diagnostic::LatencyTraceStage::daemon_pty_output_read,
                                   static_cast<std::uint32_t>(pty), bytes.size(),
                                   trace_correlation);
  write_pty_output(terminal, bytes, capture_damage, drain);
  drain.changed = true;
  return queue_terminal_responses(pending_writes, terminal);
}

[[nodiscard]] auto
drain_pty(const int pty, vt::Terminal& terminal, PanePtyWriteQueue& pending_writes,
          std::size_t& global_budget, const bool capture_interactive_damage,
          [[maybe_unused]] diagnostic::LatencyTraceMarkerMatcher* const trace_matcher) noexcept
    -> PtyDrainResult {
  constexpr std::size_t reads_per_turn_max = 4;
  std::array<std::byte, std::size_t{64} * 1'024U> output{};
  PtyDrainResult drain{};
  bool capture_damage = capture_interactive_damage;
  for (std::size_t read_count = 0; read_count < reads_per_turn_max && global_budget > 0;
       ++read_count) {
    const auto available = std::min(output.size(), global_budget);
    const auto bytes_read = ::read(pty, output.data(), available);
    if (bytes_read > 0) {
      const auto size = static_cast<std::size_t>(bytes_read);
      global_budget -= size;
      const auto bytes = std::span(output).first(size);
      if (!process_pty_output(pty, terminal, pending_writes, bytes, capture_damage, drain,
                              trace_matcher)) {
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

struct WorkingDirectory final {
  std::array<char, protocol::working_directory_bytes_max + 1U> bytes{};
  std::size_t size{0};

  [[nodiscard]] auto view() const noexcept -> std::string_view { return {bytes.data(), size}; }
};

struct SessionName final {
  std::array<char, protocol::session_name_bytes_max> bytes{};
  std::size_t size{0};

  [[nodiscard]] auto view() const noexcept -> std::string_view { return {bytes.data(), size}; }
};

// Environment framing validation is exhaustive and bounded by entry/payload limits.
[[nodiscard]] auto valid_environment(const std::span<const std::byte> environment) noexcept
    -> bool {
  if (environment.empty()) {
    return true;
  }
  std::size_t offset = 0;
  std::size_t entries = 0;
  while (offset < environment.size()) {
    const auto remaining = environment.subspan(offset);
    const auto terminator = std::ranges::find(remaining, std::byte{0});
    if (terminator == remaining.end()) {
      return false;
    }
    const auto entry_size = static_cast<std::size_t>(std::distance(remaining.begin(), terminator));
    const auto entry = remaining.first(entry_size);
    const auto separator = std::ranges::find(entry, std::byte{'='});
    if (separator == entry.begin() || separator == entry.end()) {
      return false;
    }
    ++entries;
    if (entries > protocol::environment_entries_max) {
      return false;
    }
    offset += entry_size + 1U;
  }
  return true;
}

[[nodiscard]] constexpr auto valid_session_name(const std::string_view session) noexcept -> bool {
  if (session.empty() || session.size() > protocol::session_name_bytes_max) {
    return false;
  }
  return std::ranges::all_of(session, [](const char character) {
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

  PaneId id;
  vt::Terminal terminal;
  render::PaneRectangle rectangle{};
  int pty{-1};
  pid_t child{-1};
  std::array<char, process_name_bytes_max> process_name{};
  std::size_t process_name_size{0};
  PanePtyWriteQueue pending_writes;
  InteractiveDamageLatch interactive_damage;
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  diagnostic::LatencyTraceMarkerMatcher input_trace_matcher;
  diagnostic::LatencyTraceMarkerMatcher output_trace_matcher;
#endif
  bool active{true};
};

enum class SplitAxis : std::uint8_t {
  left_right,
  top_bottom,
};

struct PaneSlot final {
  std::unique_ptr<Pane> pane;
  std::uint32_t generation{0};
};

struct LayoutNode final {
  bool active{false};
  bool leaf{true};
  PaneId pane;
  std::int16_t parent{-1};
  std::int16_t first{-1};
  std::int16_t second{-1};
  SplitAxis axis{SplitAxis::left_right};
};

struct Tab final {
  Tab(const TabId assigned_id, std::unique_ptr<Pane> first_pane) noexcept : id(assigned_id) {
    const auto first_id = PaneId::from_parts(0, 1);
    first_pane->id = first_id;
    panes.front() = {.pane = std::move(first_pane), .generation = first_id.generation()};
    layout.front() = {.active = true, .leaf = true, .pane = first_id};
    focused_pane = first_id;
    previous_pane = first_id;
  }

  Tab(const Tab&) = delete;
  auto operator=(const Tab&) -> Tab& = delete;
  Tab(Tab&&) = delete;
  auto operator=(Tab&&) -> Tab& = delete;
  ~Tab() = default;

  TabId id;
  std::array<PaneSlot, panes_per_tab_max> panes{};
  std::array<LayoutNode, layout_nodes_per_tab_max> layout{};
  // Inactive tabs retain their last usable geometry while continuing to process PTY output.
  std::uint16_t layout_columns{80};
  std::uint16_t layout_rows{24};
  PaneId focused_pane;
  PaneId previous_pane;
  bool zoomed{false};
  bool layout_suspended{false};
};

struct TabSlot final {
  std::unique_ptr<Tab> tab;
  std::uint32_t generation{0};
};

struct Session final {
  Session(const std::string_view session_name, const std::string_view initial_working_directory,
          const std::span<const std::byte> initial_environment,
          const platform::EnvironmentMode initial_environment_mode,
          std::unique_ptr<FrameBuffer> created_frame) noexcept
      : name_size(session_name.size()), working_directory_size(initial_working_directory.size()),
        environment_size(initial_environment.size()), environment_mode(initial_environment_mode),
        frame(std::move(created_frame)) {
    std::memcpy(name.data(), session_name.data(), session_name.size());
    if (!initial_working_directory.empty()) {
      std::memcpy(working_directory.data(), initial_working_directory.data(),
                  initial_working_directory.size());
    }
    std::ranges::copy(initial_environment, environment.begin());
  }

  Session(const Session&) = delete;
  auto operator=(const Session&) -> Session& = delete;
  Session(Session&&) = delete;
  auto operator=(Session&&) -> Session& = delete;

  ~Session() { close_descriptor(client); }

  [[nodiscard]] auto session_name() const noexcept -> std::string_view {
    return {name.data(), name_size};
  }

  [[nodiscard]] auto cwd() const noexcept -> std::string_view {
    return {working_directory.data(), working_directory_size};
  }

  [[nodiscard]] auto launch_environment() const noexcept -> std::span<const std::byte> {
    return std::span(environment).first(environment_size);
  }

  void detach_client() noexcept {
    close_descriptor(client);
    client_id = {};
    decoder.reset();
    output.reset();
    frame_scheduler.cancel();
    input_backpressured = false;
    for (auto& tab_slot : tabs) {
      if (tab_slot.tab != nullptr) {
        for (auto& pane_slot : tab_slot.tab->panes) {
          if (pane_slot.pane != nullptr) {
            pane_slot.pane->interactive_damage.reset();
          }
        }
      }
    }
#ifdef LEMMA_ENABLE_LATENCY_TRACE
    decoded_input_trace_matcher.reset();
    frame_trace_correlation = 0;
#endif
  }

  SessionId id;
  std::array<char, protocol::session_name_bytes_max> name{};
  std::size_t name_size{0};
  std::array<char, protocol::working_directory_bytes_max + 1U> working_directory{};
  std::size_t working_directory_size{0};
  std::array<std::byte, protocol::environment_bytes_max> environment{};
  std::size_t environment_size{0};
  platform::EnvironmentMode environment_mode{platform::EnvironmentMode::inherit};
  std::unique_ptr<FrameBuffer> frame;
  std::array<TabSlot, tabs_per_session_max> tabs{};
  TabId active_tab;
  TabId previous_tab;
  protocol::ClientDecoder decoder;
  ClientOutputState output;
  int client{-1};
  ClientId client_id;
  std::uint32_t client_generation{0};
  std::uint32_t pending_attach_slot{std::numeric_limits<std::uint32_t>::max()};
  std::uint32_t pending_attach_generation{0};
  std::uint16_t columns{80};
  std::uint16_t rows{24};
  bool active{true};
  bool status_valid{false};
  bool input_backpressured{false};
  std::uint64_t status_signature{0};
  std::array<CommandTraceEntry, command_trace_entries_max> command_trace{};
  std::uint64_t command_sequence{0};
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  diagnostic::LatencyTraceMarkerMatcher decoded_input_trace_matcher;
  std::uint64_t frame_trace_correlation{0};
#endif
  FrameScheduler frame_scheduler;
};

[[nodiscard]] constexpr auto pane_rows(const std::uint16_t viewport_rows) noexcept
    -> std::uint16_t {
  return viewport_rows >= 2 ? static_cast<std::uint16_t>(viewport_rows - 1U) : viewport_rows;
}

[[nodiscard]] auto create_pane(const std::uint16_t columns, const std::uint16_t rows,
                               const std::string_view working_directory,
                               const std::span<const std::byte> environment,
                               const platform::EnvironmentMode environment_mode) noexcept
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
  pane->child =
      platform::spawn_login_shell(pane->pty, working_directory, environment, environment_mode);
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

[[nodiscard]] auto find_pane(Tab& tab, const PaneId id) noexcept -> Pane* {
  if (!id.is_valid() || id.slot() >= tab.panes.size()) {
    return nullptr;
  }
  auto& slot = std::span(tab.panes).subspan(id.slot(), 1).front();
  return slot.generation == id.generation() ? slot.pane.get() : nullptr;
}

[[nodiscard]] auto find_pane(const Tab& tab, const PaneId id) noexcept -> const Pane* {
  if (!id.is_valid() || id.slot() >= tab.panes.size()) {
    return nullptr;
  }
  const auto& slot = std::span(tab.panes).subspan(id.slot(), 1).front();
  return slot.generation == id.generation() ? slot.pane.get() : nullptr;
}

[[nodiscard]] auto find_tab(Session& session, const TabId id) noexcept -> Tab* {
  if (!id.is_valid() || id.slot() >= session.tabs.size()) {
    return nullptr;
  }
  auto& slot = std::span(session.tabs).subspan(id.slot(), 1).front();
  return slot.generation == id.generation() ? slot.tab.get() : nullptr;
}

[[nodiscard]] auto find_tab(const Session& session, const TabId id) noexcept -> const Tab* {
  if (!id.is_valid() || id.slot() >= session.tabs.size()) {
    return nullptr;
  }
  const auto& slot = std::span(session.tabs).subspan(id.slot(), 1).front();
  return slot.generation == id.generation() ? slot.tab.get() : nullptr;
}

[[nodiscard]] auto active_tab(Session& session) noexcept -> Tab* {
  return find_tab(session, session.active_tab);
}

[[nodiscard]] auto active_tab(const Session& session) noexcept -> const Tab* {
  return find_tab(session, session.active_tab);
}

[[nodiscard]] auto pane_count(const Tab& tab) noexcept -> std::size_t {
  return static_cast<std::size_t>(
      std::ranges::count_if(tab.panes, [](const PaneSlot& slot) { return slot.pane != nullptr; }));
}

[[nodiscard]] auto pane_count(const Session& session) noexcept -> std::size_t {
  std::size_t count = 0;
  for (const auto& slot : session.tabs) {
    if (slot.tab != nullptr) {
      count += pane_count(*slot.tab);
    }
  }
  return count;
}

[[nodiscard]] auto tab_count(const Session& session) noexcept -> std::size_t {
  return static_cast<std::size_t>(
      std::ranges::count_if(session.tabs, [](const TabSlot& slot) { return slot.tab != nullptr; }));
}

[[nodiscard]] auto allocate_tab(Session& session) noexcept -> Tab* {
  if (pane_count(session) >= panes_per_session_max) {
    return nullptr;
  }
  for (std::size_t index = 0; index < session.tabs.size(); ++index) {
    auto& slot = std::span(session.tabs).subspan(index, 1).front();
    if (slot.tab != nullptr) {
      continue;
    }
    auto first_pane = create_pane(session.columns, pane_rows(session.rows), session.cwd(),
                                  session.launch_environment(), session.environment_mode);
    if (first_pane == nullptr) {
      return nullptr;
    }
    const auto generation = next_generation(slot.generation);
    const auto id = TabId::from_parts(static_cast<std::uint32_t>(index), generation);
    auto created = std::unique_ptr<Tab>(new (std::nothrow) Tab(id, std::move(first_pane)));
    if (created == nullptr) {
      return nullptr;
    }
    created->layout_columns = session.columns;
    created->layout_rows = pane_rows(session.rows);
    slot.generation = generation;
    slot.tab = std::move(created);
    session.previous_tab = session.active_tab;
    session.active_tab = id;
    return slot.tab.get();
  }
  return nullptr;
}

[[nodiscard]] auto create_session(
    const std::string_view name, const std::string_view working_directory = {},
    const std::span<const std::byte> environment = {},
    const platform::EnvironmentMode environment_mode = platform::EnvironmentMode::inherit) noexcept
    -> std::unique_ptr<Session> {
  auto frame = std::unique_ptr<FrameBuffer>(new (std::nothrow) FrameBuffer{});
  if (frame == nullptr) {
    return nullptr;
  }
  auto session = std::unique_ptr<Session>(new (std::nothrow) Session(
      name, working_directory, environment, environment_mode, std::move(frame)));
  if (session == nullptr || allocate_tab(*session) == nullptr) {
    return nullptr;
  }
  session->previous_tab = session->active_tab;
  return session;
}

[[nodiscard]] auto empty_pane_slot(Tab& tab) noexcept -> std::optional<std::size_t> {
  for (std::size_t index = 0; index < tab.panes.size(); ++index) {
    if (std::span(tab.panes).subspan(index, 1).front().pane == nullptr) {
      return index;
    }
  }
  return std::nullopt;
}

[[nodiscard]] auto empty_layout_node(Tab& tab) noexcept -> std::optional<std::size_t> {
  for (std::size_t index = 0; index < tab.layout.size(); ++index) {
    if (!std::span(tab.layout).subspan(index, 1).front().active) {
      return index;
    }
  }
  return std::nullopt;
}

[[nodiscard]] auto node_for_pane(const Tab& tab, const PaneId pane) noexcept
    -> std::optional<std::size_t> {
  for (std::size_t index = 0; index < tab.layout.size(); ++index) {
    const auto& node = std::span(tab.layout).subspan(index, 1).front();
    if (node.active && node.leaf && node.pane == pane) {
      return index;
    }
  }
  return std::nullopt;
}

[[nodiscard]] auto first_leaf(const Tab& tab, std::size_t node_index) noexcept -> PaneId {
  for (std::size_t depth = 0; depth < limits::layout_depth_hard_max; ++depth) {
    const auto& node = std::span(tab.layout).subspan(node_index, 1).front();
    if (node.leaf) {
      return node.pane;
    }
    node_index = static_cast<std::size_t>(node.first);
  }
  return tab.focused_pane;
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

[[nodiscard]] auto layout_fits_node(const Tab& tab, const std::size_t node_index,
                                    const render::PaneRectangle rectangle,
                                    const std::size_t depth) noexcept -> bool {
  if (depth >= limits::layout_depth_hard_max) {
    return false;
  }
  const auto& node = std::span(tab.layout).subspan(node_index, 1).front();
  if (!node.active) {
    return false;
  }
  if (node.leaf) {
    return find_pane(tab, node.pane) != nullptr;
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
  return layout_fits_node(tab, static_cast<std::size_t>(node.first), first_rectangle, depth + 1U) &&
         layout_fits_node(tab, static_cast<std::size_t>(node.second), second_rectangle, depth + 1U);
}

using PaneRectangles = std::array<render::PaneRectangle, panes_per_tab_max>;

[[nodiscard]] auto collect_layout_rectangles(const Tab& tab, const std::size_t node_index,
                                             const render::PaneRectangle rectangle,
                                             const std::size_t depth,
                                             PaneRectangles& rectangles) noexcept -> bool {
  if (depth >= limits::layout_depth_hard_max) {
    return false;
  }
  const auto& node = std::span(tab.layout).subspan(node_index, 1).front();
  if (!node.active) {
    return false;
  }
  if (node.leaf) {
    if (find_pane(tab, node.pane) == nullptr) {
      return false;
    }
    std::span(rectangles).subspan(node.pane.slot(), 1).front() = rectangle;
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
  return collect_layout_rectangles(tab, static_cast<std::size_t>(node.first), first_rectangle,
                                   depth + 1U, rectangles) &&
         collect_layout_rectangles(tab, static_cast<std::size_t>(node.second), second_rectangle,
                                   depth + 1U, rectangles);
}

[[nodiscard]] auto resolve_node(Tab& tab, const std::size_t node_index,
                                const render::PaneRectangle rectangle,
                                const std::size_t depth) noexcept -> bool {
  if (depth >= limits::layout_depth_hard_max) {
    return false;
  }
  const auto node = std::span(tab.layout).subspan(node_index, 1).front();
  if (!node.active) {
    return false;
  }
  if (node.leaf) {
    auto* const pane = find_pane(tab, node.pane);
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
  return resolve_node(tab, static_cast<std::size_t>(node.first), first_rectangle, depth + 1U) &&
         resolve_node(tab, static_cast<std::size_t>(node.second), second_rectangle, depth + 1U);
}

[[nodiscard]] auto resolve_layout(Tab& tab) noexcept -> bool {
  const render::PaneRectangle viewport{
      .columns = tab.layout_columns,
      .rows = tab.layout_rows,
  };
  if (tab.zoomed) {
    auto* const focused = find_pane(tab, tab.focused_pane);
    return focused != nullptr && resize_pane(*focused, viewport);
  }
  return resolve_node(tab, 0, viewport, 0);
}

[[nodiscard]] auto resolve_session_layout(Session& session, Tab& tab) noexcept -> bool {
  // PTY resizing is not transactional: retire the session rather than continue after a partial
  // geometry update.
  const bool resolved = resolve_layout(tab);
  session.active = session.active && resolved;
  return resolved;
}

[[nodiscard]] auto frame_sink_state(const Session& session) noexcept -> FrameSinkState {
  if (session.client < 0) {
    return FrameSinkState::unavailable;
  }
  return session.output.busy() ? FrameSinkState::blocked : FrameSinkState::ready;
}

void schedule_frame(Session& session, const FrameUrgency urgency, const bool force_full) noexcept {
  session.frame_scheduler.request(urgency, force_full, std::chrono::steady_clock::now(),
                                  frame_sink_state(session));
}

[[nodiscard]] auto fit_tab_to_viewport(Session& session, Tab& tab) noexcept -> bool {
  const render::PaneRectangle viewport{
      .columns = session.columns,
      .rows = pane_rows(session.rows),
  };
  if (!layout_fits_node(tab, 0, viewport, 0)) {
    tab.layout_suspended = true;
    return true;
  }
  tab.layout_suspended = false;
  tab.layout_columns = viewport.columns;
  tab.layout_rows = viewport.rows;
  return resolve_session_layout(session, tab);
}

[[nodiscard]] auto select_tab(Session& session, const TabId id) noexcept -> bool {
  auto* const selected = find_tab(session, id);
  if (selected == nullptr) {
    return false;
  }
  if (session.active_tab == id) {
    return true;
  }
  session.previous_tab = session.active_tab;
  session.active_tab = id;
  session.output.reset();
  if (!fit_tab_to_viewport(session, *selected)) {
    session.active = false;
    return false;
  }
  schedule_frame(session, FrameUrgency::state_change, true);
  return true;
}

void cycle_tab(Session& session, const bool forward) noexcept {
  const auto current = static_cast<std::size_t>(session.active_tab.slot());
  for (std::size_t offset = 1; offset <= session.tabs.size(); ++offset) {
    const auto candidate = forward
                               ? (current + offset) % session.tabs.size()
                               : (current + session.tabs.size() - (offset % session.tabs.size())) %
                                     session.tabs.size();
    const auto& slot = std::span(session.tabs).subspan(candidate, 1).front();
    if (slot.tab != nullptr) {
      static_cast<void>(select_tab(session, slot.tab->id));
      return;
    }
  }
}

void remove_tab(Session& session, const TabId id) noexcept {
  auto* const tab = find_tab(session, id);
  if (tab == nullptr) {
    return;
  }
  const auto removed_slot = static_cast<std::size_t>(id.slot());
  std::span(session.tabs).subspan(removed_slot, 1).front().tab.reset();
  if (tab_count(session) == 0) {
    session.active = false;
    return;
  }
  if (session.active_tab != id) {
    schedule_frame(session, FrameUrgency::state_change, false);
    return;
  }
  for (std::size_t offset = 1; offset <= session.tabs.size(); ++offset) {
    const auto candidate = (removed_slot + offset) % session.tabs.size();
    const auto& slot = std::span(session.tabs).subspan(candidate, 1).front();
    if (slot.tab != nullptr) {
      session.active_tab = slot.tab->id;
      session.previous_tab = session.active_tab;
      session.output.reset();
      if (!fit_tab_to_viewport(session, *slot.tab)) {
        session.active = false;
        return;
      }
      schedule_frame(session, FrameUrgency::state_change, true);
      return;
    }
  }
}

void create_tab(Session& session) noexcept {
  auto* const created = allocate_tab(session);
  if (created == nullptr) {
    return;
  }
  session.output.reset();
  if (!fit_tab_to_viewport(session, *created)) {
    session.active = false;
    return;
  }
  schedule_frame(session, FrameUrgency::state_change, true);
}

// Splitting is an explicit bounded topology transaction.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto split_pane(Session& session, Tab& tab, const PaneId source_pane,
                              const SplitAxis axis) noexcept -> bool {
  if (pane_count(session) >= panes_per_session_max) {
    return false;
  }
  const auto* const source = find_pane(tab, source_pane);
  if (source == nullptr) {
    return false;
  }
  auto source_rectangle = source->rectangle;
  if (tab.zoomed) {
    PaneRectangles rectangles{};
    const render::PaneRectangle viewport{
        .columns = tab.layout_columns,
        .rows = tab.layout_rows,
    };
    if (!collect_layout_rectangles(tab, 0, viewport, 0, rectangles)) {
      return false;
    }
    source_rectangle = std::span(rectangles).subspan(source_pane.slot(), 1).front();
  }
  if ((axis == SplitAxis::left_right && source_rectangle.columns < 3) ||
      (axis == SplitAxis::top_bottom && source_rectangle.rows < 3)) {
    return false;
  }
  const auto pane_slot = empty_pane_slot(tab);
  const auto parent_node = node_for_pane(tab, source_pane);
  if (!pane_slot.has_value() || !parent_node.has_value()) {
    return false;
  }
  std::size_t layout_depth = 0;
  auto ancestor = std::span(tab.layout).subspan(*parent_node, 1).front().parent;
  while (ancestor >= 0) {
    ++layout_depth;
    ancestor = std::span(tab.layout).subspan(static_cast<std::size_t>(ancestor), 1).front().parent;
  }
  if (layout_depth + 1U >= limits::layout_depth_hard_max) {
    return false;
  }
  const auto first_node = empty_layout_node(tab);
  if (!first_node.has_value()) {
    return false;
  }
  std::span(tab.layout).subspan(*first_node, 1).front().active = true;
  const auto second_node = empty_layout_node(tab);
  std::span(tab.layout).subspan(*first_node, 1).front().active = false;
  if (!second_node.has_value()) {
    return false;
  }

  auto new_columns = source_rectangle.columns;
  auto new_rows = source_rectangle.rows;
  if (axis == SplitAxis::left_right) {
    const auto available = static_cast<std::uint16_t>(new_columns - 1U);
    new_columns = static_cast<std::uint16_t>(available - ((available + 1U) / 2U));
  } else {
    const auto available = static_cast<std::uint16_t>(new_rows - 1U);
    new_rows = static_cast<std::uint16_t>(available - ((available + 1U) / 2U));
  }
  auto created = create_pane(new_columns, new_rows, session.cwd(), session.launch_environment(),
                             session.environment_mode);
  if (created == nullptr) {
    return false;
  }
  auto& pane_slot_value = std::span(tab.panes).subspan(*pane_slot, 1).front();
  const auto pane_generation = next_generation(pane_slot_value.generation);
  const auto pane_id = PaneId::from_parts(static_cast<std::uint32_t>(*pane_slot), pane_generation);
  created->id = pane_id;

  auto& parent = std::span(tab.layout).subspan(*parent_node, 1).front();
  const auto parent_parent = parent.parent;
  parent = {
      .active = true,
      .leaf = false,
      .pane = {},
      .parent = parent_parent,
      .first = static_cast<std::int16_t>(*first_node),
      .second = static_cast<std::int16_t>(*second_node),
      .axis = axis,
  };
  std::span(tab.layout).subspan(*first_node, 1).front() = {
      .active = true,
      .leaf = true,
      .pane = source_pane,
      .parent = static_cast<std::int16_t>(*parent_node),
  };
  std::span(tab.layout).subspan(*second_node, 1).front() = {
      .active = true,
      .leaf = true,
      .pane = pane_id,
      .parent = static_cast<std::int16_t>(*parent_node),
  };
  pane_slot_value.generation = pane_generation;
  pane_slot_value.pane = std::move(created);
  tab.zoomed = false;
  tab.previous_pane = source_pane;
  tab.focused_pane = pane_id;
  if (!resolve_session_layout(session, tab)) {
    return false;
  }
  schedule_frame(session, FrameUrgency::state_change, true);
  return true;
}

[[nodiscard]] auto close_pane(Session& session, Tab& tab, const PaneId pane_id) noexcept -> bool {
  auto* const pane = find_pane(tab, pane_id);
  if (pane == nullptr) {
    return false;
  }
  const auto pane_index = static_cast<std::size_t>(pane_id.slot());
  const bool was_focused = pane_id == tab.focused_pane;
  if (pane_count(tab) == 1) {
    const auto id = tab.id;
    remove_tab(session, id);
    return true;
  }
  const auto leaf_index = node_for_pane(tab, pane_id);
  if (!leaf_index.has_value()) {
    return false;
  }
  const auto leaf = std::span(tab.layout).subspan(*leaf_index, 1).front();
  if (leaf.parent < 0) {
    return false;
  }
  const auto parent_index = static_cast<std::size_t>(leaf.parent);
  const auto parent = std::span(tab.layout).subspan(parent_index, 1).front();
  const auto sibling_index = static_cast<std::size_t>(
      parent.first == static_cast<std::int16_t>(*leaf_index) ? parent.second : parent.first);
  auto replacement = std::span(tab.layout).subspan(sibling_index, 1).front();
  replacement.parent = parent.parent;
  std::span(tab.layout).subspan(parent_index, 1).front() = replacement;
  if (!replacement.leaf) {
    std::span(tab.layout).subspan(static_cast<std::size_t>(replacement.first), 1).front().parent =
        static_cast<std::int16_t>(parent_index);
    std::span(tab.layout).subspan(static_cast<std::size_t>(replacement.second), 1).front().parent =
        static_cast<std::int16_t>(parent_index);
  }
  std::span(tab.layout).subspan(*leaf_index, 1).front() = {};
  std::span(tab.layout).subspan(sibling_index, 1).front() = {};
  std::span(tab.panes).subspan(pane_index, 1).front().pane.reset();
  if (was_focused) {
    tab.focused_pane = first_leaf(tab, parent_index);
  }
  if (tab.previous_pane == pane_id || find_pane(tab, tab.previous_pane) == nullptr) {
    tab.previous_pane = tab.focused_pane;
  }
  tab.zoomed = false;
  if (!resolve_session_layout(session, tab)) {
    return false;
  }
  schedule_frame(session, FrameUrgency::state_change, true);
  return true;
}

void focus_pane(Session& session, Tab& tab, const PaneId pane_id) noexcept {
  if (pane_id == tab.focused_pane || find_pane(tab, pane_id) == nullptr) {
    return;
  }
  tab.previous_pane = tab.focused_pane;
  tab.focused_pane = pane_id;
  if (tab.zoomed && !resolve_session_layout(session, tab)) {
    return;
  }
  schedule_frame(session, FrameUrgency::state_change, tab.zoomed);
}

void focus_next(Session& session, Tab& tab, const PaneId source_pane) noexcept {
  const auto pane_slots = std::span(tab.panes);
  for (std::size_t offset = 1; offset <= pane_slots.size(); ++offset) {
    const auto candidate =
        (static_cast<std::size_t>(source_pane.slot()) + offset) % pane_slots.size();
    // candidate is reduced modulo pane capacity.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-constant-array-index,cppcoreguidelines-pro-bounds-avoid-unchecked-container-access)
    const auto& pane = tab.panes[candidate].pane;
    if (pane != nullptr) {
      focus_pane(session, tab, pane->id);
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
void focus_direction(Session& session, Tab& tab, const PaneId source_pane,
                     const FocusDirection direction) noexcept {
  // Zoom resizes focused panes to the viewport, so derive stable tiled geometry from the tree.
  PaneRectangles rectangles{};
  const render::PaneRectangle viewport{
      .columns = tab.layout_columns,
      .rows = tab.layout_rows,
  };
  if (!collect_layout_rectangles(tab, 0, viewport, 0, rectangles)) {
    return;
  }

  const auto& current = std::span(rectangles).subspan(source_pane.slot(), 1).front();
  const auto current_right = static_cast<std::uint32_t>(current.column) + current.columns;
  const auto current_bottom = static_cast<std::uint32_t>(current.row) + current.rows;
  const auto current_x = (static_cast<std::uint32_t>(current.column) * 2U) + current.columns;
  const auto current_y = (static_cast<std::uint32_t>(current.row) * 2U) + current.rows;
  std::uint64_t best_score = std::numeric_limits<std::uint64_t>::max();
  std::optional<PaneId> best;
  const auto pane_slots = std::span(tab.panes);
  for (std::size_t index = 0; index < pane_slots.size(); ++index) {
    // The loop bounds index by pane capacity.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-constant-array-index,cppcoreguidelines-pro-bounds-avoid-unchecked-container-access)
    const auto& candidate = tab.panes[index].pane;
    if (candidate == nullptr || candidate->id == source_pane) {
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
      best = candidate->id;
    }
  }
  if (best.has_value()) {
    focus_pane(session, tab, *best);
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
  case protocol::PaneCommand::create_tab:
    command.kind = CommandKind::create_tab;
    break;
  case protocol::PaneCommand::next_tab:
    command.kind = CommandKind::next_tab;
    break;
  case protocol::PaneCommand::previous_tab:
    command.kind = CommandKind::previous_tab;
    break;
  case protocol::PaneCommand::kill_tab:
    command.kind = CommandKind::close_tab;
    break;
  case protocol::PaneCommand::select_tab_0:
  case protocol::PaneCommand::select_tab_1:
  case protocol::PaneCommand::select_tab_2:
  case protocol::PaneCommand::select_tab_3:
  case protocol::PaneCommand::select_tab_4:
  case protocol::PaneCommand::select_tab_5:
  case protocol::PaneCommand::select_tab_6:
  case protocol::PaneCommand::select_tab_7:
  case protocol::PaneCommand::select_tab_8:
  case protocol::PaneCommand::select_tab_9: {
    command.kind = CommandKind::select_tab;
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
[[nodiscard]] auto execute_session_command(void* const context, const Command& command) noexcept
    -> CommandResult {
  auto& session = *static_cast<Session*>(context);
  if (command.target.session.is_valid() && command.target.session != session.id) {
    return {.status = command.target.session.slot() == session.id.slot()
                          ? CommandStatus::stale_target
                          : CommandStatus::wrong_owner};
  }
  if (command.target.client.is_valid() && command.target.client != session.client_id) {
    return {.status = command.target.client.slot() == session.id.slot()
                          ? CommandStatus::stale_target
                          : CommandStatus::wrong_owner};
  }
  if (command.kind == CommandKind::detach_client) {
    return session.client >= 0 ? CommandResult{.status = CommandStatus::detach_requested}
                               : CommandResult{.status = CommandStatus::unavailable};
  }
  if (command.kind == CommandKind::stop_session) {
    const bool changed = session.active;
    session.active = false;
    return command_status(changed);
  }

  auto* const tab =
      command.target.tab.is_valid() ? find_tab(session, command.target.tab) : active_tab(session);
  if (tab == nullptr) {
    return {.status = command.target.tab.is_valid() ? CommandStatus::stale_target
                                                    : CommandStatus::failed};
  }
  auto* const targeted_pane = command.target.pane.is_valid() ? find_pane(*tab, command.target.pane)
                                                             : find_pane(*tab, tab->focused_pane);
  if (targeted_pane == nullptr) {
    return {.status = command.target.pane.is_valid() ? CommandStatus::stale_target
                                                     : CommandStatus::failed};
  }

  const auto focus_result = [&](const PaneId previous) {
    return session.active ? command_status(tab->focused_pane != previous)
                          : CommandResult{.status = CommandStatus::failed};
  };
  switch (command.kind) {
  case CommandKind::none:
  case CommandKind::detach_client:
  case CommandKind::stop_session:
    return {.status = CommandStatus::invalid_command};
  case CommandKind::split_left_right:
    if (pane_count(session) >= panes_per_session_max) {
      return {.status = CommandStatus::capacity};
    }
    if (split_pane(session, *tab, targeted_pane->id, SplitAxis::left_right)) {
      return {.status = CommandStatus::applied};
    }
    return {.status = session.active ? CommandStatus::unavailable : CommandStatus::failed};
  case CommandKind::split_top_bottom:
    if (pane_count(session) >= panes_per_session_max) {
      return {.status = CommandStatus::capacity};
    }
    if (split_pane(session, *tab, targeted_pane->id, SplitAxis::top_bottom)) {
      return {.status = CommandStatus::applied};
    }
    return {.status = session.active ? CommandStatus::unavailable : CommandStatus::failed};
  case CommandKind::focus_left: {
    const auto previous = tab->focused_pane;
    focus_direction(session, *tab, targeted_pane->id, FocusDirection::left);
    return focus_result(previous);
  }
  case CommandKind::focus_right: {
    const auto previous = tab->focused_pane;
    focus_direction(session, *tab, targeted_pane->id, FocusDirection::right);
    return focus_result(previous);
  }
  case CommandKind::focus_up: {
    const auto previous = tab->focused_pane;
    focus_direction(session, *tab, targeted_pane->id, FocusDirection::up);
    return focus_result(previous);
  }
  case CommandKind::focus_down: {
    const auto previous = tab->focused_pane;
    focus_direction(session, *tab, targeted_pane->id, FocusDirection::down);
    return focus_result(previous);
  }
  case CommandKind::focus_next: {
    const auto previous = tab->focused_pane;
    focus_next(session, *tab, targeted_pane->id);
    return focus_result(previous);
  }
  case CommandKind::focus_previous: {
    const auto previous = tab->focused_pane;
    focus_pane(session, *tab, tab->previous_pane);
    return focus_result(previous);
  }
  case CommandKind::close_pane:
    if (close_pane(session, *tab, targeted_pane->id)) {
      return {.status = CommandStatus::applied};
    }
    return {.status = session.active ? CommandStatus::unavailable : CommandStatus::failed};
  case CommandKind::toggle_zoom:
    focus_pane(session, *tab, targeted_pane->id);
    if (!session.active) {
      return {.status = CommandStatus::failed};
    }
    tab->zoomed = !tab->zoomed;
    if (!resolve_session_layout(session, *tab)) {
      return {.status = CommandStatus::failed};
    }
    schedule_frame(session, FrameUrgency::state_change, true);
    return {.status = CommandStatus::applied};
  case CommandKind::create_tab: {
    if (tab_count(session) >= session.tabs.size() || pane_count(session) >= panes_per_session_max) {
      return {.status = CommandStatus::capacity};
    }
    const auto previous = tab_count(session);
    create_tab(session);
    if (!session.active) {
      return {.status = CommandStatus::failed};
    }
    return previous == tab_count(session) ? CommandResult{.status = CommandStatus::unavailable}
                                          : CommandResult{.status = CommandStatus::applied};
  }
  case CommandKind::next_tab: {
    const auto previous = session.active_tab;
    cycle_tab(session, true);
    return session.active ? command_status(previous != session.active_tab)
                          : CommandResult{.status = CommandStatus::failed};
  }
  case CommandKind::previous_tab: {
    const auto previous = session.active_tab;
    cycle_tab(session, false);
    return session.active ? command_status(previous != session.active_tab)
                          : CommandResult{.status = CommandStatus::failed};
  }
  case CommandKind::close_tab:
    remove_tab(session, tab->id);
    return {.status = CommandStatus::applied};
  case CommandKind::select_tab: {
    if (!command.target.tab.is_valid()) {
      return {.status = CommandStatus::unavailable};
    }
    const auto previous = session.active_tab;
    if (!select_tab(session, command.target.tab)) {
      return {.status = session.active ? CommandStatus::stale_target : CommandStatus::failed};
    }
    return command_status(previous != session.active_tab);
  }
  }
  return {.status = CommandStatus::invalid_command};
}

[[nodiscard]] constexpr auto targets_pane(const CommandKind kind) noexcept -> bool {
  switch (kind) {
  case CommandKind::split_left_right:
  case CommandKind::split_top_bottom:
  case CommandKind::focus_left:
  case CommandKind::focus_right:
  case CommandKind::focus_up:
  case CommandKind::focus_down:
  case CommandKind::focus_next:
  case CommandKind::focus_previous:
  case CommandKind::close_pane:
  case CommandKind::toggle_zoom:
    return true;
  case CommandKind::none:
  case CommandKind::detach_client:
  case CommandKind::create_tab:
  case CommandKind::next_tab:
  case CommandKind::previous_tab:
  case CommandKind::close_tab:
  case CommandKind::select_tab:
  case CommandKind::stop_session:
    return false;
  }
  return false;
}

void record_session_command(void* const context, const Command& command,
                            const CommandResult result) noexcept {
  auto& session = *static_cast<Session*>(context);
  ++session.command_sequence;
  const auto index =
      static_cast<std::size_t>((session.command_sequence - 1U) % session.command_trace.size());
  std::span(session.command_trace).subspan(index, 1).front() = {
      .sequence = session.command_sequence,
      .command = command,
      .result = result,
  };
}

// Target completion is the single bounded bridge from implicit client commands to stable IDs.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto dispatch_session_command(Session& session, const Command& command) noexcept
    -> CommandResult {
  auto resolved = command;
  if (!resolved.target.session.is_valid()) {
    resolved.target.session = session.id;
  }
  if (resolved.origin == CommandOrigin::client && !resolved.target.client.is_valid()) {
    resolved.target.client = session.client_id;
  }
  if (resolved.kind == CommandKind::select_tab && !resolved.target.tab.is_valid()) {
    const auto slot_index = static_cast<std::size_t>(resolved.argument);
    if (slot_index < session.tabs.size()) {
      const auto& slot = std::span(session.tabs).subspan(slot_index, 1).front();
      if (slot.tab != nullptr) {
        resolved.target.tab = slot.tab->id;
      }
    }
  } else if (resolved.kind != CommandKind::detach_client &&
             resolved.kind != CommandKind::stop_session && !resolved.target.tab.is_valid()) {
    resolved.target.tab = session.active_tab;
  }
  if (targets_pane(resolved.kind) && !resolved.target.pane.is_valid()) {
    const auto* const tab = find_tab(session, resolved.target.tab);
    if (tab != nullptr) {
      resolved.target.pane = tab->focused_pane;
    }
  }
  const CommandDispatcher dispatcher(&execute_session_command, &session, &record_session_command,
                                     &session);
  return dispatcher.dispatch(resolved);
}

[[nodiscard]] auto
collect_surfaces(Session& session,
                 std::array<render::PaneSurface, panes_per_tab_max>& storage) noexcept
    -> std::span<const render::PaneSurface> {
  auto* const tab = active_tab(session);
  if (tab == nullptr || tab->layout_suspended) {
    return std::span<const render::PaneSurface>{};
  }
  std::size_t count = 0;
  const auto pane_slots = std::span(tab->panes);
  for (std::size_t index = 0; index < pane_slots.size(); ++index) {
    // The loop bounds index by pane capacity.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-constant-array-index,cppcoreguidelines-pro-bounds-avoid-unchecked-container-access)
    auto& pane = tab->panes[index].pane;
    if (pane == nullptr || !pane->active || (tab->zoomed && pane->id != tab->focused_pane)) {
      continue;
    }
    std::span(storage).subspan(count, 1).front() = {
        .terminal = &pane->terminal,
        .rectangle = pane->rectangle,
        .focused = pane->id == tab->focused_pane,
        .border_right =
            static_cast<std::uint32_t>(pane->rectangle.column) + pane->rectangle.columns <
            tab->layout_columns,
        .border_bottom = static_cast<std::uint32_t>(pane->rectangle.row) + pane->rectangle.rows <
                         tab->layout_rows,
    };
    ++count;
  }
  return std::span(storage).first(count);
}

[[nodiscard]] auto resize_session(Session& session, const protocol::Dimensions dimensions) noexcept
    -> bool {
  const auto columns = std::clamp(dimensions.columns, std::uint16_t{1}, protocol::columns_max);
  const auto rows = std::clamp(dimensions.rows, std::uint16_t{1}, protocol::rows_max);
  // Record every physical resize and discard any unsent frame composed for the previous viewport.
  // A transiently tiny outer terminal is valid, but pane geometry cannot represent the split tree
  // until it fits again. Preserve that geometry and send a surface-free clear frame constrained to
  // the physical viewport instead of rendering stale rectangles outside it. Checking the unzoomed
  // tree also prevents an undersized viewport from becoming latent while zoomed.
  session.columns = columns;
  session.rows = rows;
  session.output.reset();
  auto* const tab = active_tab(session);
  if (tab == nullptr || !fit_tab_to_viewport(session, *tab)) {
    return false;
  }
  schedule_frame(session, FrameUrgency::state_change, true);
  return true;
}

enum class ParseResult : std::uint8_t {
  keep,
  backpressure,
  detach,
  error,
};

// Packet dispatch exhaustively maps validated protocol messages to session transitions.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto parse_client_packets(Session& session) noexcept -> ParseResult {
  while (true) {
    const auto decoded = session.decoder.next();
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
      const auto result = dispatch_session_command(session, command);
      session.decoder.consume();
      return result.status == CommandStatus::detach_requested ? ParseResult::detach
                                                              : ParseResult::error;
    }
    case protocol::ClientMessageKind::resize:
      if (!resize_session(session, message.dimensions)) {
        return ParseResult::error;
      }
      break;
    case protocol::ClientMessageKind::input: {
      auto* const tab = active_tab(session);
      if (tab == nullptr) {
        return ParseResult::error;
      }
      auto* const pane = find_pane(*tab, tab->focused_pane);
      if (pane == nullptr) {
        return ParseResult::error;
      }
      std::uint64_t trace_correlation = 0;
#ifdef LEMMA_ENABLE_LATENCY_TRACE
      trace_correlation = session.decoded_input_trace_matcher.observe(message.input);
#endif
      diagnostic::record_latency_trace(diagnostic::LatencyTraceStage::daemon_input_message_received,
                                       static_cast<std::uint32_t>(pane->pty), message.input.size(),
                                       trace_correlation);
      const auto queued_bytes_before = pane->pending_writes.size();
      const auto queued =
          queue_normalized_input(pane->pending_writes, pane->terminal, message.input);
      if (queued == InputQueueResult::full) {
        return ParseResult::backpressure;
      }
      if (queued == InputQueueResult::encoding_failed) {
        return ParseResult::error;
      }
      if (latency_sensitive_input(message.input.size())) {
        pane->interactive_damage.await_write(queued_bytes_before, pane->pending_writes.size());
      }
      break;
    }
    case protocol::ClientMessageKind::pane_command: {
      const auto command = command_from_pane_command(message.pane_command);
      if (!command.has_value() || !dispatch_session_command(session, *command).succeeded()) {
        if (!session.active) {
          session.decoder.consume();
          return ParseResult::detach;
        }
      }
      break;
    }
    }
    session.decoder.consume();
    if (!session.active) {
      return ParseResult::detach;
    }
  }
}

[[nodiscard]] auto receive_client(Session& session) noexcept -> ParseResult {
  const auto buffered = parse_client_packets(session);
  if (buffered != ParseResult::keep) {
    return buffered;
  }
  const auto available = session.decoder.writable_bytes();
  if (available.empty()) {
    return ParseResult::error;
  }
  const auto bytes_read = ::recv(session.client, available.data(), available.size(), 0);
  if (bytes_read == 0) {
    return ParseResult::detach;
  }
  if (bytes_read < 0) {
    return errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK ? ParseResult::keep
                                                                     : ParseResult::detach;
  }
  if (!session.decoder.commit(static_cast<std::size_t>(bytes_read)).has_value()) {
    return ParseResult::error;
  }
  return parse_client_packets(session);
}

[[nodiscard]] auto tab_title(const Tab& tab) noexcept -> std::string_view {
  const auto* const focused = find_pane(tab, tab.focused_pane);
  LEMMA_ASSERT(focused != nullptr);
  if (focused->process_name_size > 0) {
    return {focused->process_name.data(), focused->process_name_size};
  }
  const auto title = focused->terminal.title();
  return title.has_value() && !title->empty() ? *title : std::string_view{"shell"};
}

[[nodiscard]] auto current_status_signature(const Session& session) noexcept -> std::uint64_t {
  constexpr std::uint64_t offset_basis = 14'695'981'039'346'656'037ULL;
  constexpr std::uint64_t prime = 1'099'511'628'211ULL;
  std::uint64_t signature = offset_basis;
  const auto mix = [&](const std::uint8_t value) {
    signature ^= value;
    signature *= prime;
  };
  for (std::size_t index = 0; index < session.tabs.size(); ++index) {
    const auto& slot = std::span(session.tabs).subspan(index, 1).front();
    if (slot.tab == nullptr) {
      continue;
    }
    mix(static_cast<std::uint8_t>(index + 1U));
    mix(slot.tab->id == session.active_tab ? 1U : 0U);
    const auto title = tab_title(*slot.tab);
    for (const char character : std::span(title).first(std::min(title.size(), std::size_t{16}))) {
      mix(static_cast<std::uint8_t>(static_cast<unsigned char>(character)));
    }
    mix(title.size() > 16 ? 1U : 0U);
  }
  return signature;
}

[[nodiscard]] auto
collect_status_line(Session& session,
                    std::array<render::StatusTab, render::status_tabs_max>& storage) noexcept
    -> render::StatusLine {
  std::size_t count = 0;
  for (std::size_t index = 0; index < session.tabs.size(); ++index) {
    auto& slot = std::span(session.tabs).subspan(index, 1).front();
    if (slot.tab == nullptr) {
      continue;
    }
    if (!session.status_valid) {
      auto* const focused = find_pane(*slot.tab, slot.tab->focused_pane);
      LEMMA_ASSERT(focused != nullptr);
      static_cast<void>(refresh_process_name(*focused));
    }
    std::span(storage).subspan(count, 1).front() = {
        .number = static_cast<std::uint16_t>(index + 1U),
        .title = tab_title(*slot.tab),
        .active = slot.tab->id == session.active_tab,
    };
    ++count;
  }
  const auto signature = current_status_signature(session);
  const bool dirty = !session.status_valid || signature != session.status_signature;
  session.status_signature = signature;
  session.status_valid = true;
  return {.tabs = std::span(storage).first(count), .dirty = dirty};
}

template <typename Id>
[[nodiscard]] auto append_id(ConnectionOutput& output, const Id id) noexcept -> bool {
  return id.is_valid() && output.append_number(id.slot()) && output.append_text(":") &&
         output.append_number(id.generation());
}

[[nodiscard]] auto append_listing(ConnectionOutput& output, const Session& session) noexcept
    -> bool {
  const auto* const tab = active_tab(session);
  if (tab == nullptr) {
    return false;
  }
  const auto* const focused = find_pane(*tab, tab->focused_pane);
  LEMMA_ASSERT(focused != nullptr);
  const auto title_value = tab_title(*tab);
  return output.append_text("lemma session \"") && output.append_title(session.session_name()) &&
         output.append_text("\": ") && output.append_number(tab_count(session)) &&
         output.append_text(" tab(s), ") && output.append_number(pane_count(session)) &&
         output.append_text(" pane(s), focused pid ") &&
         output.append_number(static_cast<std::uint64_t>(focused->child)) &&
         output.append_text(session.client >= 0 ? ", attached, " : ", detached, ") &&
         output.append_number(session.columns) && output.append_text("x") &&
         output.append_number(session.rows) && output.append_text(", title \"") &&
         output.append_title(title_value) && output.append_text("\", ids session=") &&
         append_id(output, session.id) && output.append_text(" tab=") &&
         append_id(output, tab->id) && output.append_text(" pane=") &&
         append_id(output, focused->id) &&
         (session.client_id.is_valid()
              ? output.append_text(" client=") && append_id(output, session.client_id)
              : output.append_text(" client=detached")) &&
         output.append_text("\n");
}

[[nodiscard]] auto append_tab_listings(ConnectionOutput& output, const Session& session) noexcept
    -> bool {
  for (std::size_t index = 0; index < session.tabs.size(); ++index) {
    const auto& slot = std::span(session.tabs).subspan(index, 1).front();
    if (slot.tab == nullptr) {
      continue;
    }
    const auto& tab = *slot.tab;
    const auto title_value = tab_title(tab);
    if (!output.append_text("lemma tab ") || !output.append_number(index + 1U) ||
        !output.append_text(": ") || !output.append_number(pane_count(tab)) ||
        !output.append_text(" pane(s), ") ||
        !output.append_text(tab.id == session.active_tab ? "active, title \""
                                                         : "inactive, title \"") ||
        !output.append_title(title_value) || !output.append_text("\", id=") ||
        !append_id(output, tab.id) || !output.append_text(", focused-pane=") ||
        !append_id(output, tab.focused_pane) || !output.append_text("\n")) {
      return false;
    }
  }
  return true;
}

using Sessions = BoundedGenerationalStore<Session, SessionId, limits::sessions_hard_max>;

[[nodiscard]] auto find_session(Sessions& sessions, const std::string_view name) noexcept
    -> Session* {
  for (auto& session : sessions) {
    if (session != nullptr && session->active && session->session_name() == name) {
      return session.get();
    }
  }
  return nullptr;
}

void reclaim_inactive_sessions(Sessions& sessions) noexcept {
  for (auto& session : sessions) {
    if (session != nullptr && !session->active &&
        session->pending_attach_slot == std::numeric_limits<std::uint32_t>::max()) {
      const auto id = session->id;
      const bool erased = sessions.erase(id);
      LEMMA_ASSERT(erased);
    }
  }
}

[[nodiscard]] auto append_extension_error(ConnectionOutput& output,
                                          const std::string_view error) noexcept -> bool {
  return error.empty() || (output.append_text("lemma configuration error: ") &&
                           output.append_safe(error, protocol::extension::error_bytes_max) &&
                           output.append_text("\n"));
}

[[nodiscard]] auto append_all_listings(ConnectionOutput& output, const Sessions& sessions) noexcept
    -> bool {
  std::size_t listed = 0;
  for (const auto& session : sessions) {
    if (session != nullptr && session->active) {
      if (!append_listing(output, *session)) {
        return false;
      }
      ++listed;
    }
  }
  return listed > 0 || output.append_text("no lemma sessions\n");
}

enum class PendingState : std::uint8_t {
  unused,
  read_command,
  read_name_size,
  read_name,
  read_working_directory_size,
  read_working_directory,
  read_environment_size,
  read_environment,
  read_dimensions,
  flush_response,
};

enum class PendingAction : std::uint8_t {
  close,
  attach,
  shutdown,
};

struct PendingConnection final {
  [[nodiscard]] auto active() const noexcept -> bool { return state != PendingState::unused; }

  int descriptor{-1};
  std::uint32_t generation{0};
  PendingState state{PendingState::unused};
  PendingAction action{PendingAction::close};
  std::byte command{};
  SessionName session;
  WorkingDirectory working_directory;
  std::size_t environment_size{0};
  std::array<std::byte, protocol::environment_bytes_max> field{};
  std::size_t field_size{0};
  std::size_t field_target{0};
  ConnectionOutput output;
  SessionId attach_session;
  std::chrono::steady_clock::time_point deadline;
  std::chrono::steady_clock::time_point setup_deadline;
};

using PendingConnections = std::array<PendingConnection, limits::pending_connections_hard_max>;

constexpr auto setup_progress_timeout = std::chrono::seconds(5);
constexpr auto setup_total_timeout = std::chrono::seconds(10);

void record_pending_progress(PendingConnection& pending) noexcept {
  pending.deadline =
      std::min(std::chrono::steady_clock::now() + setup_progress_timeout, pending.setup_deadline);
}

void begin_pending_field(PendingConnection& pending, const PendingState state,
                         const std::size_t size) noexcept {
  LEMMA_ASSERT(size > 0 && size <= pending.field.size());
  pending.state = state;
  pending.field_size = 0;
  pending.field_target = size;
}

void release_attach_reservation(PendingConnection& pending, const std::size_t slot,
                                Sessions& sessions) noexcept {
  auto* const session = sessions.get(pending.attach_session);
  if (session != nullptr && session->pending_attach_slot == slot &&
      session->pending_attach_generation == pending.generation) {
    session->pending_attach_slot = std::numeric_limits<std::uint32_t>::max();
    session->pending_attach_generation = 0;
  }
  pending.attach_session = {};
}

void close_pending(PendingConnection& pending, const std::size_t slot,
                   Sessions& sessions) noexcept {
  release_attach_reservation(pending, slot, sessions);
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

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void prepare_unnamed_command(PendingConnection& pending, Sessions& sessions,
                             const ExtensionRuntime& extensions) noexcept {
  bool prepared = true;
  if (pending.command == command_list) {
    prepared = append_extension_error(pending.output, extensions.last_error()) &&
               append_all_listings(pending.output, sessions);
  } else if (pending.command == command_kill_all || pending.command == command_shutdown) {
    const Command stop{.kind = CommandKind::stop_session, .origin = CommandOrigin::cli};
    for (auto& session : sessions) {
      if (session != nullptr) {
        static_cast<void>(dispatch_session_command(*session, stop));
      }
    }
    prepared = pending.output.append_text(pending.command == command_shutdown
                                              ? protocol::shutdown_response
                                              : "all lemma sessions stopped\n");
  } else {
    pending.state = PendingState::unused;
    return;
  }
  if (!prepared) {
    fail_pending_output(pending);
  } else {
    finish_pending_output(pending, pending.command == command_shutdown ? PendingAction::shutdown
                                                                       : PendingAction::close);
  }
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void prepare_named_command(PendingConnection& pending, Sessions& sessions,
                           const ExtensionRuntime& extensions) noexcept {
  Session* session = find_session(sessions, pending.session.view());
  if (pending.command == command_create || pending.command == command_create_with_context) {
    if (session != nullptr) {
      finish_pending_byte(pending, response_ready);
      return;
    }
    if (sessions.size() == Sessions::capacity()) {
      finish_pending_byte(pending, response_capacity);
      return;
    }
    const auto environment_mode = pending.command == command_create_with_context
                                      ? platform::EnvironmentMode::replace
                                      : platform::EnvironmentMode::inherit;
    auto created =
        create_session(pending.session.view(), pending.working_directory.view(),
                       std::span<const std::byte>(pending.field).first(pending.environment_size),
                       environment_mode);
    if (created == nullptr) {
      finish_pending_byte(pending, response_failed);
      return;
    }
    const auto id = sessions.insert(std::move(created));
    if (!id.has_value()) {
      finish_pending_byte(pending, response_capacity);
      return;
    }
    auto* const inserted = sessions.get(*id);
    LEMMA_ASSERT(inserted != nullptr);
    inserted->id = *id;
    finish_pending_byte(pending, response_ready);
    return;
  }
  if (session == nullptr) {
    finish_pending_byte(pending, response_missing);
    return;
  }
  if (pending.command == command_list_session) {
    if (!append_extension_error(pending.output, extensions.last_error()) ||
        !append_listing(pending.output, *session)) {
      fail_pending_output(pending);
    } else {
      finish_pending_output(pending);
    }
    return;
  }
  if (pending.command == command_list_tabs) {
    if (!append_extension_error(pending.output, extensions.last_error()) ||
        !append_tab_listings(pending.output, *session)) {
      fail_pending_output(pending);
    } else {
      finish_pending_output(pending);
    }
    return;
  }

  if (!pending.output.append_text("lemma session \"") ||
      !pending.output.append_title(session->session_name()) ||
      !pending.output.append_text("\" stopped\n")) {
    fail_pending_output(pending);
    return;
  }
  const Command stop{.kind = CommandKind::stop_session, .origin = CommandOrigin::cli};
  static_cast<void>(dispatch_session_command(*session, stop));
  finish_pending_output(pending);
}

void prepare_attach(PendingConnection& pending, Sessions& sessions,
                    const std::size_t slot) noexcept {
  Session* const session = find_session(sessions, pending.session.view());
  if (session == nullptr) {
    finish_pending_byte(pending, response_missing);
    return;
  }
  if (session->client >= 0 ||
      session->pending_attach_slot != std::numeric_limits<std::uint32_t>::max()) {
    finish_pending_byte(pending, response_busy);
    return;
  }
  const auto dimensions = protocol::decode_dimensions(std::span(pending.field).first<4>());
  if (dimensions.columns == 0 || dimensions.rows == 0 ||
      dimensions.columns > protocol::columns_max || dimensions.rows > protocol::rows_max ||
      !resize_session(*session, dimensions)) {
    finish_pending_byte(pending, response_failed);
    return;
  }
  session->pending_attach_slot = static_cast<std::uint32_t>(slot);
  session->pending_attach_generation = pending.generation;
  pending.attach_session = session->id;
  finish_pending_byte(pending, response_ready, PendingAction::attach);
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void complete_pending_field(PendingConnection& pending, Sessions& sessions,
                            const ExtensionRuntime& extensions, const std::size_t slot) noexcept {
  switch (pending.state) {
  case PendingState::read_command:
    pending.command = pending.field.front();
    if (pending.command == command_list || pending.command == command_kill_all ||
        pending.command == command_shutdown) {
      pending.output.reset();
      prepare_unnamed_command(pending, sessions, extensions);
    } else if (pending.command == command_attach || pending.command == command_create ||
               pending.command == command_create_with_context ||
               pending.command == command_list_session || pending.command == command_list_tabs ||
               pending.command == command_kill) {
      begin_pending_field(pending, PendingState::read_name_size, 1);
    } else {
      pending.state = PendingState::unused;
    }
    break;
  case PendingState::read_name_size: {
    const auto size = protocol::decode_session_name_size(pending.field.front());
    if (size == 0 || size > pending.session.bytes.size()) {
      pending.state = PendingState::unused;
    } else {
      begin_pending_field(pending, PendingState::read_name, size);
    }
    break;
  }
  case PendingState::read_name:
    pending.session.size = pending.field_target;
    std::ranges::copy(std::span(pending.field).first(pending.session.size),
                      std::as_writable_bytes(std::span(pending.session.bytes)).begin());
    if (!valid_session_name(pending.session.view())) {
      pending.state = PendingState::unused;
    } else if (pending.command == command_attach) {
      begin_pending_field(pending, PendingState::read_dimensions, 4);
    } else if (pending.command == command_create_with_context) {
      begin_pending_field(pending, PendingState::read_working_directory_size, 2);
    } else {
      pending.output.reset();
      prepare_named_command(pending, sessions, extensions);
    }
    break;
  case PendingState::read_working_directory_size: {
    const auto size =
        protocol::decode_bounded_size(std::span<const std::byte>(pending.field).first<2>());
    if (size == protocol::unavailable_working_directory_size) {
      finish_pending_byte(pending, find_session(sessions, pending.session.view()) != nullptr
                                       ? response_ready
                                       : response_failed);
    } else if (size > protocol::working_directory_bytes_max) {
      pending.state = PendingState::unused;
    } else {
      begin_pending_field(pending, PendingState::read_working_directory, size);
    }
    break;
  }
  case PendingState::read_working_directory:
    pending.working_directory = {};
    pending.working_directory.size = pending.field_target;
    std::ranges::copy(std::span(pending.field).first(pending.working_directory.size),
                      std::as_writable_bytes(std::span(pending.working_directory.bytes)).begin());
    if (pending.working_directory.view().front() != '/' ||
        pending.working_directory.view().contains('\0')) {
      pending.state = PendingState::unused;
    } else {
      begin_pending_field(pending, PendingState::read_environment_size, 2);
    }
    break;
  case PendingState::read_environment_size: {
    const auto size =
        protocol::decode_bounded_size(std::span<const std::byte>(pending.field).first<2>());
    if (size > protocol::environment_bytes_max) {
      pending.state = PendingState::unused;
    } else if (size == 0) {
      pending.environment_size = 0;
      pending.output.reset();
      prepare_named_command(pending, sessions, extensions);
    } else {
      pending.environment_size = size;
      begin_pending_field(pending, PendingState::read_environment, size);
    }
    break;
  }
  case PendingState::read_environment:
    if (!valid_environment(
            std::span<const std::byte>(pending.field).first(pending.environment_size))) {
      pending.state = PendingState::unused;
    } else {
      pending.output.reset();
      prepare_named_command(pending, sessions, extensions);
    }
    break;
  case PendingState::read_dimensions:
    prepare_attach(pending, sessions, slot);
    break;
  case PendingState::unused:
  case PendingState::flush_response:
    LEMMA_ASSERT(false);
    break;
  }
}

void process_pending_fields(PendingConnection& pending, Sessions& sessions,
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
      record_pending_progress(pending);
      if (pending.field_size == pending.field_target) {
        complete_pending_field(pending, sessions, extensions, slot);
      }
      continue;
    }
    if (received < 0 && errno == EINTR) {
      continue;
    }
    if (received < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return;
    }
    close_pending(pending, slot, sessions);
    return;
  }
  if (!pending.active()) {
    close_pending(pending, slot, sessions);
  }
}

void process_pending_read(PendingConnection& pending, Sessions& sessions,
                          const ExtensionRuntime& extensions, const std::size_t slot) noexcept {
  if (std::chrono::steady_clock::now() >= pending.setup_deadline) {
    close_pending(pending, slot, sessions);
    return;
  }
  process_pending_fields(pending, sessions, extensions, slot);
}

void handoff_attached_connection(PendingConnection& pending, const std::size_t slot,
                                 Sessions& sessions) noexcept {
  Session* const session = sessions.get(pending.attach_session);
  if (session == nullptr || !session->active || session->pending_attach_slot != slot ||
      session->pending_attach_generation != pending.generation) {
    close_pending(pending, slot, sessions);
    return;
  }

  const int connection = pending.descriptor;
  pending.descriptor = -1;
  release_attach_reservation(pending, slot, sessions);
  pending.output.reset();
  pending.state = PendingState::unused;

  session->client = connection;
  session->client_generation = next_generation(session->client_generation);
  session->client_id = ClientId::from_parts(session->id.slot(), session->client_generation);
  session->decoder.reset();
  session->output.reset();
  session->input_backpressured = false;
  session->frame_scheduler.cancel();
  std::array<render::PaneSurface, panes_per_tab_max> surface_storage{};
  std::array<render::StatusTab, render::status_tabs_max> status_storage{};
  const auto surfaces = collect_surfaces(*session, surface_storage);
  const auto status = collect_status_line(*session, status_storage);
  if (!render::queue_composed_frame(connection, surfaces,
                                    {.columns = session->columns, .rows = session->rows},
                                    *session->frame, session->output, true, status)) {
    session->detach_client();
  }
}

[[nodiscard]] auto write_pending_output(void* const context,
                                        const std::span<const std::byte> bytes) noexcept
    -> ConnectionWriteAttempt {
  auto& pending = *static_cast<PendingConnection*>(context);
  const auto sent = ::send(pending.descriptor, bytes.data(), bytes.size(), MSG_NOSIGNAL);
  if (sent > 0) {
    record_pending_progress(pending);
  }
  return {.bytes = sent, .error = sent < 0 ? errno : 0};
}

[[nodiscard]] auto flush_pending_output(PendingConnection& pending, const std::size_t slot,
                                        std::size_t& global_budget, Sessions& sessions) noexcept
    -> bool {
  const auto action = pending.action;
  const auto status =
      flush_connection_output(pending.output, global_budget, &write_pending_output, &pending);
  if (status == ConnectionFlushStatus::hard_error) {
    close_pending(pending, slot, sessions);
    return action == PendingAction::shutdown;
  }
  if (!pending.active() || status != ConnectionFlushStatus::drained) {
    return false;
  }
  if (action == PendingAction::attach) {
    handoff_attached_connection(pending, slot, sessions);
  } else {
    close_pending(pending, slot, sessions);
  }
  return action == PendingAction::shutdown;
}

[[nodiscard]] auto frame_poll_timeout(const Sessions& sessions, const FrameScheduler::TimePoint now,
                                      int timeout) noexcept -> int {
  for (const auto& session : sessions) {
    if (session != nullptr && session->active) {
      const auto deadline = session->frame_scheduler.deadline(frame_sink_state(*session));
      if (deadline.has_value()) {
        if (now >= *deadline) {
          return 0;
        }
        const auto remaining =
            std::chrono::duration_cast<std::chrono::milliseconds>(*deadline - now);
        const auto candidate = static_cast<int>(std::max(remaining.count(), std::int64_t{1}));
        timeout = timeout < 0 ? candidate : std::min(timeout, candidate);
      }
    }
  }
  return timeout;
}

[[nodiscard]] auto poll_timeout(const Sessions& sessions, const PendingConnections& pending,
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
  return frame_poll_timeout(sessions, now, timeout);
}

struct PaneDamageAssessment final {
  bool interactive{false};
  bool status_changed{false};
};

[[nodiscard]] auto assess_pane_damage(Session& session, Pane& pane, const PtyDrainResult& drained,
                                      const bool track_interactive_damage,
                                      const std::uint64_t interactive_status_before) noexcept
    -> PaneDamageAssessment {
  const auto status_after = current_status_signature(session);
  const bool interactive_status_damage =
      track_interactive_damage && status_after != interactive_status_before;
  const bool status_changed = !session.status_valid || status_after != session.status_signature;
  const bool visible_damage =
      drained.render_damage || interactive_status_damage || drained.damage_capture_failed;
  const bool interactive_damage = pane.interactive_damage.pending() && visible_damage;
  if (interactive_damage) {
    // Damage in an inactive tab is already covered by its next full redraw. Do not let the input
    // latch promote an unrelated update after the tab becomes active again.
    static_cast<void>(pane.interactive_damage.consume());
  }
  return {.interactive = interactive_damage, .status_changed = status_changed};
}

[[nodiscard]] auto frame_urgency(const PtyDrainResult& drained, const bool process_changed,
                                 const PaneDamageAssessment damage) noexcept -> FrameUrgency {
  if (drained.damage_capture_failed) {
    return FrameUrgency::state_change;
  }
  if (damage.interactive) {
    return FrameUrgency::interactive;
  }
  if (!drained.alive || process_changed || damage.status_changed) {
    return FrameUrgency::state_change;
  }
  return FrameUrgency::burst;
}

[[nodiscard]] auto pane_event_changed(const Session& session, const PtyDrainResult& drained,
                                      const bool process_changed) noexcept -> bool {
  if (session.client < 0) {
    return false;
  }
  return drained.changed || process_changed;
}

void process_pane_events(Session& session, Tab& tab, Pane& pane, const pollfd& events,
                         std::size_t& global_budget) noexcept {
  if ((events.revents & (POLLIN | POLLHUP | POLLERR)) == 0) {
    return;
  }
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  auto* const trace_matcher = &pane.output_trace_matcher;
#else
  diagnostic::LatencyTraceMarkerMatcher* const trace_matcher = nullptr;
#endif
  const bool track_interactive_damage = session.client >= 0 && pane.interactive_damage.pending();
  const auto interactive_status_before =
      track_interactive_damage ? current_status_signature(session) : 0;
  const auto drained = drain_pty(pane.pty, pane.terminal, pane.pending_writes, global_budget,
                                 track_interactive_damage, trace_matcher);
  pane.active = drained.alive;
  const bool process_changed = refresh_process_name(pane);
  if (!pane_event_changed(session, drained, process_changed)) {
    return;
  }
  const auto damage = assess_pane_damage(session, pane, drained, track_interactive_damage,
                                         interactive_status_before);
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  if (drained.correlation != 0 && tab.id == session.active_tab && pane.id == tab.focused_pane) {
    session.frame_trace_correlation = drained.correlation;
  }
#endif
  if (tab.id == session.active_tab) {
    schedule_frame(session, frame_urgency(drained, process_changed, damage),
                   drained.damage_capture_failed);
  } else if (damage.status_changed) {
    schedule_frame(session, FrameUrgency::state_change, false);
  }
}

void process_client_events(Session& session, const pollfd& events) noexcept {
  // Consume resizes before flushing queued output so resize_session can discard bytes composed
  // for the previous physical viewport. A decoder-held input message is retried even without new
  // socket readiness after a prior turn made PTY queue capacity available. If its peer has already
  // closed, discard a backpressured message instead of letting it hide EOF indefinitely.
  if (session.client >= 0 && session.input_backpressured &&
      (events.revents & (POLLHUP | POLLERR)) != 0) {
    session.detach_client();
    return;
  }
  if (session.client >= 0 &&
      (session.input_backpressured || (events.revents & (POLLIN | POLLHUP | POLLERR)) != 0)) {
    const auto received = receive_client(session);
    session.input_backpressured = received == ParseResult::backpressure;
    if (received == ParseResult::detach || received == ParseResult::error) {
      session.detach_client();
      return;
    }
  }
}

[[nodiscard]] auto write_pane_pty(void* const context,
                                  const std::span<const std::byte> bytes) noexcept
    -> PtyWriteAttempt {
  auto& pane = *static_cast<Pane*>(context);
  const auto written = ::write(pane.pty, bytes.data(), bytes.size());
  if (written > 0) {
    const auto size = static_cast<std::size_t>(written);
    pane.interactive_damage.record_write(size);
    std::uint64_t trace_correlation = 0;
#ifdef LEMMA_ENABLE_LATENCY_TRACE
    trace_correlation = pane.input_trace_matcher.observe(bytes.first(size));
#endif
    diagnostic::record_latency_trace(diagnostic::LatencyTraceStage::daemon_pty_write_progress,
                                     static_cast<std::uint32_t>(pane.pty),
                                     static_cast<std::uint64_t>(written), trace_correlation);
  }
  return {.bytes = written, .error = written < 0 ? errno : 0};
}

[[nodiscard]] auto flush_pane_writes(Pane& pane, std::size_t& global_budget) noexcept -> bool {
  return flush_pty_write_queue(pane.pending_writes, global_budget, &write_pane_pty, &pane) !=
         PtyFlushStatus::hard_error;
}

void reclaim_dead_panes(Session& session) noexcept {
  for (auto& slot : session.tabs) {
    if (slot.tab == nullptr || !session.active) {
      continue;
    }
    const auto id = slot.tab->id;
    for (std::size_t index = 0;; ++index) {
      auto* const tab = find_tab(session, id);
      if (tab == nullptr || index >= tab->panes.size()) {
        break;
      }
      // The preceding check bounds index by pane capacity.
      // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-constant-array-index,cppcoreguidelines-pro-bounds-avoid-unchecked-container-access)
      const auto& pane = tab->panes[index].pane;
      if (pane != nullptr && !pane->active) {
        static_cast<void>(close_pane(session, *tab, pane->id));
      }
    }
  }
}

void queue_due_frames(Sessions& sessions) noexcept {
  const auto now = std::chrono::steady_clock::now();
  for (auto& session : sessions) {
    if (session == nullptr || !session->active ||
        !session->frame_scheduler.due(now, frame_sink_state(*session))) {
      continue;
    }
    std::array<render::PaneSurface, panes_per_tab_max> surface_storage{};
    std::array<render::StatusTab, render::status_tabs_max> status_storage{};
    const auto surfaces = collect_surfaces(*session, surface_storage);
    const auto status = collect_status_line(*session, status_storage);
#ifdef LEMMA_ENABLE_LATENCY_TRACE
    diagnostic::set_latency_trace_correlation(session->frame_trace_correlation);
#endif
    if (!render::queue_composed_frame(
            session->client, surfaces, {.columns = session->columns, .rows = session->rows},
            *session->frame, session->output, session->frame_scheduler.force_full(), status)) {
      session->detach_client();
    }
#ifdef LEMMA_ENABLE_LATENCY_TRACE
    diagnostic::set_latency_trace_correlation(0);
    session->frame_trace_correlation = 0;
#endif
    session->frame_scheduler.complete();
  }
}

void expire_pending_connections(PendingConnections& pending_connections,
                                Sessions& sessions) noexcept {
  const auto now = std::chrono::steady_clock::now();
  for (std::size_t slot = 0; slot < pending_connections.size(); ++slot) {
    auto& pending = std::span(pending_connections).subspan(slot, 1).front();
    if (pending.active() && now >= pending.deadline) {
      close_pending(pending, slot, sessions);
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
    pending.session = {};
    pending.working_directory = {};
    pending.environment_size = 0;
    pending.attach_session = {};
    pending.action = PendingAction::close;
    const auto now = std::chrono::steady_clock::now();
    pending.deadline = now + setup_progress_timeout;
    pending.setup_deadline = now + setup_total_timeout;
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
  Session* session{nullptr};
  Tab* tab{nullptr};
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
  diagnostic::set_latency_trace_role(diagnostic::LatencyTraceRole::daemon);
  EndpointReleaseGuard endpoint_release(release_endpoint, release_context);
  Sessions sessions;
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
                                        static_cast<std::size_t>(limits::sessions_hard_max) +
                                        limits::pending_connections_hard_max;
  std::array<pollfd, descriptor_count_max> descriptors{};
  std::array<DescriptorOwner, descriptor_count_max> owners{};
  std::size_t pty_read_cursor = 0;
  std::size_t pty_flush_cursor = 0;

  while (true) {
    if (stop_requested != nullptr && stop_requested()) {
      return 0;
    }
    extensions.connect_if_due(std::chrono::steady_clock::now());
    std::size_t descriptor_count = 1;
    descriptors.front() = {.fd = listener, .events = POLLIN, .revents = 0};
    for (const auto& session : sessions) {
      if (session == nullptr || !session->active) {
        continue;
      }
      for (const auto& tab_slot : session->tabs) {
        if (tab_slot.tab == nullptr) {
          continue;
        }
        for (const auto& pane_slot : tab_slot.tab->panes) {
          const auto& pane = pane_slot.pane;
          if (pane == nullptr || !pane->active) {
            continue;
          }
          const auto pane_events = static_cast<short>(
              POLLIN | (!pane->pending_writes.empty() ? static_cast<short>(POLLOUT) : 0));
          std::span(descriptors).subspan(descriptor_count, 1).front() = {
              .fd = pane->pty, .events = pane_events, .revents = 0};
          std::span(owners).subspan(descriptor_count, 1).front() = {.session = session.get(),
                                                                    .tab = tab_slot.tab.get(),
                                                                    .pane = pane.get(),
                                                                    .kind = DescriptorKind::pane};
          ++descriptor_count;
        }
      }
      if (session->client >= 0) {
        const auto client_events =
            static_cast<short>((session->input_backpressured ? 0 : POLLIN) |
                               (session->output.busy() ? static_cast<short>(POLLOUT) : 0));
        std::span(descriptors).subspan(descriptor_count, 1).front() = {
            .fd = session->client, .events = client_events, .revents = 0};
        std::span(owners).subspan(descriptor_count, 1).front() = {.session = session.get(),
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
                                    poll_timeout(sessions, pending_connections, extensions));
    if (poll_result < 0) {
      if (errno == EINTR) {
        continue;
      }
      return 1;
    }

    // Drain every ready PTY before handling client input, then remove exited panes so input is
    // always routed to a live focused pane selected by close_pane.
    std::size_t pty_read_budget = std::size_t{256} * 1'024U;
    const auto ready_owner_count = descriptor_count - 1U;
    if (ready_owner_count > 0) {
      pty_read_cursor %= ready_owner_count;
      std::size_t visited = 0;
      for (; visited < ready_owner_count && pty_read_budget > 0; ++visited) {
        const auto index = 1U + ((pty_read_cursor + visited) % ready_owner_count);
        const auto owner = std::span(owners).subspan(index, 1).front();
        if (owner.kind == DescriptorKind::pane) {
          const auto& events = std::span(descriptors).subspan(index, 1).front();
          process_pane_events(*owner.session, *owner.tab, *owner.pane, events, pty_read_budget);
        }
      }
      pty_read_cursor = (pty_read_cursor + visited) % ready_owner_count;
    } else {
      pty_read_cursor = 0;
    }
    for (auto& session : sessions) {
      if (session != nullptr && session->active) {
        reclaim_dead_panes(*session);
      }
    }
    for (std::size_t index = 1; index < descriptor_count; ++index) {
      const auto owner = std::span(owners).subspan(index, 1).front();
      if (owner.kind == DescriptorKind::client && owner.session->active) {
        const auto& events = std::span(descriptors).subspan(index, 1).front();
        process_client_events(*owner.session, events);
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
        process_pending_read(*owner.pending, sessions, extensions, owner.pending_slot);
      }
    }

    // Writes are attempted only from retained queue bytes and are bounded both per pane and across
    // this turn. A hard descriptor error retires the pane; EAGAIN leaves all bytes queued.
    std::size_t pty_write_budget = std::size_t{1} * 1'024U * 1'024U;
    std::array<Pane*, static_cast<std::size_t>(limits::panes_hard_max)> writable_panes{};
    std::size_t writable_pane_count = 0;
    for (auto& session : sessions) {
      if (session == nullptr || !session->active) {
        continue;
      }
      for (auto& tab_slot : session->tabs) {
        if (tab_slot.tab == nullptr) {
          continue;
        }
        for (auto& pane_slot : tab_slot.tab->panes) {
          auto& pane = pane_slot.pane;
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
    for (auto& session : sessions) {
      if (session != nullptr && session->active) {
        reclaim_dead_panes(*session);
      }
    }
    // Capacity may have become available without new client socket readiness.
    const pollfd no_events{.fd = -1, .events = 0, .revents = 0};
    for (auto& session : sessions) {
      if (session != nullptr && session->active && session->client >= 0 &&
          session->input_backpressured) {
        process_client_events(*session, no_events);
      }
    }

    queue_due_frames(sessions);
    for (auto& session : sessions) {
      if (session != nullptr && session->active && session->client >= 0 && session->output.busy() &&
          !flush_frame(session->client, *session->frame, session->output)) {
        session->detach_client();
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
        if (flush_pending_output(*owner.pending, owner.pending_slot, pending_output_budget,
                                 sessions)) {
          return 0;
        }
      }
    }
    expire_pending_connections(pending_connections, sessions);
    reclaim_inactive_sessions(sessions);

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
    reclaim_inactive_sessions(sessions);
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
