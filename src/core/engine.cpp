#include "core/engine.hpp"

#include "core/client_frame_output.hpp"
#include "core/connection_output.hpp"
#include "core/extension_runtime.hpp"
#include "core/frame_scheduler.hpp"
#include "core/input.hpp"
#include "core/presentation_gate.hpp"
#include "core/pty_writer.hpp"
#include "core/terminal_resize.hpp"
#include "diagnostic/latency_trace.hpp"
#include "lemma/assert.hpp"
#include "lemma/command.hpp"
#include "lemma/generational_store.hpp"
#include "lemma/id.hpp"
#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"
#include "platform/io.hpp"
#include "platform/pty.hpp"
#include "protocol/extension.hpp"
#include "protocol/single_pane.hpp"
#include "render/pane_composition.hpp"
#include "render/single_pane.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <iterator>
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
constexpr auto process_name_refresh_interval = std::chrono::milliseconds{100};
constexpr auto copy_escape_flush_delay = std::chrono::milliseconds{50};
constexpr auto copy_search_slice_delay = std::chrono::milliseconds{2};
constexpr auto scrollback_compression_slice_delay = std::chrono::milliseconds{2};
constexpr std::size_t copy_escape_bytes_max = 16;
constexpr std::size_t command_trace_entries_max = 256;
static_assert(panes_per_session_max > 0);
static_assert(tabs_per_session_max > 0);
static_assert(tabs_per_session_max <= render::status_tabs_max);
using platform::close_descriptor;
using platform::set_nonblocking;
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

[[nodiscard]] auto resize_pty_for_transaction(void* const context,
                                              const vt::TerminalSize& size) noexcept -> bool {
  const auto pty = *static_cast<const int*>(context);
  return platform::resize_pty(pty, size.columns, size.rows);
}

[[nodiscard]] auto resize_pane_terminal(const int pty, vt::Terminal& terminal,
                                        const std::uint16_t requested_columns,
                                        const std::uint16_t requested_rows) noexcept -> bool {
  const auto columns = std::clamp(requested_columns, std::uint16_t{1}, protocol::columns_max);
  const auto rows = std::clamp(requested_rows, std::uint16_t{1}, protocol::rows_max);
  const vt::TerminalSize requested{.columns = columns, .rows = rows};
  auto descriptor = pty;
  const auto status =
      resize_terminal_transaction(terminal, requested, &resize_pty_for_transaction, &descriptor);
  return status == TerminalResizeStatus::applied || status == TerminalResizeStatus::unchanged;
}

struct PtyDrainResult final {
  bool alive{true};
  bool changed{false};
  bool render_damage{false};
  bool presentation_deferred{false};
  bool presentation_released{false};
  bool force_full{false};
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

void write_pty_output(vt::Terminal& terminal, PresentationGate& presentation_gate,
                      const std::span<const std::byte> bytes, bool& capture_damage,
                      PtyDrainResult& drain) noexcept {
  bool damage_acquired = true;
  if (!capture_damage) {
    terminal.write(bytes);
  } else {
    const auto damage = terminal.write_and_report_damage(bytes);
    if (!damage.has_value()) {
      drain.damage_capture_failed = true;
      capture_damage = false;
    } else {
      damage_acquired = *damage != vt::DirtyState::clean;
      if (damage_acquired) {
        capture_damage = false;
      }
    }
  }

  const auto synchronized = terminal.synchronized_output();
  if (!synchronized.has_value()) {
    drain.damage_capture_failed = true;
    return;
  }
  const auto gate =
      presentation_gate.observe(*synchronized, damage_acquired, std::chrono::steady_clock::now());
  drain.render_damage = drain.render_damage || gate.visible_damage;
  drain.presentation_deferred = presentation_gate.presentation_suppressed();
  drain.presentation_released = drain.presentation_released || gate.urgent_render;
  drain.force_full = drain.force_full || gate.force_full;
}

[[nodiscard]] auto
process_pty_output(const int pty, vt::Terminal& terminal, PresentationGate& presentation_gate,
                   PanePtyWriteQueue& pending_writes, const std::span<const std::byte> bytes,
                   bool& capture_damage, PtyDrainResult& drain,
                   diagnostic::LatencyTraceMarkerMatcher* const trace_matcher) noexcept -> bool {
  const auto trace_correlation = trace_pty_output(drain, trace_matcher, bytes);
  diagnostic::record_latency_trace(diagnostic::LatencyTraceStage::daemon_pty_output_read,
                                   static_cast<std::uint32_t>(pty), bytes.size(),
                                   trace_correlation);
  write_pty_output(terminal, presentation_gate, bytes, capture_damage, drain);
  drain.changed = true;
  return queue_terminal_responses(pending_writes, terminal);
}

[[nodiscard]] auto
drain_pty(const int pty, vt::Terminal& terminal, PresentationGate& presentation_gate,
          PanePtyWriteQueue& pending_writes, std::size_t& global_budget,
          const bool capture_interactive_damage,
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
      if (!process_pty_output(pty, terminal, presentation_gate, pending_writes, bytes,
                              capture_damage, drain, trace_matcher)) {
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

struct PaneRuntime final {
  explicit PaneRuntime(vt::Terminal&& created_terminal) noexcept
      : terminal(std::move(created_terminal)) {}

  PaneRuntime(const PaneRuntime&) = delete;
  auto operator=(const PaneRuntime&) -> PaneRuntime& = delete;
  PaneRuntime(PaneRuntime&&) = delete;
  auto operator=(PaneRuntime&&) -> PaneRuntime& = delete;

  ~PaneRuntime() {
    if (child > 0) {
      static_cast<void>(::kill(child, SIGHUP));
      child = -1;
    }
    close_descriptor(pty);
  }

  vt::Terminal terminal;
  int pty{-1};
  decltype(::getpid()) child{-1};
  std::array<char, process_name_bytes_max> process_name{};
  std::size_t process_name_size{0};
  std::chrono::steady_clock::time_point next_process_name_refresh;
  PanePtyWriteQueue pending_writes;
  InteractiveDamageLatch interactive_damage;
  PresentationGate presentation_gate;
  std::uint64_t compression_activity{0};
  std::uint64_t mutation_generation{1};
  std::chrono::steady_clock::time_point compression_deadline;
  bool compression_scheduled{false};
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  diagnostic::LatencyTraceMarkerMatcher input_trace_matcher;
  diagnostic::LatencyTraceMarkerMatcher output_trace_matcher;
#endif
  bool active{true};
};

struct Pane final {
  explicit Pane(vt::Terminal&& created_terminal) noexcept : runtime(std::move(created_terminal)) {}

  Pane(const Pane&) = delete;
  auto operator=(const Pane&) -> Pane& = delete;
  Pane(Pane&&) = delete;
  auto operator=(Pane&&) -> Pane& = delete;
  ~Pane() = default;

  PaneId id;
  render::PaneRectangle rectangle{};
  PaneRuntime runtime;
};

void record_terminal_mutation(PaneRuntime& runtime) noexcept {
  runtime.mutation_generation =
      runtime.mutation_generation == std::numeric_limits<std::uint64_t>::max()
          ? std::uint64_t{1}
          : runtime.mutation_generation + 1U;
}

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

enum class ClientCloseState : std::uint8_t {
  none,
  queue_disconnect,
  disconnect_queued,
};

enum class CopyModeFeedback : std::uint8_t {
  none,
  no_match,
  empty_selection,
  clipboard_busy,
  too_large,
  failed,
};

struct CopyModeState final {
  TabId tab;
  PaneId pane;
  std::array<char, limits::search_query_bytes_max> query{};
  std::array<char, 64> status{};
  std::array<std::byte, copy_escape_bytes_max> pending_escape{};
  std::size_t query_size{0};
  std::size_t status_size{0};
  std::size_t pending_escape_size{0};
  std::optional<vt::SearchCursor> search_cursor;
  std::optional<vt::SearchMatch> last_search_match;
  std::chrono::steady_clock::time_point pending_escape_deadline;
  std::chrono::steady_clock::time_point search_deadline;
  vt::SearchDirection search_direction{vt::SearchDirection::forward};
  vt::SearchDirection active_search_direction{vt::SearchDirection::forward};
  std::uint64_t search_generation{0};
  std::uint64_t viewport_offset{0};
  CopyModeFeedback feedback{CopyModeFeedback::none};
  bool active{false};
  bool extending{false};
  bool search_entry{false};
  bool search_pending{false};

  [[nodiscard]] auto query_view() const noexcept -> std::string_view {
    return {query.data(), query_size};
  }

  [[nodiscard]] auto status_view() const noexcept -> std::string_view {
    return {status.data(), status_size};
  }
};

// Runtime-sized bounded clipboard staging cannot use std::array.
// NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
using ClipboardStorage = std::unique_ptr<std::byte[]>;

[[nodiscard]] auto allocate_clipboard_storage(const std::size_t bytes) noexcept
    -> ClipboardStorage {
  try {
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
    return std::make_unique_for_overwrite<std::byte[]>(bytes);
  } catch (const std::bad_alloc&) {
    return nullptr;
  }
}

struct PendingClipboardWrite final {
  ClipboardStorage bytes;
  std::size_t size{0};
  bool redraw_after_write{false};

  void reset() noexcept {
    bytes.reset();
    size = 0;
    redraw_after_write = false;
  }
};

struct Session final {
  Session(const std::string_view session_name, const std::string_view initial_working_directory,
          const std::span<const std::byte> initial_environment,
          const platform::EnvironmentMode initial_environment_mode) noexcept
      : name_size(session_name.size()), working_directory_size(initial_working_directory.size()),
        environment_size(initial_environment.size()), environment_mode(initial_environment_mode),
        theme(vt::default_theme()) {
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

  // Attachment teardown exhaustively restores every pane-owned view before releasing protocol
  // state. NOLINTNEXTLINE(readability-function-cognitive-complexity)
  void detach_client() noexcept {
    for (auto& tab_slot : tabs) {
      if (tab_slot.tab == nullptr) {
        continue;
      }
      for (auto& pane_slot : tab_slot.tab->panes) {
        if (pane_slot.pane != nullptr) {
          pane_slot.pane->runtime.terminal.reset_selection_gesture();
          pane_slot.pane->runtime.terminal.clear_selection();
          pane_slot.pane->runtime.terminal.scroll_viewport(vt::ViewportScroll::bottom);
        }
      }
    }
    copy_mode = {};
    clipboard_write.reset();
    close_descriptor(client);
    client_id = {};
    decoder.reset();
    output.reset();
    frame.release();
    server_sequence = 2;
    full_redraw_generation = 0;
    client_close_state = ClientCloseState::none;
    frame_scheduler.cancel();
    input_backpressured = false;
    retained_input_offset.reset();
    for (auto& tab_slot : tabs) {
      if (tab_slot.tab != nullptr) {
        for (auto& pane_slot : tab_slot.tab->panes) {
          if (pane_slot.pane != nullptr) {
            pane_slot.pane->runtime.interactive_damage.reset();
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
  vt::TerminalTheme theme{};
  FrameBuffer frame;
  std::array<TabSlot, tabs_per_session_max> tabs{};
  TabId active_tab;
  TabId previous_tab;
  protocol::ClientDecoder decoder;
  ClientFrameOutput output;
  std::uint32_t server_sequence{2};
  std::uint32_t full_redraw_generation{0};
  int client{-1};
  ClientId client_id;
  std::uint32_t client_generation{0};
  std::uint32_t pending_attach_slot{std::numeric_limits<std::uint32_t>::max()};
  std::uint32_t pending_attach_generation{0};
  std::uint16_t columns{80};
  std::uint16_t rows{24};
  bool active{true};
  bool theme_bound{false};
  bool status_valid{false};
  bool input_backpressured{false};
  ClientCloseState client_close_state{ClientCloseState::none};
  std::optional<std::size_t> retained_input_offset;
  CopyModeState copy_mode;
  PendingClipboardWrite clipboard_write;
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

[[nodiscard]] constexpr auto terminal_color(const protocol::RgbColor color) noexcept
    -> vt::RgbColor {
  return {.red = color.red, .green = color.green, .blue = color.blue};
}

[[nodiscard]] auto bind_session_theme(Session& session,
                                      const protocol::HostTerminalTheme& host_theme) noexcept
    -> bool {
  auto theme = session.theme;
  if (host_theme.foreground.has_value()) {
    theme.foreground = terminal_color(*host_theme.foreground);
    theme.cursor = theme.foreground;
  }
  if (host_theme.background.has_value()) {
    theme.background = terminal_color(*host_theme.background);
  }
  for (std::size_t index = 0; index < theme.palette.size(); ++index) {
    if (host_theme.has_palette_color(index)) {
      std::span(theme.palette).subspan(index, 1).front() =
          terminal_color(std::span(host_theme.palette).subspan(index, 1).front());
    }
  }
  for (auto& tab_slot : session.tabs) {
    if (tab_slot.tab == nullptr) {
      continue;
    }
    for (auto& pane_slot : tab_slot.tab->panes) {
      if (pane_slot.pane != nullptr &&
          !pane_slot.pane->runtime.terminal.set_theme(theme).has_value()) {
        return false;
      }
    }
  }
  session.theme = theme;
  session.theme_bound = true;
  return true;
}

[[nodiscard]] auto create_pane(const std::uint16_t columns, const std::uint16_t rows,
                               const std::string_view working_directory,
                               const std::span<const std::byte> environment,
                               const platform::EnvironmentMode environment_mode,
                               const vt::TerminalTheme& theme) noexcept -> std::unique_ptr<Pane> {
  vt::TerminalOptions options;
  options.size = {.columns = columns, .rows = rows};
  options.theme = theme;
  auto terminal_result = vt::Terminal::create(options);
  if (!terminal_result.has_value()) {
    return nullptr;
  }
  std::unique_ptr<Pane> pane;
  try {
    pane = std::make_unique<Pane>(std::move(*terminal_result));
  } catch (const std::bad_alloc&) {
    return nullptr;
  }
  auto& runtime = pane->runtime;
  runtime.child =
      platform::spawn_login_shell(runtime.pty, working_directory, environment, environment_mode);
  if (runtime.child <= 0 || !set_nonblocking(runtime.pty) ||
      !platform::resize_pty(runtime.pty, columns, rows)) {
    return nullptr;
  }
  pane->rectangle = {.columns = columns, .rows = rows};
  const auto compression_activity = runtime.terminal.compression_activity();
  if (!compression_activity.has_value()) {
    return nullptr;
  }
  runtime.compression_activity = *compression_activity;
  return pane;
}

[[nodiscard]] auto refresh_process_name(PaneRuntime& runtime) noexcept -> bool {
  std::array<char, process_name_bytes_max> current{};
  const auto size = platform::foreground_process_name(runtime.pty, current);
  if (size == 0 ||
      (size == runtime.process_name_size &&
       std::ranges::equal(std::span(current).first(size),
                          std::span(runtime.process_name).first(runtime.process_name_size)))) {
    return false;
  }
  std::ranges::copy(std::span(current).first(size), runtime.process_name.begin());
  runtime.process_name_size = size;
  return true;
}

[[nodiscard]] auto
refresh_process_name_if_due(PaneRuntime& runtime,
                            const std::chrono::steady_clock::time_point now) noexcept -> bool {
  if (now < runtime.next_process_name_refresh) {
    return false;
  }
  runtime.next_process_name_refresh = now + process_name_refresh_interval;
  return refresh_process_name(runtime);
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

[[nodiscard]] auto tab_at_position(const Session& session, const std::size_t position) noexcept
    -> const Tab* {
  std::size_t current = 0;
  for (const auto& slot : session.tabs) {
    if (slot.tab == nullptr) {
      continue;
    }
    if (current == position) {
      return slot.tab.get();
    }
    ++current;
  }
  return nullptr;
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
    auto first_pane =
        create_pane(session.columns, pane_rows(session.rows), session.cwd(),
                    session.launch_environment(), session.environment_mode, session.theme);
    if (first_pane == nullptr) {
      return nullptr;
    }
    const auto generation = next_generation(slot.generation);
    const auto id = TabId::from_parts(static_cast<std::uint32_t>(index), generation);
    std::unique_ptr<Tab> created;
    try {
      created = std::make_unique<Tab>(id, std::move(first_pane));
    } catch (const std::bad_alloc&) {
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
  std::unique_ptr<Session> session;
  try {
    session = std::make_unique<Session>(name, working_directory, environment, environment_mode);
  } catch (const std::bad_alloc&) {
    return nullptr;
  }
  if (allocate_tab(*session) == nullptr) {
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

void note_compression_activity(PaneRuntime& runtime) noexcept;
[[nodiscard]] auto update_copy_viewport_offset(Session& session, Pane& pane) noexcept -> bool;
void leave_copy_mode(Session& session) noexcept;

[[nodiscard]] auto resize_pane(Pane& pane, const render::PaneRectangle rectangle) noexcept -> bool {
  if (pane.rectangle == rectangle) {
    return true;
  }
  auto& runtime = pane.runtime;
  if (!resize_pane_terminal(runtime.pty, runtime.terminal, rectangle.columns, rectangle.rows)) {
    return false;
  }
  const auto synchronized = runtime.terminal.synchronized_output();
  if (!synchronized.has_value()) {
    return false;
  }
  static_cast<void>(
      runtime.presentation_gate.observe(*synchronized, true, std::chrono::steady_clock::now()));
  pane.rectangle = rectangle;
  record_terminal_mutation(runtime);
  note_compression_activity(runtime);
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
  // Each pane resize rolls canonical geometry back if its PTY update fails. A multi-pane layout can
  // still have earlier successful pane transactions, so fail closed rather than expose a partial
  // layout when any later pane rejects its target.
  const bool resolved = resolve_layout(tab);
  session.active = session.active && resolved;
  if (resolved && session.copy_mode.active && session.copy_mode.tab == tab.id) {
    auto* const pane = find_pane(tab, session.copy_mode.pane);
    if (pane == nullptr) {
      leave_copy_mode(session);
    } else {
      const auto refreshed = pane->runtime.terminal.refresh_selection();
      // Reflow updates Ghostty's tracked endpoints, but the renderer requires a freshly installed
      // selection snapshot. Re-anchor the viewport to that endpoint before saving its new offset.
      // If the refresh cannot be established, leave copy mode rather than allowing the subsequent
      // frame composition to tear down an otherwise healthy attachment.
      const auto scrolled =
          refreshed.has_value() && *refreshed
              ? pane->runtime.terminal.scroll_selection_into_view()
              : std::expected<bool, vt::Error>{std::unexpected(vt::Error::invalid_state)};
      if (!scrolled.has_value() || !update_copy_viewport_offset(session, *pane)) {
        leave_copy_mode(session);
      }
    }
  }
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

[[nodiscard]] auto copy_mode_pane(Session& session) noexcept -> Pane* {
  if (!session.copy_mode.active) {
    return nullptr;
  }
  auto* const tab = find_tab(session, session.copy_mode.tab);
  return tab == nullptr ? nullptr : find_pane(*tab, session.copy_mode.pane);
}

void note_compression_activity(PaneRuntime& runtime) noexcept {
  const auto activity = runtime.terminal.compression_activity();
  if (!activity.has_value()) {
    runtime.active = false;
    return;
  }
  if (*activity == runtime.compression_activity && runtime.compression_scheduled) {
    return;
  }
  if (*activity != runtime.compression_activity) {
    runtime.compression_activity = *activity;
  }
  runtime.compression_scheduled = true;
  runtime.compression_deadline =
      std::chrono::steady_clock::now() + limits::scrollback_compression_idle_delay;
}

void refresh_copy_mode_status(CopyModeState& state) noexcept {
  state.status_size = 0;
  const auto append = [&state](const std::string_view text) noexcept {
    const auto count = std::min(text.size(), state.status.size() - state.status_size);
    std::ranges::copy(std::span(text).first(count),
                      std::span(state.status).subspan(state.status_size, count).begin());
    state.status_size += count;
  };
  switch (state.feedback) {
  case CopyModeFeedback::no_match:
    append("COPY no match");
    return;
  case CopyModeFeedback::empty_selection:
    append("COPY empty");
    return;
  case CopyModeFeedback::clipboard_busy:
    append("COPY clipboard busy");
    return;
  case CopyModeFeedback::too_large:
    append("COPY too large");
    return;
  case CopyModeFeedback::failed:
    append("COPY failed");
    return;
  case CopyModeFeedback::none:
    break;
  }
  if (state.search_entry) {
    append(state.search_direction == vt::SearchDirection::forward ? "COPY /" : "COPY ?");
    append(state.query_view());
  } else if (state.search_pending) {
    append("COPY searching");
  } else if (state.extending) {
    append("COPY sel [Enter]");
  } else {
    append("COPY nav [Space]");
  }
}

[[nodiscard]] auto update_copy_viewport_offset(Session& session, Pane& pane) noexcept -> bool {
  const auto viewport = pane.runtime.terminal.viewport_state();
  if (!viewport.has_value()) {
    return false;
  }
  session.copy_mode.viewport_offset = viewport->offset;
  return true;
}

void leave_copy_mode(Session& session) noexcept {
  auto* const pane = copy_mode_pane(session);
  if (pane != nullptr) {
    pane->runtime.terminal.reset_selection_gesture();
    pane->runtime.terminal.clear_selection();
    pane->runtime.terminal.scroll_viewport(vt::ViewportScroll::bottom);
    note_compression_activity(pane->runtime);
  }
  const bool changed = session.copy_mode.active;
  session.copy_mode = {};
  if (changed) {
    session.status_valid = false;
    schedule_frame(session, FrameUrgency::state_change, true);
  }
}

void preserve_copy_viewport_after_mutation(Session& session, Pane& pane) noexcept {
  if (copy_mode_pane(session) != &pane) {
    return;
  }
  pane.runtime.terminal.scroll_viewport(
      vt::ViewportScroll::row, static_cast<std::int64_t>(session.copy_mode.viewport_offset));
  if (!update_copy_viewport_offset(session, pane)) {
    leave_copy_mode(session);
  }
}

[[nodiscard]] auto enter_copy_mode(Session& session, Tab& tab, Pane& pane) noexcept -> bool {
  leave_copy_mode(session);
  const auto update = pane.runtime.terminal.update_render_state();
  if (!update.has_value()) {
    return false;
  }
  const vt::TerminalPoint cursor{
      .space = vt::PointSpace::viewport,
      .column = update->cursor_in_viewport ? update->cursor_column : std::uint16_t{0},
      .row = update->cursor_in_viewport ? update->cursor_row
                                        : static_cast<std::uint32_t>(pane.rectangle.rows - 1U),
  };
  const auto selected = pane.runtime.terminal.select(vt::SelectionUnit::cell, cursor);
  if (!selected.has_value() || !*selected) {
    return false;
  }
  session.copy_mode = {};
  session.copy_mode.tab = tab.id;
  session.copy_mode.pane = pane.id;
  session.copy_mode.active = true;
  if (!update_copy_viewport_offset(session, pane)) {
    pane.runtime.terminal.clear_selection();
    session.copy_mode = {};
    return false;
  }
  refresh_copy_mode_status(session.copy_mode);
  session.status_valid = false;
  schedule_frame(session, FrameUrgency::state_change, true);
  return true;
}

[[nodiscard]] auto adjust_copy_selection(Session& session, Pane& pane,
                                         const vt::SelectionAdjustment adjustment) noexcept
    -> bool {
  const auto adjusted =
      pane.runtime.terminal.selection_adjust(adjustment, session.copy_mode.extending);
  if (!adjusted.has_value()) {
    leave_copy_mode(session);
    return false;
  }
  if (*adjusted) {
    const auto scrolled = pane.runtime.terminal.scroll_selection_into_view();
    if (!scrolled.has_value() || !update_copy_viewport_offset(session, pane)) {
      leave_copy_mode(session);
      return false;
    }
    session.copy_mode.feedback = CopyModeFeedback::none;
    refresh_copy_mode_status(session.copy_mode);
    session.status_valid = false;
    note_compression_activity(pane.runtime);
    schedule_frame(session, FrameUrgency::state_change, false);
  }
  return true;
}

[[nodiscard]] auto advance_copy_search_cursor(PaneRuntime& runtime, vt::TerminalPoint& point,
                                              vt::SearchDirection direction) noexcept -> bool;

void begin_copy_search(Session& session, Pane& pane, const vt::SearchDirection direction,
                       const bool continue_from_match = false) noexcept {
  if (session.copy_mode.query_size == 0) {
    refresh_copy_mode_status(session.copy_mode);
    session.status_valid = false;
    schedule_frame(session, FrameUrgency::state_change, false);
    return;
  }
  session.copy_mode.search_cursor.reset();
  const bool stale_match = session.copy_mode.search_generation != pane.runtime.mutation_generation;
  if (!continue_from_match || stale_match) {
    session.copy_mode.last_search_match.reset();
  } else if (session.copy_mode.last_search_match.has_value()) {
    auto point = session.copy_mode.last_search_match->start;
    if (!advance_copy_search_cursor(pane.runtime, point, direction)) {
      session.copy_mode.search_pending = false;
      session.copy_mode.feedback = CopyModeFeedback::no_match;
      refresh_copy_mode_status(session.copy_mode);
      session.status_valid = false;
      schedule_frame(session, FrameUrgency::state_change, false);
      return;
    }
    session.copy_mode.search_cursor = vt::SearchCursor{.candidate = point};
  }
  session.copy_mode.active_search_direction = direction;
  session.copy_mode.search_pending = true;
  session.copy_mode.search_deadline = std::chrono::steady_clock::now();
  session.copy_mode.feedback = CopyModeFeedback::none;
  session.copy_mode.search_generation = pane.runtime.mutation_generation;
  refresh_copy_mode_status(session.copy_mode);
  session.status_valid = false;
  schedule_frame(session, FrameUrgency::state_change, false);
}

[[nodiscard]] constexpr auto clipboard_base64_bytes(const std::size_t bytes) noexcept
    -> std::size_t {
  return 4U * ((bytes + 2U) / 3U);
}

[[nodiscard]] auto copy_selection_to_outer_clipboard(Session& session, Pane& pane) noexcept
    -> bool {
  constexpr std::size_t osc_overhead = 9;
  if (session.clipboard_write.bytes != nullptr) {
    session.copy_mode.feedback = CopyModeFeedback::clipboard_busy;
    refresh_copy_mode_status(session.copy_mode);
    return false;
  }
  if (session.frame.capacity() <= osc_overhead) {
    session.copy_mode.feedback = CopyModeFeedback::failed;
    refresh_copy_mode_status(session.copy_mode);
    return false;
  }
  const auto payload_groups = (session.frame.capacity() - osc_overhead) / 4U;
  const auto delivery_capacity = std::min(payload_groups * 3U, limits::selection_format_bytes_max);
  auto storage = allocate_clipboard_storage(delivery_capacity);
  if (storage == nullptr) {
    session.copy_mode.feedback = CopyModeFeedback::failed;
    refresh_copy_mode_status(session.copy_mode);
    return false;
  }
  const auto formatted = pane.runtime.terminal.format_selection(
      vt::ScreenFormat::plain, std::span(storage.get(), delivery_capacity));
  if (!formatted.has_value()) {
    session.copy_mode.feedback = formatted.error() == vt::Error::out_of_space
                                     ? CopyModeFeedback::too_large
                                     : CopyModeFeedback::failed;
    refresh_copy_mode_status(session.copy_mode);
    return false;
  }
  if (*formatted == 0) {
    session.copy_mode.feedback = CopyModeFeedback::empty_selection;
    refresh_copy_mode_status(session.copy_mode);
    return false;
  }
  if (clipboard_base64_bytes(*formatted) + osc_overhead > session.frame.capacity()) {
    session.copy_mode.feedback = CopyModeFeedback::too_large;
    refresh_copy_mode_status(session.copy_mode);
    return false;
  }
  session.clipboard_write.bytes = std::move(storage);
  session.clipboard_write.size = *formatted;
  leave_copy_mode(session);
  return true;
}

struct CopyInputKey final {
  std::uint8_t value{0};
};

enum class CopyEscapeStatus : std::uint8_t {
  pending,
  complete,
  unsupported,
  invalid,
};

struct CopyEscapeDecode final {
  CopyEscapeStatus status{CopyEscapeStatus::invalid};
  CopyInputKey key;
};

// Escape-sequence grammar deliberately keeps validation and mapping in one bounded pass.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto decode_copy_escape(const std::span<const std::byte> sequence) noexcept
    -> CopyEscapeDecode {
  LEMMA_ASSERT(!sequence.empty() && sequence.front() == std::byte{0x1B});
  if (sequence.size() == 1U) {
    return {.status = CopyEscapeStatus::pending, .key = {}};
  }
  const auto second = sequence.subspan(1, 1).front();
  if (second != std::byte{'['} && second != std::byte{'O'}) {
    return {.status = CopyEscapeStatus::invalid, .key = {}};
  }
  if (sequence.size() == 2U) {
    return {.status = CopyEscapeStatus::pending, .key = {}};
  }

  const auto final_byte = std::to_integer<std::uint8_t>(sequence.back());
  if (final_byte < 0x40U || final_byte > 0x7EU) {
    const bool continuation = (final_byte >= 0x20U && final_byte <= 0x3FU);
    return {.status = continuation && sequence.size() < copy_escape_bytes_max
                          ? CopyEscapeStatus::pending
                          : CopyEscapeStatus::unsupported,
            .key = {}};
  }

  if (sequence.size() == 3U) {
    switch (final_byte) {
    case static_cast<std::uint8_t>('A'):
      return {.status = CopyEscapeStatus::complete,
              .key = {.value = static_cast<std::uint8_t>('k')}};
    case static_cast<std::uint8_t>('B'):
      return {.status = CopyEscapeStatus::complete,
              .key = {.value = static_cast<std::uint8_t>('j')}};
    case static_cast<std::uint8_t>('C'):
      return {.status = CopyEscapeStatus::complete,
              .key = {.value = static_cast<std::uint8_t>('l')}};
    case static_cast<std::uint8_t>('D'):
      return {.status = CopyEscapeStatus::complete,
              .key = {.value = static_cast<std::uint8_t>('h')}};
    case static_cast<std::uint8_t>('H'):
      return {.status = CopyEscapeStatus::complete,
              .key = {.value = static_cast<std::uint8_t>('0')}};
    case static_cast<std::uint8_t>('F'):
      return {.status = CopyEscapeStatus::complete,
              .key = {.value = static_cast<std::uint8_t>('$')}};
    default:
      return {.status = CopyEscapeStatus::unsupported, .key = {}};
    }
  }

  if (second != std::byte{'['} || sequence.size() != 4U || final_byte != 0x7EU) {
    return {.status = CopyEscapeStatus::unsupported, .key = {}};
  }
  const auto parameter = std::to_integer<std::uint8_t>(sequence.subspan(2, 1).front());
  switch (parameter) {
  case static_cast<std::uint8_t>('1'):
  case static_cast<std::uint8_t>('7'):
    return {.status = CopyEscapeStatus::complete, .key = {.value = static_cast<std::uint8_t>('0')}};
  case static_cast<std::uint8_t>('4'):
  case static_cast<std::uint8_t>('8'):
    return {.status = CopyEscapeStatus::complete, .key = {.value = static_cast<std::uint8_t>('$')}};
  case static_cast<std::uint8_t>('5'):
    return {.status = CopyEscapeStatus::complete, .key = {.value = 0x15}};
  case static_cast<std::uint8_t>('6'):
    return {.status = CopyEscapeStatus::complete, .key = {.value = 0x04}};
  default:
    return {.status = CopyEscapeStatus::unsupported, .key = {}};
  }
}

// Copy-mode bytes are attachment UI input and never reach the child PTY. The current v1 client is
// legacy-byte based, so the default table intentionally uses single-byte vi bindings.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto process_copy_mode_input(Session& session,
                                           const std::span<const std::byte> input) noexcept
    -> std::size_t {
  auto* pane = copy_mode_pane(session);
  if (pane == nullptr) {
    leave_copy_mode(session);
    return input.size();
  }
  for (std::size_t index = 0; index < input.size(); ++index) {
    const auto byte = input.subspan(index, 1).front();
    const auto raw_value = std::to_integer<std::uint8_t>(byte);
    if (session.copy_mode.search_entry) {
      if (byte == std::byte{0x1B}) {
        session.copy_mode.search_entry = false;
        session.copy_mode.feedback = CopyModeFeedback::none;
        refresh_copy_mode_status(session.copy_mode);
        session.status_valid = false;
        schedule_frame(session, FrameUrgency::state_change, false);
      } else if (byte == std::byte{0x7F} || byte == std::byte{0x08}) {
        if (session.copy_mode.query_size > 0) {
          --session.copy_mode.query_size;
          refresh_copy_mode_status(session.copy_mode);
          session.status_valid = false;
          schedule_frame(session, FrameUrgency::state_change, false);
        }
      } else if (byte == std::byte{'\r'} || byte == std::byte{'\n'}) {
        session.copy_mode.search_entry = false;
        begin_copy_search(session, *pane, session.copy_mode.search_direction);
      } else if (raw_value >= 0x20 &&
                 session.copy_mode.query_size < session.copy_mode.query.size()) {
        std::span(session.copy_mode.query).subspan(session.copy_mode.query_size, 1).front() =
            static_cast<char>(raw_value);
        ++session.copy_mode.query_size;
        refresh_copy_mode_status(session.copy_mode);
        session.status_valid = false;
        schedule_frame(session, FrameUrgency::state_change, false);
      }
      continue;
    }

    auto value = raw_value;
    if (session.copy_mode.pending_escape_size > 0) {
      LEMMA_ASSERT(session.copy_mode.pending_escape_size < session.copy_mode.pending_escape.size());
      std::span(session.copy_mode.pending_escape)
          .subspan(session.copy_mode.pending_escape_size, 1)
          .front() = byte;
      ++session.copy_mode.pending_escape_size;
      const auto decoded = decode_copy_escape(
          std::span(session.copy_mode.pending_escape).first(session.copy_mode.pending_escape_size));
      if (decoded.status == CopyEscapeStatus::pending) {
        session.copy_mode.pending_escape_deadline =
            std::chrono::steady_clock::now() + copy_escape_flush_delay;
        continue;
      }
      session.copy_mode.pending_escape_size = 0;
      if (decoded.status == CopyEscapeStatus::complete) {
        value = decoded.key.value;
      } else if (decoded.status == CopyEscapeStatus::unsupported) {
        // Once a CSI/SS3 introducer has been consumed, its bounded sequence remains attachment UI
        // input even when this copy-mode key table does not support it.
        continue;
      } else {
        // A lone Escape is a complete copy-mode command when the next byte is not a
        // control-sequence introducer. Leave that byte unconsumed so ordinary routing can handle it
        // after copy mode.
        leave_copy_mode(session);
        return index;
      }
    } else if (byte == std::byte{0x1B}) {
      session.copy_mode.pending_escape.front() = byte;
      session.copy_mode.pending_escape_size = 1;
      session.copy_mode.pending_escape_deadline =
          std::chrono::steady_clock::now() + copy_escape_flush_delay;
      continue;
    }
    switch (value) {
    case 0x1B:
    case static_cast<std::uint8_t>('q'):
      leave_copy_mode(session);
      return index + 1U;
    case static_cast<std::uint8_t>('h'):
      static_cast<void>(adjust_copy_selection(session, *pane, vt::SelectionAdjustment::left));
      break;
    case static_cast<std::uint8_t>('j'):
      static_cast<void>(adjust_copy_selection(session, *pane, vt::SelectionAdjustment::down));
      break;
    case static_cast<std::uint8_t>('k'):
      static_cast<void>(adjust_copy_selection(session, *pane, vt::SelectionAdjustment::up));
      break;
    case static_cast<std::uint8_t>('l'):
      static_cast<void>(adjust_copy_selection(session, *pane, vt::SelectionAdjustment::right));
      break;
    case static_cast<std::uint8_t>('b'):
      static_cast<void>(adjust_copy_selection(session, *pane, vt::SelectionAdjustment::word_left));
      break;
    case static_cast<std::uint8_t>('w'):
      static_cast<void>(adjust_copy_selection(session, *pane, vt::SelectionAdjustment::word_right));
      break;
    case static_cast<std::uint8_t>('0'):
      static_cast<void>(
          adjust_copy_selection(session, *pane, vt::SelectionAdjustment::beginning_of_line));
      break;
    case static_cast<std::uint8_t>('$'):
      static_cast<void>(
          adjust_copy_selection(session, *pane, vt::SelectionAdjustment::end_of_line));
      break;
    case static_cast<std::uint8_t>('g'):
      static_cast<void>(adjust_copy_selection(session, *pane, vt::SelectionAdjustment::home));
      break;
    case static_cast<std::uint8_t>('G'):
      static_cast<void>(adjust_copy_selection(session, *pane, vt::SelectionAdjustment::end));
      break;
    case 0x15: // Ctrl-U
      static_cast<void>(adjust_copy_selection(session, *pane, vt::SelectionAdjustment::page_up));
      break;
    case 0x04: // Ctrl-D
      static_cast<void>(adjust_copy_selection(session, *pane, vt::SelectionAdjustment::page_down));
      break;
    case static_cast<std::uint8_t>(' '):
    case static_cast<std::uint8_t>('v'): {
      const auto collapsed = pane->runtime.terminal.collapse_selection_to_endpoint();
      if (!collapsed.has_value() || !*collapsed) {
        leave_copy_mode(session);
        break;
      }
      session.copy_mode.extending = true;
      session.copy_mode.feedback = CopyModeFeedback::none;
      refresh_copy_mode_status(session.copy_mode);
      session.status_valid = false;
      schedule_frame(session, FrameUrgency::state_change, false);
      break;
    }
    case static_cast<std::uint8_t>('y'):
    case static_cast<std::uint8_t>('\r'):
    case static_cast<std::uint8_t>('\n'):
      if (copy_selection_to_outer_clipboard(session, *pane)) {
        return index + 1U;
      }
      session.status_valid = false;
      schedule_frame(session, FrameUrgency::state_change, false);
      break;
    case static_cast<std::uint8_t>('/'):
    case static_cast<std::uint8_t>('?'):
      session.copy_mode.query_size = 0;
      session.copy_mode.search_entry = true;
      session.copy_mode.search_pending = false;
      session.copy_mode.search_cursor.reset();
      session.copy_mode.last_search_match.reset();
      session.copy_mode.feedback = CopyModeFeedback::none;
      session.copy_mode.search_direction =
          byte == std::byte{'/'} ? vt::SearchDirection::forward : vt::SearchDirection::backward;
      refresh_copy_mode_status(session.copy_mode);
      session.status_valid = false;
      schedule_frame(session, FrameUrgency::state_change, false);
      break;
    case static_cast<std::uint8_t>('n'):
      begin_copy_search(session, *pane, session.copy_mode.search_direction, true);
      break;
    case static_cast<std::uint8_t>('N'):
      begin_copy_search(session, *pane,
                        session.copy_mode.search_direction == vt::SearchDirection::forward
                            ? vt::SearchDirection::backward
                            : vt::SearchDirection::forward,
                        true);
      break;
    default:
      break;
    }
    if (!session.copy_mode.active) {
      return index + 1U;
    }
    pane = copy_mode_pane(session);
    if (pane == nullptr) {
      leave_copy_mode(session);
      return input.size();
    }
  }
  return input.size();
}

void service_copy_input_timeout(Session& session,
                                const std::chrono::steady_clock::time_point now) noexcept {
  if (session.copy_mode.active && session.copy_mode.pending_escape_size > 0 &&
      now >= session.copy_mode.pending_escape_deadline) {
    leave_copy_mode(session);
  }
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
  if (session.copy_mode.active && session.copy_mode.tab == id) {
    leave_copy_mode(session);
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
                             session.environment_mode, session.theme);
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
  if (session.copy_mode.active && session.copy_mode.tab == tab.id &&
      session.copy_mode.pane == pane_id) {
    leave_copy_mode(session);
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
  case protocol::PaneCommand::enter_copy_mode:
    command.kind = CommandKind::enter_copy_mode;
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
  if (session.copy_mode.active && command.kind != CommandKind::enter_copy_mode) {
    leave_copy_mode(session);
  }
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
  case CommandKind::enter_copy_mode:
    if (session.copy_mode.active) {
      leave_copy_mode(session);
      return {.status = CommandStatus::applied};
    }
    return enter_copy_mode(session, *tab, *targeted_pane)
               ? CommandResult{.status = CommandStatus::applied}
               : CommandResult{.status = CommandStatus::unavailable};
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
  case CommandKind::enter_copy_mode:
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
    const auto* const selected =
        tab_at_position(session, static_cast<std::size_t>(resolved.argument));
    if (selected != nullptr) {
      resolved.target.tab = selected->id;
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
    if (pane == nullptr || !pane->runtime.active ||
        (tab->zoomed && pane->id != tab->focused_pane)) {
      continue;
    }
    const bool copy_pane = session.copy_mode.active && session.copy_mode.tab == tab->id &&
                           session.copy_mode.pane == pane->id;
    const auto copy_cursor =
        copy_pane ? pane->runtime.terminal.selection_endpoint(vt::PointSpace::viewport)
                  : std::expected<std::optional<vt::TerminalPoint>, vt::Error>{
                        std::optional<vt::TerminalPoint>{}};
    const auto cursor = copy_cursor.value_or(std::optional<vt::TerminalPoint>{});
    const auto cursor_point = cursor.value_or(vt::TerminalPoint{});
    const bool cursor_override = cursor.has_value() && cursor_point.row < pane->rectangle.rows &&
                                 cursor_point.column < pane->rectangle.columns;
    std::span(storage).subspan(count, 1).front() = {
        .terminal = &pane->runtime.terminal,
        .rectangle = pane->rectangle,
        .cursor_override_column = cursor_override ? cursor_point.column : std::uint16_t{0},
        .cursor_override_row =
            cursor_override ? static_cast<std::uint16_t>(cursor_point.row) : std::uint16_t{0},
        .focused = pane->id == tab->focused_pane,
        .cursor_override = cursor_override,
        .presentation_suppressed = pane->runtime.presentation_gate.presentation_suppressed(),
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
  // Frame capacity changes only at this lifecycle boundary. Allocation failure preserves the old
  // storage and all terminal geometry, so the caller can reject the resize without partial state.
  const auto retained_frame_bytes = session.output.busy() ? session.output.frame_bytes() : 0;
  if (!session.frame.prepare({.columns = columns, .rows = rows}, retained_frame_bytes)) {
    return false;
  }
  // Record every physical resize and discard any unsent frame composed for the previous viewport.
  // A transiently tiny outer terminal is valid, but pane geometry cannot represent the split tree
  // until it fits again. Preserve that geometry and send a surface-free clear frame constrained to
  // the physical viewport instead of rendering stale rectangles outside it. Checking the unzoomed
  // tree also prevents an undersized viewport from becoming latent while zoomed.
  session.columns = columns;
  session.rows = rows;
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
    case protocol::ClientMessageKind::hello:
      return ParseResult::error;
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
      auto ordinary_input = message.input;
      if (session.retained_input_offset.has_value()) {
        if (*session.retained_input_offset > message.input.size()) {
          return ParseResult::error;
        }
        ordinary_input = message.input.subspan(*session.retained_input_offset);
      } else if (session.copy_mode.active) {
        const auto consumed = process_copy_mode_input(session, message.input);
        if (consumed > message.input.size()) {
          return ParseResult::error;
        }
        ordinary_input = message.input.subspan(consumed);
        if (ordinary_input.empty()) {
          break;
        }
        // Copy-mode mutation has already consumed this prefix. Retain that fact while the decoder
        // holds the message so a full PTY queue cannot replay UI-only bytes on retry.
        session.retained_input_offset = consumed;
      }
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
      trace_correlation = session.decoded_input_trace_matcher.observe(ordinary_input);
#endif
      auto& runtime = pane->runtime;
      diagnostic::record_latency_trace(diagnostic::LatencyTraceStage::daemon_input_message_received,
                                       static_cast<std::uint32_t>(runtime.pty),
                                       ordinary_input.size(), trace_correlation);
      const auto queued_bytes_before = runtime.pending_writes.size();
      const auto queued =
          queue_normalized_input(runtime.pending_writes, runtime.terminal, ordinary_input);
      if (queued == InputQueueResult::full) {
        return ParseResult::backpressure;
      }
      if (queued == InputQueueResult::encoding_failed) {
        return ParseResult::error;
      }
      if (latency_sensitive_input(ordinary_input.size())) {
        runtime.interactive_damage.await_write(queued_bytes_before, runtime.pending_writes.size());
      }
      session.retained_input_offset.reset();
      break;
    }
    case protocol::ClientMessageKind::host_theme:
      if (message.host_theme == nullptr) {
        return ParseResult::error;
      }
      if (!session.theme_bound) {
        if (!bind_session_theme(session, *message.host_theme)) {
          return ParseResult::error;
        }
        schedule_frame(session, FrameUrgency::state_change, true);
      }
      break;
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

[[nodiscard]] auto advance_copy_search_cursor(PaneRuntime& runtime, vt::TerminalPoint& point,
                                              const vt::SearchDirection direction) noexcept
    -> bool {
  const auto viewport = runtime.terminal.viewport_state();
  if (!viewport.has_value() || viewport->total_rows == 0) {
    return false;
  }
  const auto columns = runtime.terminal.size().columns;
  if (direction == vt::SearchDirection::forward) {
    if (point.column + 1U < columns) {
      ++point.column;
      return true;
    }
    if (static_cast<std::uint64_t>(point.row) + 1U >= viewport->total_rows) {
      return false;
    }
    point.column = 0;
    ++point.row;
    return true;
  }
  if (point.column > 0) {
    --point.column;
    return true;
  }
  if (point.row == 0) {
    return false;
  }
  point.column = static_cast<std::uint16_t>(columns - 1U);
  --point.row;
  return true;
}

[[nodiscard]] auto service_copy_search(Session& session, std::size_t& work_budget) noexcept
    -> bool {
  if (work_budget == 0 || !session.copy_mode.active || !session.copy_mode.search_pending ||
      std::chrono::steady_clock::now() < session.copy_mode.search_deadline) {
    return false;
  }
  const auto work_limit = std::min(work_budget, limits::search_candidates_per_step);
  work_budget -= work_limit;
  auto* const pane = copy_mode_pane(session);
  if (pane == nullptr) {
    leave_copy_mode(session);
    return true;
  }
  auto& runtime = pane->runtime;
  if (runtime.mutation_generation != session.copy_mode.search_generation) {
    session.copy_mode.search_generation = runtime.mutation_generation;
    session.copy_mode.search_cursor.reset();
    session.copy_mode.last_search_match.reset();
  }
  const auto searched = runtime.terminal.search_literal_step(
      session.copy_mode.query_view(), session.copy_mode.active_search_direction,
      session.copy_mode.search_cursor, work_limit);
  if (!searched.has_value()) {
    leave_copy_mode(session);
    return true;
  }
  switch (searched->status) {
  case vt::SearchStepStatus::found: {
    const auto selected = runtime.terminal.select_search_match(searched->match);
    const auto scrolled =
        selected.has_value()
            ? runtime.terminal.scroll_selection_into_view()
            : std::expected<bool, vt::Error>{std::unexpected(vt::Error::invalid_state)};
    if (!selected.has_value() || !scrolled.has_value()) {
      leave_copy_mode(session);
      return true;
    }
    session.copy_mode.search_pending = false;
    session.copy_mode.feedback = CopyModeFeedback::none;
    session.copy_mode.last_search_match = searched->match;
    session.copy_mode.search_cursor.reset();
    if (!update_copy_viewport_offset(session, *pane)) {
      leave_copy_mode(session);
      return true;
    }
    refresh_copy_mode_status(session.copy_mode);
    note_compression_activity(runtime);
    session.status_valid = false;
    schedule_frame(session, FrameUrgency::state_change, false);
    break;
  }
  case vt::SearchStepStatus::pending:
    session.copy_mode.search_cursor = searched->next;
    session.copy_mode.search_deadline = std::chrono::steady_clock::now() + copy_search_slice_delay;
    break;
  case vt::SearchStepStatus::not_found:
    session.copy_mode.search_pending = false;
    session.copy_mode.feedback = CopyModeFeedback::no_match;
    note_compression_activity(runtime);
    session.copy_mode.search_cursor.reset();
    refresh_copy_mode_status(session.copy_mode);
    session.status_valid = false;
    schedule_frame(session, FrameUrgency::state_change, false);
    break;
  }
  return true;
}

[[nodiscard]] auto tab_title(const Tab& tab) noexcept -> std::string_view {
  const auto* const focused = find_pane(tab, tab.focused_pane);
  LEMMA_ASSERT(focused != nullptr);
  const auto& runtime = focused->runtime;
  if (runtime.process_name_size > 0) {
    return {runtime.process_name.data(), runtime.process_name_size};
  }
  const auto title = runtime.terminal.title();
  return title.has_value() && !title->empty() ? *title : std::string_view{"shell"};
}

[[nodiscard]] auto status_tab_title(const Session& session, const Tab& tab) noexcept
    -> std::string_view {
  if (session.copy_mode.active && session.copy_mode.tab == tab.id) {
    return session.copy_mode.status_view();
  }
  return tab_title(tab);
}

[[nodiscard]] auto current_status_signature(const Session& session) noexcept -> std::uint64_t {
  constexpr std::uint64_t offset_basis = 14'695'981'039'346'656'037ULL;
  constexpr std::uint64_t prime = 1'099'511'628'211ULL;
  std::uint64_t signature = offset_basis;
  const auto mix = [&](const std::uint8_t value) {
    signature ^= value;
    signature *= prime;
  };
  std::uint8_t position = 0;
  for (const auto& slot : session.tabs) {
    if (slot.tab == nullptr) {
      continue;
    }
    ++position;
    mix(position);
    mix(slot.tab->id == session.active_tab ? 1U : 0U);
    const auto title = status_tab_title(session, *slot.tab);
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
      static_cast<void>(refresh_process_name(focused->runtime));
    }
    std::span(storage).subspan(count, 1).front() = {
        .number = static_cast<std::uint16_t>(count + 1U),
        .title = status_tab_title(session, *slot.tab),
        .active = slot.tab->id == session.active_tab,
    };
    ++count;
  }
  const auto signature = current_status_signature(session);
  const bool dirty = !session.status_valid || signature != session.status_signature;
  session.status_signature = signature;
  session.status_valid = true;
  return {
      .session_name = session.session_name(),
      .tabs = std::span(storage).first(count),
      .dirty = dirty,
  };
}

[[nodiscard]] auto encode_pending_clipboard_write(Session& session) noexcept
    -> std::optional<std::size_t> {
  if (session.clipboard_write.bytes == nullptr || session.clipboard_write.size == 0) {
    return std::nullopt;
  }
  constexpr std::string_view prefix = "\x1B]52;c;";
  constexpr std::string_view suffix = "\x1B\\";
  constexpr auto digits =
      std::to_array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
  auto output = session.frame.writable();
  const auto encoded_size =
      prefix.size() + clipboard_base64_bytes(session.clipboard_write.size) + suffix.size();
  if (encoded_size > output.size()) {
    return std::nullopt;
  }
  std::size_t used = 0;
  std::memcpy(output.data(), prefix.data(), prefix.size());
  used += prefix.size();
  const auto input = std::span(session.clipboard_write.bytes.get(), session.clipboard_write.size);
  for (std::size_t offset = 0; offset < input.size(); offset += 3U) {
    const auto remaining = input.size() - offset;
    const auto first = std::to_integer<std::uint32_t>(input.subspan(offset, 1).front());
    const auto second =
        remaining > 1U ? std::to_integer<std::uint32_t>(input.subspan(offset + 1U, 1).front()) : 0U;
    const auto third =
        remaining > 2U ? std::to_integer<std::uint32_t>(input.subspan(offset + 2U, 1).front()) : 0U;
    const auto value = (first << 16U) | (second << 8U) | third;
    const auto digit = [&digits](const std::uint32_t index) noexcept {
      return std::span(digits).subspan(index, 1).front();
    };
    const std::array encoded{
        digit((value >> 18U) & 0x3FU),
        digit((value >> 12U) & 0x3FU),
        remaining > 1U ? digit((value >> 6U) & 0x3FU) : '=',
        remaining > 2U ? digit(value & 0x3FU) : '=',
    };
    std::memcpy(output.subspan(used, encoded.size()).data(), encoded.data(), encoded.size());
    used += encoded.size();
  }
  std::memcpy(output.subspan(used, suffix.size()).data(), suffix.data(), suffix.size());
  used += suffix.size();
  LEMMA_ASSERT(used == encoded_size);
  return used;
}

[[nodiscard]] auto queue_pending_clipboard_write(Session& session,
                                                 const ClientFrameOutput::TimePoint now) noexcept
    -> bool {
  const auto encoded = encode_pending_clipboard_write(session);
  if (!encoded.has_value() || session.full_redraw_generation == 0 || session.server_sequence == 0) {
    return false;
  }
  const auto messages = ClientFrameOutput::frame_message_count(*encoded);
  if (messages == 0 ||
      messages > std::numeric_limits<std::uint32_t>::max() - session.server_sequence ||
      !session.output.queue_frame(*encoded, session.server_sequence, session.full_redraw_generation,
                                  false, now)) {
    return false;
  }
  session.server_sequence += static_cast<std::uint32_t>(messages);
  session.clipboard_write.bytes.reset();
  session.clipboard_write.size = 0;
  session.clipboard_write.redraw_after_write = true;
  return true;
}

[[nodiscard]] auto compose_session_frame(Session& session, const bool force_full,
                                         const ClientFrameOutput::TimePoint now) noexcept -> bool {
  if (session.clipboard_write.bytes != nullptr) {
    return queue_pending_clipboard_write(session, now);
  }
  std::array<render::PaneSurface, panes_per_tab_max> surface_storage{};
  std::array<render::StatusTab, render::status_tabs_max> status_storage{};
  const auto surfaces = collect_surfaces(session, surface_storage);
  const auto status = collect_status_line(session, status_storage);
  std::uint64_t trace_correlation = 0;
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  trace_correlation = session.frame_trace_correlation;
  diagnostic::set_latency_trace_correlation(trace_correlation);
#endif
  diagnostic::record_latency_trace(diagnostic::LatencyTraceStage::frame_composition_started,
                                   static_cast<std::uint32_t>(session.client), surfaces.size());
  const auto rendered =
      render::compose_retained_frame(surfaces, {.columns = session.columns, .rows = session.rows},
                                     session.frame, force_full, status);
  diagnostic::record_latency_trace(diagnostic::LatencyTraceStage::frame_composition_finished,
                                   static_cast<std::uint32_t>(session.client),
                                   rendered.has_value() ? rendered->bytes : 0);
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  diagnostic::set_latency_trace_correlation(0);
  session.frame_trace_correlation = 0;
#endif
  if (!rendered.has_value() || session.server_sequence == 0) {
    return false;
  }
  const auto frame_messages = ClientFrameOutput::frame_message_count(rendered->bytes);
  if (frame_messages == 0 ||
      frame_messages > std::numeric_limits<std::uint32_t>::max() - session.server_sequence) {
    return false;
  }
  auto generation = session.full_redraw_generation;
  if (rendered->full) {
    if (generation == std::numeric_limits<std::uint32_t>::max()) {
      return false;
    }
    ++generation;
  }
  if (generation == 0 ||
      !session.output.queue_frame(rendered->bytes, session.server_sequence, generation,
                                  rendered->full, now, trace_correlation)) {
    return false;
  }
  session.server_sequence += static_cast<std::uint32_t>(frame_messages);
  session.full_redraw_generation = generation;
  return true;
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
         output.append_number(static_cast<std::uint64_t>(focused->runtime.child)) &&
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
  std::size_t position = 0;
  for (const auto& slot : session.tabs) {
    if (slot.tab == nullptr) {
      continue;
    }
    ++position;
    const auto& tab = *slot.tab;
    const auto title_value = tab_title(tab);
    if (!output.append_text("lemma tab ") || !output.append_number(position) ||
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

class Sessions final {
  using Store = BoundedGenerationalStore<Session, SessionId, limits::sessions_hard_max>;

public:
  [[nodiscard]] auto insert(std::unique_ptr<Session> session) noexcept -> std::optional<SessionId> {
    if (session != nullptr) {
      session->frame.bind_capacity_budget(frame_capacity_budget_);
    }
    return sessions_.insert(std::move(session));
  }

  [[nodiscard]] auto get(const SessionId id) noexcept -> Session* { return sessions_.get(id); }
  [[nodiscard]] auto get(const SessionId id) const noexcept -> const Session* {
    return sessions_.get(id);
  }
  [[nodiscard]] auto erase(const SessionId id) noexcept -> bool { return sessions_.erase(id); }
  [[nodiscard]] auto size() const noexcept -> std::size_t { return sessions_.size(); }
  [[nodiscard]] static constexpr auto capacity() noexcept -> std::size_t {
    return Store::capacity();
  }
  [[nodiscard]] auto begin() noexcept { return sessions_.begin(); }
  [[nodiscard]] auto end() noexcept { return sessions_.end(); }
  [[nodiscard]] auto begin() const noexcept { return sessions_.begin(); }
  [[nodiscard]] auto end() const noexcept { return sessions_.end(); }

private:
  render::FrameCapacityBudget frame_capacity_budget_;
  Store sessions_;
};

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
  read_attach,
  read_name_size,
  read_name,
  read_working_directory_size,
  read_working_directory,
  read_environment_size,
  read_environment,
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
  protocol::ClientDecoder attach_decoder;
  protocol::Dimensions attach_dimensions{};
  std::optional<protocol::HostTerminalTheme> attach_host_theme;
  SessionId attach_session;
  std::chrono::steady_clock::time_point deadline;
  std::chrono::steady_clock::time_point setup_deadline;
};

// Pending setup storage is materialized only after accept claims a slot. The fixed table owns one
// optional RAII object per live setup instead of eagerly touching 128 x 135 KiB at daemon startup.
using PendingConnections =
    std::array<std::unique_ptr<PendingConnection>, limits::pending_connections_hard_max>;
using PendingConnectionGenerations =
    std::array<std::uint32_t, limits::pending_connections_hard_max>;
static_assert(sizeof(PendingConnection) <= std::size_t{152} * 1'024U);
static_assert(sizeof(PendingConnections) ==
              limits::pending_connections_hard_max * sizeof(std::unique_ptr<PendingConnection>));
static_assert(sizeof(PendingConnectionGenerations) ==
              limits::pending_connections_hard_max * sizeof(std::uint32_t));

// Once setup capacity is occupied, a small independent pool reads only the protocol discriminator
// needed to return a wire-compatible capacity response. These responders do not consume setup
// slots, so an attach peer can receive its framed rejection even while every setup slot is busy.
class CapacityRejectionOutput final {
public:
  [[nodiscard]] auto append(const std::span<const std::byte> bytes) noexcept -> bool {
    if (bytes.size() > storage_.size() - size_) {
      return false;
    }
    std::ranges::copy(bytes, std::span(storage_).subspan(size_).begin());
    size_ += bytes.size();
    return true;
  }
  [[nodiscard]] auto readable() const noexcept -> std::span<const std::byte> {
    return std::span(storage_).first(size_).subspan(offset_);
  }
  [[nodiscard]] auto busy() const noexcept -> bool { return offset_ < size_; }
  [[nodiscard]] auto consume(const std::size_t bytes) noexcept -> bool {
    if (bytes > size_ - offset_) {
      return false;
    }
    offset_ += bytes;
    return true;
  }
  void reset() noexcept {
    size_ = 0;
    offset_ = 0;
  }

private:
  std::array<std::byte, protocol::attach_header_bytes + 1U + protocol::diagnostic_bytes_max>
      storage_{};
  std::size_t size_{0};
  std::size_t offset_{0};
};

struct CapacityRejectionConnection final {
  [[nodiscard]] auto active() const noexcept -> bool { return descriptor >= 0; }

  int descriptor{-1};
  CapacityRejectionOutput output;
  std::chrono::steady_clock::time_point deadline;
  bool flush_response{false};
};

constexpr std::size_t capacity_rejection_connections_max = 8;
using CapacityRejectionConnections =
    std::array<CapacityRejectionConnection, capacity_rejection_connections_max>;
static_assert(sizeof(CapacityRejectionConnections) <= std::size_t{4} * 1'024U);

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
    if (session->client < 0) {
      session->frame.release();
    }
  }
  pending.attach_session = {};
}

void close_pending(PendingConnections& connections, const std::size_t slot,
                   Sessions& sessions) noexcept {
  auto& owner = std::span(connections).subspan(slot, 1).front();
  if (owner == nullptr) {
    return;
  }
  release_attach_reservation(*owner, slot, sessions);
  close_descriptor(owner->descriptor);
  owner.reset();
}

void close_capacity_rejection(CapacityRejectionConnections& connections,
                              const std::size_t slot) noexcept {
  auto& connection = std::span(connections).subspan(slot, 1).front();
  close_descriptor(connection.descriptor);
  connection.output.reset();
  connection.flush_response = false;
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

void finish_pending_disconnect(PendingConnection& pending, const protocol::DisconnectReason reason,
                               const std::string_view diagnostic) noexcept {
  pending.output.reset();
  const auto encoded = protocol::encode_disconnect(reason, diagnostic);
  const bool appended = pending.output.append(encoded.bytes());
  LEMMA_ASSERT(appended);
  finish_pending_output(pending);
}

[[nodiscard]] auto extension_error(const ExtensionRuntime* const extensions) noexcept
    -> std::string_view {
  return extensions == nullptr ? std::string_view{} : extensions->last_error();
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void prepare_unnamed_command(PendingConnection& pending, Sessions& sessions,
                             const ExtensionRuntime* const extensions) noexcept {
  bool prepared = true;
  if (pending.command == command_list) {
    prepared = append_extension_error(pending.output, extension_error(extensions)) &&
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
                           const ExtensionRuntime* const extensions) noexcept {
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
    if (!append_extension_error(pending.output, extension_error(extensions)) ||
        !append_listing(pending.output, *session)) {
      fail_pending_output(pending);
    } else {
      finish_pending_output(pending);
    }
    return;
  }
  if (pending.command == command_list_tabs) {
    if (!append_extension_error(pending.output, extension_error(extensions)) ||
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
    finish_pending_disconnect(pending, protocol::DisconnectReason::session_missing,
                              "no lemma session");
    return;
  }
  if (session->client >= 0 ||
      session->pending_attach_slot != std::numeric_limits<std::uint32_t>::max()) {
    finish_pending_disconnect(pending, protocol::DisconnectReason::session_busy,
                              "lemma session is already attached");
    return;
  }
  if (!session->theme_bound && pending.attach_host_theme.has_value() &&
      !bind_session_theme(*session, *pending.attach_host_theme)) {
    session->frame.release();
    finish_pending_disconnect(pending, protocol::DisconnectReason::setup_failed,
                              "failed to apply host terminal theme");
    return;
  }
  if (!resize_session(*session, pending.attach_dimensions)) {
    session->frame.release();
    finish_pending_disconnect(pending, protocol::DisconnectReason::setup_failed,
                              "failed to prepare attached viewport");
    return;
  }
  session->pending_attach_slot = static_cast<std::uint32_t>(slot);
  session->pending_attach_generation = pending.generation;
  pending.attach_session = session->id;
  pending.output.reset();
  const auto hello = protocol::encode_daemon_hello(pending.attach_dimensions);
  const bool appended = pending.output.append(hello.bytes());
  LEMMA_ASSERT(appended);
  finish_pending_output(pending, PendingAction::attach);
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void complete_pending_field(PendingConnection& pending, Sessions& sessions,
                            const ExtensionRuntime* const extensions) noexcept {
  switch (pending.state) {
  case PendingState::read_command:
    pending.command = pending.field.front();
    if (pending.command == protocol::attach_magic.front()) {
      pending.attach_decoder.reset();
      pending.attach_decoder.writable_bytes().front() = pending.command;
      const auto committed = pending.attach_decoder.commit(1);
      LEMMA_ASSERT(committed.has_value());
      pending.state = PendingState::read_attach;
    } else if (pending.command == command_list || pending.command == command_kill_all ||
               pending.command == command_shutdown) {
      pending.output.reset();
      prepare_unnamed_command(pending, sessions, extensions);
    } else if (pending.command == command_create ||
               pending.command == command_create_with_context ||
               pending.command == command_list_session || pending.command == command_list_tabs ||
               pending.command == command_kill) {
      begin_pending_field(pending, PendingState::read_name_size, 1);
    } else {
      pending.state = PendingState::unused;
    }
    break;
  case PendingState::read_attach:
    LEMMA_ASSERT(false);
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
  case PendingState::unused:
  case PendingState::flush_response:
    LEMMA_ASSERT(false);
    break;
  }
}

// The branches are the bounded outcomes of one nonblocking setup read.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void process_pending_fields(PendingConnections& connections, Sessions& sessions,
                            const ExtensionRuntime* const extensions,
                            const std::size_t slot) noexcept {
  auto* const pending = std::span(connections).subspan(slot, 1).front().get();
  LEMMA_ASSERT(pending != nullptr);
  constexpr std::size_t operations_per_turn_max = 8;
  for (std::size_t operation = 0; operation < operations_per_turn_max && pending->active() &&
                                  pending->state != PendingState::flush_response;
       ++operation) {
    if (pending->state == PendingState::read_attach) {
      const auto decoded = pending->attach_decoder.next();
      if (!decoded.has_value()) {
        const auto reason = decoded.error() == protocol::DecodeError::version_mismatch
                                ? protocol::DisconnectReason::version_mismatch
                                : protocol::DisconnectReason::protocol_error;
        finish_pending_disconnect(*pending, reason,
                                  protocol::decode_error_diagnostic(decoded.error()));
        continue;
      }
      if (decoded->has_value()) {
        const auto& message = **decoded;
        LEMMA_ASSERT(message.kind == protocol::ClientMessageKind::hello);
        pending->session = {};
        pending->session.size = message.session.size();
        std::ranges::copy(message.session, pending->session.bytes.begin());
        pending->attach_dimensions = message.dimensions;
        pending->attach_host_theme =
            message.host_theme == nullptr ? std::nullopt : std::optional{*message.host_theme};
        pending->attach_decoder.consume();
        prepare_attach(*pending, sessions, slot);
        continue;
      }
      auto available = pending->attach_decoder.writable_bytes();
      if (available.empty()) {
        finish_pending_disconnect(*pending, protocol::DisconnectReason::protocol_error,
                                  "attach decoder buffer exhausted");
        continue;
      }
      const auto received = ::recv(pending->descriptor, available.data(), available.size(), 0);
      if (received > 0) {
        if (!pending->attach_decoder.commit(static_cast<std::size_t>(received)).has_value()) {
          finish_pending_disconnect(*pending, protocol::DisconnectReason::protocol_error,
                                    "attach decoder buffer exhausted");
        } else {
          record_pending_progress(*pending);
        }
        continue;
      }
      if (received < 0 && errno == EINTR) {
        continue;
      }
      if (received < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
        return;
      }
      close_pending(connections, slot, sessions);
      return;
    }

    auto available = std::span(pending->field)
                         .subspan(pending->field_size, pending->field_target - pending->field_size);
    const auto received = ::recv(pending->descriptor, available.data(), available.size(), 0);
    if (received > 0) {
      pending->field_size += static_cast<std::size_t>(received);
      record_pending_progress(*pending);
      if (pending->field_size == pending->field_target) {
        complete_pending_field(*pending, sessions, extensions);
      }
      continue;
    }
    if (received < 0 && errno == EINTR) {
      continue;
    }
    if (received < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return;
    }
    close_pending(connections, slot, sessions);
    return;
  }
  if (!pending->active()) {
    close_pending(connections, slot, sessions);
  }
}

void process_pending_read(PendingConnections& connections, Sessions& sessions,
                          const ExtensionRuntime* const extensions,
                          const std::size_t slot) noexcept {
  auto* const pending = std::span(connections).subspan(slot, 1).front().get();
  LEMMA_ASSERT(pending != nullptr);
  if (std::chrono::steady_clock::now() >= pending->setup_deadline) {
    close_pending(connections, slot, sessions);
    return;
  }
  process_pending_fields(connections, sessions, extensions, slot);
}

void handle_client_parse_result(Session& session, ParseResult result) noexcept;

void handoff_attached_connection(PendingConnections& connections, const std::size_t slot,
                                 Sessions& sessions) noexcept {
  auto& owner = std::span(connections).subspan(slot, 1).front();
  LEMMA_ASSERT(owner != nullptr);
  auto& pending = *owner;
  Session* const session = sessions.get(pending.attach_session);
  if (session == nullptr || !session->active || session->pending_attach_slot != slot ||
      session->pending_attach_generation != pending.generation) {
    close_pending(connections, slot, sessions);
    return;
  }

  const int connection = pending.descriptor;
  pending.descriptor = -1;
  session->client = connection;
  session->decoder = pending.attach_decoder;
  release_attach_reservation(pending, slot, sessions);
  owner.reset();

  session->client_generation = next_generation(session->client_generation);
  session->client_id = ClientId::from_parts(session->id.slot(), session->client_generation);
  session->output.reset();
  session->server_sequence = 2;
  session->full_redraw_generation = 0;
  session->input_backpressured = false;
  session->retained_input_offset.reset();
  session->client_close_state = ClientCloseState::none;
  session->frame_scheduler.cancel();
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  session->frame_trace_correlation = 0;
#endif
  if (!compose_session_frame(*session, true, std::chrono::steady_clock::now())) {
    session->detach_client();
    return;
  }
  handle_client_parse_result(*session, parse_client_packets(*session));
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

[[nodiscard]] auto flush_pending_output(PendingConnections& connections, const std::size_t slot,
                                        std::size_t& global_budget, Sessions& sessions) noexcept
    -> bool {
  auto* const pending = std::span(connections).subspan(slot, 1).front().get();
  LEMMA_ASSERT(pending != nullptr);
  const auto action = pending->action;
  const auto status =
      flush_connection_output(pending->output, global_budget, &write_pending_output, pending);
  if (status == ConnectionFlushStatus::hard_error) {
    close_pending(connections, slot, sessions);
    return action == PendingAction::shutdown;
  }
  if (!pending->active() || status != ConnectionFlushStatus::drained) {
    return false;
  }
  if (action == PendingAction::attach) {
    handoff_attached_connection(connections, slot, sessions);
  } else {
    close_pending(connections, slot, sessions);
  }
  return action == PendingAction::shutdown;
}

void process_capacity_rejection_read(CapacityRejectionConnections& connections,
                                     const std::size_t slot) noexcept {
  auto& connection = std::span(connections).subspan(slot, 1).front();
  LEMMA_ASSERT(connection.active() && !connection.flush_response);
  std::byte discriminator{};
  const auto received = ::recv(connection.descriptor, &discriminator, 1, 0);
  if (received > 0) {
    connection.output.reset();
    if (discriminator == protocol::attach_magic.front()) {
      const auto rejection = protocol::encode_disconnect(
          protocol::DisconnectReason::capacity, "daemon pending connection capacity exhausted");
      const bool appended = connection.output.append(rejection.bytes());
      LEMMA_ASSERT(appended);
    } else {
      const bool appended = connection.output.append(std::span(&response_capacity, 1));
      LEMMA_ASSERT(appended);
    }
    connection.flush_response = true;
    connection.deadline = std::chrono::steady_clock::now() + setup_progress_timeout;
    return;
  }
  if (received < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) {
    return;
  }
  close_capacity_rejection(connections, slot);
}

[[nodiscard]] auto write_capacity_rejection_output(void* const context,
                                                   const std::span<const std::byte> bytes) noexcept
    -> ConnectionWriteAttempt {
  auto& connection = *static_cast<CapacityRejectionConnection*>(context);
  const auto sent = ::send(connection.descriptor, bytes.data(), bytes.size(), MSG_NOSIGNAL);
  if (sent > 0) {
    connection.deadline = std::chrono::steady_clock::now() + setup_progress_timeout;
  }
  return {.bytes = sent, .error = sent < 0 ? errno : 0};
}

void flush_capacity_rejection_output(CapacityRejectionConnections& connections,
                                     const std::size_t slot, std::size_t& global_budget) noexcept {
  auto& connection = std::span(connections).subspan(slot, 1).front();
  LEMMA_ASSERT(connection.active() && connection.flush_response);
  const auto status = flush_connection_output(connection.output, global_budget,
                                              &write_capacity_rejection_output, &connection);
  if (status == ConnectionFlushStatus::drained || status == ConnectionFlushStatus::hard_error) {
    close_capacity_rejection(connections, slot);
  }
}

// Deadline folding is bounded across the fixed session/tab/pane hierarchy.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto frame_poll_timeout(const Sessions& sessions, const FrameScheduler::TimePoint now,
                                      int timeout) noexcept -> int {
  const auto tighten = [now, &timeout](const std::optional<FrameScheduler::TimePoint> deadline) {
    if (!deadline.has_value()) {
      return false;
    }
    if (now >= *deadline) {
      timeout = 0;
      return true;
    }
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(*deadline - now);
    const auto candidate = static_cast<int>(std::max(remaining.count(), std::int64_t{1}));
    timeout = timeout < 0 ? candidate : std::min(timeout, candidate);
    return false;
  };
  for (const auto& session : sessions) {
    if (session == nullptr || !session->active) {
      continue;
    }
    if ((session->copy_mode.search_pending && tighten(session->copy_mode.search_deadline)) ||
        (session->copy_mode.pending_escape_size > 0 &&
         tighten(session->copy_mode.pending_escape_deadline)) ||
        tighten(session->frame_scheduler.deadline(frame_sink_state(*session))) ||
        tighten(session->output.deadline())) {
      return 0;
    }
    for (const auto& tab_slot : session->tabs) {
      if (tab_slot.tab == nullptr) {
        continue;
      }
      for (const auto& pane_slot : tab_slot.tab->panes) {
        if (pane_slot.pane == nullptr) {
          continue;
        }
        const auto& runtime = pane_slot.pane->runtime;
        if (tighten(runtime.presentation_gate.deadline()) ||
            (runtime.compression_scheduled && tighten(runtime.compression_deadline))) {
          return 0;
        }
      }
    }
  }
  return timeout;
}

[[nodiscard]] auto poll_timeout(const Sessions& sessions, const PendingConnections& pending,
                                const CapacityRejectionConnections& capacity_rejections,
                                const ExtensionRuntime* const extensions) noexcept -> int {
  const auto now = std::chrono::steady_clock::now();
  auto timeout = extensions == nullptr ? -1 : extensions->poll_timeout(now);
  const auto tighten = [now, &timeout](const auto& connection) {
    if (now >= connection.deadline) {
      return true;
    }
    const auto remaining =
        std::chrono::duration_cast<std::chrono::milliseconds>(connection.deadline - now);
    const auto candidate = static_cast<int>(std::max(remaining.count(), std::int64_t{1}));
    timeout = timeout < 0 ? candidate : std::min(timeout, candidate);
    return false;
  };
  for (const auto& connection : pending) {
    if (connection != nullptr && connection->active() && tighten(*connection)) {
      return 0;
    }
  }
  for (const auto& connection : capacity_rejections) {
    if (connection.active() && tighten(connection)) {
      return 0;
    }
  }
  return frame_poll_timeout(sessions, now, timeout);
}

struct PaneDamageAssessment final {
  bool interactive{false};
  bool status_changed{false};
};

[[nodiscard]] auto assess_pane_damage(Session& session, PaneRuntime& runtime,
                                      const PtyDrainResult& drained,
                                      const bool track_interactive_damage,
                                      const std::uint64_t interactive_status_before) noexcept
    -> PaneDamageAssessment {
  const auto status_after = current_status_signature(session);
  const bool interactive_status_damage =
      track_interactive_damage && status_after != interactive_status_before;
  const bool status_changed = !session.status_valid || status_after != session.status_signature;
  const bool visible_damage =
      drained.render_damage || interactive_status_damage || drained.damage_capture_failed;
  const bool interactive_damage = runtime.interactive_damage.pending() && visible_damage;
  if (interactive_damage) {
    // Damage in an inactive tab is already covered by its next full redraw. Do not let the input
    // latch promote an unrelated update after the tab becomes active again.
    static_cast<void>(runtime.interactive_damage.consume());
  }
  return {.interactive = interactive_damage, .status_changed = status_changed};
}

[[nodiscard]] auto frame_urgency(const PtyDrainResult& drained, const bool process_changed,
                                 const PaneDamageAssessment damage) noexcept -> FrameUrgency {
  if (drained.damage_capture_failed || drained.presentation_released) {
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

constexpr std::size_t blocked_sink_pty_read_bytes_per_turn_max = std::size_t{4} * 1'024U;

void process_pane_events(Session& session, Tab& tab, Pane& pane, const pollfd& events,
                         std::size_t& global_budget, std::size_t& blocked_session_budget) noexcept {
  if ((events.revents & (POLLIN | POLLHUP | POLLERR)) == 0) {
    return;
  }
  auto& runtime = pane.runtime;
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  auto* const trace_matcher = &runtime.output_trace_matcher;
#else
  diagnostic::LatencyTraceMarkerMatcher* const trace_matcher = nullptr;
#endif
  const bool track_interactive_damage = session.client >= 0 && runtime.interactive_damage.pending();
  const auto interactive_status_before =
      track_interactive_damage ? current_status_signature(session) : 0;
  // A client-blocked session keeps consuming canonical PTY state, but all of its ready panes share
  // one isolation slice so a many-pane session cannot spend the daemon-wide allowance by taking a
  // fresh slice for every pane.
  const bool blocked_sink = session.output.busy();
  std::size_t pane_budget =
      blocked_sink ? std::min(global_budget, blocked_session_budget) : global_budget;
  if (pane_budget == 0) {
    return;
  }
  const auto pane_budget_before = pane_budget;
  const auto drained =
      drain_pty(runtime.pty, runtime.terminal, runtime.presentation_gate, runtime.pending_writes,
                pane_budget, track_interactive_damage, trace_matcher);
  const auto bytes_drained = pane_budget_before - pane_budget;
  global_budget -= bytes_drained;
  if (blocked_sink) {
    blocked_session_budget -= bytes_drained;
  }
  runtime.active = drained.alive;
  if (drained.changed && runtime.active) {
    record_terminal_mutation(runtime);
    preserve_copy_viewport_after_mutation(session, pane);
    note_compression_activity(runtime);
  }
  const bool process_changed =
      refresh_process_name_if_due(runtime, std::chrono::steady_clock::now());
  if (!pane_event_changed(session, drained, process_changed)) {
    return;
  }
  const auto damage = assess_pane_damage(session, runtime, drained, track_interactive_damage,
                                         interactive_status_before);
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  if (drained.correlation != 0 && tab.id == session.active_tab && pane.id == tab.focused_pane) {
    session.frame_trace_correlation = drained.correlation;
  }
#endif
  if (tab.id == session.active_tab &&
      (!drained.presentation_deferred || process_changed || damage.status_changed)) {
    schedule_frame(session, frame_urgency(drained, process_changed, damage),
                   drained.damage_capture_failed || drained.force_full);
  } else if (damage.status_changed) {
    schedule_frame(session, FrameUrgency::state_change, false);
  }
}

void queue_client_disconnect_if_ready(Session& session) noexcept {
  if (session.client_close_state != ClientCloseState::queue_disconnect || session.output.busy()) {
    return;
  }
  if (session.server_sequence == 0 ||
      session.server_sequence == std::numeric_limits<std::uint32_t>::max() ||
      !session.output.queue_disconnect(protocol::DisconnectReason::protocol_error,
                                       "invalid client protocol message", session.server_sequence,
                                       std::chrono::steady_clock::now())) {
    session.detach_client();
    return;
  }
  ++session.server_sequence;
  session.client_close_state = ClientCloseState::disconnect_queued;
}

void handle_client_parse_result(Session& session, const ParseResult result) noexcept {
  session.input_backpressured = result == ParseResult::backpressure;
  if (result == ParseResult::detach) {
    session.detach_client();
    return;
  }
  if (result == ParseResult::error) {
    session.client_close_state = ClientCloseState::queue_disconnect;
    session.input_backpressured = false;
    queue_client_disconnect_if_ready(session);
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
  if (session.client >= 0 && session.client_close_state == ClientCloseState::none &&
      (session.input_backpressured || (events.revents & (POLLIN | POLLHUP | POLLERR)) != 0)) {
    handle_client_parse_result(session, receive_client(session));
  }
}

[[nodiscard]] auto write_pane_pty(void* const context,
                                  const std::span<const std::byte> bytes) noexcept
    -> PtyWriteAttempt {
  auto& runtime = *static_cast<PaneRuntime*>(context);
  const auto written = ::write(runtime.pty, bytes.data(), bytes.size());
  if (written > 0) {
    const auto size = static_cast<std::size_t>(written);
    runtime.interactive_damage.record_write(size);
    std::uint64_t trace_correlation = 0;
#ifdef LEMMA_ENABLE_LATENCY_TRACE
    trace_correlation = runtime.input_trace_matcher.observe(bytes.first(size));
#endif
    diagnostic::record_latency_trace(diagnostic::LatencyTraceStage::daemon_pty_write_progress,
                                     static_cast<std::uint32_t>(runtime.pty),
                                     static_cast<std::uint64_t>(written), trace_correlation);
  }
  return {.bytes = written, .error = written < 0 ? errno : 0};
}

[[nodiscard]] auto flush_pane_writes(PaneRuntime& runtime, std::size_t& global_budget) noexcept
    -> bool {
  return flush_pty_write_queue(runtime.pending_writes, global_budget, &write_pane_pty, &runtime) !=
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
      if (pane != nullptr && !pane->runtime.active) {
        static_cast<void>(close_pane(session, *tab, pane->id));
      }
    }
  }
}

// Collecting due panes traverses the fixed session hierarchy before the bounded fair work pass.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void run_due_scrollback_compression(Sessions& sessions, std::size_t& cursor) noexcept {
  constexpr std::size_t steps_per_turn_max = 8;
  const auto now = std::chrono::steady_clock::now();
  std::array<PaneRuntime*, static_cast<std::size_t>(limits::panes_hard_max)> due{};
  std::size_t count = 0;
  for (auto& session : sessions) {
    if (session == nullptr || !session->active) {
      continue;
    }
    for (auto& tab_slot : session->tabs) {
      if (tab_slot.tab == nullptr) {
        continue;
      }
      for (auto& pane_slot : tab_slot.tab->panes) {
        if (pane_slot.pane == nullptr) {
          continue;
        }
        auto& runtime = pane_slot.pane->runtime;
        if (runtime.active && runtime.compression_scheduled &&
            now >= runtime.compression_deadline) {
          std::span(due).subspan(count, 1).front() = &runtime;
          ++count;
        }
      }
    }
  }
  if (count == 0) {
    cursor = 0;
    return;
  }
  cursor %= count;
  const auto steps = std::min(count, steps_per_turn_max);
  for (std::size_t visited = 0; visited < steps; ++visited) {
    auto& runtime = *std::span(due).subspan((cursor + visited) % count, 1).front();
    const auto compressed = runtime.terminal.compress_scrollback();
    if (!compressed.has_value()) {
      runtime.active = false;
      runtime.compression_scheduled = false;
      continue;
    }
    runtime.compression_scheduled = *compressed == vt::CompressionResult::pending;
    if (runtime.compression_scheduled) {
      runtime.compression_deadline = now + scrollback_compression_slice_delay;
    }
  }
  cursor = (cursor + steps) % count;
}

// Gate expiry visits the same fixed hierarchy and schedules only visible active-tab repairs.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void release_expired_presentation_gates(Sessions& sessions) noexcept {
  const auto now = std::chrono::steady_clock::now();
  for (auto& session : sessions) {
    if (session == nullptr || !session->active) {
      continue;
    }
    for (auto& tab_slot : session->tabs) {
      if (tab_slot.tab == nullptr) {
        continue;
      }
      for (auto& pane_slot : tab_slot.tab->panes) {
        if (pane_slot.pane == nullptr) {
          continue;
        }
        const auto released = pane_slot.pane->runtime.presentation_gate.release_if_expired(now);
        if (released.urgent_render && tab_slot.tab->id == session->active_tab) {
          schedule_frame(*session, FrameUrgency::state_change, released.force_full);
        }
      }
    }
  }
}

void queue_due_frames(Sessions& sessions) noexcept {
  const auto now = std::chrono::steady_clock::now();
  for (auto& session : sessions) {
    if (session == nullptr || !session->active ||
        session->client_close_state != ClientCloseState::none ||
        !session->frame_scheduler.due(now, frame_sink_state(*session))) {
      continue;
    }
    if (!compose_session_frame(*session, session->frame_scheduler.force_full(), now)) {
      session->detach_client();
    }
    session->frame_scheduler.complete();
  }
}

[[nodiscard]] auto write_attached_client(void* const context,
                                         const std::span<const std::byte> bytes) noexcept
    -> ClientFrameWriteAttempt {
  auto& session = *static_cast<Session*>(context);
  const auto sent = ::send(session.client, bytes.data(), bytes.size(), MSG_NOSIGNAL);
  return {.bytes = sent, .error = sent < 0 ? errno : 0};
}

void expire_attached_client_frames(Sessions& sessions,
                                   const ClientFrameOutput::TimePoint now) noexcept {
  for (auto& session : sessions) {
    if (session != nullptr && session->active && session->client >= 0 &&
        session->output.expired(now)) {
      session->detach_client();
    }
  }
}

void flush_attached_client_frames(Sessions& sessions,
                                  const std::span<ClientFrameFlushTarget> storage,
                                  std::size_t& cursor,
                                  const ClientFrameOutput::TimePoint now) noexcept {
  std::size_t count = 0;
  for (auto& session : sessions) {
    if (session == nullptr || !session->active || session->client < 0) {
      continue;
    }
    LEMMA_ASSERT(count < storage.size());
    storage.subspan(count, 1).front() = {
        .descriptor = session->client,
        .frame = &session->frame,
        .output = &session->output,
        .write = &write_attached_client,
        .context = session.get(),
    };
    ++count;
  }

  std::size_t global_budget = attached_client_write_bytes_per_turn_max;
  auto active_targets = storage.first(count);
  flush_ready_client_frames(active_targets, cursor, global_budget, now);
  for (std::size_t index = 0; index < active_targets.size(); ++index) {
    auto& target = active_targets.subspan(index, 1).front();
    auto& session = *static_cast<Session*>(target.context);
    const auto status = target.status;
    if (status == ClientFrameFlushStatus::hard_error ||
        status == ClientFrameFlushStatus::deadline_exceeded ||
        (status == ClientFrameFlushStatus::drained &&
         session.client_close_state == ClientCloseState::disconnect_queued)) {
      session.detach_client();
    } else if (status == ClientFrameFlushStatus::drained) {
      if (session.clipboard_write.redraw_after_write) {
        session.clipboard_write.redraw_after_write = false;
        schedule_frame(session, FrameUrgency::state_change, true);
      }
      queue_client_disconnect_if_ready(session);
    }
  }
}

void expire_pending_connections(PendingConnections& pending_connections,
                                Sessions& sessions) noexcept {
  const auto now = std::chrono::steady_clock::now();
  for (std::size_t slot = 0; slot < pending_connections.size(); ++slot) {
    const auto& pending = std::span(pending_connections).subspan(slot, 1).front();
    if (pending != nullptr && pending->active() && now >= pending->deadline) {
      close_pending(pending_connections, slot, sessions);
    }
  }
}

void expire_capacity_rejections(CapacityRejectionConnections& connections) noexcept {
  const auto now = std::chrono::steady_clock::now();
  for (std::size_t slot = 0; slot < connections.size(); ++slot) {
    const auto& connection = std::span(connections).subspan(slot, 1).front();
    if (connection.active() && now >= connection.deadline) {
      close_capacity_rejection(connections, slot);
    }
  }
}

[[nodiscard]] auto empty_pending_slot(PendingConnections& pending_connections) noexcept
    -> std::optional<std::size_t> {
  for (std::size_t slot = 0; slot < pending_connections.size(); ++slot) {
    if (std::span(pending_connections).subspan(slot, 1).front() == nullptr) {
      return slot;
    }
  }
  return std::nullopt;
}

[[nodiscard]] auto empty_capacity_rejection_slot(CapacityRejectionConnections& connections) noexcept
    -> std::optional<std::size_t> {
  for (std::size_t slot = 0; slot < connections.size(); ++slot) {
    if (!std::span(connections).subspan(slot, 1).front().active()) {
      return slot;
    }
  }
  return std::nullopt;
}

// Acceptance exhaustively handles primary slots, bounded rejection slots, and allocation failure.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void accept_pending_connections(const int listener, PendingConnections& pending_connections,
                                PendingConnectionGenerations& generations,
                                CapacityRejectionConnections& capacity_rejections) noexcept {
  constexpr std::size_t accepts_per_turn_max = 8;
  for (std::size_t accepted = 0; accepted < accepts_per_turn_max; ++accepted) {
    const auto available = empty_pending_slot(pending_connections);
    std::optional<std::size_t> rejection_slot;
    if (!available.has_value()) {
      rejection_slot = empty_capacity_rejection_slot(capacity_rejections);
    }

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
    if (!available.has_value()) {
      if (!rejection_slot.has_value()) {
        // The bounded responder pool is reserved for peers whose protocol can still be identified.
        // Shed additional peers so silent saturated connections cannot gate listener service.
        close_descriptor(connection);
        continue;
      }
      auto& rejection = std::span(capacity_rejections).subspan(*rejection_slot, 1).front();
      rejection.descriptor = connection;
      rejection.output.reset();
      rejection.flush_response = false;
      rejection.deadline = std::chrono::steady_clock::now() + setup_progress_timeout;
      continue;
    }
    auto& owner = std::span(pending_connections).subspan(*available, 1).front();
    try {
      owner = std::make_unique<PendingConnection>();
    } catch (const std::bad_alloc&) {
      close_descriptor(connection);
      continue;
    }
    owner->descriptor = connection;
    auto& generation = std::span(generations).subspan(*available, 1).front();
    generation = next_generation(generation);
    owner->generation = generation;
    const auto now = std::chrono::steady_clock::now();
    owner->deadline = now + setup_progress_timeout;
    owner->setup_deadline = now + setup_total_timeout;
    begin_pending_field(*owner, PendingState::read_command, 1);
  }
}

enum class DescriptorKind : std::uint8_t {
  pane,
  client,
  pending,
  capacity_rejection,
  extension,
};

struct DescriptorOwner final {
  Session* session{nullptr};
  Tab* tab{nullptr};
  Pane* pane{nullptr};
  std::size_t pending_slot{0};
  std::size_t capacity_rejection_slot{0};
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
  PendingConnections pending_connections;
  PendingConnectionGenerations pending_generations{};
  CapacityRejectionConnections capacity_rejections{};
  std::unique_ptr<ExtensionRuntime> extensions;
  if (acquire_extension != nullptr) {
    try {
      extensions = std::make_unique<ExtensionRuntime>(
          acquire_extension, extension_context, report_extension_error, extension_error_context);
    } catch (const std::bad_alloc&) {
      return 1;
    }
  }
  if (!set_nonblocking(listener)) {
    return 1;
  }
  constexpr auto descriptor_count_max = std::size_t{2} + limits::panes_hard_max +
                                        static_cast<std::size_t>(limits::sessions_hard_max) +
                                        limits::pending_connections_hard_max +
                                        capacity_rejection_connections_max;
  std::array<pollfd, descriptor_count_max> descriptors{};
  std::array<DescriptorOwner, descriptor_count_max> owners{};
  std::array<ClientFrameFlushTarget, static_cast<std::size_t>(limits::sessions_hard_max)>
      client_flush_targets{};
  std::size_t pty_read_cursor = 0;
  std::size_t pty_flush_cursor = 0;
  std::size_t client_flush_cursor = 0;
  std::size_t search_cursor = 0;
  std::size_t compression_cursor = 0;

  while (true) {
    if (stop_requested != nullptr && stop_requested()) {
      return 0;
    }
    if (extensions != nullptr) {
      extensions->connect_if_due(std::chrono::steady_clock::now());
    }
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
          if (pane == nullptr || !pane->runtime.active) {
            continue;
          }
          const auto& runtime = pane->runtime;
          const auto pane_events = static_cast<short>(
              POLLIN | (!runtime.pending_writes.empty() ? static_cast<short>(POLLOUT) : 0));
          std::span(descriptors).subspan(descriptor_count, 1).front() = {
              .fd = runtime.pty, .events = pane_events, .revents = 0};
          std::span(owners).subspan(descriptor_count, 1).front() = {.session = session.get(),
                                                                    .tab = tab_slot.tab.get(),
                                                                    .pane = pane.get(),
                                                                    .kind = DescriptorKind::pane};
          ++descriptor_count;
        }
      }
      if (session->client >= 0) {
        const auto client_events = static_cast<short>(
            (session->input_backpressured || session->client_close_state != ClientCloseState::none
                 ? 0
                 : POLLIN) |
            (session->output.busy() ? static_cast<short>(POLLOUT) : 0));
        std::span(descriptors).subspan(descriptor_count, 1).front() = {
            .fd = session->client, .events = client_events, .revents = 0};
        std::span(owners).subspan(descriptor_count, 1).front() = {.session = session.get(),
                                                                  .kind = DescriptorKind::client};
        ++descriptor_count;
      }
    }
    for (std::size_t slot = 0; slot < pending_connections.size(); ++slot) {
      const auto& pending = std::span(pending_connections).subspan(slot, 1).front();
      if (pending == nullptr || !pending->active()) {
        continue;
      }
      const auto events =
          static_cast<short>(pending->state == PendingState::flush_response ? POLLOUT : POLLIN);
      std::span(descriptors).subspan(descriptor_count, 1).front() = {
          .fd = pending->descriptor, .events = events, .revents = 0};
      std::span(owners).subspan(descriptor_count, 1).front() = {.pending_slot = slot,
                                                                .kind = DescriptorKind::pending};
      ++descriptor_count;
    }
    for (std::size_t slot = 0; slot < capacity_rejections.size(); ++slot) {
      const auto& rejection = std::span(capacity_rejections).subspan(slot, 1).front();
      if (!rejection.active()) {
        continue;
      }
      const auto events = static_cast<short>(rejection.flush_response ? POLLOUT : POLLIN);
      std::span(descriptors).subspan(descriptor_count, 1).front() = {
          .fd = rejection.descriptor, .events = events, .revents = 0};
      std::span(owners).subspan(descriptor_count, 1).front() = {
          .capacity_rejection_slot = slot, .kind = DescriptorKind::capacity_rejection};
      ++descriptor_count;
    }
    if (extensions != nullptr && extensions->descriptor() >= 0) {
      std::span(descriptors).subspan(descriptor_count, 1).front() = {
          .fd = extensions->descriptor(), .events = POLLIN, .revents = 0};
      std::span(owners).subspan(descriptor_count, 1).front() = {.kind = DescriptorKind::extension};
      ++descriptor_count;
    }

    const auto poll_result =
        ::poll(descriptors.data(), static_cast<nfds_t>(descriptor_count),
               poll_timeout(sessions, pending_connections, capacity_rejections, extensions.get()));
    if (poll_result < 0) {
      if (errno == EINTR) {
        continue;
      }
      return 1;
    }
    expire_attached_client_frames(sessions, std::chrono::steady_clock::now());

    // Drain every ready PTY before handling client input, then remove exited panes so input is
    // always routed to a live focused pane selected by close_pane.
    std::size_t pty_read_budget = std::size_t{256} * 1'024U;
    std::array<std::size_t, static_cast<std::size_t>(limits::sessions_hard_max)>
        blocked_session_read_budgets{};
    blocked_session_read_budgets.fill(blocked_sink_pty_read_bytes_per_turn_max);
    const auto ready_owner_count = descriptor_count - 1U;
    if (ready_owner_count > 0) {
      pty_read_cursor %= ready_owner_count;
      std::size_t visited = 0;
      for (; visited < ready_owner_count && pty_read_budget > 0; ++visited) {
        const auto index = 1U + ((pty_read_cursor + visited) % ready_owner_count);
        const auto owner = std::span(owners).subspan(index, 1).front();
        if (owner.kind == DescriptorKind::pane) {
          const auto& events = std::span(descriptors).subspan(index, 1).front();
          auto& blocked_session_budget =
              std::span(blocked_session_read_budgets).subspan(owner.session->id.slot(), 1).front();
          process_pane_events(*owner.session, *owner.tab, *owner.pane, events, pty_read_budget,
                              blocked_session_budget);
        }
      }
      pty_read_cursor = (pty_read_cursor + visited) % ready_owner_count;
    } else {
      pty_read_cursor = 0;
    }
    for (auto& session : sessions) {
      if (session != nullptr && session->active) {
        reclaim_dead_panes(*session);
        service_copy_input_timeout(*session, std::chrono::steady_clock::now());
      }
    }
    for (std::size_t index = 1; index < descriptor_count; ++index) {
      const auto owner = std::span(owners).subspan(index, 1).front();
      if (owner.kind == DescriptorKind::client && owner.session->active) {
        const auto& events = std::span(descriptors).subspan(index, 1).front();
        if ((events.revents & (POLLOUT | POLLHUP | POLLERR)) != 0) {
          owner.session->output.mark_write_ready();
        }
        process_client_events(*owner.session, events);
      }
    }
    std::array<Session*, static_cast<std::size_t>(limits::sessions_hard_max)> search_sessions{};
    for (auto& session : sessions) {
      if (session != nullptr && session->active) {
        std::span(search_sessions).subspan(session->id.slot(), 1).front() = session.get();
      }
    }
    std::size_t search_work_budget = limits::search_candidates_per_step;
    std::size_t visited = 0;
    for (; visited < search_sessions.size() && search_work_budget > 0; ++visited) {
      auto* const session = std::span(search_sessions)
                                .subspan((search_cursor + visited) % search_sessions.size(), 1)
                                .front();
      if (session != nullptr) {
        static_cast<void>(service_copy_search(*session, search_work_budget));
      }
    }
    search_cursor = (search_cursor + visited) % search_sessions.size();
    for (std::size_t index = 1; index < descriptor_count; ++index) {
      const auto owner = std::span(owners).subspan(index, 1).front();
      if (owner.kind == DescriptorKind::pending) {
        const auto& pending = std::span(pending_connections).subspan(owner.pending_slot, 1).front();
        if (pending == nullptr || !pending->active()) {
          continue;
        }
        const auto events = std::span(descriptors).subspan(index, 1).front().revents;
        if (pending->state != PendingState::flush_response &&
            (events & (POLLIN | POLLHUP | POLLERR)) != 0) {
          process_pending_read(pending_connections, sessions, extensions.get(), owner.pending_slot);
        }
      } else if (owner.kind == DescriptorKind::capacity_rejection) {
        const auto& rejection =
            std::span(capacity_rejections).subspan(owner.capacity_rejection_slot, 1).front();
        const auto events = std::span(descriptors).subspan(index, 1).front().revents;
        if (rejection.active() && !rejection.flush_response &&
            (events & (POLLIN | POLLHUP | POLLERR)) != 0) {
          process_capacity_rejection_read(capacity_rejections, owner.capacity_rejection_slot);
        }
      }
    }

    // Writes are attempted only from retained queue bytes and are bounded both per pane and across
    // this turn. A hard descriptor error retires the pane; EAGAIN leaves all bytes queued.
    std::size_t pty_write_budget = std::size_t{1} * 1'024U * 1'024U;
    std::array<PaneRuntime*, static_cast<std::size_t>(limits::panes_hard_max)> writable_panes{};
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
          if (pane_slot.pane == nullptr) {
            continue;
          }
          auto& runtime = pane_slot.pane->runtime;
          if (runtime.active && !runtime.pending_writes.empty()) {
            std::span(writable_panes).subspan(writable_pane_count, 1).front() = &runtime;
            ++writable_pane_count;
          }
        }
      }
    }
    if (writable_pane_count > 0) {
      pty_flush_cursor %= writable_pane_count;
      std::size_t writable_visited = 0;
      for (; writable_visited < writable_pane_count && pty_write_budget > 0; ++writable_visited) {
        const auto index = (pty_flush_cursor + writable_visited) % writable_pane_count;
        auto& runtime = *std::span(writable_panes).subspan(index, 1).front();
        if (!flush_pane_writes(runtime, pty_write_budget)) {
          runtime.active = false;
        }
      }
      pty_flush_cursor = (pty_flush_cursor + writable_visited) % writable_pane_count;
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

    std::size_t pending_output_budget = std::size_t{256} * 1'024U;
    bool shutdown_after_outputs = false;
    for (std::size_t index = 1; index < descriptor_count; ++index) {
      const auto owner = std::span(owners).subspan(index, 1).front();
      const auto events = std::span(descriptors).subspan(index, 1).front().revents;
      if (owner.kind == DescriptorKind::pending) {
        const auto& pending = std::span(pending_connections).subspan(owner.pending_slot, 1).front();
        if (pending == nullptr || !pending->active() ||
            pending->state != PendingState::flush_response) {
          continue;
        }
        if ((events & (POLLOUT | POLLHUP | POLLERR)) != 0 &&
            flush_pending_output(pending_connections, owner.pending_slot, pending_output_budget,
                                 sessions)) {
          shutdown_after_outputs = true;
          break;
        }
      } else if (owner.kind == DescriptorKind::capacity_rejection) {
        const auto& rejection =
            std::span(capacity_rejections).subspan(owner.capacity_rejection_slot, 1).front();
        if (rejection.active() && rejection.flush_response &&
            (events & (POLLOUT | POLLHUP | POLLERR)) != 0) {
          flush_capacity_rejection_output(capacity_rejections, owner.capacity_rejection_slot,
                                          pending_output_budget);
        }
      }
    }

    run_due_scrollback_compression(sessions, compression_cursor);
    release_expired_presentation_gates(sessions);
    queue_due_frames(sessions);
    // Attached frame writes are core-owned, daemon-wide bounded, and round-robin fair. Newly
    // composed and newly handed-off attach frames get one immediate attempt; a blocked frame is
    // retried only after poll reports write readiness or its progress deadline expires.
    flush_attached_client_frames(sessions, client_flush_targets, client_flush_cursor,
                                 std::chrono::steady_clock::now());
    if (shutdown_after_outputs) {
      return 0;
    }
    expire_pending_connections(pending_connections, sessions);
    expire_capacity_rejections(capacity_rejections);
    reclaim_inactive_sessions(sessions);

    // Extension work is deliberately last: the reactor never waits for Lua before PTY progress,
    // client input, queued writes, or due frame composition.
    for (std::size_t index = 1; index < descriptor_count; ++index) {
      const auto owner = std::span(owners).subspan(index, 1).front();
      if (owner.kind == DescriptorKind::extension) {
        LEMMA_ASSERT(extensions != nullptr);
        extensions->process(std::span(descriptors).subspan(index, 1).front().revents);
      }
    }

    if ((descriptors.front().revents & POLLIN) != 0) {
      accept_pending_connections(listener, pending_connections, pending_generations,
                                 capacity_rejections);
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
