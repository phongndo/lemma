#include "core/engine.hpp"

#include "core/client_frame_output.hpp"
#include "core/connection_output.hpp"
#include "core/copy_mode.hpp"
#include "core/extension_runtime.hpp"
#include "core/frame_scheduler.hpp"
#include "core/input.hpp"
#include "core/layout.hpp"
#include "core/presentation_gate.hpp"
#include "core/pty_writer.hpp"
#include "core/session.hpp"
#include "core/terminal_resize.hpp"
#include "diagnostic/latency_trace.hpp"
#include "input/input_router.hpp"
#include "lemma/assert.hpp"
#include "lemma/command.hpp"
#include "lemma/generational_store.hpp"
#include "lemma/id.hpp"
#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"
#include "platform/io.hpp"
#include "platform/pty.hpp"
#include "protocol/attachment.hpp"
#include "protocol/extension.hpp"
#include "render/frame_buffer.hpp"
#include "render/pane_composition.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
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
#include <system_error>
#include <utility>
#include <variant>

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
constexpr auto command_rename_session =
    protocol::wire_byte(protocol::ControlCommand::rename_session);
constexpr auto command_rename_tab = protocol::wire_byte(protocol::ControlCommand::rename_tab);
constexpr auto command_kill = protocol::wire_byte(protocol::ControlCommand::kill);
constexpr auto command_kill_all = protocol::wire_byte(protocol::ControlCommand::kill_all);
constexpr auto command_shutdown = protocol::wire_byte(protocol::ControlCommand::shutdown);
constexpr auto response_ready = protocol::wire_byte(protocol::ControlResponse::ready);
constexpr auto response_missing = protocol::wire_byte(protocol::ControlResponse::missing);
constexpr auto response_capacity = protocol::wire_byte(protocol::ControlResponse::capacity);
constexpr auto response_conflict = protocol::wire_byte(protocol::ControlResponse::conflict);
constexpr auto response_failed = protocol::wire_byte(protocol::ControlResponse::failed);
constexpr std::size_t process_name_bytes_max = 64;
constexpr auto process_name_refresh_interval = std::chrono::milliseconds{100};
constexpr auto copy_escape_flush_delay = std::chrono::milliseconds{50};
constexpr auto copy_search_slice_delay = std::chrono::milliseconds{2};
constexpr auto scrollback_compression_slice_delay = std::chrono::milliseconds{2};
constexpr auto mouse_repeat_click_interval = std::chrono::milliseconds{500};
// SGR wheel reports are already normalized by the outer terminal. Applying another multiplier
// here makes Ghostty's default three-report discrete wheel step move nine rows.
constexpr std::int64_t mouse_wheel_scroll_rows = 1;
constexpr double mouse_repeat_click_distance = 1.0;
constexpr std::size_t copy_escape_bytes_max = 16;
// Decoder capacity is a storage bound, not a CPU bound. Every session gets a fresh bounded slice
// each reactor turn; geometry work is tighter because one message can reflow every pane in a tab.
constexpr std::size_t client_messages_per_turn_max = 16;
constexpr std::size_t client_geometry_messages_per_turn_max = 1;
constexpr std::size_t client_input_steps_per_turn_max = 16;
static_assert(client_messages_per_turn_max > 0 && client_geometry_messages_per_turn_max > 0 &&
              client_input_steps_per_turn_max > 0);
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
                                        const std::uint16_t requested_rows) noexcept
    -> TerminalResizeStatus {
  const auto columns = std::clamp(requested_columns, std::uint16_t{1}, protocol::columns_max);
  const auto rows = std::clamp(requested_rows, std::uint16_t{1}, protocol::rows_max);
  const vt::TerminalSize requested{.columns = columns, .rows = rows};
  auto descriptor = pty;
  return resize_terminal_transaction(terminal, requested, &resize_pty_for_transaction, &descriptor);
}

enum class PaneRuntimeFailure : std::uint8_t {
  child_exit,
  pty_read_error,
  pty_write_error,
  terminal_integrity_error,
  scrollback_compression_error,
  resize_consistency_lost,
};

struct PtyDrainResult final {
  std::optional<PaneRuntimeFailure> failure;
  bool changed{false};
  bool render_damage{false};
  bool presentation_deferred{false};
  bool presentation_released{false};
  bool force_full{false};
  bool damage_capture_failed{false};
  bool bell{false};
  bool title_changed{false};
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
  const auto effects = terminal.take_effects();
  // Desktop notifications use the same bounded visible-attention policy as BEL. Title, PWD, and
  // progress changes invalidate status metadata; denied clipboard and unknown sequences are
  // intentionally drained and dropped by policy at the adapter boundary.
  drain.bell = drain.bell || effects.bells > 0 || effects.desktop_notifications > 0;
  drain.title_changed = drain.title_changed || effects.title_changes > 0 ||
                        effects.pwd_changes > 0 || effects.progress_reports > 0;
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
        drain.failure = PaneRuntimeFailure::terminal_integrity_error;
        return drain;
      }
      continue;
    }
    if (bytes_read == 0) {
      drain.failure = PaneRuntimeFailure::child_exit;
      return drain;
    }
    if (errno == EINTR) {
      continue;
    }
    if (errno != EAGAIN && errno != EWOULDBLOCK) {
      drain.failure = PaneRuntimeFailure::pty_read_error;
    }
    return drain;
  }
  return drain;
}

[[nodiscard]] constexpr auto platform_environment_mode(const LaunchEnvironmentMode mode) noexcept
    -> platform::EnvironmentMode {
  return mode == LaunchEnvironmentMode::inherit ? platform::EnvironmentMode::inherit
                                                : platform::EnvironmentMode::replace;
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
  PaneRuntime(vt::Terminal&& created_terminal, const std::size_t scrollback_reservation) noexcept
      : terminal(std::move(created_terminal)), scrollback_bytes_reserved(scrollback_reservation) {}

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

  [[nodiscard]] auto live() const noexcept -> bool { return !failure.has_value(); }
  [[nodiscard]] auto publishable() const noexcept -> bool {
    return live() && pty >= 0 && child > 0 && !terminal.integrity_failed();
  }
  void fail(const PaneRuntimeFailure reason) noexcept {
    if (!failure.has_value()) {
      failure = reason;
    }
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
  std::size_t scrollback_bytes_reserved{0};
  std::chrono::steady_clock::time_point compression_deadline;
  bool compression_scheduled{false};
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  diagnostic::LatencyTraceMarkerMatcher input_trace_matcher;
  diagnostic::LatencyTraceMarkerMatcher output_trace_matcher;
#endif
  std::optional<PaneRuntimeFailure> failure;
};

struct PaneAddress final {
  SessionId session;
  PaneId pane;

  [[nodiscard]] auto valid() const noexcept -> bool {
    return session.is_valid() && pane.is_valid();
  }
};

// Pane identity is Session-scoped. A tab move changes only semantic membership and never rekeys the
// PTY, terminal, queues, or process owned by this direct runtime counterpart.
class PaneRuntimeStore final {
  struct PaneSlot final {
    std::unique_ptr<PaneRuntime> runtime;
    std::uint32_t generation{0};
  };

  struct SessionSlots final {
    explicit SessionSlots(const std::uint32_t assigned_generation) noexcept
        : generation(assigned_generation) {}

    std::array<PaneSlot, panes_per_session_max> panes{};
    std::size_t size{0};
    std::uint32_t generation{0};
  };

  [[nodiscard]] static constexpr auto address_in_bounds(const PaneAddress address) noexcept
      -> bool {
    return address.valid() && address.session.slot() < limits::sessions_hard_max &&
           address.pane.slot() < panes_per_session_max;
  }

  void release_scrollback(const std::size_t bytes) noexcept {
    LEMMA_ASSERT(scrollback_bytes_reserved_ >= bytes);
    scrollback_bytes_reserved_ -= bytes;
  }

public:
  [[nodiscard]] auto insert(const PaneAddress address,
                            std::unique_ptr<PaneRuntime> runtime) noexcept -> bool {
    if (!address_in_bounds(address) || runtime == nullptr || !runtime->publishable() ||
        size_ == limits::panes_hard_max ||
        runtime->scrollback_bytes_reserved >
            limits::terminal_scrollback_bytes_aggregate_max - scrollback_bytes_reserved_) {
      return false;
    }
    auto& session = std::span(sessions_).subspan(address.session.slot(), 1).front();
    if (session == nullptr) {
      try {
        session = std::make_unique<SessionSlots>(address.session.generation());
      } catch (const std::bad_alloc&) {
        return false;
      }
    } else if (session->generation != address.session.generation()) {
      return false;
    }
    auto& pane = std::span(session->panes).subspan(address.pane.slot(), 1).front();
    if (pane.runtime != nullptr) {
      return false;
    }
    pane.generation = address.pane.generation();
    scrollback_bytes_reserved_ += runtime->scrollback_bytes_reserved;
    pane.runtime = std::move(runtime);
    ++session->size;
    ++size_;
    return true;
  }

  [[nodiscard]] auto get(const PaneAddress address) noexcept -> PaneRuntime* {
    if (!address_in_bounds(address)) {
      return nullptr;
    }
    auto& session = std::span(sessions_).subspan(address.session.slot(), 1).front();
    if (session == nullptr || session->generation != address.session.generation()) {
      return nullptr;
    }
    auto& pane = std::span(session->panes).subspan(address.pane.slot(), 1).front();
    return pane.generation == address.pane.generation() ? pane.runtime.get() : nullptr;
  }

  [[nodiscard]] auto get(const PaneAddress address) const noexcept -> const PaneRuntime* {
    if (!address_in_bounds(address)) {
      return nullptr;
    }
    const auto& session = std::span(sessions_).subspan(address.session.slot(), 1).front();
    if (session == nullptr || session->generation != address.session.generation()) {
      return nullptr;
    }
    const auto& pane = std::span(session->panes).subspan(address.pane.slot(), 1).front();
    return pane.generation == address.pane.generation() ? pane.runtime.get() : nullptr;
  }

  [[nodiscard]] auto erase(const PaneAddress address) noexcept -> bool {
    if (!address_in_bounds(address)) {
      return false;
    }
    auto& session = std::span(sessions_).subspan(address.session.slot(), 1).front();
    if (session == nullptr || session->generation != address.session.generation()) {
      return false;
    }
    auto& pane = std::span(session->panes).subspan(address.pane.slot(), 1).front();
    if (pane.runtime == nullptr || pane.generation != address.pane.generation()) {
      return false;
    }
    release_scrollback(pane.runtime->scrollback_bytes_reserved);
    pane.runtime.reset();
    pane.generation = 0;
    --session->size;
    --size_;
    if (session->size == 0) {
      session.reset();
    }
    return true;
  }

  void erase_session(const SessionId session_id) noexcept {
    if (!session_id.is_valid() || session_id.slot() >= limits::sessions_hard_max) {
      return;
    }
    auto& session = std::span(sessions_).subspan(session_id.slot(), 1).front();
    if (session == nullptr || session->generation != session_id.generation()) {
      return;
    }
    for (const auto& pane : session->panes) {
      if (pane.runtime != nullptr) {
        release_scrollback(pane.runtime->scrollback_bytes_reserved);
      }
    }
    LEMMA_ASSERT(size_ >= session->size);
    size_ -= session->size;
    session.reset();
  }

  [[nodiscard]] auto size() const noexcept -> std::size_t { return size_; }
  [[nodiscard]] auto can_reserve_scrollback(const std::size_t bytes) const noexcept -> bool {
    return bytes <= limits::terminal_scrollback_bytes_aggregate_max - scrollback_bytes_reserved_;
  }

private:
  std::array<std::unique_ptr<SessionSlots>, limits::sessions_hard_max> sessions_{};
  std::size_t size_{0};
  std::size_t scrollback_bytes_reserved_{0};
};

static_assert(sizeof(PaneRuntimeStore) <= std::size_t{4} * 1'024U);

void record_terminal_mutation(PaneRuntime& runtime) noexcept {
  runtime.mutation_generation =
      runtime.mutation_generation == std::numeric_limits<std::uint64_t>::max()
          ? std::uint64_t{1}
          : runtime.mutation_generation + 1U;
}

enum class ConnectionCloseState : std::uint8_t {
  none,
  queue_disconnect,
  disconnect_queued,
};

[[nodiscard]] constexpr auto terminal_search_direction(const CopySearchDirection direction) noexcept
    -> vt::SearchDirection {
  return direction == CopySearchDirection::forward ? vt::SearchDirection::forward
                                                   : vt::SearchDirection::backward;
}

struct CopySearchTask final {
  vt::SearchCursor cursor;
  vt::TerminalPoint stop_before;
  std::chrono::steady_clock::time_point deadline;
  CopySearchDirection direction{CopySearchDirection::forward};
  std::uint64_t terminal_generation{0};
  bool wrapped{false};
};

struct CopyModeRuntimeState final {
  std::array<std::byte, copy_escape_bytes_max> pending_escape{};
  std::size_t pending_escape_size{0};
  std::optional<CopySearchTask> search_task;
  std::optional<vt::SearchMatch> last_search_match;
  std::optional<std::uint64_t> search_restore_viewport_offset;
  std::chrono::steady_clock::time_point pending_escape_deadline;
  std::uint64_t last_search_generation{0};
  bool preview_match{false};
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

struct AttachmentRuntime final {
  AttachmentRuntime() noexcept = default;
  AttachmentRuntime(const AttachmentRuntime&) = delete;
  auto operator=(const AttachmentRuntime&) -> AttachmentRuntime& = delete;
  AttachmentRuntime(AttachmentRuntime&&) = delete;
  auto operator=(AttachmentRuntime&&) -> AttachmentRuntime& = delete;
  ~AttachmentRuntime() { close_descriptor(client); }

  void reset_connection() noexcept {
    copy_mode = {};
    clipboard_write.reset();
    close_descriptor(client);
    connection_id = {};
    decoder.release();
    output.reset();
    frame.release();
    server_sequence = 2;
    full_redraw_generation = 0;
    pending_attach_slot = std::numeric_limits<std::uint32_t>::max();
    pending_attach_generation = 0;
    status_signature = 0;
    status_valid = false;
    bell_pending = false;
    input_backpressured = false;
    client_work_pending = false;
    client_close_state = ConnectionCloseState::none;
    client_close_reason = protocol::DisconnectReason::protocol_error;
    retained_input_offset.reset();
    pending_routed_input_size = 0;
    frame_scheduler.cancel();
#ifdef LEMMA_ENABLE_LATENCY_TRACE
    decoded_input_trace_matcher.reset();
    frame_trace_correlation = 0;
#endif
  }

  FrameBuffer frame;
  protocol::ClientDecoder decoder;
  ClientFrameOutput output;
  PendingClipboardWrite clipboard_write;
  CopyModeRuntimeState copy_mode;
  FrameScheduler frame_scheduler;
  ConnectionId connection_id;
  std::uint32_t server_sequence{2};
  std::uint32_t full_redraw_generation{0};
  std::uint32_t pending_attach_slot{std::numeric_limits<std::uint32_t>::max()};
  std::uint32_t pending_attach_generation{0};
  std::uint64_t status_signature{0};
  int client{-1};
  bool status_valid{false};
  bool bell_pending{false};
  bool input_backpressured{false};
  bool client_work_pending{false};
  ConnectionCloseState client_close_state{ConnectionCloseState::none};
  protocol::DisconnectReason client_close_reason{protocol::DisconnectReason::protocol_error};
  std::optional<std::size_t> retained_input_offset;
  std::array<std::byte, input::deferred_input_bytes_max + 1U> pending_routed_input{};
  std::uint8_t pending_routed_input_size{0};
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  diagnostic::LatencyTraceMarkerMatcher decoded_input_trace_matcher;
  std::uint64_t frame_trace_correlation{0};
#endif
};

// The runtime store owns one aggregate record per semantic Session. The three subobjects retain
// direct, stable addresses without adding connection-lifetime allocation or hot-path lookup.
struct SessionRecord final : Session {
  SessionRecord(const std::string_view session_name,
                const std::string_view initial_working_directory,
                const std::span<const std::byte> initial_environment,
                const LaunchEnvironmentMode initial_environment_mode) noexcept
      : Session(session_name, initial_working_directory, initial_environment,
                initial_environment_mode),
        input_router(input::default_input_map()), theme(vt::default_theme()) {}

  SessionRecord(const SessionRecord&) = delete;
  auto operator=(const SessionRecord&) -> SessionRecord& = delete;
  SessionRecord(SessionRecord&&) = delete;
  auto operator=(SessionRecord&&) -> SessionRecord& = delete;
  ~SessionRecord() = default;

  Attachment attachment;
  input::InputRouter input_router;
  AttachmentRuntime attachment_runtime;
  vt::TerminalTheme theme;
  std::uint32_t connection_generation{0};
};

static_assert(sizeof(AttachmentRuntime) <= std::size_t{16} * 1'024U);
static_assert(sizeof(SessionRecord) <= std::size_t{96} * 1'024U);

void finish_live_divider_resize(SessionRecord& session, bool discard_release = false) noexcept;

// Connection teardown resets only Attachment and AttachmentRuntime state. Session and PaneRuntime
// lifetimes remain independent, while the direct aggregate layout avoids a connection hot-path
// allocation or lookup.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void detach_attachment(SessionRecord& session, PaneRuntimeStore& runtimes) noexcept {
  finish_live_divider_resize(session);
  for (auto& pane_slot : session.panes) {
    if (pane_slot.pane == nullptr) {
      continue;
    }
    auto* const runtime = runtimes.get({.session = session.id, .pane = pane_slot.pane->id});
    LEMMA_ASSERT(runtime != nullptr);
    runtime->terminal.reset_selection_gesture();
    runtime->terminal.clear_selection_checkpoint();
    runtime->terminal.clear_selection();
    runtime->terminal.scroll_viewport(vt::ViewportScroll::bottom);
    runtime->interactive_damage.reset();
  }

  session.attachment.copy_mode = {};
  session.attachment.rename_prompt = {};
  session.input_router.reset();
  session.attachment.selection_target.reset();
  session.attachment.mouse_capture.reset();
  session.attachment_runtime.reset_connection();
}

[[nodiscard]] constexpr auto pane_rows(const std::uint16_t viewport_rows) noexcept
    -> std::uint16_t {
  return viewport_rows >= 2 ? static_cast<std::uint16_t>(viewport_rows - 1U) : viewport_rows;
}

[[nodiscard]] constexpr auto terminal_color(const protocol::RgbColor color) noexcept
    -> vt::RgbColor {
  return {.red = color.red, .green = color.green, .blue = color.blue};
}

[[nodiscard]] constexpr auto terminal_mouse_button(const protocol::MouseInputButton button) noexcept
    -> std::optional<vt::MouseButton> {
  switch (button) {
  case protocol::MouseInputButton::none:
    return std::nullopt;
  case protocol::MouseInputButton::left:
    return vt::MouseButton::left;
  case protocol::MouseInputButton::right:
    return vt::MouseButton::right;
  case protocol::MouseInputButton::middle:
    return vt::MouseButton::middle;
  case protocol::MouseInputButton::four:
    return vt::MouseButton::four;
  case protocol::MouseInputButton::five:
    return vt::MouseButton::five;
  case protocol::MouseInputButton::six:
    return vt::MouseButton::six;
  case protocol::MouseInputButton::seven:
    return vt::MouseButton::seven;
  case protocol::MouseInputButton::eight:
    return vt::MouseButton::eight;
  case protocol::MouseInputButton::nine:
    return vt::MouseButton::nine;
  case protocol::MouseInputButton::ten:
    return vt::MouseButton::ten;
  case protocol::MouseInputButton::eleven:
    return vt::MouseButton::eleven;
  }
  return std::nullopt;
}

[[nodiscard]] auto rollback_session_theme(const std::span<PaneRuntime* const> changed,
                                          const vt::TerminalTheme& previous) noexcept -> bool {
  bool restored = true;
  for (std::size_t remaining = changed.size(); remaining > 0; --remaining) {
    auto* const runtime = changed.subspan(remaining - 1U, 1).front();
    LEMMA_ASSERT(runtime != nullptr);
    if (!runtime->terminal.set_theme(previous).has_value()) {
      runtime->fail(PaneRuntimeFailure::terminal_integrity_error);
      restored = false;
    }
  }
  return restored;
}

// Theme application is one fixed bounded transaction across the session hierarchy.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto bind_session_theme(SessionRecord& session, PaneRuntimeStore& runtimes,
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
  std::array<PaneRuntime*, panes_per_session_max> changed{};
  std::size_t changed_count = 0;
  for (auto& pane_slot : session.panes) {
    if (pane_slot.pane == nullptr) {
      continue;
    }
    auto* const runtime = runtimes.get({.session = session.id, .pane = pane_slot.pane->id});
    LEMMA_ASSERT(runtime != nullptr && changed_count < changed.size());
    if (!runtime->terminal.set_theme(theme).has_value()) {
      const bool restored =
          rollback_session_theme(std::span(changed).first(changed_count), session.theme);
      session.active = session.active && restored;
      return false;
    }
    std::span(changed).subspan(changed_count, 1).front() = runtime;
    ++changed_count;
  }
  session.theme = theme;
  session.theme_bound = true;
  return true;
}

[[nodiscard]] auto create_pane_runtime(const std::uint16_t columns, const std::uint16_t rows,
                                       const std::string_view working_directory,
                                       const std::span<const std::byte> environment,
                                       const LaunchEnvironmentMode environment_mode,
                                       const vt::TerminalTheme& theme) noexcept
    -> std::unique_ptr<PaneRuntime> {
  vt::TerminalOptions options;
  options.size = {.columns = columns, .rows = rows};
  options.theme = theme;
  auto terminal_result = vt::Terminal::create(options);
  if (!terminal_result.has_value()) {
    return nullptr;
  }
  std::unique_ptr<PaneRuntime> runtime;
  try {
    runtime =
        std::make_unique<PaneRuntime>(std::move(*terminal_result), options.scrollback_bytes_max);
  } catch (const std::bad_alloc&) {
    return nullptr;
  }
  runtime->child = platform::spawn_login_shell(runtime->pty, working_directory, environment,
                                               platform_environment_mode(environment_mode));
  if (runtime->child <= 0 || !set_nonblocking(runtime->pty) ||
      !platform::resize_pty(runtime->pty, columns, rows)) {
    return nullptr;
  }
  const auto compression_activity = runtime->terminal.compression_activity();
  if (!compression_activity.has_value()) {
    return nullptr;
  }
  runtime->compression_activity = *compression_activity;
  return runtime;
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
  LEMMA_ASSERT(generation < std::numeric_limits<std::uint32_t>::max());
  return generation + 1U;
}

[[nodiscard]] auto find_pane(SessionRecord& session, const PaneId id) noexcept -> Pane* {
  if (!id.is_valid() || id.slot() >= session.panes.size()) {
    return nullptr;
  }
  auto& slot = std::span(session.panes).subspan(id.slot(), 1).front();
  return slot.generation == id.generation() ? slot.pane.get() : nullptr;
}

[[nodiscard]] auto find_pane(const SessionRecord& session, const PaneId id) noexcept
    -> const Pane* {
  if (!id.is_valid() || id.slot() >= session.panes.size()) {
    return nullptr;
  }
  const auto& slot = std::span(session.panes).subspan(id.slot(), 1).front();
  return slot.generation == id.generation() ? slot.pane.get() : nullptr;
}

[[nodiscard]] auto find_pane(SessionRecord& session, const Tab& tab, const PaneId id) noexcept
    -> Pane* {
  auto* const pane = find_pane(session, id);
  return pane != nullptr && pane->tab == tab.id ? pane : nullptr;
}

[[nodiscard]] auto find_pane(const SessionRecord& session, const Tab& tab, const PaneId id) noexcept
    -> const Pane* {
  const auto* const pane = find_pane(session, id);
  return pane != nullptr && pane->tab == tab.id ? pane : nullptr;
}

[[nodiscard]] auto find_tab(SessionRecord& session, const TabId id) noexcept -> Tab* {
  if (!id.is_valid() || id.slot() >= session.tabs.size()) {
    return nullptr;
  }
  auto& slot = std::span(session.tabs).subspan(id.slot(), 1).front();
  return slot.generation == id.generation() ? slot.tab.get() : nullptr;
}

[[nodiscard]] auto find_tab(const SessionRecord& session, const TabId id) noexcept -> const Tab* {
  if (!id.is_valid() || id.slot() >= session.tabs.size()) {
    return nullptr;
  }
  const auto& slot = std::span(session.tabs).subspan(id.slot(), 1).front();
  return slot.generation == id.generation() ? slot.tab.get() : nullptr;
}

[[nodiscard]] auto active_tab(SessionRecord& session) noexcept -> Tab* {
  return find_tab(session, session.active_tab);
}

[[nodiscard]] auto active_tab(const SessionRecord& session) noexcept -> const Tab* {
  return find_tab(session, session.active_tab);
}

[[nodiscard]] auto pane_address(const SessionRecord& session, const Pane& pane) noexcept
    -> PaneAddress {
  return {.session = session.id, .pane = pane.id};
}

[[nodiscard]] auto find_pane_runtime(PaneRuntimeStore& runtimes, const SessionRecord& session,
                                     const Pane& pane) noexcept -> PaneRuntime* {
  return runtimes.get(pane_address(session, pane));
}

[[nodiscard]] auto find_pane_runtime(const PaneRuntimeStore& runtimes, const SessionRecord& session,
                                     const Pane& pane) noexcept -> const PaneRuntime* {
  return runtimes.get(pane_address(session, pane));
}

[[nodiscard]] auto find_pane_runtime(PaneRuntimeStore& runtimes, const SessionRecord& session,
                                     const Tab& tab, const Pane& pane) noexcept -> PaneRuntime* {
  LEMMA_ASSERT(pane.tab == tab.id);
  return find_pane_runtime(runtimes, session, pane);
}

[[nodiscard]] auto find_pane_runtime(const PaneRuntimeStore& runtimes, const SessionRecord& session,
                                     const Tab& tab, const Pane& pane) noexcept
    -> const PaneRuntime* {
  LEMMA_ASSERT(pane.tab == tab.id);
  return find_pane_runtime(runtimes, session, pane);
}

[[nodiscard]] auto pane_count(const Tab& tab) noexcept -> std::size_t {
  return tab.layout.pane_count();
}

[[nodiscard]] auto pane_count(const SessionRecord& session) noexcept -> std::size_t {
  return static_cast<std::size_t>(std::ranges::count_if(
      session.panes, [](const PaneSlot& slot) { return slot.pane != nullptr; }));
}

[[nodiscard]] auto tab_count(const SessionRecord& session) noexcept -> std::size_t {
  return session.tab_order.size();
}

[[nodiscard]] auto tab_at_position(const SessionRecord& session,
                                   const std::size_t position) noexcept -> const Tab* {
  const auto id = session.tab_order.at(position);
  return id.has_value() ? find_tab(session, *id) : nullptr;
}

[[nodiscard]] auto empty_pane_slot(const SessionRecord& session) noexcept
    -> std::optional<std::size_t> {
  for (std::size_t index = 0; index < session.panes.size(); ++index) {
    const auto& slot = std::span(session.panes).subspan(index, 1).front();
    if (slot.pane == nullptr && slot.generation < std::numeric_limits<std::uint32_t>::max()) {
      return index;
    }
  }
  return std::nullopt;
}

// Allocation stages all fallible owners before publishing the Session pane/tab/order relation.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto allocate_tab(SessionRecord& session, PaneRuntimeStore& runtimes) noexcept
    -> Tab* {
  if (!session.id.is_valid() || tab_count(session) >= session.tabs.size() ||
      pane_count(session) >= panes_per_session_max || runtimes.size() >= limits::panes_hard_max ||
      !runtimes.can_reserve_scrollback(limits::terminal_scrollback_bytes_default)) {
    return nullptr;
  }
  const auto pane_index = empty_pane_slot(session);
  if (!pane_index.has_value()) {
    return nullptr;
  }
  auto& pane_slot = std::span(session.panes).subspan(*pane_index, 1).front();
  const auto pane_generation = next_generation(pane_slot.generation);
  const auto pane_id = PaneId::from_parts(static_cast<std::uint32_t>(*pane_index), pane_generation);

  for (std::size_t index = 0; index < session.tabs.size(); ++index) {
    auto& tab_slot = std::span(session.tabs).subspan(index, 1).front();
    if (tab_slot.tab != nullptr ||
        tab_slot.generation == std::numeric_limits<std::uint32_t>::max()) {
      continue;
    }
    const auto tab_generation = next_generation(tab_slot.generation);
    const auto tab_id = TabId::from_parts(static_cast<std::uint32_t>(index), tab_generation);
    const PaneAddress address{.session = session.id, .pane = pane_id};
    auto runtime = create_pane_runtime(
        session.attachment.columns, pane_rows(session.attachment.rows), session.cwd(),
        session.launch_environment(), session.environment_mode, session.theme);
    if (runtime == nullptr) {
      return nullptr;
    }
    std::unique_ptr<Pane> first_pane;
    std::unique_ptr<Tab> created;
    try {
      first_pane = std::make_unique<Pane>(Pane{
          .id = pane_id,
          .tab = tab_id,
          .rectangle = {.columns = session.attachment.columns,
                        .rows = pane_rows(session.attachment.rows)},
      });
      created = std::make_unique<Tab>(tab_id, pane_id);
    } catch (const std::bad_alloc&) {
      return nullptr;
    }
    created->layout_columns = session.attachment.columns;
    created->layout_rows = pane_rows(session.attachment.rows);
    if (!runtimes.insert(address, std::move(runtime))) {
      return nullptr;
    }
    if (!session.tab_order.append(tab_id)) {
      const bool erased = runtimes.erase(address);
      LEMMA_ASSERT(erased);
      return nullptr;
    }
    pane_slot.generation = pane_generation;
    pane_slot.pane = std::move(first_pane);
    tab_slot.generation = tab_generation;
    tab_slot.tab = std::move(created);
    session.previous_tab = session.active_tab;
    session.active_tab = tab_id;
    return tab_slot.tab.get();
  }
  return nullptr;
}

[[nodiscard]] auto create_session(
    const std::string_view name, const std::string_view working_directory = {},
    const std::span<const std::byte> environment = {},
    const LaunchEnvironmentMode environment_mode = LaunchEnvironmentMode::inherit) noexcept
    -> std::unique_ptr<SessionRecord> {
  try {
    return std::make_unique<SessionRecord>(name, working_directory, environment, environment_mode);
  } catch (const std::bad_alloc&) {
    return nullptr;
  }
}

void note_compression_activity(PaneRuntime& runtime) noexcept;
[[nodiscard]] auto update_copy_viewport_offset(SessionRecord& session,
                                               PaneRuntime& runtime) noexcept -> bool;
void leave_copy_mode(SessionRecord& session, PaneRuntimeStore& runtimes) noexcept;

enum class LayoutResolutionStatus : std::uint8_t {
  applied,
  rejected,
  consistency_lost,
};

struct PaneResizePlanEntry final {
  Pane* pane{nullptr};
  PaneRuntime* runtime{nullptr};
  render::PaneRectangle previous;
  render::PaneRectangle target;
  bool runtime_resized{false};
  bool runtime_touched{false};
};

using PaneResizePlan = std::array<PaneResizePlanEntry, panes_per_tab_max>;

[[nodiscard]] auto resize_runtime_for_layout(PaneRuntime& runtime,
                                             const render::PaneRectangle target) noexcept
    -> TerminalResizeStatus {
  const auto status =
      resize_pane_terminal(runtime.pty, runtime.terminal, target.columns, target.rows);
  if (status == TerminalResizeStatus::consistency_lost) {
    runtime.fail(PaneRuntimeFailure::resize_consistency_lost);
    return status;
  }
  if (status != TerminalResizeStatus::applied) {
    return status;
  }
  const auto synchronized = runtime.terminal.synchronized_output();
  if (!synchronized.has_value()) {
    runtime.fail(PaneRuntimeFailure::terminal_integrity_error);
    return TerminalResizeStatus::consistency_lost;
  }
  static_cast<void>(
      runtime.presentation_gate.observe(*synchronized, true, std::chrono::steady_clock::now()));
  return status;
}

void finish_resize_mutation(PaneResizePlanEntry& entry) noexcept {
  if (!entry.runtime_touched) {
    return;
  }
  LEMMA_ASSERT(entry.runtime != nullptr);
  record_terminal_mutation(*entry.runtime);
  note_compression_activity(*entry.runtime);
}

[[nodiscard]] auto rollback_layout_resize(PaneResizePlan& plan, const std::size_t count) noexcept
    -> LayoutResolutionStatus {
  bool consistency_lost = false;
  for (std::size_t remaining = count; remaining > 0; --remaining) {
    auto& entry = std::span(plan).subspan(remaining - 1U, 1).front();
    if (!entry.runtime_resized) {
      finish_resize_mutation(entry);
      continue;
    }
    LEMMA_ASSERT(entry.runtime != nullptr);
    const auto status = resize_runtime_for_layout(*entry.runtime, entry.previous);
    entry.runtime_touched = true;
    if (status != TerminalResizeStatus::applied && status != TerminalResizeStatus::unchanged) {
      entry.runtime->fail(PaneRuntimeFailure::resize_consistency_lost);
      consistency_lost = true;
    }
    finish_resize_mutation(entry);
  }
  return consistency_lost ? LayoutResolutionStatus::consistency_lost
                          : LayoutResolutionStatus::rejected;
}

[[nodiscard]] auto apply_layout_resize_plan(PaneResizePlan& plan, const std::size_t count) noexcept
    -> LayoutResolutionStatus {
  for (std::size_t index = 0; index < count; ++index) {
    auto& entry = std::span(plan).subspan(index, 1).front();
    LEMMA_ASSERT(entry.pane != nullptr && entry.runtime != nullptr);
    if (entry.previous.columns == entry.target.columns &&
        entry.previous.rows == entry.target.rows) {
      continue;
    }
    const auto status = resize_runtime_for_layout(*entry.runtime, entry.target);
    entry.runtime_touched = status == TerminalResizeStatus::applied ||
                            status == TerminalResizeStatus::rolled_back ||
                            status == TerminalResizeStatus::consistency_lost;
    entry.runtime_resized = status == TerminalResizeStatus::applied;
    if (status == TerminalResizeStatus::rejected || status == TerminalResizeStatus::rolled_back) {
      return rollback_layout_resize(plan, index + 1U);
    }
    if (status == TerminalResizeStatus::consistency_lost) {
      static_cast<void>(rollback_layout_resize(plan, index));
      finish_resize_mutation(entry);
      return LayoutResolutionStatus::consistency_lost;
    }
  }
  return LayoutResolutionStatus::applied;
}

void commit_layout_resize_plan(PaneResizePlan& plan, const std::size_t count) noexcept {
  for (auto& entry : std::span(plan).first(count)) {
    LEMMA_ASSERT(entry.pane != nullptr);
    entry.pane->rectangle = entry.target;
    finish_resize_mutation(entry);
  }
}

// Building and applying the fixed transaction handles zoomed and tiled plans explicitly.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto resolve_layout(SessionRecord& session, Tab& tab, PaneRuntimeStore& runtimes,
                                  const PaneLayout* const proposed_layout = nullptr) noexcept
    -> LayoutResolutionStatus {
  LEMMA_ASSERT(proposed_layout == nullptr || !tab.zoomed);
  const render::PaneRectangle viewport{
      .columns = tab.layout_columns,
      .rows = tab.layout_rows,
  };
  LayoutProjection projection;
  if (tab.zoomed) {
    auto* const focused = find_pane(session, tab, tab.focused_pane);
    if (focused == nullptr) {
      return LayoutResolutionStatus::consistency_lost;
    }
    std::span(projection.rectangles).subspan(focused->id.slot(), 1).front() = viewport;
    std::span(projection.panes).subspan(focused->id.slot(), 1).front() = focused->id;
    std::span(projection.included).subspan(focused->id.slot(), 1).front() = true;
    projection.pane_count = 1;
  } else {
    const auto& layout = proposed_layout == nullptr ? tab.layout : *proposed_layout;
    const auto projected = layout.project(viewport);
    if (!projected.has_value()) {
      return LayoutResolutionStatus::consistency_lost;
    }
    projection = *projected;
    for (std::size_t index = 0; index < session.panes.size(); ++index) {
      const auto& pane_slot = std::span(session.panes).subspan(index, 1).front();
      const bool belongs = pane_slot.pane != nullptr && pane_slot.pane->tab == tab.id;
      const bool included = std::span(projection.included).subspan(index, 1).front();
      if (belongs != included ||
          (included &&
           std::span(projection.panes).subspan(index, 1).front() != pane_slot.pane->id)) {
        return LayoutResolutionStatus::consistency_lost;
      }
    }
  }

  PaneResizePlan plan{};
  std::size_t count = 0;
  for (std::size_t index = 0; index < session.panes.size(); ++index) {
    auto& pane_slot = std::span(session.panes).subspan(index, 1).front();
    if (pane_slot.pane == nullptr || pane_slot.pane->tab != tab.id ||
        !std::span(projection.included).subspan(index, 1).front()) {
      continue;
    }
    auto* const runtime = find_pane_runtime(runtimes, session, *pane_slot.pane);
    LEMMA_ASSERT(runtime != nullptr);
    std::span(plan).subspan(count, 1).front() = {
        .pane = pane_slot.pane.get(),
        .runtime = runtime,
        .previous = pane_slot.pane->rectangle,
        .target = std::span(projection.rectangles).subspan(index, 1).front(),
    };
    ++count;
  }

  const auto status = apply_layout_resize_plan(plan, count);
  if (status != LayoutResolutionStatus::applied) {
    return status;
  }
  if (proposed_layout != nullptr) {
    LEMMA_ASSERT(proposed_layout->valid());
    tab.layout = *proposed_layout;
  }
  commit_layout_resize_plan(plan, count);
  return LayoutResolutionStatus::applied;
}

void refresh_copy_selection_after_layout(SessionRecord& session, Tab& tab,
                                         PaneRuntimeStore& runtimes) noexcept {
  const auto target = session.attachment.selection_target;
  if (!session.attachment.copy_mode.active() || !target.has_value() || target->tab != tab.id) {
    return;
  }
  auto* const pane = find_pane(session, tab, target->pane);
  if (pane == nullptr) {
    leave_copy_mode(session, runtimes);
    return;
  }
  auto* const runtime = find_pane_runtime(runtimes, session, tab, *pane);
  LEMMA_ASSERT(runtime != nullptr);
  const auto refreshed = runtime->terminal.refresh_selection();
  // Reflow updates Ghostty's tracked endpoints, but the renderer requires a freshly installed
  // selection snapshot. Re-anchor Ghostty's canonical viewport to that endpoint.
  const auto scrolled =
      refreshed.has_value() && *refreshed
          ? runtime->terminal.scroll_selection_into_view()
          : std::expected<bool, vt::Error>{std::unexpected(vt::Error::invalid_state)};
  if (!scrolled.has_value() || !update_copy_viewport_offset(session, *runtime)) {
    leave_copy_mode(session, runtimes);
  }
}

[[nodiscard]] auto
resolve_session_layout(SessionRecord& session, Tab& tab, PaneRuntimeStore& runtimes,
                       const PaneLayout* const proposed_layout = nullptr) noexcept -> bool {
  const auto status = resolve_layout(session, tab, runtimes, proposed_layout);
  if (status == LayoutResolutionStatus::consistency_lost) {
    session.active = false;
    return false;
  }
  refresh_copy_selection_after_layout(session, tab, runtimes);
  return status == LayoutResolutionStatus::applied;
}

[[nodiscard]] auto frame_sink_state(const SessionRecord& session) noexcept -> FrameSinkState {
  if (session.attachment_runtime.client < 0) {
    return FrameSinkState::unavailable;
  }
  return session.attachment_runtime.output.busy() ? FrameSinkState::blocked : FrameSinkState::ready;
}

void schedule_frame(SessionRecord& session, const FrameUrgency urgency,
                    const bool force_full) noexcept {
  session.attachment_runtime.frame_scheduler.request(
      urgency, force_full, std::chrono::steady_clock::now(), frame_sink_state(session));
}

void finish_live_divider_resize(SessionRecord& session, const bool discard_release) noexcept {
  if (!session.attachment.mouse_capture.has_value() ||
      session.attachment.mouse_capture->owner != MouseCaptureOwner::divider) {
    return;
  }
  if (discard_release) {
    session.attachment.mouse_capture->owner = MouseCaptureOwner::discard_until_release;
  } else {
    session.attachment.mouse_capture.reset();
  }
}

[[nodiscard]] auto selection_pane(SessionRecord& session) noexcept -> Pane* {
  const auto target = session.attachment.selection_target;
  if (!target.has_value()) {
    return nullptr;
  }
  auto* const tab = find_tab(session, target->tab);
  return tab == nullptr ? nullptr : find_pane(session, *tab, target->pane);
}

[[nodiscard]] auto selection_runtime(SessionRecord& session, PaneRuntimeStore& runtimes) noexcept
    -> PaneRuntime* {
  const auto target = session.attachment.selection_target;
  if (!target.has_value()) {
    return nullptr;
  }
  auto* const tab = find_tab(session, target->tab);
  auto* const pane = tab == nullptr ? nullptr : find_pane(session, *tab, target->pane);
  return pane == nullptr ? nullptr : find_pane_runtime(runtimes, session, *tab, *pane);
}

[[nodiscard]] auto copy_mode_pane(SessionRecord& session) noexcept -> Pane* {
  return session.attachment.copy_mode.active() ? selection_pane(session) : nullptr;
}

[[nodiscard]] auto copy_mode_runtime(SessionRecord& session, PaneRuntimeStore& runtimes) noexcept
    -> PaneRuntime* {
  return session.attachment.copy_mode.active() ? selection_runtime(session, runtimes) : nullptr;
}

void note_compression_activity(PaneRuntime& runtime) noexcept {
  const auto activity = runtime.terminal.compression_activity();
  if (!activity.has_value()) {
    runtime.fail(PaneRuntimeFailure::scrollback_compression_error);
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

[[nodiscard]] auto scroll_viewport_for_application_input(SessionRecord& session,
                                                         PaneRuntime& runtime) noexcept -> bool {
  const auto scrolled = runtime.terminal.scroll_viewport_to_bottom();
  if (!scrolled.has_value()) {
    runtime.fail(PaneRuntimeFailure::terminal_integrity_error);
    return false;
  }
  if (*scrolled) {
    note_compression_activity(runtime);
    schedule_frame(session, FrameUrgency::interactive, true);
  }
  return true;
}

void invalidate_copy_presentation(SessionRecord& session, PaneRuntime& runtime) noexcept {
  runtime.terminal.invalidate_ansi_render_state();
  schedule_frame(session, FrameUrgency::state_change, false);
}

[[nodiscard]] auto update_copy_viewport_offset(SessionRecord& session,
                                               PaneRuntime& runtime) noexcept -> bool {
  const auto viewport = runtime.terminal.viewport_state();
  if (!viewport.has_value()) {
    return false;
  }
  session.attachment.copy_mode.viewport_offset = viewport->offset;
  return true;
}

void reset_selection_capture(Attachment& attachment,
                             const std::optional<AttachmentPaneTarget> target) noexcept {
  if (target.has_value() && attachment.mouse_capture.has_value() &&
      attachment.mouse_capture->owner == MouseCaptureOwner::selection &&
      attachment.mouse_capture->target == *target) {
    attachment.mouse_capture.reset();
  }
}

void leave_copy_mode(SessionRecord& session, PaneRuntimeStore& runtimes) noexcept {
  const bool changed = session.attachment.copy_mode.active();
  const auto target = session.attachment.selection_target;
  auto* const runtime = selection_runtime(session, runtimes);
  if (runtime != nullptr) {
    runtime->terminal.reset_selection_gesture();
    runtime->terminal.clear_selection_checkpoint();
    runtime->terminal.clear_selection();
    if (changed) {
      runtime->terminal.scroll_viewport(vt::ViewportScroll::bottom);
      note_compression_activity(*runtime);
    }
  }
  reset_selection_capture(session.attachment, target);
  session.attachment.selection_target.reset();
  session.attachment.copy_mode = {};
  session.attachment_runtime.copy_mode = {};
  if (changed) {
    schedule_frame(session, FrameUrgency::state_change, true);
  }
}

void reset_rename_prompt(SessionRecord& session, const bool redraw = true) noexcept {
  const bool changed = session.attachment.rename_prompt.active();
  session.attachment.rename_prompt = {};
  if (changed && redraw) {
    schedule_frame(session, FrameUrgency::state_change, false);
  }
}

[[nodiscard]] constexpr auto rename_prompt_character(const RenamePromptKind kind,
                                                     const std::uint8_t byte) noexcept -> bool {
  if (kind == RenamePromptKind::session) {
    return (byte >= static_cast<std::uint8_t>('a') && byte <= static_cast<std::uint8_t>('z')) ||
           (byte >= static_cast<std::uint8_t>('A') && byte <= static_cast<std::uint8_t>('Z')) ||
           (byte >= static_cast<std::uint8_t>('0') && byte <= static_cast<std::uint8_t>('9')) ||
           byte == static_cast<std::uint8_t>('_') || byte == static_cast<std::uint8_t>('-');
  }
  return kind == RenamePromptKind::tab && byte >= 0x20U && byte <= 0x7eU;
}

[[nodiscard]] constexpr auto rename_prompt_capacity(const RenamePromptKind kind) noexcept
    -> std::size_t {
  return kind == RenamePromptKind::session ? limits::session_name_bytes_max
                                           : limits::tab_title_bytes_max;
}

[[nodiscard]] auto begin_rename_prompt(SessionRecord& session, const RenamePromptKind kind,
                                       const TabId tab, const std::string_view initial) noexcept
    -> bool {
  if (kind == RenamePromptKind::inactive) {
    return false;
  }
  const auto capacity = rename_prompt_capacity(kind);
  auto prompt = RenamePromptState{.tab = tab, .kind = kind};
  for (const char character : initial) {
    if (prompt.size == capacity) {
      break;
    }
    const auto byte = static_cast<std::uint8_t>(static_cast<unsigned char>(character));
    if (rename_prompt_character(kind, byte)) {
      std::span(prompt.text).subspan(prompt.size, 1).front() = character;
      ++prompt.size;
    } else if (kind == RenamePromptKind::tab) {
      // Derived process and terminal titles are child-controlled. Preserve their bounded shape for
      // editing without allowing control or non-ASCII bytes to enter the outer-terminal stream.
      std::span(prompt.text).subspan(prompt.size, 1).front() = '?';
      ++prompt.size;
    }
  }
  prompt.cursor = prompt.size;
  session.attachment.rename_prompt = prompt;
  schedule_frame(session, FrameUrgency::state_change, false);
  return true;
}

void clear_mouse_selection(SessionRecord& session, PaneRuntimeStore& runtimes) noexcept {
  if (session.attachment.copy_mode.active() || !session.attachment.selection_target.has_value()) {
    return;
  }
  const auto target = session.attachment.selection_target;
  auto* const runtime = selection_runtime(session, runtimes);
  bool changed = false;
  if (runtime != nullptr) {
    const auto active = runtime->terminal.selection_active();
    changed = !active.has_value() || *active;
    runtime->terminal.reset_selection_gesture();
    runtime->terminal.clear_selection();
  }
  reset_selection_capture(session.attachment, target);
  session.attachment.selection_target.reset();
  if (changed) {
    schedule_frame(session, FrameUrgency::interactive, false);
  }
}

void preserve_copy_viewport_after_mutation(SessionRecord& session, Pane& pane, PaneRuntime& runtime,
                                           PaneRuntimeStore& runtimes) noexcept {
  if (copy_mode_pane(session) != &pane) {
    return;
  }
  runtime.terminal.scroll_viewport(
      vt::ViewportScroll::row,
      static_cast<std::int64_t>(session.attachment.copy_mode.viewport_offset));
  if (!update_copy_viewport_offset(session, runtime)) {
    leave_copy_mode(session, runtimes);
  }
}

[[nodiscard]] auto enter_copy_mode(SessionRecord& session, Tab& tab, Pane& pane,
                                   PaneRuntime& runtime, PaneRuntimeStore& runtimes) noexcept
    -> bool {
  leave_copy_mode(session, runtimes);
  const auto update = runtime.terminal.update_render_state();
  if (!update.has_value()) {
    return false;
  }
  const vt::TerminalPoint cursor{
      .space = vt::PointSpace::viewport,
      .column = update->cursor_in_viewport ? update->cursor_column : std::uint16_t{0},
      .row = update->cursor_in_viewport ? update->cursor_row
                                        : static_cast<std::uint32_t>(pane.rectangle.rows - 1U),
  };
  const auto selected = runtime.terminal.select(vt::SelectionUnit::cell, cursor);
  if (!selected.has_value() || !*selected) {
    return false;
  }
  session.attachment.copy_mode = {};
  session.attachment.selection_target = AttachmentPaneTarget{.tab = tab.id, .pane = pane.id};
  session.attachment.copy_mode.phase = CopyModePhase::navigation;
  if (!update_copy_viewport_offset(session, runtime)) {
    runtime.terminal.clear_selection();
    session.attachment.selection_target.reset();
    session.attachment.copy_mode = {};
    return false;
  }
  runtime.terminal.invalidate_ansi_render_state();
  schedule_frame(session, FrameUrgency::state_change, true);
  return true;
}

[[nodiscard]] auto scroll_viewport_with_mouse(SessionRecord& session, PaneRuntime& runtime,
                                              const protocol::MouseInputButton button,
                                              const bool copy_selection) noexcept -> bool {
  const auto viewport = runtime.terminal.viewport_state();
  if (!viewport.has_value()) {
    return false;
  }

  const bool upward = button == protocol::MouseInputButton::four;
  runtime.terminal.scroll_viewport(vt::ViewportScroll::delta,
                                   upward ? -mouse_wheel_scroll_rows : mouse_wheel_scroll_rows);
  const auto scrolled = runtime.terminal.viewport_state();
  if (!scrolled.has_value()) {
    return false;
  }
  const bool changed =
      scrolled->offset != viewport->offset || scrolled->follows_output != viewport->follows_output;
  if (copy_selection) {
    session.attachment.copy_mode.viewport_offset = scrolled->offset;
  }
  if (changed) {
    note_compression_activity(runtime);
    schedule_frame(session, FrameUrgency::interactive, true);
  }
  return true;
}

[[nodiscard]] constexpr auto copy_selection_unit(const CopyModePhase phase) noexcept
    -> vt::SelectionUnit {
  switch (phase) {
  case CopyModePhase::visual_line:
    return vt::SelectionUnit::line;
  case CopyModePhase::visual_block:
    return vt::SelectionUnit::block;
  case CopyModePhase::inactive:
  case CopyModePhase::navigation:
  case CopyModePhase::visual_character:
  case CopyModePhase::search_prompt:
  case CopyModePhase::searching:
    return vt::SelectionUnit::cell;
  }
  return vt::SelectionUnit::cell;
}

[[nodiscard]] auto adjust_copy_selection(SessionRecord& session, PaneRuntime& runtime,
                                         PaneRuntimeStore& runtimes,
                                         const vt::SelectionAdjustment adjustment) noexcept
    -> bool {
  const auto phase = session.attachment.copy_mode.phase;
  const auto adjusted =
      runtime.terminal.selection_adjust(adjustment, session.attachment.copy_mode.selecting());
  if (!adjusted.has_value()) {
    leave_copy_mode(session, runtimes);
    return false;
  }
  if (*adjusted && session.attachment.copy_mode.selecting()) {
    const auto normalized = runtime.terminal.selection_normalize_unit(copy_selection_unit(phase));
    if (!normalized.has_value()) {
      leave_copy_mode(session, runtimes);
      return false;
    }
  }
  if (*adjusted) {
    const auto scrolled = runtime.terminal.scroll_selection_into_view();
    if (!scrolled.has_value() || !update_copy_viewport_offset(session, runtime)) {
      leave_copy_mode(session, runtimes);
      return false;
    }
    session.attachment.copy_mode.feedback = CopyModeFeedback::none;
    note_compression_activity(runtime);
    invalidate_copy_presentation(session, runtime);
  }
  return true;
}

[[nodiscard]] auto advance_copy_search_cursor(PaneRuntime& runtime, vt::TerminalPoint& point,
                                              CopySearchDirection direction) noexcept -> bool;

[[nodiscard]] auto copy_search_boundary(PaneRuntime& runtime,
                                        const CopySearchDirection direction) noexcept
    -> std::optional<vt::TerminalPoint> {
  const auto viewport = runtime.terminal.viewport_state();
  const auto columns = runtime.terminal.size().columns;
  if (!viewport.has_value() || viewport->total_rows == 0 || columns == 0) {
    return std::nullopt;
  }
  return vt::TerminalPoint{
      .space = vt::PointSpace::screen,
      .column = direction == CopySearchDirection::forward
                    ? std::uint16_t{0}
                    : static_cast<std::uint16_t>(columns - 1U),
      .row = direction == CopySearchDirection::forward
                 ? std::uint32_t{0}
                 : static_cast<std::uint32_t>(viewport->total_rows - 1U),
  };
}

[[nodiscard]] auto begin_copy_search(SessionRecord& session, PaneRuntime& runtime,
                                     const CopySearchDirection direction,
                                     const vt::TerminalPoint anchor) noexcept -> bool {
  auto& search = session.attachment_runtime.copy_mode;
  auto first = anchor;
  const bool has_first = advance_copy_search_cursor(runtime, first, direction);
  if (!has_first) {
    const auto boundary = copy_search_boundary(runtime, direction);
    if (!boundary.has_value()) {
      return false;
    }
    first = *boundary;
  }
  search.search_task = CopySearchTask{
      .cursor = {.candidate = first},
      .stop_before = anchor,
      .deadline = std::chrono::steady_clock::now(),
      .direction = direction,
      .terminal_generation = runtime.mutation_generation,
      .wrapped = !has_first,
  };
  search.preview_match = false;
  session.attachment.copy_mode.feedback = CopyModeFeedback::none;
  invalidate_copy_presentation(session, runtime);
  return true;
}

[[nodiscard]] constexpr auto clipboard_base64_bytes(const std::size_t bytes) noexcept
    -> std::size_t {
  return 4U * ((bytes + 2U) / 3U);
}

[[nodiscard]] auto copy_selection_to_outer_clipboard(SessionRecord& session, PaneRuntime& runtime,
                                                     PaneRuntimeStore& runtimes) noexcept -> bool {
  constexpr std::size_t osc_overhead = 9;
  const auto fail = [&](const CopyModeFeedback feedback) noexcept {
    session.attachment.copy_mode.feedback = feedback;
    invalidate_copy_presentation(session, runtime);
    return false;
  };
  if (session.attachment_runtime.clipboard_write.bytes != nullptr) {
    return fail(CopyModeFeedback::clipboard_busy);
  }
  if (session.attachment_runtime.frame.capacity() <= osc_overhead) {
    return fail(CopyModeFeedback::failed);
  }
  const auto payload_groups = (session.attachment_runtime.frame.capacity() - osc_overhead) / 4U;
  const auto delivery_capacity = std::min(payload_groups * 3U, limits::selection_format_bytes_max);
  auto storage = allocate_clipboard_storage(delivery_capacity);
  if (storage == nullptr) {
    return fail(CopyModeFeedback::failed);
  }
  const auto formatted = runtime.terminal.format_selection(
      vt::ScreenFormat::plain, std::span(storage.get(), delivery_capacity));
  if (!formatted.has_value()) {
    return fail(formatted.error() == vt::Error::out_of_space ? CopyModeFeedback::too_large
                                                             : CopyModeFeedback::failed);
  }
  if (*formatted == 0) {
    return fail(CopyModeFeedback::empty_selection);
  }
  if (clipboard_base64_bytes(*formatted) + osc_overhead >
      session.attachment_runtime.frame.capacity()) {
    return fail(CopyModeFeedback::too_large);
  }
  session.attachment_runtime.clipboard_write.bytes = std::move(storage);
  session.attachment_runtime.clipboard_write.size = *formatted;
  leave_copy_mode(session, runtimes);
  return true;
}

enum class CopyEscapeStatus : std::uint8_t {
  pending,
  complete,
  unsupported,
  invalid,
};

struct CopyEscapeDecode final {
  CopyEscapeStatus status{CopyEscapeStatus::invalid};
  CopyKey key;
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
      return {.status = CopyEscapeStatus::complete, .key = {.kind = CopyKeyKind::arrow_up}};
    case static_cast<std::uint8_t>('B'):
      return {.status = CopyEscapeStatus::complete, .key = {.kind = CopyKeyKind::arrow_down}};
    case static_cast<std::uint8_t>('C'):
      return {.status = CopyEscapeStatus::complete, .key = {.kind = CopyKeyKind::arrow_right}};
    case static_cast<std::uint8_t>('D'):
      return {.status = CopyEscapeStatus::complete, .key = {.kind = CopyKeyKind::arrow_left}};
    case static_cast<std::uint8_t>('H'):
      return {.status = CopyEscapeStatus::complete, .key = {.kind = CopyKeyKind::home}};
    case static_cast<std::uint8_t>('F'):
      return {.status = CopyEscapeStatus::complete, .key = {.kind = CopyKeyKind::end}};
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
    return {.status = CopyEscapeStatus::complete, .key = {.kind = CopyKeyKind::home}};
  case static_cast<std::uint8_t>('4'):
  case static_cast<std::uint8_t>('8'):
    return {.status = CopyEscapeStatus::complete, .key = {.kind = CopyKeyKind::end}};
  case static_cast<std::uint8_t>('5'):
    return {.status = CopyEscapeStatus::complete, .key = {.kind = CopyKeyKind::page_up}};
  case static_cast<std::uint8_t>('6'):
    return {.status = CopyEscapeStatus::complete, .key = {.kind = CopyKeyKind::page_down}};
  default:
    return {.status = CopyEscapeStatus::unsupported, .key = {}};
  }
}

[[nodiscard]] auto restore_copy_search_selection(SessionRecord& session,
                                                 PaneRuntime& runtime) noexcept -> bool {
  auto& search = session.attachment_runtime.copy_mode;
  const auto restored = runtime.terminal.restore_selection_checkpoint();
  if (!restored.has_value() || !*restored || !search.search_restore_viewport_offset.has_value()) {
    return false;
  }
  runtime.terminal.scroll_viewport(
      vt::ViewportScroll::row, static_cast<std::int64_t>(*search.search_restore_viewport_offset));
  return update_copy_viewport_offset(session, runtime);
}

void reset_copy_search_task(CopyModeRuntimeState& search) noexcept {
  search.search_task.reset();
  search.preview_match = false;
}

void discard_copy_search_restore(PaneRuntime& runtime, CopyModeRuntimeState& search) noexcept {
  runtime.terminal.clear_selection_checkpoint();
  search.search_restore_viewport_offset.reset();
}

[[nodiscard]] auto begin_copy_search_prompt(SessionRecord& session, PaneRuntime& runtime,
                                            const CopySearchDirection direction) noexcept -> bool {
  const auto endpoint = runtime.terminal.selection_endpoint(vt::PointSpace::screen);
  const auto viewport = runtime.terminal.viewport_state();
  const auto checkpointed = runtime.terminal.checkpoint_selection();
  if (!endpoint.has_value() || !endpoint->has_value() || !viewport.has_value() ||
      !checkpointed.has_value() || !*checkpointed) {
    return false;
  }
  auto& state = session.attachment.copy_mode;
  auto& search = session.attachment_runtime.copy_mode;
  if (state.phase == CopyModePhase::searching) {
    state.phase_before_search = CopyModePhase::navigation;
  } else if (state.phase != CopyModePhase::search_prompt) {
    state.phase_before_search = state.phase;
  }
  state.phase = CopyModePhase::search_prompt;
  state.prompt_search_direction = direction;
  state.draft_query_size = 0;
  state.feedback = CopyModeFeedback::none;
  state.pending_chord = CopyPendingChord::none;
  reset_copy_search_task(search);
  search.search_restore_viewport_offset = viewport->offset;
  invalidate_copy_presentation(session, runtime);
  return true;
}

[[nodiscard]] auto restart_incremental_copy_search(SessionRecord& session,
                                                   PaneRuntime& runtime) noexcept -> bool {
  auto& state = session.attachment.copy_mode;
  auto& search = session.attachment_runtime.copy_mode;
  reset_copy_search_task(search);
  state.feedback = CopyModeFeedback::none;
  if (state.draft_query_size == 0) {
    if (!restore_copy_search_selection(session, runtime)) {
      return false;
    }
    invalidate_copy_presentation(session, runtime);
    return true;
  }
  // Keep the previous preview installed while the refined query is searched. The tracked
  // checkpoint remains the stable search origin, so no temporary restore frame can flash the
  // original copy cursor between previews.
  const auto endpoint = runtime.terminal.selection_checkpoint_endpoint(vt::PointSpace::screen);
  if (!endpoint.has_value() || !endpoint->has_value()) {
    return false;
  }
  return begin_copy_search(session, runtime, state.prompt_search_direction, **endpoint);
}

[[nodiscard]] auto cancel_copy_search(SessionRecord& session, PaneRuntime& runtime) noexcept
    -> bool {
  auto& state = session.attachment.copy_mode;
  auto& search = session.attachment_runtime.copy_mode;
  const bool prompt = state.phase == CopyModePhase::search_prompt;
  reset_copy_search_task(search);
  if (!restore_copy_search_selection(session, runtime)) {
    return false;
  }
  discard_copy_search_restore(runtime, search);
  state.phase = prompt ? state.phase_before_search : CopyModePhase::navigation;
  if (prompt) {
    state.draft_query_size = 0;
  }
  state.feedback = CopyModeFeedback::none;
  invalidate_copy_presentation(session, runtime);
  return true;
}

void commit_draft_copy_query(CopyModeState& state) noexcept {
  std::ranges::copy(std::span(state.draft_query).first(state.draft_query_size),
                    state.query.begin());
  state.query_size = state.draft_query_size;
  state.search_direction = state.prompt_search_direction;
}

[[nodiscard]] auto commit_copy_search_prompt(SessionRecord& session, PaneRuntime& runtime) noexcept
    -> bool {
  auto& state = session.attachment.copy_mode;
  auto& search = session.attachment_runtime.copy_mode;
  if (state.draft_query_size == 0) {
    return cancel_copy_search(session, runtime);
  }
  commit_draft_copy_query(state);
  if (search.preview_match) {
    const auto selected = runtime.terminal.selection_range(vt::PointSpace::screen);
    if (!selected.has_value() || !selected->has_value()) {
      return false;
    }
    search.last_search_match =
        vt::SearchMatch{.start = (**selected).start, .end = (**selected).end};
    search.last_search_generation = runtime.mutation_generation;
    reset_copy_search_task(search);
    discard_copy_search_restore(runtime, search);
    state.phase = CopyModePhase::navigation;
    state.feedback = CopyModeFeedback::none;
    invalidate_copy_presentation(session, runtime);
    return true;
  }
  if (search.search_task.has_value()) {
    search.last_search_match.reset();
    search.last_search_generation = 0;
    state.phase = CopyModePhase::searching;
    invalidate_copy_presentation(session, runtime);
    return true;
  }
  search.last_search_match.reset();
  search.last_search_generation = 0;
  discard_copy_search_restore(runtime, search);
  state.phase = CopyModePhase::navigation;
  state.feedback = CopyModeFeedback::no_match;
  invalidate_copy_presentation(session, runtime);
  return true;
}

[[nodiscard]] auto begin_repeated_copy_search(SessionRecord& session, PaneRuntime& runtime,
                                              const CopySearchDirection direction) noexcept
    -> bool {
  auto& state = session.attachment.copy_mode;
  auto& search = session.attachment_runtime.copy_mode;
  if (state.query_size == 0) {
    return true;
  }
  const auto endpoint = runtime.terminal.selection_endpoint(vt::PointSpace::screen);
  const auto viewport = runtime.terminal.viewport_state();
  const auto checkpointed = runtime.terminal.checkpoint_selection();
  if (!endpoint.has_value() || !endpoint->has_value() || !viewport.has_value() ||
      !checkpointed.has_value() || !*checkpointed) {
    return false;
  }
  auto anchor = **endpoint;
  if (search.last_search_generation == runtime.mutation_generation &&
      search.last_search_match.has_value()) {
    anchor = search.last_search_match->start;
  }
  reset_copy_search_task(search);
  search.search_restore_viewport_offset = viewport->offset;
  state.phase = CopyModePhase::searching;
  return begin_copy_search(session, runtime, direction, anchor);
}

[[nodiscard]] auto set_copy_visual_phase(SessionRecord& session, PaneRuntime& runtime,
                                         const CopyModePhase phase) noexcept -> bool {
  auto& state = session.attachment.copy_mode;
  if (state.phase == phase) {
    const auto collapsed = runtime.terminal.collapse_selection_to_endpoint();
    if (!collapsed.has_value() || !*collapsed) {
      return false;
    }
    state.phase = CopyModePhase::navigation;
  } else {
    const auto collapsed = runtime.terminal.collapse_selection_to_endpoint();
    const auto selected =
        collapsed.has_value() && *collapsed
            ? runtime.terminal.selection_set_unit(copy_selection_unit(phase))
            : std::expected<bool, vt::Error>{std::unexpected(vt::Error::invalid_state)};
    if (!selected.has_value() || !*selected) {
      return false;
    }
    state.phase = phase;
  }
  state.feedback = CopyModeFeedback::none;
  invalidate_copy_presentation(session, runtime);
  return true;
}

[[nodiscard]] constexpr auto copy_motion(const CopyActionKind kind) noexcept
    -> std::optional<vt::SelectionAdjustment> {
  switch (kind) {
  case CopyActionKind::move_left:
    return vt::SelectionAdjustment::left;
  case CopyActionKind::move_down:
    return vt::SelectionAdjustment::down;
  case CopyActionKind::move_up:
    return vt::SelectionAdjustment::up;
  case CopyActionKind::move_right:
    return vt::SelectionAdjustment::right;
  case CopyActionKind::word_left:
    return vt::SelectionAdjustment::word_left;
  case CopyActionKind::word_right:
    return vt::SelectionAdjustment::word_right;
  case CopyActionKind::word_end:
    return vt::SelectionAdjustment::word_end;
  case CopyActionKind::line_start:
    return vt::SelectionAdjustment::beginning_of_line;
  case CopyActionKind::line_first_nonblank:
    return vt::SelectionAdjustment::first_nonblank;
  case CopyActionKind::line_end:
    return vt::SelectionAdjustment::end_of_line;
  case CopyActionKind::history_top:
    return vt::SelectionAdjustment::history_top;
  case CopyActionKind::history_bottom:
    return vt::SelectionAdjustment::history_bottom;
  case CopyActionKind::viewport_top:
    return vt::SelectionAdjustment::viewport_top;
  case CopyActionKind::viewport_middle:
    return vt::SelectionAdjustment::viewport_middle;
  case CopyActionKind::viewport_bottom:
    return vt::SelectionAdjustment::viewport_bottom;
  case CopyActionKind::half_page_up:
    return vt::SelectionAdjustment::half_page_up;
  case CopyActionKind::half_page_down:
    return vt::SelectionAdjustment::half_page_down;
  case CopyActionKind::page_up:
    return vt::SelectionAdjustment::page_up;
  case CopyActionKind::page_down:
    return vt::SelectionAdjustment::page_down;
  case CopyActionKind::none:
  case CopyActionKind::leave:
  case CopyActionKind::cancel_selection:
  case CopyActionKind::visual_character:
  case CopyActionKind::visual_line:
  case CopyActionKind::visual_block:
  case CopyActionKind::swap_endpoint:
  case CopyActionKind::copy:
  case CopyActionKind::begin_search_forward:
  case CopyActionKind::begin_search_backward:
  case CopyActionKind::repeat_search:
  case CopyActionKind::reverse_search:
  case CopyActionKind::cancel_search:
  case CopyActionKind::commit_search:
  case CopyActionKind::query_backspace:
  case CopyActionKind::query_append:
    return std::nullopt;
  }
  return std::nullopt;
}

void pop_copy_query_codepoint(CopyModeState& state) noexcept {
  if (state.draft_query_size == 0) {
    return;
  }
  --state.draft_query_size;
  while (state.draft_query_size > 0) {
    const auto value = static_cast<std::uint8_t>(static_cast<unsigned char>(
        std::span(state.draft_query).subspan(state.draft_query_size, 1).front()));
    if ((value & 0xC0U) != 0x80U) {
      break;
    }
    --state.draft_query_size;
  }
}

// Returns false only when the action leaves copy mode or terminal state can no longer support it.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto apply_copy_action(SessionRecord& session, PaneRuntime& runtime,
                                     PaneRuntimeStore& runtimes, const CopyAction action) noexcept
    -> bool {
  auto& state = session.attachment.copy_mode;
  if (const auto motion = copy_motion(action.kind); motion.has_value()) {
    return adjust_copy_selection(session, runtime, runtimes, *motion) && state.active();
  }
  switch (action.kind) {
  case CopyActionKind::none:
    return true;
  case CopyActionKind::leave:
    leave_copy_mode(session, runtimes);
    return false;
  case CopyActionKind::cancel_selection: {
    const auto collapsed = runtime.terminal.collapse_selection_to_endpoint();
    if (!collapsed.has_value() || !*collapsed) {
      leave_copy_mode(session, runtimes);
      return false;
    }
    state.phase = CopyModePhase::navigation;
    state.feedback = CopyModeFeedback::none;
    invalidate_copy_presentation(session, runtime);
    return true;
  }
  case CopyActionKind::visual_character:
  case CopyActionKind::visual_line:
  case CopyActionKind::visual_block: {
    auto phase = CopyModePhase::visual_block;
    if (action.kind == CopyActionKind::visual_character) {
      phase = CopyModePhase::visual_character;
    } else if (action.kind == CopyActionKind::visual_line) {
      phase = CopyModePhase::visual_line;
    }
    if (!set_copy_visual_phase(session, runtime, phase)) {
      leave_copy_mode(session, runtimes);
      return false;
    }
    return true;
  }
  case CopyActionKind::swap_endpoint: {
    if (!state.selecting()) {
      return true;
    }
    const auto swapped = runtime.terminal.swap_selection_endpoints();
    if (!swapped.has_value() || !*swapped) {
      leave_copy_mode(session, runtimes);
      return false;
    }
    invalidate_copy_presentation(session, runtime);
    return true;
  }
  case CopyActionKind::copy:
    return !copy_selection_to_outer_clipboard(session, runtime, runtimes);
  case CopyActionKind::begin_search_forward:
  case CopyActionKind::begin_search_backward:
    if (!begin_copy_search_prompt(session, runtime,
                                  action.kind == CopyActionKind::begin_search_forward
                                      ? CopySearchDirection::forward
                                      : CopySearchDirection::backward)) {
      leave_copy_mode(session, runtimes);
      return false;
    }
    return true;
  case CopyActionKind::repeat_search:
  case CopyActionKind::reverse_search: {
    auto direction = state.search_direction;
    if (action.kind == CopyActionKind::reverse_search) {
      direction = state.search_direction == CopySearchDirection::forward
                      ? CopySearchDirection::backward
                      : CopySearchDirection::forward;
    }
    if (!begin_repeated_copy_search(session, runtime, direction)) {
      leave_copy_mode(session, runtimes);
      return false;
    }
    return true;
  }
  case CopyActionKind::cancel_search:
    if (!cancel_copy_search(session, runtime)) {
      leave_copy_mode(session, runtimes);
      return false;
    }
    return true;
  case CopyActionKind::commit_search:
    if (!commit_copy_search_prompt(session, runtime)) {
      leave_copy_mode(session, runtimes);
      return false;
    }
    return true;
  case CopyActionKind::query_backspace:
    pop_copy_query_codepoint(state);
    if (!restart_incremental_copy_search(session, runtime)) {
      leave_copy_mode(session, runtimes);
      return false;
    }
    return true;
  case CopyActionKind::query_append:
    if (state.draft_query_size < state.draft_query.size()) {
      std::span(state.draft_query).subspan(state.draft_query_size, 1).front() =
          static_cast<char>(action.byte);
      ++state.draft_query_size;
      if (!restart_incremental_copy_search(session, runtime)) {
        leave_copy_mode(session, runtimes);
        return false;
      }
    }
    return true;
  case CopyActionKind::move_left:
  case CopyActionKind::move_down:
  case CopyActionKind::move_up:
  case CopyActionKind::move_right:
  case CopyActionKind::word_left:
  case CopyActionKind::word_right:
  case CopyActionKind::word_end:
  case CopyActionKind::line_start:
  case CopyActionKind::line_first_nonblank:
  case CopyActionKind::line_end:
  case CopyActionKind::history_top:
  case CopyActionKind::history_bottom:
  case CopyActionKind::viewport_top:
  case CopyActionKind::viewport_middle:
  case CopyActionKind::viewport_bottom:
  case CopyActionKind::half_page_up:
  case CopyActionKind::half_page_down:
  case CopyActionKind::page_up:
  case CopyActionKind::page_down:
    break;
  }
  return true;
}

// Legacy byte input and structured keys converge on the same typed copy action table.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto process_copy_mode_input(SessionRecord& session, PaneRuntimeStore& runtimes,
                                           const std::span<const std::byte> input) noexcept
    -> std::size_t {
  auto* runtime = copy_mode_runtime(session, runtimes);
  if (runtime == nullptr) {
    leave_copy_mode(session, runtimes);
    return input.size();
  }
  for (std::size_t index = 0; index < input.size(); ++index) {
    const auto byte = input.subspan(index, 1).front();
    auto key = CopyKey{.byte = std::to_integer<std::uint8_t>(byte)};
    if (session.attachment_runtime.copy_mode.pending_escape_size > 0) {
      LEMMA_ASSERT(session.attachment_runtime.copy_mode.pending_escape_size <
                   session.attachment_runtime.copy_mode.pending_escape.size());
      std::span(session.attachment_runtime.copy_mode.pending_escape)
          .subspan(session.attachment_runtime.copy_mode.pending_escape_size, 1)
          .front() = byte;
      ++session.attachment_runtime.copy_mode.pending_escape_size;
      const auto decoded =
          decode_copy_escape(std::span(session.attachment_runtime.copy_mode.pending_escape)
                                 .first(session.attachment_runtime.copy_mode.pending_escape_size));
      if (decoded.status == CopyEscapeStatus::pending) {
        session.attachment_runtime.copy_mode.pending_escape_deadline =
            std::chrono::steady_clock::now() + copy_escape_flush_delay;
        continue;
      }
      session.attachment_runtime.copy_mode.pending_escape_size = 0;
      if (decoded.status == CopyEscapeStatus::complete) {
        key = decoded.key;
      } else if (decoded.status == CopyEscapeStatus::unsupported) {
        continue;
      } else {
        const auto escape =
            copy_action_for_key(session.attachment.copy_mode, CopyKey{.kind = CopyKeyKind::escape});
        if (!apply_copy_action(session, *runtime, runtimes, escape)) {
          return index;
        }
        key = CopyKey{.byte = std::to_integer<std::uint8_t>(byte)};
      }
    } else if (byte == std::byte{0x1B}) {
      session.attachment_runtime.copy_mode.pending_escape.front() = byte;
      session.attachment_runtime.copy_mode.pending_escape_size = 1;
      session.attachment_runtime.copy_mode.pending_escape_deadline =
          std::chrono::steady_clock::now() + copy_escape_flush_delay;
      continue;
    }
    const auto action = copy_action_for_key(session.attachment.copy_mode, key);
    if (!apply_copy_action(session, *runtime, runtimes, action)) {
      return index + 1U;
    }
    runtime = copy_mode_runtime(session, runtimes);
    if (runtime == nullptr) {
      leave_copy_mode(session, runtimes);
      return input.size();
    }
  }
  return input.size();
}

// Structured-key normalization is an exhaustive mapping, not product policy.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void process_typed_copy_mode_input(SessionRecord& session, PaneRuntimeStore& runtimes,
                                   const protocol::KeyInput& key,
                                   const std::span<const std::byte> text) noexcept {
  if (key.action == protocol::KeyInputAction::release) {
    return;
  }
  std::optional<CopyKey> copy_key;
  const bool control = (key.modifiers & protocol::key_input_modifier_control) != 0;
  const bool shift = (key.modifiers & protocol::key_input_modifier_shift) != 0;
  switch (key.key) {
  case protocol::KeyInputKey::arrow_up:
    copy_key = CopyKey{.kind = CopyKeyKind::arrow_up};
    break;
  case protocol::KeyInputKey::arrow_down:
    copy_key = CopyKey{.kind = CopyKeyKind::arrow_down};
    break;
  case protocol::KeyInputKey::arrow_left:
    copy_key = CopyKey{.kind = CopyKeyKind::arrow_left};
    break;
  case protocol::KeyInputKey::arrow_right:
    copy_key = CopyKey{.kind = CopyKeyKind::arrow_right};
    break;
  case protocol::KeyInputKey::home:
    copy_key = CopyKey{.kind = CopyKeyKind::home};
    break;
  case protocol::KeyInputKey::end:
    copy_key = CopyKey{.kind = CopyKeyKind::end};
    break;
  case protocol::KeyInputKey::page_up:
    copy_key = CopyKey{.kind = CopyKeyKind::page_up};
    break;
  case protocol::KeyInputKey::page_down:
    copy_key = CopyKey{.kind = CopyKeyKind::page_down};
    break;
  case protocol::KeyInputKey::enter:
    copy_key = CopyKey{.kind = CopyKeyKind::enter};
    break;
  case protocol::KeyInputKey::backspace:
    copy_key = CopyKey{.kind = CopyKeyKind::backspace};
    break;
  case protocol::KeyInputKey::escape:
    copy_key = CopyKey{.kind = CopyKeyKind::escape};
    break;
  case protocol::KeyInputKey::space:
    copy_key = CopyKey{.byte = static_cast<std::uint8_t>(' ')};
    break;
  case protocol::KeyInputKey::b:
    if (control) {
      copy_key = CopyKey{.byte = 0x02};
    }
    break;
  case protocol::KeyInputKey::c:
    if (control) {
      copy_key = CopyKey{.byte = 0x03};
    }
    break;
  case protocol::KeyInputKey::d:
    if (control) {
      copy_key = CopyKey{.byte = 0x04};
    }
    break;
  case protocol::KeyInputKey::f:
    if (control) {
      copy_key = CopyKey{.byte = 0x06};
    }
    break;
  case protocol::KeyInputKey::g:
    if (control) {
      copy_key = CopyKey{.byte = 0x07};
    }
    break;
  case protocol::KeyInputKey::u:
    if (control) {
      copy_key = CopyKey{.byte = 0x15};
    }
    break;
  case protocol::KeyInputKey::v:
    if (control) {
      copy_key = CopyKey{.byte = 0x16};
    } else if (shift && text.empty()) {
      copy_key = CopyKey{.byte = static_cast<std::uint8_t>('V')};
    }
    break;
  case protocol::KeyInputKey::unidentified:
  case protocol::KeyInputKey::a:
  case protocol::KeyInputKey::e:
  case protocol::KeyInputKey::h:
  case protocol::KeyInputKey::i:
  case protocol::KeyInputKey::j:
  case protocol::KeyInputKey::k:
  case protocol::KeyInputKey::l:
  case protocol::KeyInputKey::m:
  case protocol::KeyInputKey::n:
  case protocol::KeyInputKey::o:
  case protocol::KeyInputKey::p:
  case protocol::KeyInputKey::q:
  case protocol::KeyInputKey::r:
  case protocol::KeyInputKey::s:
  case protocol::KeyInputKey::t:
  case protocol::KeyInputKey::w:
  case protocol::KeyInputKey::x:
  case protocol::KeyInputKey::y:
  case protocol::KeyInputKey::z:
  case protocol::KeyInputKey::tab:
  case protocol::KeyInputKey::insert:
  case protocol::KeyInputKey::delete_key:
  case protocol::KeyInputKey::f1:
  case protocol::KeyInputKey::f2:
  case protocol::KeyInputKey::f3:
  case protocol::KeyInputKey::f4:
  case protocol::KeyInputKey::f5:
  case protocol::KeyInputKey::f6:
  case protocol::KeyInputKey::f7:
  case protocol::KeyInputKey::f8:
  case protocol::KeyInputKey::f9:
  case protocol::KeyInputKey::f10:
  case protocol::KeyInputKey::f11:
  case protocol::KeyInputKey::f12:
    break;
  }
  if (copy_key.has_value()) {
    auto* const runtime = copy_mode_runtime(session, runtimes);
    if (runtime == nullptr) {
      leave_copy_mode(session, runtimes);
      return;
    }
    static_cast<void>(apply_copy_action(
        session, *runtime, runtimes, copy_action_for_key(session.attachment.copy_mode, *copy_key)));
    return;
  }
  static_cast<void>(process_copy_mode_input(session, runtimes, text));
}

void service_copy_input_timeout(SessionRecord& session, PaneRuntimeStore& runtimes,
                                const std::chrono::steady_clock::time_point now) noexcept {
  if (session.attachment.copy_mode.active() &&
      session.attachment_runtime.copy_mode.pending_escape_size > 0 &&
      now >= session.attachment_runtime.copy_mode.pending_escape_deadline) {
    session.attachment_runtime.copy_mode.pending_escape_size = 0;
    auto* const runtime = copy_mode_runtime(session, runtimes);
    if (runtime == nullptr ||
        !apply_copy_action(session, *runtime, runtimes,
                           copy_action_for_key(session.attachment.copy_mode,
                                               CopyKey{.kind = CopyKeyKind::escape}))) {
      return;
    }
  }
}

[[nodiscard]] auto fit_tab_to_viewport(SessionRecord& session, Tab& tab,
                                       PaneRuntimeStore& runtimes) noexcept -> bool {
  const render::PaneRectangle viewport{
      .columns = session.attachment.columns,
      .rows = pane_rows(session.attachment.rows),
  };
  if (!tab.layout.project(viewport).has_value()) {
    tab.layout_suspended = true;
    return true;
  }
  const auto previous_suspended = tab.layout_suspended;
  const auto previous_columns = tab.layout_columns;
  const auto previous_rows = tab.layout_rows;
  tab.layout_suspended = false;
  tab.layout_columns = viewport.columns;
  tab.layout_rows = viewport.rows;
  if (resolve_session_layout(session, tab, runtimes)) {
    return true;
  }
  if (session.active) {
    tab.layout_suspended = previous_suspended;
    tab.layout_columns = previous_columns;
    tab.layout_rows = previous_rows;
  }
  return false;
}

[[nodiscard]] auto select_tab(SessionRecord& session, PaneRuntimeStore& runtimes,
                              const TabId id) noexcept -> bool {
  auto* const selected = find_tab(session, id);
  if (selected == nullptr) {
    return false;
  }
  if (session.active_tab == id) {
    return true;
  }
  const auto previous_active = session.active_tab;
  const auto previous_previous = session.previous_tab;
  session.previous_tab = session.active_tab;
  session.active_tab = id;
  if (!fit_tab_to_viewport(session, *selected, runtimes)) {
    if (session.active) {
      session.active_tab = previous_active;
      session.previous_tab = previous_previous;
    }
    return false;
  }
  schedule_frame(session, FrameUrgency::state_change, true);
  return true;
}

void cycle_tab(SessionRecord& session, PaneRuntimeStore& runtimes, const bool forward) noexcept {
  const auto current = session.tab_order.position_of(session.active_tab);
  if (!current.has_value() || session.tab_order.size() <= 1U) {
    return;
  }
  const auto count = session.tab_order.size();
  const auto candidate = forward ? (*current + 1U) % count : (*current + count - 1U) % count;
  const auto id = session.tab_order.at(candidate);
  LEMMA_ASSERT(id.has_value());
  static_cast<void>(select_tab(session, runtimes, *id));
}

void erase_tab_panes(SessionRecord& session, const Tab& tab, PaneRuntimeStore& runtimes) noexcept {
  for (auto& pane_slot : session.panes) {
    if (pane_slot.pane == nullptr || pane_slot.pane->tab != tab.id) {
      continue;
    }
    const bool erased = runtimes.erase(pane_address(session, *pane_slot.pane));
    LEMMA_ASSERT(erased);
    pane_slot.pane.reset();
  }
}

void reset_removed_tab_attachment_state(SessionRecord& session, PaneRuntimeStore& runtimes,
                                        const TabId id) noexcept {
  if (session.attachment.selection_target.has_value() &&
      session.attachment.selection_target->tab == id) {
    leave_copy_mode(session, runtimes);
  }
  if (session.attachment.rename_prompt.kind == RenamePromptKind::tab &&
      session.attachment.rename_prompt.tab == id) {
    reset_rename_prompt(session, false);
  }
  if (session.attachment.mouse_capture.has_value() &&
      session.attachment.mouse_capture->owner == MouseCaptureOwner::status_tab &&
      (session.attachment.mouse_capture->target.tab == id ||
       session.attachment.mouse_capture->status_tab_before == id)) {
    session.attachment.mouse_capture.reset();
  }
}

void remove_tab(SessionRecord& session, PaneRuntimeStore& runtimes, const TabId id) noexcept {
  auto* const tab = find_tab(session, id);
  const auto removed_position = session.tab_order.position_of(id);
  if (tab == nullptr || !removed_position.has_value()) {
    return;
  }
  reset_removed_tab_attachment_state(session, runtimes, id);
  erase_tab_panes(session, *tab, runtimes);
  std::span(session.tabs).subspan(id.slot(), 1).front().tab.reset();
  const bool order_erased = session.tab_order.erase(id);
  LEMMA_ASSERT(order_erased);
  if (tab_count(session) == 0) {
    session.active = false;
    return;
  }
  if (session.active_tab != id) {
    if (session.previous_tab == id) {
      session.previous_tab = session.active_tab;
    }
    schedule_frame(session, FrameUrgency::state_change, false);
    return;
  }
  const auto next_position = std::min(*removed_position, session.tab_order.size() - 1U);
  const auto selected_id = session.tab_order.at(next_position);
  LEMMA_ASSERT(selected_id.has_value());
  auto* const selected = find_tab(session, *selected_id);
  LEMMA_ASSERT(selected != nullptr);
  session.active_tab = *selected_id;
  session.previous_tab = session.active_tab;
  if (!fit_tab_to_viewport(session, *selected, runtimes)) {
    if (session.active) {
      selected->layout_suspended = true;
      schedule_frame(session, FrameUrgency::state_change, true);
    }
    return;
  }
  schedule_frame(session, FrameUrgency::state_change, true);
}

void create_tab(SessionRecord& session, PaneRuntimeStore& runtimes) noexcept {
  const auto previous_active = session.active_tab;
  const auto previous_previous = session.previous_tab;
  auto* const created = allocate_tab(session, runtimes);
  if (created == nullptr) {
    return;
  }
  if (!fit_tab_to_viewport(session, *created, runtimes)) {
    if (session.active) {
      const auto created_id = created->id;
      erase_tab_panes(session, *created, runtimes);
      std::span(session.tabs).subspan(created_id.slot(), 1).front().tab.reset();
      const bool order_erased = session.tab_order.erase(created_id);
      LEMMA_ASSERT(order_erased);
      session.active_tab = previous_active;
      session.previous_tab = previous_previous;
    }
    return;
  }
  schedule_frame(session, FrameUrgency::state_change, true);
}

// Splitting stages topology, pane identity, runtime creation, and geometry before publishing the
// candidate layout through the same bounded resize transaction used by interactive resize.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto split_pane(SessionRecord& session, Tab& tab, PaneRuntimeStore& runtimes,
                              const PaneId source_pane, const SplitAxis axis) noexcept -> bool {
  if (pane_count(session) >= panes_per_session_max ||
      find_pane(session, tab, source_pane) == nullptr ||
      !runtimes.can_reserve_scrollback(limits::terminal_scrollback_bytes_default)) {
    return false;
  }
  const auto pane_index = empty_pane_slot(session);
  if (!pane_index.has_value()) {
    return false;
  }
  auto& pane_slot = std::span(session.panes).subspan(*pane_index, 1).front();
  const auto pane_generation = next_generation(pane_slot.generation);
  const auto pane_id = PaneId::from_parts(static_cast<std::uint32_t>(*pane_index), pane_generation);

  auto proposed_layout = tab.layout;
  if (!proposed_layout.split(source_pane, pane_id, axis)) {
    return false;
  }
  const render::PaneRectangle viewport{
      .columns = tab.layout_columns,
      .rows = tab.layout_rows,
  };
  const auto projection = proposed_layout.project(viewport);
  const auto new_rectangle = projection.has_value() ? projection->rectangle(pane_id) : std::nullopt;
  if (!new_rectangle.has_value()) {
    return false;
  }

  auto runtime =
      create_pane_runtime(new_rectangle->columns, new_rectangle->rows, session.cwd(),
                          session.launch_environment(), session.environment_mode, session.theme);
  if (runtime == nullptr) {
    return false;
  }
  std::unique_ptr<Pane> created;
  try {
    created =
        std::make_unique<Pane>(Pane{.id = pane_id, .tab = tab.id, .rectangle = *new_rectangle});
  } catch (const std::bad_alloc&) {
    return false;
  }

  const auto previous_zoomed = tab.zoomed;
  const auto previous_focused = tab.focused_pane;
  const auto previous_previous = tab.previous_pane;
  const auto previous_generation = pane_slot.generation;
  const PaneAddress address{.session = session.id, .pane = pane_id};
  if (!runtimes.insert(address, std::move(runtime))) {
    return false;
  }
  pane_slot.generation = pane_generation;
  pane_slot.pane = std::move(created);
  tab.zoomed = false;
  tab.previous_pane = source_pane;
  tab.focused_pane = pane_id;
  if (!resolve_session_layout(session, tab, runtimes, &proposed_layout)) {
    if (session.active) {
      const bool erased = runtimes.erase(address);
      LEMMA_ASSERT(erased);
      pane_slot.pane.reset();
      pane_slot.generation = previous_generation;
      tab.zoomed = previous_zoomed;
      tab.focused_pane = previous_focused;
      tab.previous_pane = previous_previous;
    }
    return false;
  }
  schedule_frame(session, FrameUrgency::state_change, true);
  return true;
}

[[nodiscard]] auto close_pane(SessionRecord& session, Tab& tab, PaneRuntimeStore& runtimes,
                              const PaneId pane_id) noexcept -> bool {
  auto* const pane = find_pane(session, tab, pane_id);
  if (pane == nullptr) {
    return false;
  }
  if (session.attachment.selection_target ==
      std::optional{AttachmentPaneTarget{.tab = tab.id, .pane = pane_id}}) {
    leave_copy_mode(session, runtimes);
  }
  const auto pane_index = static_cast<std::size_t>(pane_id.slot());
  const bool was_focused = pane_id == tab.focused_pane;
  if (pane_count(tab) == 1) {
    remove_tab(session, runtimes, tab.id);
    return true;
  }
  auto proposed_layout = tab.layout;
  const auto focus_candidate = proposed_layout.remove(pane_id);
  if (!focus_candidate.has_value()) {
    return false;
  }
  // Process teardown is irreversible, so publish the already-valid reduced topology before
  // removing its runtime counterpart. Any later external resize rejection suspends this layout.
  tab.layout = proposed_layout;
  const bool runtime_erased = runtimes.erase(pane_address(session, *pane));
  LEMMA_ASSERT(runtime_erased);
  std::span(session.panes).subspan(pane_index, 1).front().pane.reset();
  if (was_focused) {
    tab.focused_pane = *focus_candidate;
  }
  if (tab.previous_pane == pane_id || find_pane(session, tab, tab.previous_pane) == nullptr) {
    tab.previous_pane = tab.focused_pane;
  }
  tab.zoomed = false;
  if (!resolve_session_layout(session, tab, runtimes)) {
    if (session.active) {
      tab.layout_suspended = true;
      schedule_frame(session, FrameUrgency::state_change, true);
      return true;
    }
    return false;
  }
  schedule_frame(session, FrameUrgency::state_change, true);
  return true;
}

void focus_pane(SessionRecord& session, Tab& tab, PaneRuntimeStore& runtimes,
                const PaneId pane_id) noexcept {
  if (pane_id == tab.focused_pane || find_pane(session, tab, pane_id) == nullptr) {
    return;
  }
  const auto previous_focused = tab.focused_pane;
  const auto previous_previous = tab.previous_pane;
  tab.previous_pane = tab.focused_pane;
  tab.focused_pane = pane_id;
  if (tab.zoomed && !resolve_session_layout(session, tab, runtimes)) {
    if (session.active) {
      tab.focused_pane = previous_focused;
      tab.previous_pane = previous_previous;
    }
    return;
  }
  schedule_frame(session, FrameUrgency::state_change, tab.zoomed);
}

void focus_next(SessionRecord& session, Tab& tab, PaneRuntimeStore& runtimes,
                const PaneId source_pane) noexcept {
  for (std::size_t offset = 1; offset <= session.panes.size(); ++offset) {
    const auto candidate =
        (static_cast<std::size_t>(source_pane.slot()) + offset) % session.panes.size();
    // candidate is reduced modulo the fixed Session pane capacity.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-constant-array-index,cppcoreguidelines-pro-bounds-avoid-unchecked-container-access)
    const auto& pane = session.panes[candidate].pane;
    if (pane != nullptr && pane->tab == tab.id) {
      focus_pane(session, tab, runtimes, pane->id);
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

// Focus and swap share one spatial-neighbor rule so modifier changes never retarget a different
// pane. Directional scoring handles each axis explicitly and remains bounded by pane capacity.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto pane_in_direction(const SessionRecord& session, const Tab& tab,
                                     const PaneId source_pane,
                                     const FocusDirection direction) noexcept
    -> std::optional<PaneId> {
  // Zoom resizes focused panes to the viewport, so derive stable tiled geometry from the tree.
  const render::PaneRectangle viewport{
      .columns = tab.layout_columns,
      .rows = tab.layout_rows,
  };
  const auto projection = tab.layout.project(viewport);
  const auto current_rectangle =
      projection.has_value() ? projection->rectangle(source_pane) : std::nullopt;
  if (!projection.has_value() || !current_rectangle.has_value()) {
    return std::nullopt;
  }
  const auto& rectangles = projection->rectangles;
  const auto current = *current_rectangle;
  const auto current_right = static_cast<std::uint32_t>(current.column) + current.columns;
  const auto current_bottom = static_cast<std::uint32_t>(current.row) + current.rows;
  const auto current_x = (static_cast<std::uint32_t>(current.column) * 2U) + current.columns;
  const auto current_y = (static_cast<std::uint32_t>(current.row) * 2U) + current.rows;
  std::uint64_t best_score = std::numeric_limits<std::uint64_t>::max();
  std::optional<PaneId> best;
  for (std::size_t index = 0; index < session.panes.size(); ++index) {
    // index is bounded by the fixed Session pane capacity.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-constant-array-index,cppcoreguidelines-pro-bounds-avoid-unchecked-container-access)
    const auto& candidate = session.panes[index].pane;
    if (candidate == nullptr || candidate->tab != tab.id || candidate->id == source_pane) {
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
  return best;
}

void focus_direction(SessionRecord& session, Tab& tab, PaneRuntimeStore& runtimes,
                     const PaneId source_pane, const FocusDirection direction) noexcept {
  if (const auto target = pane_in_direction(session, tab, source_pane, direction);
      target.has_value()) {
    focus_pane(session, tab, runtimes, *target);
  }
}

[[nodiscard]] auto commit_layout_resize(SessionRecord& session, Tab& tab,
                                        PaneRuntimeStore& runtimes,
                                        const PaneLayout& proposed_layout) noexcept
    -> CommandResult {
  if (!resolve_session_layout(session, tab, runtimes, &proposed_layout)) {
    if (session.active) {
      // A rejected compensating transaction may still have reflowed terminals out and back.
      // Repair presentation without publishing the proposed ratio.
      schedule_frame(session, FrameUrgency::state_change, true);
      return {.status = CommandStatus::unavailable};
    }
    return {.status = CommandStatus::failed};
  }
  schedule_frame(session, FrameUrgency::state_change, true);
  return {.status = CommandStatus::applied};
}

[[nodiscard]] auto resize_split(SessionRecord& session, Tab& tab, PaneRuntimeStore& runtimes,
                                const PaneId pane, const ResizeDirection direction) noexcept
    -> CommandResult {
  if (tab.zoomed || tab.layout_suspended) {
    return {.status = CommandStatus::unavailable};
  }
  auto proposed_layout = tab.layout;
  const render::PaneRectangle viewport{
      .columns = tab.layout_columns,
      .rows = tab.layout_rows,
  };
  const auto edit = proposed_layout.resize(pane, direction, viewport);
  switch (edit) {
  case LayoutResizeStatus::no_effect:
    return {.status = CommandStatus::no_effect};
  case LayoutResizeStatus::unavailable:
    return {.status = CommandStatus::unavailable};
  case LayoutResizeStatus::invalid:
    LEMMA_ASSERT(false && "PaneLayout rejected an authoritative pane target");
  case LayoutResizeStatus::applied:
    break;
  }
  return commit_layout_resize(session, tab, runtimes, proposed_layout);
}

[[nodiscard]] auto resize_split_divider(SessionRecord& session, Tab& tab,
                                        PaneRuntimeStore& runtimes, const LayoutDivider divider,
                                        const std::uint16_t coordinate) noexcept -> CommandResult {
  if (tab.zoomed || tab.layout_suspended) {
    return {.status = CommandStatus::unavailable};
  }
  auto proposed_layout = tab.layout;
  const render::PaneRectangle viewport{
      .columns = tab.layout_columns,
      .rows = tab.layout_rows,
  };
  const auto edit = proposed_layout.resize_divider(divider, coordinate, viewport);
  switch (edit) {
  case LayoutResizeStatus::no_effect:
    return {.status = CommandStatus::no_effect};
  case LayoutResizeStatus::unavailable:
    return {.status = CommandStatus::unavailable};
  case LayoutResizeStatus::invalid:
    return {.status = CommandStatus::stale_target};
  case LayoutResizeStatus::applied:
    break;
  }
  return commit_layout_resize(session, tab, runtimes, proposed_layout);
}

template <typename Value>
[[nodiscard]] auto command_payload_value(const CommandPayload& payload) noexcept -> const Value& {
  const auto* const value = std::get_if<Value>(&payload);
  LEMMA_ASSERT(value != nullptr);
  return *value;
}

[[nodiscard]] auto swap_panes(SessionRecord& session, Tab& tab, PaneRuntimeStore& runtimes,
                              const PaneId first, const PaneId second) noexcept -> CommandResult {
  if (tab.zoomed || tab.layout_suspended) {
    return {.status = CommandStatus::unavailable};
  }
  auto proposed = tab.layout;
  if (!proposed.swap(first, second)) {
    return {.status = CommandStatus::stale_target};
  }
  return commit_layout_resize(session, tab, runtimes, proposed);
}

[[nodiscard]] constexpr auto command_status(const bool changed) noexcept -> CommandResult {
  return {.status = changed ? CommandStatus::applied : CommandStatus::no_effect};
}

// Resolving relative input intent into stable IDs is deliberately centralized at the input/Core
// bridge rather than represented as another semantic mutation primitive.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto command_from_input(const SessionRecord& session,
                                      const input::InputCommand input_command,
                                      const CommandOrigin origin) noexcept
    -> std::optional<Command> {
  Command command{.origin = origin};
  switch (input_command) {
  case input::InputCommand::detach:
    command.kind = CommandKind::detach_client;
    break;
  case input::InputCommand::split_left_right:
    command.kind = CommandKind::split_left_right;
    break;
  case input::InputCommand::split_top_bottom:
    command.kind = CommandKind::split_top_bottom;
    break;
  case input::InputCommand::resize_left:
    command.kind = CommandKind::resize_left;
    break;
  case input::InputCommand::resize_right:
    command.kind = CommandKind::resize_right;
    break;
  case input::InputCommand::resize_up:
    command.kind = CommandKind::resize_up;
    break;
  case input::InputCommand::resize_down:
    command.kind = CommandKind::resize_down;
    break;
  case input::InputCommand::focus_left:
    command.kind = CommandKind::focus_left;
    break;
  case input::InputCommand::focus_right:
    command.kind = CommandKind::focus_right;
    break;
  case input::InputCommand::focus_up:
    command.kind = CommandKind::focus_up;
    break;
  case input::InputCommand::focus_down:
    command.kind = CommandKind::focus_down;
    break;
  case input::InputCommand::focus_next:
    command.kind = CommandKind::focus_next;
    break;
  case input::InputCommand::focus_previous:
    command.kind = CommandKind::focus_previous;
    break;
  case input::InputCommand::close_pane:
    command.kind = CommandKind::close_pane;
    break;
  case input::InputCommand::toggle_zoom:
    command.kind = CommandKind::toggle_zoom;
    break;
  case input::InputCommand::enter_copy_mode:
    command.kind = CommandKind::enter_copy_mode;
    break;
  case input::InputCommand::enter_copy_search_forward:
    command.kind = CommandKind::enter_copy_search_forward;
    break;
  case input::InputCommand::enter_copy_search_backward:
    command.kind = CommandKind::enter_copy_search_backward;
    break;
  case input::InputCommand::create_tab:
    command.kind = CommandKind::create_tab;
    break;
  case input::InputCommand::next_tab:
    command.kind = CommandKind::next_tab;
    break;
  case input::InputCommand::previous_tab:
    command.kind = CommandKind::previous_tab;
    break;
  case input::InputCommand::begin_rename_session:
    command.kind = CommandKind::begin_rename_session;
    command.target = {.session = session.id,
                      .tab = {},
                      .pane = {},
                      .peer_pane = {},
                      .attachment = session.attachment.id};
    break;
  case input::InputCommand::begin_rename_tab:
    command.kind = CommandKind::begin_rename_tab;
    command.target = {.session = session.id,
                      .tab = session.active_tab,
                      .pane = {},
                      .peer_pane = {},
                      .attachment = session.attachment.id};
    break;
  case input::InputCommand::move_tab_left:
  case input::InputCommand::move_tab_right: {
    const auto position = session.tab_order.position_of(session.active_tab);
    if (!position.has_value() || session.tab_order.size() <= 1U) {
      return std::nullopt;
    }
    command.kind = CommandKind::place_tab;
    command.target = {.session = session.id,
                      .tab = session.active_tab,
                      .pane = {},
                      .peer_pane = {},
                      .attachment = {}};
    const auto position_value = position.value_or(0);
    TabId before;
    if (input_command == input::InputCommand::move_tab_left) {
      if (position_value > 0) {
        before = session.tab_order.at(position_value - 1U).value_or(TabId{});
      }
    } else if (position_value + 1U == session.tab_order.size()) {
      before = session.tab_order.at(0).value_or(TabId{});
    } else if (position_value + 2U < session.tab_order.size()) {
      before = session.tab_order.at(position_value + 2U).value_or(TabId{});
    }
    command.payload = TabPlacementCommand{.before = before};
    break;
  }
  case input::InputCommand::swap_pane_left:
  case input::InputCommand::swap_pane_right:
  case input::InputCommand::swap_pane_up:
  case input::InputCommand::swap_pane_down: {
    auto direction = FocusDirection::left;
    if (input_command == input::InputCommand::swap_pane_right) {
      direction = FocusDirection::right;
    } else if (input_command == input::InputCommand::swap_pane_up) {
      direction = FocusDirection::up;
    } else if (input_command == input::InputCommand::swap_pane_down) {
      direction = FocusDirection::down;
    }
    const auto* const tab = active_tab(session);
    const auto other = tab == nullptr
                           ? std::nullopt
                           : pane_in_direction(session, *tab, tab->focused_pane, direction);
    if (tab == nullptr || !other.has_value()) {
      return std::nullopt;
    }
    command.kind = CommandKind::swap_panes;
    command.target = {.session = session.id,
                      .tab = tab->id,
                      .pane = tab->focused_pane,
                      .peer_pane = {},
                      .attachment = {}};
    command.payload = PaneSwapCommand{.other = *other};
    break;
  }
  case input::InputCommand::close_tab:
    command.kind = CommandKind::close_tab;
    break;
  case input::InputCommand::select_tab_0:
  case input::InputCommand::select_tab_1:
  case input::InputCommand::select_tab_2:
  case input::InputCommand::select_tab_3:
  case input::InputCommand::select_tab_4:
  case input::InputCommand::select_tab_5:
  case input::InputCommand::select_tab_6:
  case input::InputCommand::select_tab_7:
  case input::InputCommand::select_tab_8:
  case input::InputCommand::select_tab_9: {
    command.kind = CommandKind::select_tab;
    const auto encoded = static_cast<std::uint8_t>(input_command);
    const auto first = static_cast<std::uint8_t>(input::InputCommand::select_tab_0);
    const auto logical = static_cast<std::uint16_t>(encoded - first);
    command.payload = CommandCoordinate{
        .value = logical == 0U ? std::uint16_t{9} : static_cast<std::uint16_t>(logical - 1U)};
    break;
  }
  case input::InputCommand::count:
    return std::nullopt;
  }
  return command;
}

[[nodiscard]] constexpr auto pane_input_command(const protocol::PaneCommand command) noexcept
    -> std::optional<input::InputCommand> {
  using enum input::InputCommand;
  switch (command) {
  case protocol::PaneCommand::none:
    return std::nullopt;
  case protocol::PaneCommand::split_left_right:
    return split_left_right;
  case protocol::PaneCommand::split_top_bottom:
    return split_top_bottom;
  case protocol::PaneCommand::resize_left:
    return resize_left;
  case protocol::PaneCommand::resize_right:
    return resize_right;
  case protocol::PaneCommand::resize_up:
    return resize_up;
  case protocol::PaneCommand::resize_down:
    return resize_down;
  case protocol::PaneCommand::focus_left:
    return focus_left;
  case protocol::PaneCommand::focus_right:
    return focus_right;
  case protocol::PaneCommand::focus_up:
    return focus_up;
  case protocol::PaneCommand::focus_down:
    return focus_down;
  case protocol::PaneCommand::focus_next:
    return focus_next;
  case protocol::PaneCommand::focus_previous:
    return focus_previous;
  case protocol::PaneCommand::close:
    return close_pane;
  case protocol::PaneCommand::zoom:
    return toggle_zoom;
  case protocol::PaneCommand::enter_copy_mode:
    return enter_copy_mode;
  case protocol::PaneCommand::enter_copy_search_forward:
    return enter_copy_search_forward;
  case protocol::PaneCommand::enter_copy_search_backward:
    return enter_copy_search_backward;
  case protocol::PaneCommand::create_tab:
    return create_tab;
  case protocol::PaneCommand::next_tab:
    return next_tab;
  case protocol::PaneCommand::previous_tab:
    return previous_tab;
  case protocol::PaneCommand::begin_rename_session:
    return begin_rename_session;
  case protocol::PaneCommand::begin_rename_tab:
    return begin_rename_tab;
  case protocol::PaneCommand::move_tab_left:
    return move_tab_left;
  case protocol::PaneCommand::move_tab_right:
    return move_tab_right;
  case protocol::PaneCommand::swap_pane_left:
    return swap_pane_left;
  case protocol::PaneCommand::swap_pane_right:
    return swap_pane_right;
  case protocol::PaneCommand::swap_pane_up:
    return swap_pane_up;
  case protocol::PaneCommand::swap_pane_down:
    return swap_pane_down;
  case protocol::PaneCommand::kill_tab:
    return close_tab;
  case protocol::PaneCommand::select_tab_0:
    return select_tab_0;
  case protocol::PaneCommand::select_tab_1:
    return select_tab_1;
  case protocol::PaneCommand::select_tab_2:
    return select_tab_2;
  case protocol::PaneCommand::select_tab_3:
    return select_tab_3;
  case protocol::PaneCommand::select_tab_4:
    return select_tab_4;
  case protocol::PaneCommand::select_tab_5:
    return select_tab_5;
  case protocol::PaneCommand::select_tab_6:
    return select_tab_6;
  case protocol::PaneCommand::select_tab_7:
    return select_tab_7;
  case protocol::PaneCommand::select_tab_8:
    return select_tab_8;
  case protocol::PaneCommand::select_tab_9:
    return select_tab_9;
  }
  return std::nullopt;
}

[[nodiscard]] auto command_from_pane_command(const SessionRecord& session,
                                             const protocol::PaneCommand pane_command) noexcept
    -> std::optional<Command> {
  const auto input_command = pane_input_command(pane_command);
  return input_command.has_value()
             ? command_from_input(session, *input_command, CommandOrigin::client)
             : std::nullopt;
}

using SessionNameConflict = bool (*)(void* context, SessionId renamed,
                                     std::string_view candidate) noexcept;

struct SessionCommandContext final {
  SessionRecord* session{nullptr};
  PaneRuntimeStore* runtimes{nullptr};
  SessionNameConflict name_conflict{nullptr};
  void* name_conflict_context{nullptr};
};

[[nodiscard]] auto tab_title(const SessionRecord& session, const Tab& tab,
                             const PaneRuntimeStore& runtimes) noexcept -> std::string_view;

enum class StatusHitKind : std::uint8_t {
  tab,
  create_tab,
};

struct StatusHit final {
  TabId tab;
  TabId next;
  std::uint16_t position{0};
  std::uint16_t moving_position{0};
  StatusHitKind kind{StatusHitKind::tab};
};

[[nodiscard]] auto status_target_at_column(const SessionRecord& session,
                                           const PaneRuntimeStore& runtimes,
                                           std::uint16_t column) noexcept
    -> std::optional<StatusHit>;

// This is the only function that translates validated commands into authoritative mux mutations.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto execute_session_command(void* const context, const Command& command) noexcept
    -> CommandResult {
  auto& command_context = *static_cast<SessionCommandContext*>(context);
  LEMMA_ASSERT(command_context.session != nullptr && command_context.runtimes != nullptr);
  auto& session = *command_context.session;
  auto& runtimes = *command_context.runtimes;
  if (command.target.session.is_valid() && command.target.session != session.id) {
    return {.status = command.target.session.slot() == session.id.slot()
                          ? CommandStatus::stale_target
                          : CommandStatus::wrong_owner};
  }
  if (command.target.attachment.is_valid() && command.target.attachment != session.attachment.id) {
    return {.status = command.target.attachment.slot() == session.id.slot()
                          ? CommandStatus::stale_target
                          : CommandStatus::wrong_owner};
  }
  if (command.kind == CommandKind::detach_client) {
    return session.attachment_runtime.client >= 0
               ? CommandResult{.status = CommandStatus::detach_requested}
               : CommandResult{.status = CommandStatus::unavailable};
  }
  if (command.kind == CommandKind::stop_session) {
    const bool changed = session.active;
    session.active = false;
    return command_status(changed);
  }
  if (command.kind == CommandKind::cancel_attachment_interaction) {
    const bool changed =
        session.attachment.copy_mode.active() || session.attachment.rename_prompt.active();
    leave_copy_mode(session, runtimes);
    reset_rename_prompt(session);
    return command_status(changed);
  }
  if (command.kind == CommandKind::begin_rename_session) {
    if (session.attachment.copy_mode.active()) {
      leave_copy_mode(session, runtimes);
    }
    return begin_rename_prompt(session, RenamePromptKind::session, {}, {})
               ? CommandResult{.status = CommandStatus::applied}
               : CommandResult{.status = CommandStatus::unavailable};
  }
  if (command.kind == CommandKind::rename_session) {
    const auto& name = command_payload_value<SessionNameValue>(command.payload);
    if (session.session_name() == name.view()) {
      return {.status = CommandStatus::no_effect};
    }
    if (command_context.name_conflict == nullptr) {
      return {.status = CommandStatus::unavailable};
    }
    if (command_context.name_conflict(command_context.name_conflict_context, session.id,
                                      name.view())) {
      return {.status = CommandStatus::conflict};
    }
    const bool renamed = session.rename(name.view());
    LEMMA_ASSERT(renamed);
    reset_rename_prompt(session, false);
    session.attachment_runtime.status_valid = false;
    schedule_frame(session, FrameUrgency::state_change, false);
    return {.status = CommandStatus::applied};
  }

  auto* const tab =
      command.target.tab.is_valid() ? find_tab(session, command.target.tab) : active_tab(session);
  if (tab == nullptr) {
    return {.status = command.target.tab.is_valid() ? CommandStatus::stale_target
                                                    : CommandStatus::failed};
  }
  if (command.kind == CommandKind::begin_rename_tab) {
    if (session.attachment.copy_mode.active()) {
      leave_copy_mode(session, runtimes);
    }
    return begin_rename_prompt(session, RenamePromptKind::tab, tab->id,
                               tab_title(session, *tab, runtimes))
               ? CommandResult{.status = CommandStatus::applied}
               : CommandResult{.status = CommandStatus::unavailable};
  }
  auto* const targeted_pane = command.target.pane.is_valid()
                                  ? find_pane(session, *tab, command.target.pane)
                                  : find_pane(session, *tab, tab->focused_pane);
  if (targeted_pane == nullptr) {
    return {.status = command.target.pane.is_valid() ? CommandStatus::stale_target
                                                     : CommandStatus::failed};
  }
  const bool divider_resize = command.kind == CommandKind::resize_left_right_divider ||
                              command.kind == CommandKind::resize_top_bottom_divider;
  auto* const peer_pane =
      divider_resize ? find_pane(session, *tab, command.target.peer_pane) : nullptr;
  if (divider_resize && peer_pane == nullptr) {
    return {.status = CommandStatus::stale_target};
  }

  const auto focus_result = [&](const PaneId previous) {
    return session.active ? command_status(tab->focused_pane != previous)
                          : CommandResult{.status = CommandStatus::failed};
  };
  const bool copy_command = command.kind == CommandKind::enter_copy_mode ||
                            command.kind == CommandKind::enter_copy_search_forward ||
                            command.kind == CommandKind::enter_copy_search_backward;
  if (session.attachment.copy_mode.active() && !copy_command) {
    leave_copy_mode(session, runtimes);
  }
  switch (command.kind) {
  case CommandKind::none:
  case CommandKind::detach_client:
  case CommandKind::cancel_attachment_interaction:
  case CommandKind::begin_rename_session:
  case CommandKind::begin_rename_tab:
  case CommandKind::rename_session:
  case CommandKind::stop_session:
    return {.status = CommandStatus::invalid_command};
  case CommandKind::split_left_right:
    if (pane_count(session) >= panes_per_session_max) {
      return {.status = CommandStatus::capacity};
    }
    if (split_pane(session, *tab, runtimes, targeted_pane->id, SplitAxis::left_right)) {
      return {.status = CommandStatus::applied};
    }
    return {.status = session.active ? CommandStatus::unavailable : CommandStatus::failed};
  case CommandKind::split_top_bottom:
    if (pane_count(session) >= panes_per_session_max) {
      return {.status = CommandStatus::capacity};
    }
    if (split_pane(session, *tab, runtimes, targeted_pane->id, SplitAxis::top_bottom)) {
      return {.status = CommandStatus::applied};
    }
    return {.status = session.active ? CommandStatus::unavailable : CommandStatus::failed};
  case CommandKind::resize_left_right_divider:
    LEMMA_ASSERT(peer_pane != nullptr);
    return resize_split_divider(
        session, *tab, runtimes,
        {.first = targeted_pane->id, .second = peer_pane->id, .axis = SplitAxis::left_right},
        command_payload_value<CommandCoordinate>(command.payload).value);
  case CommandKind::resize_top_bottom_divider:
    LEMMA_ASSERT(peer_pane != nullptr);
    return resize_split_divider(
        session, *tab, runtimes,
        {.first = targeted_pane->id, .second = peer_pane->id, .axis = SplitAxis::top_bottom},
        command_payload_value<CommandCoordinate>(command.payload).value);
  case CommandKind::resize_left:
    return resize_split(session, *tab, runtimes, targeted_pane->id, ResizeDirection::left);
  case CommandKind::resize_right:
    return resize_split(session, *tab, runtimes, targeted_pane->id, ResizeDirection::right);
  case CommandKind::resize_up:
    return resize_split(session, *tab, runtimes, targeted_pane->id, ResizeDirection::up);
  case CommandKind::resize_down:
    return resize_split(session, *tab, runtimes, targeted_pane->id, ResizeDirection::down);
  case CommandKind::focus_left: {
    const auto previous = tab->focused_pane;
    focus_direction(session, *tab, runtimes, targeted_pane->id, FocusDirection::left);
    return focus_result(previous);
  }
  case CommandKind::focus_right: {
    const auto previous = tab->focused_pane;
    focus_direction(session, *tab, runtimes, targeted_pane->id, FocusDirection::right);
    return focus_result(previous);
  }
  case CommandKind::focus_up: {
    const auto previous = tab->focused_pane;
    focus_direction(session, *tab, runtimes, targeted_pane->id, FocusDirection::up);
    return focus_result(previous);
  }
  case CommandKind::focus_down: {
    const auto previous = tab->focused_pane;
    focus_direction(session, *tab, runtimes, targeted_pane->id, FocusDirection::down);
    return focus_result(previous);
  }
  case CommandKind::focus_next: {
    const auto previous = tab->focused_pane;
    focus_next(session, *tab, runtimes, targeted_pane->id);
    return focus_result(previous);
  }
  case CommandKind::focus_previous: {
    const auto previous = tab->focused_pane;
    focus_pane(session, *tab, runtimes, tab->previous_pane);
    return focus_result(previous);
  }
  case CommandKind::focus_pane: {
    const auto previous = tab->focused_pane;
    focus_pane(session, *tab, runtimes, targeted_pane->id);
    return focus_result(previous);
  }
  case CommandKind::close_pane:
    if (close_pane(session, *tab, runtimes, targeted_pane->id)) {
      return {.status = CommandStatus::applied};
    }
    return {.status = session.active ? CommandStatus::unavailable : CommandStatus::failed};
  case CommandKind::toggle_zoom: {
    const auto previous_focused = tab->focused_pane;
    const auto previous_previous = tab->previous_pane;
    const auto previous_zoomed = tab->zoomed;
    if (targeted_pane->id != tab->focused_pane) {
      tab->previous_pane = tab->focused_pane;
      tab->focused_pane = targeted_pane->id;
    }
    tab->zoomed = !tab->zoomed;
    if (!resolve_session_layout(session, *tab, runtimes)) {
      if (session.active) {
        tab->focused_pane = previous_focused;
        tab->previous_pane = previous_previous;
        tab->zoomed = previous_zoomed;
        return {.status = CommandStatus::unavailable};
      }
      return {.status = CommandStatus::failed};
    }
    schedule_frame(session, FrameUrgency::state_change, true);
    return {.status = CommandStatus::applied};
  }
  case CommandKind::enter_copy_mode:
    if (session.attachment.copy_mode.active()) {
      leave_copy_mode(session, runtimes);
      return {.status = CommandStatus::applied};
    }
    if (auto* const runtime = find_pane_runtime(runtimes, session, *tab, *targeted_pane);
        runtime != nullptr && enter_copy_mode(session, *tab, *targeted_pane, *runtime, runtimes)) {
      return {.status = CommandStatus::applied};
    }
    return {.status = CommandStatus::unavailable};
  case CommandKind::enter_copy_search_forward:
  case CommandKind::enter_copy_search_backward: {
    auto* runtime = find_pane_runtime(runtimes, session, *tab, *targeted_pane);
    if (runtime == nullptr) {
      return {.status = CommandStatus::unavailable};
    }
    if (!session.attachment.copy_mode.active() &&
        !enter_copy_mode(session, *tab, *targeted_pane, *runtime, runtimes)) {
      return {.status = CommandStatus::unavailable};
    }
    runtime = copy_mode_runtime(session, runtimes);
    const auto direction = command.kind == CommandKind::enter_copy_search_forward
                               ? CopySearchDirection::forward
                               : CopySearchDirection::backward;
    if (runtime == nullptr || !begin_copy_search_prompt(session, *runtime, direction)) {
      leave_copy_mode(session, runtimes);
      return {.status = CommandStatus::unavailable};
    }
    return {.status = CommandStatus::applied};
  }
  case CommandKind::rename_tab: {
    const auto& title = command_payload_value<TabTitleValue>(command.payload);
    if (tab->title_override() == title.view()) {
      return {.status = CommandStatus::no_effect};
    }
    const bool renamed = tab->set_title_override(title.view());
    LEMMA_ASSERT(renamed);
    if (session.attachment.rename_prompt.kind == RenamePromptKind::tab &&
        session.attachment.rename_prompt.tab == tab->id) {
      reset_rename_prompt(session, false);
    }
    session.attachment_runtime.status_valid = false;
    schedule_frame(session, FrameUrgency::state_change, false);
    return {.status = CommandStatus::applied};
  }
  case CommandKind::place_tab: {
    const auto before = command_payload_value<TabPlacementCommand>(command.payload).before;
    if (before.is_valid() && find_tab(session, before) == nullptr) {
      return {.status = CommandStatus::stale_target};
    }
    const bool changed = session.tab_order.place_before(
        tab->id, before.is_valid() ? std::optional<TabId>{before} : std::nullopt);
    if (changed) {
      session.attachment_runtime.status_valid = false;
      schedule_frame(session, FrameUrgency::state_change, false);
    }
    return command_status(changed);
  }
  case CommandKind::swap_panes: {
    const auto other_id = command_payload_value<PaneSwapCommand>(command.payload).other;
    auto* const other = find_pane(session, *tab, other_id);
    if (other == nullptr) {
      return {.status = CommandStatus::stale_target};
    }
    finish_live_divider_resize(session);
    return swap_panes(session, *tab, runtimes, targeted_pane->id, other->id);
  }
  case CommandKind::create_tab: {
    if (tab_count(session) >= session.tabs.size() || pane_count(session) >= panes_per_session_max) {
      return {.status = CommandStatus::capacity};
    }
    const auto previous = tab_count(session);
    create_tab(session, runtimes);
    if (!session.active) {
      return {.status = CommandStatus::failed};
    }
    return previous == tab_count(session) ? CommandResult{.status = CommandStatus::unavailable}
                                          : CommandResult{.status = CommandStatus::applied};
  }
  case CommandKind::next_tab: {
    const auto previous = session.active_tab;
    cycle_tab(session, runtimes, true);
    return session.active ? command_status(previous != session.active_tab)
                          : CommandResult{.status = CommandStatus::failed};
  }
  case CommandKind::previous_tab: {
    const auto previous = session.active_tab;
    cycle_tab(session, runtimes, false);
    return session.active ? command_status(previous != session.active_tab)
                          : CommandResult{.status = CommandStatus::failed};
  }
  case CommandKind::close_tab:
    remove_tab(session, runtimes, tab->id);
    return {.status = CommandStatus::applied};
  case CommandKind::select_tab: {
    if (!command.target.tab.is_valid()) {
      return {.status = CommandStatus::unavailable};
    }
    const auto previous = session.active_tab;
    if (!select_tab(session, runtimes, command.target.tab)) {
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
  case CommandKind::resize_left_right_divider:
  case CommandKind::resize_top_bottom_divider:
  case CommandKind::resize_left:
  case CommandKind::resize_right:
  case CommandKind::resize_up:
  case CommandKind::resize_down:
  case CommandKind::focus_left:
  case CommandKind::focus_right:
  case CommandKind::focus_up:
  case CommandKind::focus_down:
  case CommandKind::focus_next:
  case CommandKind::focus_previous:
  case CommandKind::focus_pane:
  case CommandKind::close_pane:
  case CommandKind::toggle_zoom:
  case CommandKind::enter_copy_mode:
  case CommandKind::enter_copy_search_forward:
  case CommandKind::enter_copy_search_backward:
  case CommandKind::swap_panes:
    return true;
  case CommandKind::none:
  case CommandKind::detach_client:
  case CommandKind::cancel_attachment_interaction:
  case CommandKind::create_tab:
  case CommandKind::next_tab:
  case CommandKind::previous_tab:
  case CommandKind::close_tab:
  case CommandKind::select_tab:
  case CommandKind::begin_rename_session:
  case CommandKind::begin_rename_tab:
  case CommandKind::rename_session:
  case CommandKind::rename_tab:
  case CommandKind::place_tab:
  case CommandKind::stop_session:
    return false;
  }
  return false;
}

// Target completion is the single bounded bridge from implicit client commands to stable IDs.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto dispatch_session_command(SessionRecord& session, PaneRuntimeStore& runtimes,
                                            const Command& command,
                                            const SessionNameConflict name_conflict = nullptr,
                                            void* const name_conflict_context = nullptr) noexcept
    -> CommandResult {
  auto resolved = command;
  if (!resolved.target.session.is_valid()) {
    resolved.target.session = session.id;
  }
  if (resolved.origin == CommandOrigin::client && !resolved.target.attachment.is_valid()) {
    resolved.target.attachment = session.attachment.id;
  }
  if (resolved.kind == CommandKind::select_tab && !resolved.target.tab.is_valid()) {
    const auto* const selected = tab_at_position(
        session,
        static_cast<std::size_t>(command_payload_value<CommandCoordinate>(resolved.payload).value));
    if (selected != nullptr) {
      resolved.target.tab = selected->id;
    }
  } else if (resolved.kind != CommandKind::detach_client &&
             resolved.kind != CommandKind::cancel_attachment_interaction &&
             resolved.kind != CommandKind::begin_rename_session &&
             resolved.kind != CommandKind::rename_session &&
             resolved.kind != CommandKind::stop_session && !resolved.target.tab.is_valid()) {
    resolved.target.tab = session.active_tab;
  }
  if (targets_pane(resolved.kind) && !resolved.target.pane.is_valid()) {
    const auto* const tab = find_tab(session, resolved.target.tab);
    if (tab != nullptr) {
      resolved.target.pane = tab->focused_pane;
    }
  }
  SessionCommandContext context{.session = &session,
                                .runtimes = &runtimes,
                                .name_conflict = name_conflict,
                                .name_conflict_context = name_conflict_context};
  const CommandDispatcher dispatcher(&execute_session_command, &context);
  return dispatcher.dispatch(resolved);
}

void invalidate_rename_prompt(SessionRecord& session) noexcept {
  schedule_frame(session, FrameUrgency::state_change, false);
}

[[nodiscard]] auto insert_rename_prompt_text(SessionRecord& session,
                                             const std::span<const std::byte> input) noexcept
    -> bool {
  auto& prompt = session.attachment.rename_prompt;
  if (!prompt.active()) {
    return false;
  }
  const auto capacity = rename_prompt_capacity(prompt.kind);
  if (prompt.size >= capacity) {
    return false;
  }
  // The editor can retain at most one title's worth of bytes. Do not scan a protocol-maximum paste
  // on the reactor thread looking for useful characters after that bounded prefix.
  const auto examined = input.first(std::min(input.size(), limits::tab_title_bytes_max));
  bool changed = false;
  for (const auto encoded : examined) {
    if (prompt.size == capacity) {
      break;
    }
    const auto byte = std::to_integer<std::uint8_t>(encoded);
    if (!rename_prompt_character(prompt.kind, byte)) {
      continue;
    }
    auto text = std::span(prompt.text);
    for (std::size_t index = prompt.size; index > prompt.cursor; --index) {
      text.subspan(index, 1).front() = text.subspan(index - 1U, 1).front();
    }
    text.subspan(prompt.cursor, 1).front() = static_cast<char>(byte);
    ++prompt.cursor;
    ++prompt.size;
    prompt.feedback = RenamePromptFeedback::none;
    changed = true;
  }
  return changed;
}

[[nodiscard]] auto erase_rename_prompt_before_cursor(RenamePromptState& prompt) noexcept -> bool {
  if (prompt.cursor == 0) {
    return false;
  }
  auto text = std::span(prompt.text);
  for (std::size_t index = prompt.cursor; index < prompt.size; ++index) {
    text.subspan(index - 1U, 1).front() = text.subspan(index, 1).front();
  }
  --prompt.cursor;
  --prompt.size;
  std::span(prompt.text).subspan(prompt.size, 1).front() = {};
  prompt.feedback = RenamePromptFeedback::none;
  return true;
}

[[nodiscard]] auto erase_rename_prompt_at_cursor(RenamePromptState& prompt) noexcept -> bool {
  if (prompt.cursor >= prompt.size) {
    return false;
  }
  auto text = std::span(prompt.text);
  for (std::size_t index = prompt.cursor + 1U; index < prompt.size; ++index) {
    text.subspan(index - 1U, 1).front() = text.subspan(index, 1).front();
  }
  --prompt.size;
  std::span(prompt.text).subspan(prompt.size, 1).front() = {};
  prompt.feedback = RenamePromptFeedback::none;
  return true;
}

void clear_rename_prompt(RenamePromptState& prompt) noexcept {
  prompt.text = {};
  prompt.size = 0;
  prompt.cursor = 0;
  prompt.feedback = RenamePromptFeedback::none;
}

void erase_rename_prompt_word(RenamePromptState& prompt) noexcept {
  while (prompt.cursor > 0 &&
         std::span(prompt.text).subspan(prompt.cursor - 1U, 1).front() == ' ') {
    static_cast<void>(erase_rename_prompt_before_cursor(prompt));
  }
  while (prompt.cursor > 0 &&
         std::span(prompt.text).subspan(prompt.cursor - 1U, 1).front() != ' ') {
    static_cast<void>(erase_rename_prompt_before_cursor(prompt));
  }
}

void complete_rename_prompt(SessionRecord& session, PaneRuntimeStore& runtimes,
                            const SessionNameConflict name_conflict,
                            void* const name_conflict_context) noexcept {
  const auto prompt = session.attachment.rename_prompt;
  if (!prompt.active()) {
    return;
  }
  Command command{.origin = CommandOrigin::client};
  command.target = {.session = session.id,
                    .tab = {},
                    .pane = {},
                    .peer_pane = {},
                    .attachment = session.attachment.id};
  if (prompt.kind == RenamePromptKind::session) {
    const auto name = SessionNameValue::create(prompt.view());
    if (!name.has_value()) {
      session.attachment.rename_prompt.feedback = RenamePromptFeedback::invalid;
      invalidate_rename_prompt(session);
      return;
    }
    command.kind = CommandKind::rename_session;
    command.payload = *name;
  } else {
    const auto title = TabTitleValue::create(prompt.view());
    if (!title.has_value()) {
      session.attachment.rename_prompt.feedback = RenamePromptFeedback::invalid;
      invalidate_rename_prompt(session);
      return;
    }
    command.kind = CommandKind::rename_tab;
    command.target.tab = prompt.tab;
    command.payload = *title;
  }
  const auto result =
      dispatch_session_command(session, runtimes, command, name_conflict, name_conflict_context);
  if (result.succeeded()) {
    reset_rename_prompt(session, false);
  } else if (result.status == CommandStatus::conflict) {
    session.attachment.rename_prompt.feedback = RenamePromptFeedback::conflict;
  } else {
    session.attachment.rename_prompt.feedback = RenamePromptFeedback::invalid;
  }
  invalidate_rename_prompt(session);
}

enum class RenamePromptByteResult : std::uint8_t {
  unchanged,
  changed,
  finished,
};

[[nodiscard]] auto apply_rename_prompt_byte(SessionRecord& session, PaneRuntimeStore& runtimes,
                                            const std::byte encoded,
                                            const SessionNameConflict name_conflict,
                                            void* const name_conflict_context) noexcept
    -> RenamePromptByteResult {
  auto& prompt = session.attachment.rename_prompt;
  const auto byte = std::to_integer<std::uint8_t>(encoded);
  switch (byte) {
  case 0x1B:
  case 0x03:
  case 0x07:
    reset_rename_prompt(session, false);
    invalidate_rename_prompt(session);
    return RenamePromptByteResult::finished;
  case static_cast<std::uint8_t>('\r'):
  case static_cast<std::uint8_t>('\n'):
    complete_rename_prompt(session, runtimes, name_conflict, name_conflict_context);
    return RenamePromptByteResult::finished;
  case 0x7F:
  case 0x08:
    return erase_rename_prompt_before_cursor(prompt) ? RenamePromptByteResult::changed
                                                     : RenamePromptByteResult::unchanged;
  case 0x01: {
    const bool changed = prompt.cursor != 0;
    prompt.cursor = 0;
    return changed ? RenamePromptByteResult::changed : RenamePromptByteResult::unchanged;
  }
  case 0x05: {
    const bool changed = prompt.cursor != prompt.size;
    prompt.cursor = prompt.size;
    return changed ? RenamePromptByteResult::changed : RenamePromptByteResult::unchanged;
  }
  case 0x15: {
    const bool changed = prompt.size != 0;
    clear_rename_prompt(prompt);
    return changed ? RenamePromptByteResult::changed : RenamePromptByteResult::unchanged;
  }
  case 0x17: {
    const auto before = prompt.size;
    erase_rename_prompt_word(prompt);
    return prompt.size != before ? RenamePromptByteResult::changed
                                 : RenamePromptByteResult::unchanged;
  }
  default: {
    const std::array value{encoded};
    return insert_rename_prompt_text(session, value) ? RenamePromptByteResult::changed
                                                     : RenamePromptByteResult::unchanged;
  }
  }
}

void process_rename_prompt_input(SessionRecord& session, PaneRuntimeStore& runtimes,
                                 const std::span<const std::byte> input,
                                 const SessionNameConflict name_conflict,
                                 void* const name_conflict_context) noexcept {
  bool changed = false;
  for (const auto encoded : input) {
    const auto result =
        apply_rename_prompt_byte(session, runtimes, encoded, name_conflict, name_conflict_context);
    if (result == RenamePromptByteResult::finished) {
      return;
    }
    changed = result == RenamePromptByteResult::changed ? true : changed;
  }
  if (changed) {
    invalidate_rename_prompt(session);
  }
}

// Structured prompt editing remains Attachment-owned and never reaches the pane PTY.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void process_typed_rename_prompt_input(SessionRecord& session, PaneRuntimeStore& runtimes,
                                       const protocol::KeyInput& key,
                                       const std::span<const std::byte> text,
                                       const SessionNameConflict name_conflict,
                                       void* const name_conflict_context) noexcept {
  if (key.action == protocol::KeyInputAction::release ||
      !session.attachment.rename_prompt.active()) {
    return;
  }
  auto& prompt = session.attachment.rename_prompt;
  const bool control = (key.modifiers & protocol::key_input_modifier_control) != 0;
  bool changed = false;
  switch (key.key) {
  case protocol::KeyInputKey::escape:
    reset_rename_prompt(session);
    return;
  case protocol::KeyInputKey::enter:
    complete_rename_prompt(session, runtimes, name_conflict, name_conflict_context);
    return;
  case protocol::KeyInputKey::backspace:
    changed = erase_rename_prompt_before_cursor(prompt);
    break;
  case protocol::KeyInputKey::delete_key:
    changed = erase_rename_prompt_at_cursor(prompt);
    break;
  case protocol::KeyInputKey::arrow_left:
    changed = prompt.cursor > 0;
    prompt.cursor -= changed ? 1U : 0U;
    break;
  case protocol::KeyInputKey::arrow_right:
    changed = prompt.cursor < prompt.size;
    prompt.cursor += changed ? 1U : 0U;
    break;
  case protocol::KeyInputKey::home:
    changed = prompt.cursor != 0;
    prompt.cursor = 0;
    break;
  case protocol::KeyInputKey::end:
    changed = prompt.cursor != prompt.size;
    prompt.cursor = prompt.size;
    break;
  case protocol::KeyInputKey::a:
    if (control) {
      changed = prompt.cursor != 0;
      prompt.cursor = 0;
    }
    break;
  case protocol::KeyInputKey::e:
    if (control) {
      changed = prompt.cursor != prompt.size;
      prompt.cursor = prompt.size;
    }
    break;
  case protocol::KeyInputKey::u:
    if (control) {
      changed = prompt.size != 0;
      clear_rename_prompt(prompt);
    }
    break;
  case protocol::KeyInputKey::w:
    if (control) {
      const auto before = prompt.size;
      erase_rename_prompt_word(prompt);
      changed = prompt.size != before;
    }
    break;
  case protocol::KeyInputKey::c:
  case protocol::KeyInputKey::g:
    if (control) {
      reset_rename_prompt(session);
      return;
    }
    break;
  case protocol::KeyInputKey::unidentified:
  case protocol::KeyInputKey::b:
  case protocol::KeyInputKey::d:
  case protocol::KeyInputKey::f:
  case protocol::KeyInputKey::h:
  case protocol::KeyInputKey::i:
  case protocol::KeyInputKey::j:
  case protocol::KeyInputKey::k:
  case protocol::KeyInputKey::l:
  case protocol::KeyInputKey::m:
  case protocol::KeyInputKey::n:
  case protocol::KeyInputKey::o:
  case protocol::KeyInputKey::p:
  case protocol::KeyInputKey::q:
  case protocol::KeyInputKey::r:
  case protocol::KeyInputKey::s:
  case protocol::KeyInputKey::t:
  case protocol::KeyInputKey::v:
  case protocol::KeyInputKey::x:
  case protocol::KeyInputKey::y:
  case protocol::KeyInputKey::z:
  case protocol::KeyInputKey::tab:
  case protocol::KeyInputKey::space:
  case protocol::KeyInputKey::arrow_up:
  case protocol::KeyInputKey::arrow_down:
  case protocol::KeyInputKey::insert:
  case protocol::KeyInputKey::page_up:
  case protocol::KeyInputKey::page_down:
  case protocol::KeyInputKey::f1:
  case protocol::KeyInputKey::f2:
  case protocol::KeyInputKey::f3:
  case protocol::KeyInputKey::f4:
  case protocol::KeyInputKey::f5:
  case protocol::KeyInputKey::f6:
  case protocol::KeyInputKey::f7:
  case protocol::KeyInputKey::f8:
  case protocol::KeyInputKey::f9:
  case protocol::KeyInputKey::f10:
  case protocol::KeyInputKey::f11:
  case protocol::KeyInputKey::f12:
    break;
  }
  if (!changed && !text.empty() && !control) {
    changed = insert_rename_prompt_text(session, text);
  }
  if (changed) {
    invalidate_rename_prompt(session);
  }
}

struct CopyOverlayStorage final {
  std::array<char, limits::search_query_bytes_max + 16U> text{};
  std::size_t size{0};

  [[nodiscard]] auto view() const noexcept -> std::string_view { return {text.data(), size}; }
};

[[nodiscard]] auto copy_feedback_text(const CopyModeFeedback feedback) noexcept
    -> std::string_view {
  switch (feedback) {
  case CopyModeFeedback::no_match:
    return " no match ";
  case CopyModeFeedback::empty_selection:
    return " empty ";
  case CopyModeFeedback::clipboard_busy:
    return " clipboard busy ";
  case CopyModeFeedback::too_large:
    return " selection too large ";
  case CopyModeFeedback::failed:
    return " copy failed ";
  case CopyModeFeedback::none:
    return {};
  }
  return {};
}

void assign_copy_overlay(const std::string_view text, const std::size_t limit,
                         CopyOverlayStorage& output) noexcept {
  output.size = std::min(limit, text.size());
  std::ranges::copy(std::span(text).first(output.size), output.text.begin());
}

void build_copy_query_overlay(const CopyModeState& state, const std::size_t limit,
                              CopyOverlayStorage& output) noexcept {
  output.text.front() = state.prompt_search_direction == CopySearchDirection::forward ? '/' : '?';
  output.size = 1;
  if (limit == 1) {
    return;
  }
  const auto query = state.draft_query_view();
  const auto count = std::min(query.size(), limit - 1U);
  const auto begin = query.size() - count;
  for (const char character : std::span(query).subspan(begin, count)) {
    const auto value = static_cast<unsigned char>(character);
    const auto sanitized = value >= 0x20U && value < 0x7FU ? character : '?';
    std::span(output.text).subspan(output.size, 1).front() = sanitized;
    ++output.size;
  }
}

void build_copy_position_overlay(PaneRuntime& runtime, const std::size_t limit,
                                 CopyOverlayStorage& output) noexcept {
  const auto viewport = runtime.terminal.viewport_state();
  if (!viewport.has_value()) {
    return;
  }
  const auto covered = viewport->offset + viewport->visible_rows;
  const auto below = viewport->total_rows > covered ? viewport->total_rows - covered : 0U;
  const auto history = viewport->total_rows > viewport->visible_rows
                           ? viewport->total_rows - viewport->visible_rows
                           : 0U;
  std::array<char, 64> encoded{};
  encoded.front() = '[';
  auto position = std::to_chars(std::next(encoded.begin()), encoded.end(), below);
  if (position.ec != std::errc{} || position.ptr == encoded.end()) {
    return;
  }
  *position.ptr = '/';
  const auto total = std::to_chars(std::next(position.ptr), encoded.end(), history);
  if (total.ec != std::errc{} || total.ptr == encoded.end()) {
    return;
  }
  *total.ptr = ']';
  const auto size = static_cast<std::size_t>(std::distance(encoded.begin(), std::next(total.ptr)));
  if (size <= limit) {
    assign_copy_overlay(std::string_view(encoded.data(), size), limit, output);
  }
}

void build_copy_overlay(const SessionRecord& session, PaneRuntime& runtime,
                        const std::uint16_t columns, CopyOverlayStorage& output) noexcept {
  output.size = 0;
  if (columns == 0) {
    return;
  }
  const auto limit = std::min<std::size_t>(columns, output.text.size());
  const auto& state = session.attachment.copy_mode;
  // An editable prompt remains visible for its complete lifetime. Incremental no-match feedback is
  // provisional and must not replace the query between keystrokes; Enter exposes the committed
  // result after leaving the prompt phase.
  if (state.phase == CopyModePhase::search_prompt) {
    build_copy_query_overlay(state, limit, output);
    return;
  }
  const auto feedback = copy_feedback_text(state.feedback);
  if (!feedback.empty()) {
    assign_copy_overlay(feedback, limit, output);
  } else if (state.phase == CopyModePhase::searching) {
    assign_copy_overlay(" searching ", limit, output);
  } else {
    build_copy_position_overlay(runtime, limit, output);
  }
}

// Surface projection combines bounded semantic and runtime state without retaining either.
[[nodiscard]] auto
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
collect_surfaces(SessionRecord& session, PaneRuntimeStore& runtimes,
                 std::array<render::PaneSurface, panes_per_tab_max>& storage,
                 CopyOverlayStorage& copy_overlay, render::PaneOverlay& overlay) noexcept
    -> std::span<const render::PaneSurface> {
  auto* const tab = active_tab(session);
  if (tab == nullptr || tab->layout_suspended) {
    return std::span<const render::PaneSurface>{};
  }
  std::size_t count = 0;
  for (auto& pane_slot : session.panes) {
    auto& pane = pane_slot.pane;
    if (pane == nullptr || pane->tab != tab->id || (tab->zoomed && pane->id != tab->focused_pane)) {
      continue;
    }
    auto* const runtime = find_pane_runtime(runtimes, session, *tab, *pane);
    if (runtime == nullptr || !runtime->live()) {
      continue;
    }
    const bool copy_pane =
        session.attachment.copy_mode.active() &&
        session.attachment.selection_target ==
            std::optional{AttachmentPaneTarget{.tab = tab->id, .pane = pane->id}};
    const auto copy_cursor = copy_pane
                                 ? runtime->terminal.selection_endpoint(vt::PointSpace::viewport)
                                 : std::expected<std::optional<vt::TerminalPoint>, vt::Error>{
                                       std::optional<vt::TerminalPoint>{}};
    const auto cursor = copy_cursor.value_or(std::optional<vt::TerminalPoint>{});
    const auto cursor_point = cursor.value_or(vt::TerminalPoint{});
    const bool cursor_override = cursor.has_value() && cursor_point.row < pane->rectangle.rows &&
                                 cursor_point.column < pane->rectangle.columns;
    if (copy_pane && cursor_override) {
      build_copy_overlay(session, *runtime, pane->rectangle.columns, copy_overlay);
      overlay = {.terminal = &runtime->terminal, .top_right = copy_overlay.view()};
    }
    std::span(storage).subspan(count, 1).front() = {
        .terminal = &runtime->terminal,
        .rectangle = pane->rectangle,
        .cursor_override_column = cursor_override ? cursor_point.column : std::uint16_t{0},
        .cursor_override_row =
            cursor_override ? static_cast<std::uint16_t>(cursor_point.row) : std::uint16_t{0},
        .focused = pane->id == tab->focused_pane,
        .cursor_override = cursor_override,
        .presentation_suppressed = runtime->presentation_gate.presentation_suppressed(),
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

[[nodiscard]] auto resize_session(SessionRecord& session, PaneRuntimeStore& runtimes,
                                  const protocol::Dimensions dimensions) noexcept -> bool {
  finish_live_divider_resize(session, true);
  const auto columns = std::clamp(dimensions.columns, std::uint16_t{1}, protocol::columns_max);
  const auto rows = std::clamp(dimensions.rows, std::uint16_t{1}, protocol::rows_max);
  const auto previous_columns = session.attachment.columns;
  const auto previous_rows = session.attachment.rows;
  // Frame capacity changes only at this lifecycle boundary. Allocation failure preserves the old
  // storage and all terminal geometry, so the caller can reject the resize without partial state.
  const auto retained_frame_bytes = session.attachment_runtime.output.busy()
                                        ? session.attachment_runtime.output.frame_bytes()
                                        : 0;
  if (!session.attachment_runtime.frame.prepare({.columns = columns, .rows = rows},
                                                retained_frame_bytes)) {
    return false;
  }
  // Record every physical resize and discard any unsent frame composed for the previous viewport.
  // A transiently tiny outer terminal is valid, but pane geometry cannot represent the split tree
  // until it fits again. Preserve that geometry and send a surface-free clear frame constrained to
  // the physical viewport instead of rendering stale rectangles outside it. Checking the unzoomed
  // tree also prevents an undersized viewport from becoming latent while zoomed.
  session.attachment.columns = columns;
  session.attachment.rows = rows;
  auto* const tab = active_tab(session);
  if (tab == nullptr || !fit_tab_to_viewport(session, *tab, runtimes)) {
    if (session.active) {
      session.attachment.columns = previous_columns;
      session.attachment.rows = previous_rows;
    }
    return false;
  }
  schedule_frame(session, FrameUrgency::state_change, true);
  return true;
}

[[nodiscard]] constexpr auto
selection_gesture_phase(const protocol::MouseInputAction action) noexcept
    -> vt::SelectionGesturePhase {
  switch (action) {
  case protocol::MouseInputAction::press:
    return vt::SelectionGesturePhase::press;
  case protocol::MouseInputAction::release:
    return vt::SelectionGesturePhase::release;
  case protocol::MouseInputAction::motion:
    return vt::SelectionGesturePhase::drag;
  }
  return vt::SelectionGesturePhase::drag;
}

[[nodiscard]] auto process_mouse_selection(SessionRecord& session, PaneRuntimeStore& runtimes,
                                           const Tab& tab, const Pane& pane, PaneRuntime& runtime,
                                           const protocol::MouseInput& mouse,
                                           const std::uint16_t content_row) noexcept -> bool {
  const AttachmentPaneTarget target{.tab = tab.id, .pane = pane.id};
  if (session.attachment.selection_target != std::optional{target}) {
    if (session.attachment.copy_mode.active()) {
      leave_copy_mode(session, runtimes);
    } else {
      clear_mouse_selection(session, runtimes);
    }
    session.attachment.selection_target = target;
  }

  const auto& rectangle = pane.rectangle;
  const auto local_column = static_cast<std::uint16_t>(
      std::clamp(mouse.column, rectangle.column,
                 static_cast<std::uint16_t>(rectangle.column + rectangle.columns - 1U)) -
      rectangle.column);
  const auto local_row = static_cast<std::uint16_t>(
      std::clamp(content_row, rectangle.row,
                 static_cast<std::uint16_t>(rectangle.row + rectangle.rows - 1U)) -
      rectangle.row);
  bool presentation_changed = false;
  if (mouse.action == protocol::MouseInputAction::press) {
    const auto active = runtime.terminal.selection_active();
    if (!active.has_value()) {
      return false;
    }
    presentation_changed = *active;
    runtime.terminal.clear_selection();
  }
  const auto now = std::chrono::steady_clock::now().time_since_epoch();
  const auto time_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(now).count();
  const vt::SelectionGestureEvent event{
      .phase = selection_gesture_phase(mouse.action),
      .point = {.space = vt::PointSpace::viewport, .column = local_column, .row = local_row},
      .pointer_x = static_cast<double>(mouse.column) - static_cast<double>(rectangle.column) + 0.5,
      .pointer_y = static_cast<double>(content_row) - static_cast<double>(rectangle.row) + 0.5,
      .cell_width = 1,
      .screen_height = rectangle.rows,
      .time_ns = mouse.action == protocol::MouseInputAction::press
                     ? static_cast<std::uint64_t>(time_ns)
                     : std::uint64_t{0},
      .repeat_interval_ns = static_cast<std::uint64_t>(
          std::chrono::duration_cast<std::chrono::nanoseconds>(mouse_repeat_click_interval)
              .count()),
      .repeat_distance = mouse_repeat_click_distance,
      .has_pointer_position = true,
  };
  const auto result = runtime.terminal.selection_gesture(event);
  if (!result.has_value()) {
    return false;
  }
  presentation_changed = presentation_changed || result->selection_changed;
  if (session.attachment.copy_mode.active() && result->selection_changed &&
      !update_copy_viewport_offset(session, runtime)) {
    leave_copy_mode(session, runtimes);
    return false;
  }
  if (presentation_changed) {
    schedule_frame(session, FrameUrgency::interactive, false);
  }
  return true;
}

enum class ParseResult : std::uint8_t {
  keep,
  backpressure,
  yield,
  detach,
  peer_closed,
  error,
};

[[nodiscard]] constexpr auto physical_key(const protocol::KeyInputKey key) noexcept
    -> input::PhysicalKey {
  constexpr std::array mapping{
      input::PhysicalKey::unidentified,
      input::PhysicalKey::a,
      input::PhysicalKey::b,
      input::PhysicalKey::c,
      input::PhysicalKey::d,
      input::PhysicalKey::e,
      input::PhysicalKey::f,
      input::PhysicalKey::g,
      input::PhysicalKey::h,
      input::PhysicalKey::i,
      input::PhysicalKey::j,
      input::PhysicalKey::k,
      input::PhysicalKey::l,
      input::PhysicalKey::m,
      input::PhysicalKey::n,
      input::PhysicalKey::o,
      input::PhysicalKey::p,
      input::PhysicalKey::q,
      input::PhysicalKey::r,
      input::PhysicalKey::s,
      input::PhysicalKey::t,
      input::PhysicalKey::u,
      input::PhysicalKey::v,
      input::PhysicalKey::w,
      input::PhysicalKey::x,
      input::PhysicalKey::y,
      input::PhysicalKey::z,
      input::PhysicalKey::enter,
      input::PhysicalKey::tab,
      input::PhysicalKey::backspace,
      input::PhysicalKey::escape,
      input::PhysicalKey::space,
      input::PhysicalKey::arrow_up,
      input::PhysicalKey::arrow_down,
      input::PhysicalKey::arrow_left,
      input::PhysicalKey::arrow_right,
      input::PhysicalKey::home,
      input::PhysicalKey::end,
      input::PhysicalKey::insert,
      input::PhysicalKey::delete_key,
      input::PhysicalKey::page_up,
      input::PhysicalKey::page_down,
      input::PhysicalKey::f1,
      input::PhysicalKey::f2,
      input::PhysicalKey::f3,
      input::PhysicalKey::f4,
      input::PhysicalKey::f5,
      input::PhysicalKey::f6,
      input::PhysicalKey::f7,
      input::PhysicalKey::f8,
      input::PhysicalKey::f9,
      input::PhysicalKey::f10,
      input::PhysicalKey::f11,
      input::PhysicalKey::f12,
  };
  const auto index = static_cast<std::size_t>(key);
  return index < mapping.size() ? std::span(mapping).subspan(index, 1).front()
                                : input::PhysicalKey::unidentified;
}

[[nodiscard]] constexpr auto key_action(const protocol::KeyInputAction action) noexcept
    -> input::KeyAction {
  switch (action) {
  case protocol::KeyInputAction::release:
    return input::KeyAction::release;
  case protocol::KeyInputAction::press:
    return input::KeyAction::press;
  case protocol::KeyInputAction::repeat:
    return input::KeyAction::repeat;
  }
  return input::KeyAction::press;
}

[[nodiscard]] constexpr auto key_modifiers(const std::uint16_t modifiers) noexcept
    -> std::uint16_t {
  std::uint16_t result = 0;
  result |= (modifiers & protocol::key_input_modifier_shift) != 0 ? input::key_modifier_shift : 0U;
  result |=
      (modifiers & protocol::key_input_modifier_control) != 0 ? input::key_modifier_control : 0U;
  result |= (modifiers & protocol::key_input_modifier_alt) != 0 ? input::key_modifier_alt : 0U;
  result |= (modifiers & protocol::key_input_modifier_super) != 0 ? input::key_modifier_super : 0U;
  result |= (modifiers & protocol::key_input_modifier_caps_lock) != 0
                ? input::key_modifier_caps_lock
                : 0U;
  result |=
      (modifiers & protocol::key_input_modifier_num_lock) != 0 ? input::key_modifier_num_lock : 0U;
  return result;
}

[[nodiscard]] auto routed_key_event(const protocol::KeyInput& key,
                                    const std::span<const std::byte> text) noexcept
    -> input::KeyEvent {
  return {.action = key_action(key.action),
          .key = physical_key(key.key),
          .modifiers = key_modifiers(key.modifiers),
          .unshifted_codepoint = key.unshifted_codepoint,
          .text = text};
}

[[nodiscard]] auto focused_input_runtime(SessionRecord& session,
                                         PaneRuntimeStore& runtimes) noexcept -> PaneRuntime* {
  auto* const tab = active_tab(session);
  auto* const pane = tab == nullptr ? nullptr : find_pane(session, *tab, tab->focused_pane);
  return pane == nullptr ? nullptr : find_pane_runtime(runtimes, session, *tab, *pane);
}

[[nodiscard]] auto queue_application_bytes(SessionRecord& session, PaneRuntimeStore& runtimes,
                                           const std::span<const std::byte> bytes) noexcept
    -> InputQueueResult {
  auto* const runtime = focused_input_runtime(session, runtimes);
  if (runtime == nullptr) {
    return InputQueueResult::encoding_failed;
  }
  const auto queued_bytes_before = runtime->pending_writes.size();
  const auto queued = queue_normalized_input(runtime->pending_writes, runtime->terminal, bytes);
  if (queued != InputQueueResult::queued) {
    return queued;
  }
  clear_mouse_selection(session, runtimes);
  std::uint64_t trace_correlation = 0;
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  trace_correlation = session.attachment_runtime.decoded_input_trace_matcher.observe(bytes);
#endif
  diagnostic::record_latency_trace(diagnostic::LatencyTraceStage::daemon_input_message_received,
                                   static_cast<std::uint32_t>(runtime->pty), bytes.size(),
                                   trace_correlation);
  if (runtime->pending_writes.size() > queued_bytes_before &&
      !scroll_viewport_for_application_input(session, *runtime)) {
    return InputQueueResult::encoding_failed;
  }
  if (latency_sensitive_input(bytes.size())) {
    runtime->interactive_damage.await_write(queued_bytes_before, runtime->pending_writes.size());
  }
  return InputQueueResult::queued;
}

[[nodiscard]] auto queue_application_key(SessionRecord& session, PaneRuntimeStore& runtimes,
                                         const protocol::KeyInput& key,
                                         const std::span<const std::byte> text,
                                         const std::span<const std::byte> prefix = {}) noexcept
    -> InputQueueResult {
  auto* const runtime = focused_input_runtime(session, runtimes);
  if (runtime == nullptr) {
    return InputQueueResult::encoding_failed;
  }
  const auto queued_bytes_before = runtime->pending_writes.size();
  const auto queued =
      prefix.empty()
          ? queue_key_input(runtime->pending_writes, runtime->terminal, key, text)
          : queue_prefixed_key_input(runtime->pending_writes, runtime->terminal, prefix, key, text);
  if (queued != InputQueueResult::queued) {
    return queued;
  }
  clear_mouse_selection(session, runtimes);
  if (runtime->pending_writes.size() > queued_bytes_before) {
    if (!scroll_viewport_for_application_input(session, *runtime)) {
      return InputQueueResult::encoding_failed;
    }
    runtime->interactive_damage.await_write(queued_bytes_before, runtime->pending_writes.size());
  }
  return InputQueueResult::queued;
}

void accept_input_route(SessionRecord& session, PaneRuntimeStore& runtimes,
                        const bool presentation_changed,
                        const bool interaction_preemption_requested) noexcept {
  if (interaction_preemption_requested) {
    const Command cancel{
        .kind = CommandKind::cancel_attachment_interaction,
        .origin = CommandOrigin::keymap,
        .target = {.session = session.id,
                   .tab = {},
                   .pane = {},
                   .peer_pane = {},
                   .attachment = session.attachment.id},
    };
    const auto result = dispatch_session_command(session, runtimes, cancel);
    LEMMA_ASSERT(result.succeeded());
  }
  if (presentation_changed) {
    schedule_frame(session, FrameUrgency::state_change, false);
  }
}

[[nodiscard]] auto dispatch_input_command(SessionRecord& session, PaneRuntimeStore& runtimes,
                                          const input::InputCommand input_command,
                                          const SessionNameConflict name_conflict,
                                          void* const name_conflict_context) noexcept
    -> ParseResult {
  finish_live_divider_resize(session, true);
  const bool begins_rename = input_command == input::InputCommand::begin_rename_session ||
                             input_command == input::InputCommand::begin_rename_tab;
  if (session.attachment.rename_prompt.active() && !begins_rename) {
    reset_rename_prompt(session);
  }
  const auto command = command_from_input(session, input_command, CommandOrigin::keymap);
  if (!command.has_value()) {
    return ParseResult::keep;
  }
  const auto result =
      dispatch_session_command(session, runtimes, *command, name_conflict, name_conflict_context);
  return result.status == CommandStatus::detach_requested || !session.active ? ParseResult::detach
                                                                             : ParseResult::keep;
}

[[nodiscard]] auto materialize_legacy_input(
    const input::ForwardLegacyInput& forwarded,
    std::array<std::byte, input::deferred_input_bytes_max + 1U>& storage) noexcept
    -> std::span<const std::byte> {
  if (forwarded.prefix_size == 0U) {
    return forwarded.current;
  }
  LEMMA_ASSERT(forwarded.prefix_size <= forwarded.prefix.size());
  LEMMA_ASSERT(forwarded.current.size() <= storage.size() - forwarded.prefix_size);
  std::ranges::copy(std::span(forwarded.prefix).first(forwarded.prefix_size), storage.begin());
  std::ranges::copy(
      forwarded.current,
      std::span(storage).subspan(forwarded.prefix_size, forwarded.current.size()).begin());
  return std::span(storage).first(forwarded.prefix_size + forwarded.current.size());
}

// One decoder-held input message is advanced monotonically. Context transitions and commands are
// never replayed when the pane PTY queue applies backpressure.
// NOLINTNEXTLINE(bugprone-exception-escape,readability-function-cognitive-complexity)
[[nodiscard]] auto process_routed_legacy_input(SessionRecord& session, PaneRuntimeStore& runtimes,
                                               const std::span<const std::byte> message,
                                               std::size_t& input_budget,
                                               const SessionNameConflict name_conflict,
                                               void* const name_conflict_context) noexcept
    -> ParseResult {
  auto offset = session.attachment_runtime.retained_input_offset.value_or(0);
  if (offset > message.size()) {
    return ParseResult::error;
  }
  if (session.attachment_runtime.pending_routed_input_size > 0U) {
    const auto pending = std::span(session.attachment_runtime.pending_routed_input)
                             .first(session.attachment_runtime.pending_routed_input_size);
    const auto queued = queue_application_bytes(session, runtimes, pending);
    if (queued == InputQueueResult::full) {
      return ParseResult::backpressure;
    }
    if (queued != InputQueueResult::queued) {
      return ParseResult::error;
    }
    session.attachment_runtime.pending_routed_input_size = 0;
  }

  while (offset < message.size()) {
    if (input_budget == 0U) {
      session.attachment_runtime.retained_input_offset = offset;
      return ParseResult::yield;
    }
    --input_budget;
    std::optional<input::InputRouter> router_before;
    if (session.input_router.legacy_route_requires_checkpoint()) {
      router_before.emplace(session.input_router);
    }
    const auto forward_limit =
        session.attachment.copy_mode.active() ? std::size_t{1} : message.size() - offset;
    const auto routed = session.input_router.route_legacy(message.subspan(offset), forward_limit);
    if (routed.consumed == 0U || routed.consumed > message.size() - offset) {
      return ParseResult::error;
    }
    if (const auto* const command = std::get_if<input::RoutedCommand>(&routed.effect);
        command != nullptr) {
      accept_input_route(session, runtimes, routed.presentation_changed,
                         routed.interaction_preemption_requested);
      offset += routed.consumed;
      const auto dispatched = dispatch_input_command(session, runtimes, command->command,
                                                     name_conflict, name_conflict_context);
      if (dispatched == ParseResult::detach) {
        return dispatched;
      }
      continue;
    }
    if (std::holds_alternative<input::ConsumedInput>(routed.effect)) {
      accept_input_route(session, runtimes, routed.presentation_changed,
                         routed.interaction_preemption_requested);
      offset += routed.consumed;
      continue;
    }

    const auto& forwarded = std::get<input::ForwardLegacyInput>(routed.effect);
    std::array<std::byte, input::deferred_input_bytes_max + 1U> storage{};
    const auto application_input = materialize_legacy_input(forwarded, storage);
    if (application_input.empty()) {
      return ParseResult::error;
    }
    if (session.attachment.rename_prompt.active()) {
      process_rename_prompt_input(session, runtimes, application_input, name_conflict,
                                  name_conflict_context);
    } else if (session.attachment.copy_mode.active()) {
      const auto consumed = process_copy_mode_input(session, runtimes, application_input);
      if (consumed > application_input.size()) {
        return ParseResult::error;
      }
      const auto remaining = application_input.subspan(consumed);
      if (!remaining.empty()) {
        const auto queued = queue_application_bytes(session, runtimes, remaining);
        if (queued == InputQueueResult::full) {
          LEMMA_ASSERT(remaining.size() <= session.attachment_runtime.pending_routed_input.size());
          std::ranges::copy(remaining, session.attachment_runtime.pending_routed_input.begin());
          session.attachment_runtime.pending_routed_input_size =
              static_cast<std::uint8_t>(remaining.size());
          offset += routed.consumed;
          session.attachment_runtime.retained_input_offset = offset;
          accept_input_route(session, runtimes, routed.presentation_changed,
                             routed.interaction_preemption_requested);
          return ParseResult::backpressure;
        }
        if (queued != InputQueueResult::queued) {
          return ParseResult::error;
        }
      }
    } else {
      const auto queued = queue_application_bytes(session, runtimes, application_input);
      if (queued == InputQueueResult::full) {
        if (router_before.has_value()) {
          session.input_router = *router_before;
        }
        session.attachment_runtime.retained_input_offset = offset;
        return ParseResult::backpressure;
      }
      if (queued != InputQueueResult::queued) {
        return ParseResult::error;
      }
    }
    accept_input_route(session, runtimes, routed.presentation_changed,
                       routed.interaction_preemption_requested);
    offset += routed.consumed;
  }
  session.attachment_runtime.retained_input_offset.reset();
  return ParseResult::keep;
}

// NOLINTBEGIN(readability-function-cognitive-complexity)
[[nodiscard]] auto
process_routed_key_input(SessionRecord& session, PaneRuntimeStore& runtimes,
                         const protocol::KeyInput& key, const std::span<const std::byte> text,
                         std::size_t& input_budget, const SessionNameConflict name_conflict,
                         void* const name_conflict_context) noexcept -> ParseResult {
  if (input_budget == 0U) {
    return ParseResult::yield;
  }
  --input_budget;
  auto router_before = session.input_router;
  const auto routed = session.input_router.route_key(routed_key_event(key, text));
  if (const auto* const command = std::get_if<input::RoutedCommand>(&routed.effect);
      command != nullptr) {
    accept_input_route(session, runtimes, routed.presentation_changed,
                       routed.interaction_preemption_requested);
    return dispatch_input_command(session, runtimes, command->command, name_conflict,
                                  name_conflict_context);
  }
  if (std::holds_alternative<input::ConsumedInput>(routed.effect)) {
    accept_input_route(session, runtimes, routed.presentation_changed,
                       routed.interaction_preemption_requested);
    return ParseResult::keep;
  }

  if (std::holds_alternative<input::ForwardCurrentKey>(routed.effect)) {
    if (session.attachment.rename_prompt.active()) {
      process_typed_rename_prompt_input(session, runtimes, key, text, name_conflict,
                                        name_conflict_context);
    } else if (session.attachment.copy_mode.active()) {
      process_typed_copy_mode_input(session, runtimes, key, text);
    } else {
      const auto queued = queue_application_key(session, runtimes, key, text);
      if (queued == InputQueueResult::full) {
        session.input_router = router_before;
        return ParseResult::backpressure;
      }
      if (queued != InputQueueResult::queued) {
        return ParseResult::error;
      }
    }
  } else {
    std::array<std::byte, input::deferred_input_bytes_max> prefix_storage{};
    std::span<const std::byte> prefix;
    bool forward_current = false;
    if (const auto* const bytes = std::get_if<input::ForwardBytes>(&routed.effect);
        bytes != nullptr) {
      prefix_storage = bytes->bytes;
      prefix = std::span(prefix_storage).first(bytes->size);
    } else if (const auto* const following =
                   std::get_if<input::ForwardBytesThenCurrentKey>(&routed.effect);
               following != nullptr) {
      prefix_storage = following->bytes;
      prefix = std::span(prefix_storage).first(following->size);
      forward_current = true;
    } else {
      return ParseResult::error;
    }
    if (prefix.empty()) {
      return ParseResult::error;
    }
    if (session.attachment.rename_prompt.active()) {
      process_rename_prompt_input(session, runtimes, prefix, name_conflict, name_conflict_context);
      if (forward_current && session.attachment.rename_prompt.active()) {
        process_typed_rename_prompt_input(session, runtimes, key, text, name_conflict,
                                          name_conflict_context);
      }
    } else if (session.attachment.copy_mode.active()) {
      static_cast<void>(process_copy_mode_input(session, runtimes, prefix));
      if (forward_current) {
        if (!session.attachment.copy_mode.active()) {
          return ParseResult::error;
        }
        process_typed_copy_mode_input(session, runtimes, key, text);
      }
    } else {
      const auto queued = forward_current
                              ? queue_application_key(session, runtimes, key, text, prefix)
                              : queue_application_bytes(session, runtimes, prefix);
      if (queued == InputQueueResult::full) {
        session.input_router = router_before;
        return ParseResult::backpressure;
      }
      if (queued != InputQueueResult::queued) {
        return ParseResult::error;
      }
    }
  }
  accept_input_route(session, runtimes, routed.presentation_changed,
                     routed.interaction_preemption_requested);
  return ParseResult::keep;
}
// NOLINTEND(readability-function-cognitive-complexity)

[[nodiscard]] auto expensive_client_message(const SessionRecord& session,
                                            const protocol::ClientMessage& message) noexcept
    -> bool {
  if (message.kind == protocol::ClientMessageKind::resize ||
      message.kind == protocol::ClientMessageKind::pane_command) {
    return true;
  }
  return message.kind == protocol::ClientMessageKind::mouse &&
         message.mouse.action != protocol::MouseInputAction::press &&
         session.attachment.mouse_capture.has_value() &&
         (session.attachment.mouse_capture->owner == MouseCaptureOwner::divider ||
          session.attachment.mouse_capture->owner == MouseCaptureOwner::status_tab);
}

// Packet dispatch exhaustively maps validated protocol messages to session transitions.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto parse_client_packets(SessionRecord& session, PaneRuntimeStore& runtimes,
                                        std::size_t& message_budget, std::size_t& geometry_budget,
                                        std::size_t& input_budget,
                                        const SessionNameConflict name_conflict,
                                        void* const name_conflict_context) noexcept -> ParseResult {
  while (true) {
    const auto decoded = session.attachment_runtime.decoder.next();
    if (!decoded.has_value()) {
      return ParseResult::error;
    }
    if (!decoded->has_value()) {
      return ParseResult::keep;
    }
    const auto& message = **decoded;
    const bool expensive = expensive_client_message(session, message);
    if (message_budget == 0 || (expensive && geometry_budget == 0)) {
      return ParseResult::yield;
    }
    --message_budget;
    if (expensive) {
      --geometry_budget;
    }
    switch (message.kind) {
    case protocol::ClientMessageKind::hello:
      return ParseResult::error;
    case protocol::ClientMessageKind::detach: {
      const Command command{.kind = CommandKind::detach_client, .origin = CommandOrigin::client};
      const auto result = dispatch_session_command(session, runtimes, command);
      session.attachment_runtime.decoder.consume();
      return result.status == CommandStatus::detach_requested ? ParseResult::detach
                                                              : ParseResult::error;
    }
    case protocol::ClientMessageKind::resize:
      if (!resize_session(session, runtimes, message.dimensions)) {
        return ParseResult::error;
      }
      break;
    case protocol::ClientMessageKind::input: {
      const auto result = process_routed_legacy_input(
          session, runtimes, message.input, input_budget, name_conflict, name_conflict_context);
      if (result != ParseResult::keep) {
        return result;
      }
      break;
    }
    case protocol::ClientMessageKind::key: {
      const auto result =
          process_routed_key_input(session, runtimes, message.key, message.input, input_budget,
                                   name_conflict, name_conflict_context);
      if (result != ParseResult::keep) {
        return result;
      }
      break;
    }
    case protocol::ClientMessageKind::paste: {
      if (session.attachment.rename_prompt.active()) {
        if (insert_rename_prompt_text(session, message.input)) {
          invalidate_rename_prompt(session);
        }
        break;
      }
      if (session.attachment.copy_mode.active()) {
        break;
      }
      auto* const tab = active_tab(session);
      auto* const pane = tab == nullptr ? nullptr : find_pane(session, *tab, tab->focused_pane);
      if (pane == nullptr) {
        return ParseResult::error;
      }
      auto* const runtime = find_pane_runtime(runtimes, session, *tab, *pane);
      if (runtime == nullptr) {
        return ParseResult::error;
      }
      const auto queued_bytes_before = runtime->pending_writes.size();
      const auto queued =
          queue_paste_input(runtime->pending_writes, runtime->terminal, message.input);
      if (queued == InputQueueResult::full) {
        return ParseResult::backpressure;
      }
      if (queued == InputQueueResult::encoding_failed) {
        return ParseResult::error;
      }
      clear_mouse_selection(session, runtimes);
      if (runtime->pending_writes.size() > queued_bytes_before) {
        if (!scroll_viewport_for_application_input(session, *runtime)) {
          return ParseResult::error;
        }
        runtime->interactive_damage.await_write(queued_bytes_before,
                                                runtime->pending_writes.size());
      }
      break;
    }
    case protocol::ClientMessageKind::focus: {
      auto* const tab = active_tab(session);
      auto* const pane = tab == nullptr ? nullptr : find_pane(session, *tab, tab->focused_pane);
      if (pane == nullptr) {
        return ParseResult::error;
      }
      auto* const runtime = find_pane_runtime(runtimes, session, *tab, *pane);
      if (runtime == nullptr) {
        return ParseResult::error;
      }
      const auto queued_bytes_before = runtime->pending_writes.size();
      const auto queued =
          queue_focus_input(runtime->pending_writes, runtime->terminal,
                            message.focus == protocol::FocusInput::gained ? vt::FocusEvent::gained
                                                                          : vt::FocusEvent::lost);
      if (queued == InputQueueResult::full) {
        return ParseResult::backpressure;
      }
      if (queued == InputQueueResult::encoding_failed) {
        return ParseResult::error;
      }
      if (runtime->pending_writes.size() > queued_bytes_before) {
        runtime->interactive_damage.await_write(queued_bytes_before,
                                                runtime->pending_writes.size());
      }
      break;
    }
    case protocol::ClientMessageKind::mouse: {
      if (message.mouse.geometry.columns != session.attachment.columns ||
          message.mouse.geometry.rows != session.attachment.rows) {
        return ParseResult::error;
      }
      if (session.attachment.rename_prompt.active()) {
        break;
      }
      auto* const tab = active_tab(session);
      if (tab == nullptr) {
        return ParseResult::error;
      }
      const auto status_rows = session.attachment.rows >= 2 ? std::uint16_t{1} : std::uint16_t{0};
      if (message.mouse.action == protocol::MouseInputAction::press &&
          session.attachment.mouse_capture.has_value()) {
        if (session.attachment.mouse_capture->owner == MouseCaptureOwner::divider) {
          // A fresh press supersedes the completed divider gesture.
          finish_live_divider_resize(session);
        } else if (session.attachment.mouse_capture->owner == MouseCaptureOwner::status_tab) {
          session.attachment.mouse_capture.reset();
          schedule_frame(session, FrameUrgency::state_change, false);
        }
      }
      const bool captured_continuation = session.attachment.mouse_capture.has_value() &&
                                         message.mouse.action != protocol::MouseInputAction::press;
      if (message.mouse.row < status_rows && !captured_continuation) {
        if (message.mouse.action != protocol::MouseInputAction::press ||
            message.mouse.button != protocol::MouseInputButton::left) {
          break;
        }
        const auto target = status_target_at_column(session, runtimes, message.mouse.column);
        session.attachment.mouse_capture = MouseCapture{
            .target = {.tab = tab->id, .pane = tab->focused_pane},
            .peer_pane = {},
            .status_tab_before = {},
            .owner = MouseCaptureOwner::discard_until_release,
            .divider_axis = SplitAxis::left_right,
        };
        if (!target.has_value()) {
          break;
        }
        if (target->kind == StatusHitKind::create_tab) {
          const Command create{
              .kind = CommandKind::create_tab,
              .origin = CommandOrigin::client,
              .target = {.session = session.id,
                         .tab = {},
                         .pane = {},
                         .peer_pane = {},
                         .attachment = session.attachment.id},
          };
          const auto created = dispatch_session_command(session, runtimes, create);
          if (created.status == CommandStatus::failed) {
            return ParseResult::error;
          }
          break;
        }
        session.attachment.mouse_capture = MouseCapture{
            .target = {.tab = target->tab, .pane = {}},
            .peer_pane = {},
            .status_tab_before = target->next,
            .owner = MouseCaptureOwner::status_tab,
            .divider_axis = SplitAxis::left_right,
        };
        const Command select{
            .kind = CommandKind::select_tab,
            .origin = CommandOrigin::client,
            .target = {.session = session.id,
                       .tab = target->tab,
                       .pane = {},
                       .peer_pane = {},
                       .attachment = session.attachment.id},
            .payload = CommandCoordinate{.value = target->position},
        };
        if (!dispatch_session_command(session, runtimes, select).succeeded()) {
          session.attachment.mouse_capture.reset();
          return ParseResult::error;
        }
        break;
      }
      const auto content_row = message.mouse.row < status_rows
                                   ? std::uint16_t{0}
                                   : static_cast<std::uint16_t>(message.mouse.row - status_rows);
      if (captured_continuation &&
          session.attachment.mouse_capture->owner == MouseCaptureOwner::status_tab) {
        if (message.mouse.action == protocol::MouseInputAction::motion) {
          const auto target = status_target_at_column(session, runtimes, message.mouse.column);
          if (target.has_value()) {
            auto before = session.attachment.mouse_capture->status_tab_before;
            if (target->kind == StatusHitKind::create_tab) {
              before = {};
            } else if (target->tab != session.attachment.mouse_capture->target.tab) {
              before = target->position < target->moving_position ? target->tab : target->next;
            }
            if (before != session.attachment.mouse_capture->status_tab_before) {
              session.attachment.mouse_capture->status_tab_before = before;
              schedule_frame(session, FrameUrgency::state_change, false);
            }
          }
        } else if (message.mouse.action == protocol::MouseInputAction::release) {
          const auto capture = *session.attachment.mouse_capture;
          session.attachment.mouse_capture.reset();
          schedule_frame(session, FrameUrgency::state_change, false);
          const Command place{
              .kind = CommandKind::place_tab,
              .origin = CommandOrigin::client,
              .target = {.session = session.id,
                         .tab = capture.target.tab,
                         .pane = {},
                         .peer_pane = {},
                         .attachment = session.attachment.id},
              .payload = TabPlacementCommand{.before = capture.status_tab_before},
          };
          const auto placed = dispatch_session_command(session, runtimes, place);
          if (placed.status == CommandStatus::failed) {
            return ParseResult::error;
          }
        }
        break;
      }
      if (tab->layout_suspended) {
        if (session.attachment.mouse_capture.has_value() &&
            session.attachment.mouse_capture->owner == MouseCaptureOwner::divider) {
          session.active = false;
          return ParseResult::error;
        }
        if (message.mouse.action == protocol::MouseInputAction::release) {
          session.attachment.mouse_capture.reset();
        }
        break;
      }
      const render::PaneRectangle viewport{
          .columns = tab->layout_columns,
          .rows = tab->layout_rows,
      };
      if (!captured_continuation && !tab->zoomed &&
          message.mouse.action == protocol::MouseInputAction::press &&
          message.mouse.button == protocol::MouseInputButton::left) {
        const auto divider = tab->layout.divider_at(viewport, message.mouse.column, content_row);
        if (divider.has_value()) {
          session.attachment.mouse_capture = MouseCapture{
              .target = {.tab = tab->id, .pane = divider->first},
              .peer_pane = divider->second,
              .status_tab_before = {},
              .owner = MouseCaptureOwner::divider,
              .divider_axis = divider->axis,
          };
          break;
        }
      }
      if (captured_continuation &&
          session.attachment.mouse_capture->owner == MouseCaptureOwner::discard_until_release) {
        if (message.mouse.action == protocol::MouseInputAction::release) {
          session.attachment.mouse_capture.reset();
        }
        break;
      }
      if (captured_continuation &&
          session.attachment.mouse_capture->owner == MouseCaptureOwner::divider) {
        const auto capture = *session.attachment.mouse_capture;
        auto* const captured_tab = find_tab(session, capture.target.tab);
        if (captured_tab == nullptr || captured_tab->id != session.active_tab ||
            captured_tab->zoomed || captured_tab->layout_suspended) {
          session.active = false;
          return ParseResult::error;
        }
        const auto coordinate =
            capture.divider_axis == SplitAxis::left_right ? message.mouse.column : content_row;
        const Command resize{
            .kind = capture.divider_axis == SplitAxis::left_right
                        ? CommandKind::resize_left_right_divider
                        : CommandKind::resize_top_bottom_divider,
            .origin = CommandOrigin::client,
            .target = {.session = session.id,
                       .tab = capture.target.tab,
                       .pane = capture.target.pane,
                       .peer_pane = capture.peer_pane,
                       .attachment = session.attachment.id},
            .payload = CommandCoordinate{.value = coordinate},
        };
        const auto result = dispatch_session_command(session, runtimes, resize);
        if (result.status == CommandStatus::failed) {
          return ParseResult::error;
        }
        if (result.status != CommandStatus::applied && result.status != CommandStatus::no_effect) {
          if (message.mouse.action == protocol::MouseInputAction::release) {
            session.attachment.mouse_capture.reset();
          } else {
            session.attachment.mouse_capture->owner = MouseCaptureOwner::discard_until_release;
          }
          break;
        }
        if (message.mouse.action == protocol::MouseInputAction::release) {
          finish_live_divider_resize(session);
        }
        break;
      }

      Tab* target_tab = tab;
      Pane* pane = nullptr;
      auto owner = MouseCaptureOwner::application;
      if (captured_continuation) {
        const auto capture = *session.attachment.mouse_capture;
        auto* const captured_tab = find_tab(session, capture.target.tab);
        auto* const captured = captured_tab == nullptr
                                   ? nullptr
                                   : find_pane(session, *captured_tab, capture.target.pane);
        if (captured == nullptr) {
          session.attachment.mouse_capture.reset();
          break;
        }
        target_tab = captured_tab;
        pane = captured;
        owner = capture.owner;
      } else {
        for (auto& slot : session.panes) {
          if (slot.pane == nullptr || slot.pane->tab != tab->id ||
              (tab->zoomed && slot.pane->id != tab->focused_pane)) {
            continue;
          }
          const auto& candidate = slot.pane->rectangle;
          if (message.mouse.column >= candidate.column && content_row >= candidate.row &&
              message.mouse.column < candidate.column + candidate.columns &&
              content_row < candidate.row + candidate.rows) {
            pane = slot.pane.get();
            break;
          }
        }
        if (pane == nullptr) {
          break;
        }
      }
      auto* const runtime = find_pane_runtime(runtimes, session, *target_tab, *pane);
      if (runtime == nullptr) {
        return ParseResult::error;
      }
      const bool wheel_button = message.mouse.button == protocol::MouseInputButton::four ||
                                message.mouse.button == protocol::MouseInputButton::five;
      if (message.mouse.action == protocol::MouseInputAction::press) {
        if (message.mouse.button == protocol::MouseInputButton::left && target_tab == tab &&
            pane->id != tab->focused_pane) {
          const Command focus{
              .kind = CommandKind::focus_pane,
              .origin = CommandOrigin::client,
              .target = {.session = session.id,
                         .tab = target_tab->id,
                         .pane = pane->id,
                         .peer_pane = {},
                         .attachment = session.attachment.id},
          };
          if (!dispatch_session_command(session, runtimes, focus).succeeded()) {
            return ParseResult::error;
          }
        }
        const auto tracking = runtime->terminal.mouse_tracking();
        if (!tracking.has_value()) {
          return ParseResult::error;
        }
        const AttachmentPaneTarget target{.tab = target_tab->id, .pane = pane->id};
        const bool copy_selection = session.attachment.copy_mode.active() &&
                                    session.attachment.selection_target == std::optional{target};
        if (wheel_button && (copy_selection || !tracking->enabled)) {
          if (!copy_selection) {
            const auto alternate_scroll = runtime->terminal.wheel_uses_alternate_scroll();
            if (!alternate_scroll.has_value()) {
              return ParseResult::error;
            }
            if (*alternate_scroll) {
              clear_mouse_selection(session, runtimes);
              const auto queued_bytes_before = runtime->pending_writes.size();
              const auto queued = queue_alternate_scroll_input(
                  runtime->pending_writes, runtime->terminal,
                  message.mouse.button == protocol::MouseInputButton::four);
              if (queued == InputQueueResult::full) {
                return ParseResult::backpressure;
              }
              if (queued == InputQueueResult::encoding_failed) {
                return ParseResult::error;
              }
              if (runtime->pending_writes.size() > queued_bytes_before) {
                runtime->interactive_damage.await_write(queued_bytes_before,
                                                        runtime->pending_writes.size());
              }
              break;
            }
          }
          if (!scroll_viewport_with_mouse(session, *runtime, message.mouse.button,
                                          copy_selection)) {
            return ParseResult::error;
          }
          break;
        }
        owner = message.mouse.button == protocol::MouseInputButton::left &&
                        (copy_selection || !tracking->enabled)
                    ? MouseCaptureOwner::selection
                    : MouseCaptureOwner::application;
        if (!wheel_button) {
          session.attachment.mouse_capture = MouseCapture{
              .target = target,
              .peer_pane = {},
              .status_tab_before = {},
              .owner = owner,
              .divider_axis = SplitAxis::left_right,
          };
        }
        if (owner == MouseCaptureOwner::application) {
          clear_mouse_selection(session, runtimes);
        }
      }
      if (owner == MouseCaptureOwner::selection) {
        if (!process_mouse_selection(session, runtimes, *target_tab, *pane, *runtime, message.mouse,
                                     content_row)) {
          return ParseResult::error;
        }
        if (message.mouse.action == protocol::MouseInputAction::release) {
          session.attachment.mouse_capture.reset();
        }
        break;
      }

      const auto& rectangle = pane->rectangle;
      const auto action = [value = message.mouse.action]() noexcept {
        switch (value) {
        case protocol::MouseInputAction::press:
          return vt::MouseAction::press;
        case protocol::MouseInputAction::release:
          return vt::MouseAction::release;
        case protocol::MouseInputAction::motion:
          return vt::MouseAction::motion;
        }
        return vt::MouseAction::motion;
      }();
      const vt::MouseEvent event{
          .action = action,
          .button = terminal_mouse_button(message.mouse.button),
          .modifiers = message.mouse.modifiers,
          .x = static_cast<float>(
              std::clamp(message.mouse.column, rectangle.column,
                         static_cast<std::uint16_t>(rectangle.column + rectangle.columns - 1U)) -
              rectangle.column),
          .y = static_cast<float>(
              std::clamp(content_row, rectangle.row,
                         static_cast<std::uint16_t>(rectangle.row + rectangle.rows - 1U)) -
              rectangle.row),
          .geometry = {.screen_width = rectangle.columns, .screen_height = rectangle.rows},
          .any_button_pressed = message.mouse.any_button_pressed,
      };
      const auto queued_bytes_before = runtime->pending_writes.size();
      const auto queued = queue_mouse_input(runtime->pending_writes, runtime->terminal, event);
      if (queued == InputQueueResult::full) {
        return ParseResult::backpressure;
      }
      if (queued == InputQueueResult::encoding_failed) {
        return ParseResult::error;
      }
      if (runtime->pending_writes.size() > queued_bytes_before) {
        runtime->interactive_damage.await_write(queued_bytes_before,
                                                runtime->pending_writes.size());
      }
      if (message.mouse.action == protocol::MouseInputAction::release) {
        session.attachment.mouse_capture.reset();
      }
      break;
    }
    case protocol::ClientMessageKind::host_theme:
      if (message.host_theme == nullptr) {
        return ParseResult::error;
      }
      if (!session.theme_bound) {
        if (!bind_session_theme(session, runtimes, *message.host_theme)) {
          return ParseResult::error;
        }
        schedule_frame(session, FrameUrgency::state_change, true);
      }
      break;
    case protocol::ClientMessageKind::pane_command: {
      finish_live_divider_resize(session, true);
      const bool begins_rename =
          message.pane_command == protocol::PaneCommand::begin_rename_session ||
          message.pane_command == protocol::PaneCommand::begin_rename_tab;
      if (session.attachment.rename_prompt.active() && !begins_rename) {
        reset_rename_prompt(session);
      }
      const auto command = command_from_pane_command(session, message.pane_command);
      if (!command.has_value() || !dispatch_session_command(session, runtimes, *command,
                                                            name_conflict, name_conflict_context)
                                       .succeeded()) {
        if (!session.active) {
          session.attachment_runtime.decoder.consume();
          return ParseResult::detach;
        }
      }
      break;
    }
    }
    session.attachment_runtime.decoder.consume();
    if (!session.active) {
      return ParseResult::detach;
    }
  }
}

[[nodiscard]] auto receive_client(SessionRecord& session, PaneRuntimeStore& runtimes,
                                  std::size_t& message_budget, std::size_t& geometry_budget,
                                  std::size_t& input_budget,
                                  const SessionNameConflict name_conflict,
                                  void* const name_conflict_context) noexcept -> ParseResult {
  const auto buffered = parse_client_packets(session, runtimes, message_budget, geometry_budget,
                                             input_budget, name_conflict, name_conflict_context);
  if (buffered != ParseResult::keep) {
    return buffered;
  }
  const auto available = session.attachment_runtime.decoder.writable_bytes();
  if (available.empty()) {
    return ParseResult::error;
  }
  const auto bytes_read =
      ::recv(session.attachment_runtime.client, available.data(), available.size(), 0);
  if (bytes_read == 0) {
    return ParseResult::peer_closed;
  }
  if (bytes_read < 0) {
    return errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK ? ParseResult::keep
                                                                     : ParseResult::peer_closed;
  }
  if (!session.attachment_runtime.decoder.commit(static_cast<std::size_t>(bytes_read))
           .has_value()) {
    return ParseResult::error;
  }
  return parse_client_packets(session, runtimes, message_budget, geometry_budget, input_budget,
                              name_conflict, name_conflict_context);
}

[[nodiscard]] auto advance_copy_search_cursor(PaneRuntime& runtime, vt::TerminalPoint& point,
                                              const CopySearchDirection direction) noexcept
    -> bool {
  const auto viewport = runtime.terminal.viewport_state();
  if (!viewport.has_value() || viewport->total_rows == 0) {
    return false;
  }
  const auto columns = runtime.terminal.size().columns;
  if (direction == CopySearchDirection::forward) {
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

[[nodiscard]] auto active_copy_search_query(const CopyModeState& state) noexcept
    -> std::string_view {
  return state.phase == CopyModePhase::search_prompt ? state.draft_query_view()
                                                     : state.query_view();
}

[[nodiscard]] auto restart_copy_search_after_mutation(SessionRecord& session,
                                                      PaneRuntime& runtime) noexcept -> bool {
  auto& search = session.attachment_runtime.copy_mode;
  if (!search.search_task.has_value()) {
    return false;
  }
  const auto direction = search.search_task->direction;
  const auto endpoint = runtime.terminal.selection_checkpoint_endpoint(vt::PointSpace::screen);
  return endpoint.has_value() && endpoint->has_value() &&
         begin_copy_search(session, runtime, direction, **endpoint);
}

[[nodiscard]] auto finish_copy_search_match(SessionRecord& session, PaneRuntime& runtime,
                                            const vt::SearchMatch match) noexcept -> bool {
  auto& state = session.attachment.copy_mode;
  auto& search = session.attachment_runtime.copy_mode;
  const auto selected = runtime.terminal.select_search_match(match);
  if (!selected.has_value()) {
    return false;
  }
  const auto viewport = runtime.terminal.viewport_state();
  if (!viewport.has_value()) {
    return false;
  }
  const auto target_offset = copy_search_viewport_offset(
      match.end.row, viewport->offset, viewport->visible_rows, viewport->total_rows);
  if (target_offset != viewport->offset) {
    runtime.terminal.scroll_viewport(vt::ViewportScroll::row,
                                     static_cast<std::int64_t>(target_offset));
  }
  if (!update_copy_viewport_offset(session, runtime)) {
    return false;
  }
  search.search_task.reset();
  state.feedback = CopyModeFeedback::none;
  if (state.phase == CopyModePhase::search_prompt) {
    search.preview_match = true;
  } else {
    search.last_search_match = match;
    search.last_search_generation = runtime.mutation_generation;
    search.preview_match = false;
    discard_copy_search_restore(runtime, search);
    state.phase = CopyModePhase::navigation;
  }
  note_compression_activity(runtime);
  invalidate_copy_presentation(session, runtime);
  return true;
}

[[nodiscard]] auto finish_or_wrap_failed_copy_search(SessionRecord& session,
                                                     PaneRuntime& runtime) noexcept -> bool {
  auto& state = session.attachment.copy_mode;
  auto& search = session.attachment_runtime.copy_mode;
  if (!search.search_task.has_value()) {
    return false;
  }
  auto& task = *search.search_task;
  if (!task.wrapped) {
    const auto boundary = copy_search_boundary(runtime, task.direction);
    if (!boundary.has_value()) {
      return false;
    }
    task.wrapped = true;
    task.cursor = vt::SearchCursor{.candidate = *boundary};
    task.deadline = std::chrono::steady_clock::now();
    return true;
  }
  search.search_task.reset();
  search.preview_match = false;
  state.feedback = CopyModeFeedback::no_match;
  if (!restore_copy_search_selection(session, runtime)) {
    return false;
  }
  if (state.phase == CopyModePhase::searching) {
    discard_copy_search_restore(runtime, search);
    state.phase = CopyModePhase::navigation;
  }
  note_compression_activity(runtime);
  invalidate_copy_presentation(session, runtime);
  return true;
}

[[nodiscard]] auto service_copy_search(SessionRecord& session, PaneRuntimeStore& runtimes,
                                       std::size_t& work_budget) noexcept -> bool {
  auto& state = session.attachment.copy_mode;
  auto& search = session.attachment_runtime.copy_mode;
  auto* const task = search.search_task.has_value() ? &*search.search_task : nullptr;
  if (work_budget == 0 || !state.active() || task == nullptr ||
      std::chrono::steady_clock::now() < task->deadline) {
    return false;
  }
  auto* const runtime = copy_mode_runtime(session, runtimes);
  if (runtime == nullptr) {
    leave_copy_mode(session, runtimes);
    return true;
  }
  const auto query = active_copy_search_query(state);
  if (query.empty()) {
    leave_copy_mode(session, runtimes);
    return true;
  }
  if (runtime->mutation_generation != task->terminal_generation) {
    if (!restart_copy_search_after_mutation(session, *runtime)) {
      leave_copy_mode(session, runtimes);
    }
    return true;
  }

  const auto work_limit = std::min(work_budget, limits::search_candidates_per_step);
  work_budget -= work_limit;
  const auto stop = task->wrapped ? std::optional{task->stop_before} : std::nullopt;
  const auto searched = runtime->terminal.search_literal_step(
      query, terminal_search_direction(task->direction), task->cursor, work_limit, stop);
  if (!searched.has_value()) {
    leave_copy_mode(session, runtimes);
    return true;
  }
  bool valid = true;
  switch (searched->status) {
  case vt::SearchStepStatus::found:
    valid = finish_copy_search_match(session, *runtime, searched->match);
    break;
  case vt::SearchStepStatus::pending:
    task->cursor = searched->next;
    task->deadline = std::chrono::steady_clock::now() + copy_search_slice_delay;
    break;
  case vt::SearchStepStatus::not_found:
    valid = finish_or_wrap_failed_copy_search(session, *runtime);
    break;
  }
  if (!valid) {
    leave_copy_mode(session, runtimes);
  }
  return true;
}

[[nodiscard]] auto tab_title(const SessionRecord& session, const Tab& tab,
                             const PaneRuntimeStore& runtimes) noexcept -> std::string_view {
  if (!tab.title_override().empty()) {
    return tab.title_override();
  }
  const auto* const focused = find_pane(session, tab, tab.focused_pane);
  LEMMA_ASSERT(focused != nullptr);
  const auto* const runtime = find_pane_runtime(runtimes, session, tab, *focused);
  LEMMA_ASSERT(runtime != nullptr);
  if (runtime->process_name_size > 0) {
    return {runtime->process_name.data(), runtime->process_name_size};
  }
  const auto title = runtime->terminal.title();
  return title.has_value() && !title->empty() ? *title : std::string_view{"shell"};
}

[[nodiscard]] auto status_tab_drag_signature(const SessionRecord& session) noexcept
    -> std::uint64_t {
  if (!session.attachment.mouse_capture.has_value() ||
      session.attachment.mouse_capture->owner != MouseCaptureOwner::status_tab) {
    return 0;
  }
  const auto& capture = *session.attachment.mouse_capture;
  const auto source = (static_cast<std::uint64_t>(capture.target.tab.slot()) << 32U) |
                      capture.target.tab.generation();
  const auto anchor = (static_cast<std::uint64_t>(capture.status_tab_before.slot()) << 32U) |
                      capture.status_tab_before.generation();
  return (source * 1'099'511'628'211ULL) ^ anchor;
}

[[nodiscard]] auto current_status_signature(const SessionRecord& session,
                                            const PaneRuntimeStore& runtimes) noexcept
    -> std::uint64_t {
  constexpr std::uint64_t offset_basis = 14'695'981'039'346'656'037ULL;
  constexpr std::uint64_t prime = 1'099'511'628'211ULL;
  std::uint64_t signature = offset_basis;
  const auto mix = [&](const std::uint8_t value) {
    signature ^= value;
    signature *= prime;
  };
  for (std::size_t position = 0; position < session.tab_order.size(); ++position) {
    const auto id = session.tab_order.at(position);
    LEMMA_ASSERT(id.has_value());
    const auto* const tab = find_tab(session, *id);
    LEMMA_ASSERT(tab != nullptr);
    mix(static_cast<std::uint8_t>(position + 1U));
    mix(tab->id == session.active_tab ? 1U : 0U);
    const auto title = tab_title(session, *tab, runtimes);
    for (const char character : std::span(title).first(std::min(title.size(), std::size_t{16}))) {
      mix(static_cast<std::uint8_t>(static_cast<unsigned char>(character)));
    }
    mix(title.size() > 16 ? 1U : 0U);
  }
  const auto& prompt = session.attachment.rename_prompt;
  mix(static_cast<std::uint8_t>(prompt.kind));
  mix(static_cast<std::uint8_t>(prompt.feedback));
  mix(static_cast<std::uint8_t>(prompt.cursor));
  for (const char character : prompt.view()) {
    mix(static_cast<std::uint8_t>(static_cast<unsigned char>(character)));
  }
  for (const char character : session.input_router.active_label()) {
    mix(static_cast<std::uint8_t>(static_cast<unsigned char>(character)));
  }
  const auto drag = status_tab_drag_signature(session);
  mix(static_cast<std::uint8_t>(drag));
  mix(static_cast<std::uint8_t>(drag >> 8U));
  mix(static_cast<std::uint8_t>(drag >> 16U));
  mix(static_cast<std::uint8_t>(drag >> 24U));
  mix(static_cast<std::uint8_t>(drag >> 32U));
  mix(static_cast<std::uint8_t>(drag >> 40U));
  mix(static_cast<std::uint8_t>(drag >> 48U));
  mix(static_cast<std::uint8_t>(drag >> 56U));
  return signature;
}

[[nodiscard]] constexpr auto status_prompt_target(const RenamePromptKind kind) noexcept
    -> render::StatusPromptTarget {
  switch (kind) {
  case RenamePromptKind::inactive:
    return render::StatusPromptTarget::none;
  case RenamePromptKind::session:
    return render::StatusPromptTarget::session;
  case RenamePromptKind::tab:
    return render::StatusPromptTarget::active_tab;
  }
  return render::StatusPromptTarget::none;
}

[[nodiscard]] constexpr auto status_prompt_feedback(const RenamePromptFeedback feedback) noexcept
    -> render::StatusPromptFeedback {
  switch (feedback) {
  case RenamePromptFeedback::none:
    return render::StatusPromptFeedback::none;
  case RenamePromptFeedback::invalid:
    return render::StatusPromptFeedback::invalid;
  case RenamePromptFeedback::conflict:
    return render::StatusPromptFeedback::conflict;
  }
  return render::StatusPromptFeedback::none;
}

void refresh_status_process_names(SessionRecord& session, PaneRuntimeStore& runtimes) noexcept {
  for (std::size_t position = 0; position < session.tab_order.size(); ++position) {
    const auto id = session.tab_order.at(position);
    LEMMA_ASSERT(id.has_value());
    auto* const tab = find_tab(session, *id);
    LEMMA_ASSERT(tab != nullptr);
    auto* const focused = find_pane(session, *tab, tab->focused_pane);
    LEMMA_ASSERT(focused != nullptr);
    auto* const runtime = find_pane_runtime(runtimes, session, *tab, *focused);
    LEMMA_ASSERT(runtime != nullptr);
    static_cast<void>(refresh_process_name(*runtime));
  }
}

[[nodiscard]] auto
collect_status_tab_order(const SessionRecord& session,
                         std::array<TabId, render::status_tabs_max>& storage) noexcept
    -> std::span<const TabId> {
  std::array<TabId, render::status_tabs_max> semantic{};
  const auto count = session.tab_order.size();
  for (std::size_t position = 0; position < count; ++position) {
    const auto id = session.tab_order.at(position);
    LEMMA_ASSERT(id.has_value());
    std::span(semantic).subspan(position, 1).front() = *id;
  }
  const auto copy_semantic = [&] {
    std::ranges::copy(std::span(semantic).first(count), storage.begin());
    return std::span<const TabId>(storage).first(count);
  };
  if (!session.attachment.mouse_capture.has_value() ||
      session.attachment.mouse_capture->owner != MouseCaptureOwner::status_tab) {
    return copy_semantic();
  }

  const auto& capture = *session.attachment.mouse_capture;
  const bool source_present =
      std::ranges::find(std::span(semantic).first(count), capture.target.tab) !=
      std::span(semantic).first(count).end();
  const bool anchor_present =
      !capture.status_tab_before.is_valid() ||
      std::ranges::find(std::span(semantic).first(count), capture.status_tab_before) !=
          std::span(semantic).first(count).end();
  if (!source_present || !anchor_present || capture.status_tab_before == capture.target.tab) {
    return copy_semantic();
  }

  std::size_t projected = 0;
  for (const auto id : std::span(semantic).first(count)) {
    if (id == capture.target.tab) {
      continue;
    }
    if (id == capture.status_tab_before) {
      std::span(storage).subspan(projected, 1).front() = capture.target.tab;
      ++projected;
    }
    std::span(storage).subspan(projected, 1).front() = id;
    ++projected;
  }
  if (!capture.status_tab_before.is_valid()) {
    std::span(storage).subspan(projected, 1).front() = capture.target.tab;
    ++projected;
  }
  LEMMA_ASSERT(projected == count);
  return std::span<const TabId>(storage).first(count);
}

[[nodiscard]] auto
collect_status_tabs(const SessionRecord& session, const PaneRuntimeStore& runtimes,
                    const std::span<const TabId> order,
                    std::array<render::StatusTab, render::status_tabs_max>& storage) noexcept
    -> std::span<const render::StatusTab> {
  for (std::size_t position = 0; position < order.size(); ++position) {
    const auto* const tab = find_tab(session, order.subspan(position, 1).front());
    LEMMA_ASSERT(tab != nullptr);
    const auto semantic_position = session.tab_order.position_of(tab->id);
    LEMMA_ASSERT(semantic_position.has_value());
    std::span(storage).subspan(position, 1).front() = {
        // A drag moves complete labels while previewing. Position prefixes change only when the
        // release commits TabOrder, so identical titles remain distinguishable throughout.
        .number = static_cast<std::uint16_t>(*semantic_position + 1U),
        .title = tab_title(session, *tab, runtimes),
        .active = tab->id == session.active_tab,
    };
  }
  return std::span(storage).first(order.size());
}

[[nodiscard]] auto status_line_value(const SessionRecord& session,
                                     const std::span<const render::StatusTab> tabs,
                                     const bool dirty) noexcept -> render::StatusLine {
  return {
      .session_name = session.session_name(),
      .tabs = tabs,
      .prompt_target = status_prompt_target(session.attachment.rename_prompt.kind),
      .prompt_feedback = status_prompt_feedback(session.attachment.rename_prompt.feedback),
      .prompt_value = session.attachment.rename_prompt.view(),
      .input_context = session.input_router.active_label(),
      .prompt_cursor = session.attachment.rename_prompt.cursor,
      .dirty = dirty,
  };
}

[[nodiscard]] auto
collect_status_line(SessionRecord& session, PaneRuntimeStore& runtimes,
                    std::array<render::StatusTab, render::status_tabs_max>& storage) noexcept
    -> render::StatusLine {
  if (!session.attachment_runtime.status_valid) {
    refresh_status_process_names(session, runtimes);
  }
  std::array<TabId, render::status_tabs_max> order_storage{};
  const auto order = collect_status_tab_order(session, order_storage);
  const auto tabs = collect_status_tabs(session, runtimes, order, storage);
  const auto signature = current_status_signature(session, runtimes);
  const bool dirty = !session.attachment_runtime.status_valid ||
                     signature != session.attachment_runtime.status_signature;
  session.attachment_runtime.status_signature = signature;
  session.attachment_runtime.status_valid = true;
  return status_line_value(session, tabs, dirty);
}

[[nodiscard]] auto status_target_at_column(const SessionRecord& session,
                                           const PaneRuntimeStore& runtimes,
                                           const std::uint16_t column) noexcept
    -> std::optional<StatusHit> {
  std::array<TabId, render::status_tabs_max> order_storage{};
  std::array<render::StatusTab, render::status_tabs_max> status_storage{};
  const auto order = collect_status_tab_order(session, order_storage);
  const auto tabs = collect_status_tabs(session, runtimes, order, status_storage);
  const auto target = render::status_target_at_column(
      status_line_value(session, tabs, false),
      {.columns = session.attachment.columns, .rows = session.attachment.rows}, column);
  if (!target.has_value()) {
    return std::nullopt;
  }
  if (target->kind == render::StatusTargetKind::create_tab) {
    return StatusHit{.tab = {},
                     .next = {},
                     .position = 0,
                     .moving_position = 0,
                     .kind = StatusHitKind::create_tab};
  }
  LEMMA_ASSERT(target->tab_position < order.size());
  auto moving_position = target->tab_position;
  if (session.attachment.mouse_capture.has_value() &&
      session.attachment.mouse_capture->owner == MouseCaptureOwner::status_tab) {
    const auto moving = std::ranges::find(order, session.attachment.mouse_capture->target.tab);
    if (moving == order.end()) {
      return std::nullopt;
    }
    moving_position = static_cast<std::size_t>(std::distance(order.begin(), moving));
  }
  return StatusHit{
      .tab = order.subspan(target->tab_position, 1).front(),
      .next = target->tab_position + 1U < order.size()
                  ? order.subspan(target->tab_position + 1U, 1).front()
                  : TabId{},
      .position = static_cast<std::uint16_t>(target->tab_position),
      .moving_position = static_cast<std::uint16_t>(moving_position),
      .kind = StatusHitKind::tab,
  };
}

[[nodiscard]] auto encode_pending_clipboard_write(SessionRecord& session) noexcept
    -> std::optional<std::size_t> {
  if (session.attachment_runtime.clipboard_write.bytes == nullptr ||
      session.attachment_runtime.clipboard_write.size == 0) {
    return std::nullopt;
  }
  constexpr std::string_view prefix = "\x1B]52;c;";
  constexpr std::string_view suffix = "\x1B\\";
  constexpr auto digits =
      std::to_array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
  auto output = session.attachment_runtime.frame.writable();
  const auto encoded_size =
      prefix.size() + clipboard_base64_bytes(session.attachment_runtime.clipboard_write.size) +
      suffix.size();
  if (encoded_size > output.size()) {
    return std::nullopt;
  }
  std::size_t used = 0;
  std::memcpy(output.data(), prefix.data(), prefix.size());
  used += prefix.size();
  const auto input = std::span(session.attachment_runtime.clipboard_write.bytes.get(),
                               session.attachment_runtime.clipboard_write.size);
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

[[nodiscard]] auto queue_pending_clipboard_write(SessionRecord& session,
                                                 const ClientFrameOutput::TimePoint now) noexcept
    -> bool {
  const auto encoded = encode_pending_clipboard_write(session);
  if (!encoded.has_value() || session.attachment_runtime.full_redraw_generation == 0 ||
      session.attachment_runtime.server_sequence == 0) {
    return false;
  }
  const auto messages = ClientFrameOutput::frame_message_count(*encoded);
  if (messages == 0 ||
      messages >
          std::numeric_limits<std::uint32_t>::max() - session.attachment_runtime.server_sequence ||
      !session.attachment_runtime.output.queue_frame(
          *encoded, session.attachment_runtime.server_sequence,
          session.attachment_runtime.full_redraw_generation, false, now)) {
    return false;
  }
  session.attachment_runtime.server_sequence += static_cast<std::uint32_t>(messages);
  session.attachment_runtime.clipboard_write.bytes.reset();
  session.attachment_runtime.clipboard_write.size = 0;
  session.attachment_runtime.clipboard_write.redraw_after_write = true;
  return true;
}

[[nodiscard]] auto compose_session_frame(SessionRecord& session, PaneRuntimeStore& runtimes,
                                         const bool force_full,
                                         const ClientFrameOutput::TimePoint now) noexcept -> bool {
  if (session.attachment_runtime.clipboard_write.bytes != nullptr) {
    return queue_pending_clipboard_write(session, now);
  }
  std::array<render::PaneSurface, panes_per_tab_max> surface_storage{};
  std::array<render::StatusTab, render::status_tabs_max> status_storage{};
  CopyOverlayStorage copy_overlay;
  render::PaneOverlay overlay;
  const auto surfaces = collect_surfaces(session, runtimes, surface_storage, copy_overlay, overlay);
  const auto status = collect_status_line(session, runtimes, status_storage);
  std::uint64_t trace_correlation = 0;
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  trace_correlation = session.attachment_runtime.frame_trace_correlation;
  diagnostic::set_latency_trace_correlation(trace_correlation);
#endif
  diagnostic::record_latency_trace(diagnostic::LatencyTraceStage::frame_composition_started,
                                   static_cast<std::uint32_t>(session.attachment_runtime.client),
                                   surfaces.size());
  const auto rendered = render::compose_retained_frame(
      surfaces, {.columns = session.attachment.columns, .rows = session.attachment.rows},
      session.attachment_runtime.frame, force_full, status, overlay);
  diagnostic::record_latency_trace(diagnostic::LatencyTraceStage::frame_composition_finished,
                                   static_cast<std::uint32_t>(session.attachment_runtime.client),
                                   rendered.has_value() ? rendered->bytes : 0);
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  diagnostic::set_latency_trace_correlation(0);
  session.attachment_runtime.frame_trace_correlation = 0;
#endif
  if (!rendered.has_value() || session.attachment_runtime.server_sequence == 0) {
    return false;
  }
  auto frame_bytes = rendered->bytes;
  if (session.attachment_runtime.bell_pending) {
    auto output = session.attachment_runtime.frame.writable();
    if (frame_bytes >= output.size()) {
      return false;
    }
    output.subspan(frame_bytes, 1).front() = std::byte{0x07};
    ++frame_bytes;
  }
  const auto frame_messages = ClientFrameOutput::frame_message_count(frame_bytes);
  if (frame_messages == 0 || frame_messages > std::numeric_limits<std::uint32_t>::max() -
                                                  session.attachment_runtime.server_sequence) {
    return false;
  }
  auto generation = session.attachment_runtime.full_redraw_generation;
  if (rendered->full) {
    if (generation == std::numeric_limits<std::uint32_t>::max()) {
      return false;
    }
    ++generation;
  }
  if (generation == 0 || !session.attachment_runtime.output.queue_frame(
                             frame_bytes, session.attachment_runtime.server_sequence, generation,
                             rendered->full, now, trace_correlation)) {
    return false;
  }
  session.attachment_runtime.server_sequence += static_cast<std::uint32_t>(frame_messages);
  session.attachment_runtime.full_redraw_generation = generation;
  session.attachment_runtime.bell_pending = false;
  return true;
}

template <typename Id>
[[nodiscard]] auto append_id(ConnectionOutput& output, const Id id) noexcept -> bool {
  return id.is_valid() && output.append_number(id.slot()) && output.append_text(":") &&
         output.append_number(id.generation());
}

[[nodiscard]] auto append_listing(ConnectionOutput& output, const SessionRecord& session,
                                  const PaneRuntimeStore& runtimes) noexcept -> bool {
  const auto* const tab = active_tab(session);
  if (tab == nullptr) {
    return false;
  }
  const auto* const focused = find_pane(session, *tab, tab->focused_pane);
  LEMMA_ASSERT(focused != nullptr);
  const auto* const runtime = find_pane_runtime(runtimes, session, *tab, *focused);
  LEMMA_ASSERT(runtime != nullptr);
  const auto title_value = tab_title(session, *tab, runtimes);
  return output.append_text("lemma session \"") && output.append_title(session.session_name()) &&
         output.append_text("\": ") && output.append_number(tab_count(session)) &&
         output.append_text(" tab(s), ") && output.append_number(pane_count(session)) &&
         output.append_text(" pane(s), focused pid ") &&
         output.append_number(static_cast<std::uint64_t>(runtime->child)) &&
         output.append_text(session.attachment_runtime.client >= 0 ? ", attached, "
                                                                   : ", detached, ") &&
         output.append_number(session.attachment.columns) && output.append_text("x") &&
         output.append_number(session.attachment.rows) && output.append_text(", title \"") &&
         output.append_title(title_value) && output.append_text("\", ids session=") &&
         append_id(output, session.id) && output.append_text(" tab=") &&
         append_id(output, tab->id) && output.append_text(" pane=") &&
         append_id(output, focused->id) &&
         (session.attachment_runtime.connection_id.is_valid()
              ? output.append_text(" client=") &&
                    append_id(output, session.attachment_runtime.connection_id)
              : output.append_text(" client=detached")) &&
         output.append_text("\n");
}

[[nodiscard]] auto append_tab_listings(ConnectionOutput& output, const SessionRecord& session,
                                       const PaneRuntimeStore& runtimes) noexcept -> bool {
  for (std::size_t position = 0; position < session.tab_order.size(); ++position) {
    const auto id = session.tab_order.at(position);
    LEMMA_ASSERT(id.has_value());
    const auto* const tab_value = find_tab(session, *id);
    LEMMA_ASSERT(tab_value != nullptr);
    const auto& tab = *tab_value;
    const auto title_value = tab_title(session, tab, runtimes);
    if (!output.append_text("lemma tab ") || !output.append_number(position + 1U) ||
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
  using Store = BoundedGenerationalStore<SessionRecord, SessionId, limits::sessions_hard_max>;

public:
  [[nodiscard]] auto insert(std::unique_ptr<SessionRecord> session) noexcept
      -> std::optional<SessionId> {
    if (session != nullptr) {
      session->attachment_runtime.frame.bind_capacity_budget(frame_capacity_budget_);
    }
    return sessions_.insert(std::move(session));
  }

  [[nodiscard]] auto get(const SessionId id) noexcept -> SessionRecord* {
    return sessions_.get(id);
  }
  [[nodiscard]] auto get(const SessionId id) const noexcept -> const SessionRecord* {
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
    -> SessionRecord* {
  for (auto& session : sessions) {
    if (session != nullptr && session->active && session->session_name() == name) {
      return session.get();
    }
  }
  return nullptr;
}

[[nodiscard]] auto session_name_conflict(void* const context, const SessionId renamed,
                                         const std::string_view candidate) noexcept -> bool {
  auto& sessions = *static_cast<Sessions*>(context);
  for (const auto& session : sessions) {
    if (session != nullptr && session->active && session->id != renamed &&
        session->session_name() == candidate) {
      return true;
    }
  }
  return false;
}

void reclaim_inactive_sessions(Sessions& sessions, PaneRuntimeStore& runtimes) noexcept {
  for (auto& session : sessions) {
    if (session != nullptr && !session->active &&
        session->attachment_runtime.pending_attach_slot ==
            std::numeric_limits<std::uint32_t>::max()) {
      const auto id = session->id;
      runtimes.erase_session(id);
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

[[nodiscard]] auto append_all_listings(ConnectionOutput& output, const Sessions& sessions,
                                       const PaneRuntimeStore& runtimes) noexcept -> bool {
  std::size_t listed = 0;
  for (const auto& session : sessions) {
    if (session != nullptr && session->active) {
      if (!append_listing(output, *session, runtimes)) {
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
  read_mutation_position,
  read_mutation_size,
  read_mutation,
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
  std::array<char, protocol::tab_title_bytes_max> mutation_text{};
  std::size_t mutation_text_size{0};
  std::uint8_t mutation_position{0};
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
  if (session != nullptr && session->attachment_runtime.pending_attach_slot == slot &&
      session->attachment_runtime.pending_attach_generation == pending.generation) {
    if (session->attachment_runtime.client < 0) {
      session->attachment_runtime.reset_connection();
    } else {
      session->attachment_runtime.pending_attach_slot = std::numeric_limits<std::uint32_t>::max();
      session->attachment_runtime.pending_attach_generation = 0;
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
                             PaneRuntimeStore& runtimes,
                             const ExtensionRuntime* const extensions) noexcept {
  bool prepared = true;
  if (pending.command == command_list) {
    prepared = append_extension_error(pending.output, extension_error(extensions)) &&
               append_all_listings(pending.output, sessions, runtimes);
  } else if (pending.command == command_kill_all || pending.command == command_shutdown) {
    const Command stop{.kind = CommandKind::stop_session, .origin = CommandOrigin::cli};
    for (auto& session : sessions) {
      if (session != nullptr) {
        static_cast<void>(dispatch_session_command(*session, runtimes, stop));
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

void prepare_rename_command(PendingConnection& pending, Sessions& sessions,
                            PaneRuntimeStore& runtimes) noexcept {
  auto* const session = find_session(sessions, pending.session.view());
  if (session == nullptr) {
    finish_pending_byte(pending, response_missing);
    return;
  }
  Command command{
      .origin = CommandOrigin::cli,
      .target = {.session = session->id, .tab = {}, .pane = {}, .peer_pane = {}, .attachment = {}}};
  if (pending.command == command_rename_session) {
    const auto name =
        SessionNameValue::create({pending.mutation_text.data(), pending.mutation_text_size});
    if (!name.has_value()) {
      finish_pending_byte(pending, response_failed);
      return;
    }
    command.kind = CommandKind::rename_session;
    command.payload = *name;
  } else {
    const auto* const tab = tab_at_position(*session, pending.mutation_position);
    const auto title =
        TabTitleValue::create({pending.mutation_text.data(), pending.mutation_text_size});
    if (tab == nullptr) {
      finish_pending_byte(pending, response_missing);
      return;
    }
    if (!title.has_value()) {
      finish_pending_byte(pending, response_failed);
      return;
    }
    command.kind = CommandKind::rename_tab;
    command.target.tab = tab->id;
    command.payload = *title;
  }
  const auto result =
      dispatch_session_command(*session, runtimes, command, &session_name_conflict, &sessions);
  switch (result.status) {
  case CommandStatus::applied:
  case CommandStatus::no_effect:
    finish_pending_byte(pending, response_ready);
    return;
  case CommandStatus::conflict:
    finish_pending_byte(pending, response_conflict);
    return;
  case CommandStatus::stale_target:
  case CommandStatus::wrong_owner:
    finish_pending_byte(pending, response_missing);
    return;
  case CommandStatus::capacity:
    finish_pending_byte(pending, response_capacity);
    return;
  case CommandStatus::detach_requested:
  case CommandStatus::invalid_command:
  case CommandStatus::invalid_target:
  case CommandStatus::unavailable:
  case CommandStatus::failed:
    finish_pending_byte(pending, response_failed);
    return;
  }
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void prepare_named_command(PendingConnection& pending, Sessions& sessions,
                           PaneRuntimeStore& runtimes,
                           const ExtensionRuntime* const extensions) noexcept {
  SessionRecord* session = find_session(sessions, pending.session.view());
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
                                      ? LaunchEnvironmentMode::replace
                                      : LaunchEnvironmentMode::inherit;
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
    inserted->attachment.id = AttachmentId::from_parts(id->slot(), id->generation());
    inserted->attachment.session = *id;
    if (allocate_tab(*inserted, runtimes) == nullptr) {
      const bool erased = sessions.erase(*id);
      LEMMA_ASSERT(erased);
      finish_pending_byte(pending, response_failed);
      return;
    }
    inserted->previous_tab = inserted->active_tab;
    finish_pending_byte(pending, response_ready);
    return;
  }
  if (session == nullptr) {
    finish_pending_byte(pending, response_missing);
    return;
  }
  if (pending.command == command_list_session) {
    if (!append_extension_error(pending.output, extension_error(extensions)) ||
        !append_listing(pending.output, *session, runtimes)) {
      fail_pending_output(pending);
    } else {
      finish_pending_output(pending);
    }
    return;
  }
  if (pending.command == command_list_tabs) {
    if (!append_extension_error(pending.output, extension_error(extensions)) ||
        !append_tab_listings(pending.output, *session, runtimes)) {
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
  static_cast<void>(dispatch_session_command(*session, runtimes, stop));
  finish_pending_output(pending);
}

void prepare_attach(PendingConnection& pending, Sessions& sessions, PaneRuntimeStore& runtimes,
                    const std::size_t slot) noexcept {
  SessionRecord* const session = find_session(sessions, pending.session.view());
  if (session == nullptr) {
    finish_pending_disconnect(pending, protocol::DisconnectReason::session_missing,
                              "no lemma session");
    return;
  }
  if (session->attachment_runtime.client >= 0 || session->attachment_runtime.pending_attach_slot !=
                                                     std::numeric_limits<std::uint32_t>::max()) {
    finish_pending_disconnect(pending, protocol::DisconnectReason::session_busy,
                              "lemma session is already attached");
    return;
  }
  if (session->connection_generation == std::numeric_limits<std::uint32_t>::max()) {
    finish_pending_disconnect(pending, protocol::DisconnectReason::capacity,
                              "attachment identity capacity exhausted");
    return;
  }
  const protocol::Dimensions previous_dimensions{.columns = session->attachment.columns,
                                                 .rows = session->attachment.rows};
  if (!resize_session(*session, runtimes, pending.attach_dimensions)) {
    session->attachment_runtime.frame.release();
    finish_pending_disconnect(pending, protocol::DisconnectReason::setup_failed,
                              "failed to prepare attached viewport");
    return;
  }
  if (!session->theme_bound && pending.attach_host_theme.has_value() &&
      !bind_session_theme(*session, runtimes, *pending.attach_host_theme)) {
    // Viewport and theme are one attach transaction. A recoverable theme failure restores the
    // previous viewport; inability to restore either terminal state fails the Session closed.
    if (session->active && !resize_session(*session, runtimes, previous_dimensions)) {
      session->active = false;
    }
    session->attachment_runtime.frame.release();
    finish_pending_disconnect(pending, protocol::DisconnectReason::setup_failed,
                              "failed to apply host terminal theme");
    return;
  }
  // Theme and viewport are committed together here. Failure while flushing the accepted hello is
  // then ordinary AttachmentRuntime loss: it releases connection resources but does not rewrite
  // stable Session defaults or the last committed viewport.
  session->attachment_runtime.pending_attach_slot = static_cast<std::uint32_t>(slot);
  session->attachment_runtime.pending_attach_generation = pending.generation;
  pending.attach_session = session->id;
  pending.output.reset();
  const auto hello = protocol::encode_daemon_hello(pending.attach_dimensions);
  const bool appended = pending.output.append(hello.bytes());
  LEMMA_ASSERT(appended);
  finish_pending_output(pending, PendingAction::attach);
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void complete_pending_field(PendingConnection& pending, Sessions& sessions,
                            PaneRuntimeStore& runtimes,
                            const ExtensionRuntime* const extensions) noexcept {
  switch (pending.state) {
  case PendingState::read_command:
    pending.command = pending.field.front();
    if (pending.command == protocol::attach_magic.front()) {
      if (!pending.attach_decoder.prepare().has_value()) {
        pending.state = PendingState::unused;
        break;
      }
      pending.attach_decoder.reset();
      pending.attach_decoder.writable_bytes().front() = pending.command;
      const auto committed = pending.attach_decoder.commit(1);
      LEMMA_ASSERT(committed.has_value());
      pending.state = PendingState::read_attach;
    } else if (pending.command == command_list || pending.command == command_kill_all ||
               pending.command == command_shutdown) {
      pending.output.reset();
      prepare_unnamed_command(pending, sessions, runtimes, extensions);
    } else if (pending.command == command_create ||
               pending.command == command_create_with_context ||
               pending.command == command_list_session || pending.command == command_list_tabs ||
               pending.command == command_rename_session || pending.command == command_rename_tab ||
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
    } else if (pending.command == command_rename_session) {
      begin_pending_field(pending, PendingState::read_mutation_size, 1);
    } else if (pending.command == command_rename_tab) {
      begin_pending_field(pending, PendingState::read_mutation_position, 1);
    } else {
      pending.output.reset();
      prepare_named_command(pending, sessions, runtimes, extensions);
    }
    break;
  case PendingState::read_mutation_position:
    pending.mutation_position = std::to_integer<std::uint8_t>(pending.field.front());
    if (pending.mutation_position >= tabs_per_session_max) {
      pending.state = PendingState::unused;
    } else {
      begin_pending_field(pending, PendingState::read_mutation_size, 1);
    }
    break;
  case PendingState::read_mutation_size: {
    const auto size =
        static_cast<std::size_t>(std::to_integer<std::uint8_t>(pending.field.front()));
    const auto maximum = pending.command == command_rename_session
                             ? protocol::session_name_bytes_max
                             : protocol::tab_title_bytes_max;
    if (size > maximum || (pending.command == command_rename_session && size == 0)) {
      pending.state = PendingState::unused;
    } else if (size == 0) {
      pending.mutation_text = {};
      pending.mutation_text_size = 0;
      pending.output.reset();
      prepare_rename_command(pending, sessions, runtimes);
    } else {
      begin_pending_field(pending, PendingState::read_mutation, size);
    }
    break;
  }
  case PendingState::read_mutation:
    pending.mutation_text = {};
    pending.mutation_text_size = pending.field_target;
    std::ranges::copy(std::span(pending.field).first(pending.mutation_text_size),
                      std::as_writable_bytes(std::span(pending.mutation_text)).begin());
    pending.output.reset();
    prepare_rename_command(pending, sessions, runtimes);
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
      prepare_named_command(pending, sessions, runtimes, extensions);
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
      prepare_named_command(pending, sessions, runtimes, extensions);
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
                            PaneRuntimeStore& runtimes, const ExtensionRuntime* const extensions,
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
        prepare_attach(*pending, sessions, runtimes, slot);
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
        complete_pending_field(*pending, sessions, runtimes, extensions);
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
                          PaneRuntimeStore& runtimes, const ExtensionRuntime* const extensions,
                          const std::size_t slot) noexcept {
  auto* const pending = std::span(connections).subspan(slot, 1).front().get();
  LEMMA_ASSERT(pending != nullptr);
  if (std::chrono::steady_clock::now() >= pending->setup_deadline) {
    close_pending(connections, slot, sessions);
    return;
  }
  process_pending_fields(connections, sessions, runtimes, extensions, slot);
}

void handle_client_parse_result(SessionRecord& session, PaneRuntimeStore& runtimes,
                                ParseResult result) noexcept;

void handoff_attached_connection(PendingConnections& connections, const std::size_t slot,
                                 Sessions& sessions, PaneRuntimeStore& runtimes) noexcept {
  auto& owner = std::span(connections).subspan(slot, 1).front();
  LEMMA_ASSERT(owner != nullptr);
  auto& pending = *owner;
  SessionRecord* const session = sessions.get(pending.attach_session);
  if (session == nullptr || !session->active ||
      session->attachment_runtime.pending_attach_slot != slot ||
      session->attachment_runtime.pending_attach_generation != pending.generation) {
    close_pending(connections, slot, sessions);
    return;
  }

  const int connection = pending.descriptor;
  pending.descriptor = -1;
  session->attachment_runtime.client = connection;
  session->attachment_runtime.decoder = std::move(pending.attach_decoder);
  release_attach_reservation(pending, slot, sessions);
  owner.reset();

  session->connection_generation = next_generation(session->connection_generation);
  session->attachment_runtime.connection_id =
      ConnectionId::from_parts(session->id.slot(), session->connection_generation);
  session->attachment_runtime.output.reset();
  session->attachment_runtime.server_sequence = 2;
  session->attachment_runtime.full_redraw_generation = 0;
  session->attachment_runtime.input_backpressured = false;
  session->attachment_runtime.client_work_pending = false;
  session->attachment_runtime.retained_input_offset.reset();
  session->attachment_runtime.pending_routed_input_size = 0;
  session->attachment_runtime.client_close_state = ConnectionCloseState::none;
  session->attachment_runtime.client_close_reason = protocol::DisconnectReason::protocol_error;
  session->attachment_runtime.frame_scheduler.cancel();
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  session->attachment_runtime.frame_trace_correlation = 0;
#endif
  if (!compose_session_frame(*session, runtimes, true, std::chrono::steady_clock::now())) {
    detach_attachment(*session, runtimes);
    return;
  }
  auto message_budget = client_messages_per_turn_max;
  auto geometry_budget = client_geometry_messages_per_turn_max;
  auto input_budget = client_input_steps_per_turn_max;
  handle_client_parse_result(*session, runtimes,
                             parse_client_packets(*session, runtimes, message_budget,
                                                  geometry_budget, input_budget,
                                                  &session_name_conflict, &sessions));
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
                                        std::size_t& global_budget, Sessions& sessions,
                                        PaneRuntimeStore& runtimes) noexcept -> bool {
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
    handoff_attached_connection(connections, slot, sessions, runtimes);
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
[[nodiscard]] auto frame_poll_timeout(const Sessions& sessions, const PaneRuntimeStore& runtimes,
                                      const FrameScheduler::TimePoint now, int timeout) noexcept
    -> int {
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
    if (session->attachment_runtime.client_work_pending) {
      return 0;
    }
    if ((session->attachment_runtime.copy_mode.search_task.has_value() &&
         tighten(session->attachment_runtime.copy_mode.search_task->deadline)) ||
        (session->attachment_runtime.copy_mode.pending_escape_size > 0 &&
         tighten(session->attachment_runtime.copy_mode.pending_escape_deadline)) ||
        tighten(session->attachment_runtime.frame_scheduler.deadline(frame_sink_state(*session))) ||
        tighten(session->attachment_runtime.output.deadline())) {
      return 0;
    }
    for (const auto& pane_slot : session->panes) {
      if (pane_slot.pane == nullptr) {
        continue;
      }
      const auto* const runtime = find_pane_runtime(runtimes, *session, *pane_slot.pane);
      LEMMA_ASSERT(runtime != nullptr);
      if (tighten(runtime->presentation_gate.deadline()) ||
          (runtime->compression_scheduled && tighten(runtime->compression_deadline))) {
        return 0;
      }
    }
  }
  return timeout;
}

[[nodiscard]] auto poll_timeout(const Sessions& sessions, const PaneRuntimeStore& runtimes,
                                const PendingConnections& pending,
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
  return frame_poll_timeout(sessions, runtimes, now, timeout);
}

struct PaneDamageAssessment final {
  bool interactive{false};
  bool status_changed{false};
};

[[nodiscard]] auto assess_pane_damage(SessionRecord& session, const PaneRuntimeStore& runtimes,
                                      PaneRuntime& runtime, const PtyDrainResult& drained,
                                      const bool track_interactive_damage,
                                      const std::uint64_t interactive_status_before) noexcept
    -> PaneDamageAssessment {
  const auto status_after = current_status_signature(session, runtimes);
  const bool interactive_status_damage =
      track_interactive_damage && status_after != interactive_status_before;
  const bool status_changed = !session.attachment_runtime.status_valid ||
                              status_after != session.attachment_runtime.status_signature;
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
  if (drained.failure.has_value() || process_changed || damage.status_changed) {
    return FrameUrgency::state_change;
  }
  return FrameUrgency::burst;
}

[[nodiscard]] auto pane_event_changed(const SessionRecord& session, const PtyDrainResult& drained,
                                      const bool process_changed) noexcept -> bool {
  if (session.attachment_runtime.client < 0) {
    return false;
  }
  return drained.changed || process_changed;
}

constexpr std::size_t blocked_sink_pty_read_bytes_per_turn_max = std::size_t{4} * 1'024U;

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void process_pane_events(SessionRecord& session, Tab& tab, Pane& pane, PaneRuntime& runtime,
                         PaneRuntimeStore& runtimes, const pollfd& events,
                         std::size_t& global_budget, std::size_t& blocked_session_budget) noexcept {
  if ((events.revents & (POLLIN | POLLHUP | POLLERR)) == 0) {
    return;
  }
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  auto* const trace_matcher = &runtime.output_trace_matcher;
#else
  diagnostic::LatencyTraceMarkerMatcher* const trace_matcher = nullptr;
#endif
  const bool track_interactive_damage =
      session.attachment_runtime.client >= 0 && runtime.interactive_damage.pending();
  const auto interactive_status_before =
      track_interactive_damage ? current_status_signature(session, runtimes) : 0;
  // A client-blocked session keeps consuming canonical PTY state, but all of its ready panes share
  // one isolation slice so a many-pane session cannot spend the daemon-wide allowance by taking a
  // fresh slice for every pane.
  const bool blocked_sink = session.attachment_runtime.output.busy();
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
  if (drained.failure.has_value()) {
    runtime.fail(*drained.failure);
  }
  session.attachment_runtime.bell_pending = session.attachment_runtime.bell_pending || drained.bell;
  if (drained.title_changed) {
    session.attachment_runtime.status_valid = false;
  }
  if (drained.changed && runtime.live()) {
    record_terminal_mutation(runtime);
    preserve_copy_viewport_after_mutation(session, pane, runtime, runtimes);
    note_compression_activity(runtime);
  }
  const bool process_changed =
      refresh_process_name_if_due(runtime, std::chrono::steady_clock::now());
  if (!pane_event_changed(session, drained, process_changed)) {
    return;
  }
  const auto damage = assess_pane_damage(session, runtimes, runtime, drained,
                                         track_interactive_damage, interactive_status_before);
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  if (drained.correlation != 0 && tab.id == session.active_tab && pane.id == tab.focused_pane) {
    session.attachment_runtime.frame_trace_correlation = drained.correlation;
  }
#endif
  if (tab.id == session.active_tab && (!drained.presentation_deferred || drained.bell ||
                                       process_changed || damage.status_changed)) {
    schedule_frame(session, frame_urgency(drained, process_changed, damage),
                   drained.damage_capture_failed || drained.force_full);
  } else if (damage.status_changed) {
    schedule_frame(session, FrameUrgency::state_change, false);
  }
}

void queue_client_disconnect_if_ready(SessionRecord& session, PaneRuntimeStore& runtimes) noexcept {
  if (session.attachment_runtime.client_close_state != ConnectionCloseState::queue_disconnect ||
      session.attachment_runtime.output.busy()) {
    return;
  }
  const auto reason = session.attachment_runtime.client_close_reason;
  const auto diagnostic = reason == protocol::DisconnectReason::normal
                              ? std::string_view{}
                              : std::string_view{"invalid client protocol message"};
  if (session.attachment_runtime.server_sequence == 0 ||
      session.attachment_runtime.server_sequence == std::numeric_limits<std::uint32_t>::max() ||
      !session.attachment_runtime.output.queue_disconnect(
          reason, diagnostic, session.attachment_runtime.server_sequence,
          std::chrono::steady_clock::now())) {
    detach_attachment(session, runtimes);
    return;
  }
  ++session.attachment_runtime.server_sequence;
  session.attachment_runtime.client_close_state = ConnectionCloseState::disconnect_queued;
}

void handle_client_parse_result(SessionRecord& session, PaneRuntimeStore& runtimes,
                                const ParseResult result) noexcept {
  session.attachment_runtime.input_backpressured = result == ParseResult::backpressure;
  session.attachment_runtime.client_work_pending = result == ParseResult::yield;
  if (result == ParseResult::detach) {
    session.attachment_runtime.client_close_reason = protocol::DisconnectReason::normal;
    session.attachment_runtime.client_close_state = ConnectionCloseState::queue_disconnect;
    session.attachment_runtime.input_backpressured = false;
    session.attachment_runtime.client_work_pending = false;
    queue_client_disconnect_if_ready(session, runtimes);
    return;
  }
  if (result == ParseResult::peer_closed) {
    detach_attachment(session, runtimes);
    return;
  }
  if (result == ParseResult::error) {
    session.attachment_runtime.client_close_reason = protocol::DisconnectReason::protocol_error;
    session.attachment_runtime.client_close_state = ConnectionCloseState::queue_disconnect;
    session.attachment_runtime.input_backpressured = false;
    session.attachment_runtime.client_work_pending = false;
    queue_client_disconnect_if_ready(session, runtimes);
  }
}

void process_client_events(SessionRecord& session, PaneRuntimeStore& runtimes, const pollfd& events,
                           std::size_t& message_budget, std::size_t& geometry_budget,
                           std::size_t& input_budget, const SessionNameConflict name_conflict,
                           void* const name_conflict_context) noexcept {
  // Consume resizes before flushing queued output so resize_session can discard bytes composed
  // for the previous physical viewport. Decoder-held work is retried without socket readiness on a
  // later bounded turn or after PTY capacity becomes available. A closed peer cannot retain it.
  if (session.attachment_runtime.client >= 0 &&
      (session.attachment_runtime.input_backpressured ||
       session.attachment_runtime.client_work_pending) &&
      (events.revents & (POLLHUP | POLLERR)) != 0) {
    detach_attachment(session, runtimes);
    return;
  }
  if (session.attachment_runtime.client >= 0 &&
      session.attachment_runtime.client_close_state == ConnectionCloseState::none &&
      (session.attachment_runtime.input_backpressured ||
       session.attachment_runtime.client_work_pending ||
       (events.revents & (POLLIN | POLLHUP | POLLERR)) != 0)) {
    handle_client_parse_result(session, runtimes,
                               receive_client(session, runtimes, message_budget, geometry_budget,
                                              input_budget, name_conflict, name_conflict_context));
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

struct PaneWriteTarget final {
  SessionRecord* session{nullptr};
  Pane* pane{nullptr};
  PaneRuntime* runtime{nullptr};
};

constexpr std::size_t interactive_followup_read_bytes_per_pane_max = std::size_t{16} * 1'024U;
constexpr std::size_t interactive_followup_read_bytes_per_turn_max = std::size_t{64} * 1'024U;

void process_interactive_followups(const std::span<PaneWriteTarget> targets,
                                   PaneRuntimeStore& runtimes) noexcept {
  std::array<pollfd, static_cast<std::size_t>(limits::panes_hard_max)> descriptors{};
  std::array<PaneWriteTarget*, static_cast<std::size_t>(limits::panes_hard_max)> owners{};
  std::size_t count = 0;
  for (auto& target : targets) {
    LEMMA_ASSERT(target.session != nullptr && target.pane != nullptr && target.runtime != nullptr);
    if (!target.runtime->live() || !target.runtime->interactive_damage.pending() ||
        target.session->attachment_runtime.output.busy()) {
      continue;
    }
    std::span(descriptors).subspan(count, 1).front() = {
        .fd = target.runtime->pty, .events = POLLIN, .revents = 0};
    std::span(owners).subspan(count, 1).front() = &target;
    ++count;
  }
  if (count == 0 || ::poll(descriptors.data(), static_cast<nfds_t>(count), 0) <= 0) {
    return;
  }

  std::size_t global_budget = interactive_followup_read_bytes_per_turn_max;
  for (std::size_t index = 0; index < count && global_budget > 0; ++index) {
    const auto& events = std::span(descriptors).subspan(index, 1).front();
    if ((events.revents & (POLLIN | POLLHUP | POLLERR)) == 0) {
      continue;
    }
    auto& owner = *std::span(owners).subspan(index, 1).front();
    auto* const tab = find_tab(*owner.session, owner.pane->tab);
    LEMMA_ASSERT(tab != nullptr);
    std::size_t pane_budget = std::min(global_budget, interactive_followup_read_bytes_per_pane_max);
    const auto pane_budget_before = pane_budget;
    std::size_t blocked_session_budget = 0;
    process_pane_events(*owner.session, *tab, *owner.pane, *owner.runtime, runtimes, events,
                        pane_budget, blocked_session_budget);
    global_budget -= pane_budget_before - pane_budget;
  }
}

struct PaneRuntimeOutcome final {
  PaneAddress pane;
  PaneRuntimeFailure failure{PaneRuntimeFailure::terminal_integrity_error};
};

void apply_pane_runtime_outcome(SessionRecord& session, Tab& tab, PaneRuntimeStore& runtimes,
                                const PaneRuntimeOutcome& outcome) noexcept {
  LEMMA_ASSERT(outcome.pane.session == session.id);
  if (session.attachment.mouse_capture.has_value() &&
      session.attachment.mouse_capture->owner == MouseCaptureOwner::divider &&
      session.attachment.mouse_capture->target.tab == tab.id) {
    // Every committed divider position is already converged; consume the eventual stale release.
    finish_live_divider_resize(session, true);
  }
  // Current policy closes the semantic pane for every terminal-integrity or process-lifetime loss.
  // Keeping the reasons distinct prevents Runtime from deciding that policy and permits a later
  // Core policy change without altering PTY, terminal, or reactor code.
  switch (outcome.failure) {
  case PaneRuntimeFailure::child_exit:
  case PaneRuntimeFailure::pty_read_error:
  case PaneRuntimeFailure::pty_write_error:
  case PaneRuntimeFailure::terminal_integrity_error:
  case PaneRuntimeFailure::scrollback_compression_error:
  case PaneRuntimeFailure::resize_consistency_lost:
    static_cast<void>(close_pane(session, tab, runtimes, outcome.pane.pane));
    return;
  }
}

// Removal may rewrite tab and pane ownership while traversing fixed Session pane slots.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void reclaim_dead_panes(SessionRecord& session, PaneRuntimeStore& runtimes) noexcept {
  for (std::size_t index = 0; index < session.panes.size() && session.active; ++index) {
    // index is bounded by the fixed Session pane capacity.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-constant-array-index,cppcoreguidelines-pro-bounds-avoid-unchecked-container-access)
    auto& pane_owner = session.panes[index].pane;
    if (pane_owner == nullptr) {
      continue;
    }
    auto* const tab = find_tab(session, pane_owner->tab);
    LEMMA_ASSERT(tab != nullptr);
    auto* const runtime = find_pane_runtime(runtimes, session, *pane_owner);
    LEMMA_ASSERT(runtime != nullptr);
    if (!runtime->live()) {
      LEMMA_ASSERT(runtime->failure.has_value());
      const auto address = pane_address(session, *pane_owner);
      const auto failure = *runtime->failure;
      apply_pane_runtime_outcome(session, *tab, runtimes, {.pane = address, .failure = failure});
    }
  }
}

// Collecting due panes traverses the fixed session hierarchy before the bounded fair work pass.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void run_due_scrollback_compression(Sessions& sessions, PaneRuntimeStore& runtimes,
                                    std::size_t& cursor) noexcept {
  constexpr std::size_t steps_per_turn_max = 8;
  const auto now = std::chrono::steady_clock::now();
  std::array<PaneRuntime*, static_cast<std::size_t>(limits::panes_hard_max)> due{};
  std::size_t count = 0;
  for (auto& session : sessions) {
    if (session == nullptr || !session->active) {
      continue;
    }
    for (auto& pane_slot : session->panes) {
      if (pane_slot.pane == nullptr) {
        continue;
      }
      auto* const runtime = find_pane_runtime(runtimes, *session, *pane_slot.pane);
      LEMMA_ASSERT(runtime != nullptr);
      if (runtime->live() && runtime->compression_scheduled &&
          now >= runtime->compression_deadline) {
        std::span(due).subspan(count, 1).front() = runtime;
        ++count;
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
      runtime.fail(PaneRuntimeFailure::scrollback_compression_error);
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
void release_expired_presentation_gates(Sessions& sessions, PaneRuntimeStore& runtimes) noexcept {
  const auto now = std::chrono::steady_clock::now();
  for (auto& session : sessions) {
    if (session == nullptr || !session->active) {
      continue;
    }
    for (auto& pane_slot : session->panes) {
      if (pane_slot.pane == nullptr) {
        continue;
      }
      auto* const runtime = find_pane_runtime(runtimes, *session, *pane_slot.pane);
      LEMMA_ASSERT(runtime != nullptr);
      const auto released = runtime->presentation_gate.release_if_expired(now);
      if (released.urgent_render && pane_slot.pane->tab == session->active_tab) {
        schedule_frame(*session, FrameUrgency::state_change, released.force_full);
      }
    }
  }
}

void queue_due_frames(Sessions& sessions, PaneRuntimeStore& runtimes) noexcept {
  const auto now = std::chrono::steady_clock::now();
  for (auto& session : sessions) {
    if (session == nullptr || !session->active ||
        session->attachment_runtime.client_close_state != ConnectionCloseState::none ||
        !session->attachment_runtime.frame_scheduler.due(now, frame_sink_state(*session))) {
      continue;
    }
    if (!compose_session_frame(*session, runtimes,
                               session->attachment_runtime.frame_scheduler.force_full(), now)) {
      detach_attachment(*session, runtimes);
    }
    session->attachment_runtime.frame_scheduler.complete();
  }
}

[[nodiscard]] auto write_attached_client(void* const context,
                                         const std::span<const std::byte> bytes) noexcept
    -> ClientFrameWriteAttempt {
  auto& session = *static_cast<SessionRecord*>(context);
  const auto sent =
      ::send(session.attachment_runtime.client, bytes.data(), bytes.size(), MSG_NOSIGNAL);
  return {.bytes = sent, .error = sent < 0 ? errno : 0};
}

void expire_attached_client_frames(Sessions& sessions, PaneRuntimeStore& runtimes,
                                   const ClientFrameOutput::TimePoint now) noexcept {
  for (auto& session : sessions) {
    if (session != nullptr && session->active && session->attachment_runtime.client >= 0 &&
        session->attachment_runtime.output.expired(now)) {
      detach_attachment(*session, runtimes);
    }
  }
}

void flush_attached_client_frames(Sessions& sessions, PaneRuntimeStore& runtimes,
                                  const std::span<ClientFrameFlushTarget> storage,
                                  std::size_t& cursor,
                                  const ClientFrameOutput::TimePoint now) noexcept {
  std::size_t count = 0;
  for (auto& session : sessions) {
    if (session == nullptr || !session->active || session->attachment_runtime.client < 0) {
      continue;
    }
    LEMMA_ASSERT(count < storage.size());
    storage.subspan(count, 1).front() = {
        .descriptor = session->attachment_runtime.client,
        .frame = &session->attachment_runtime.frame,
        .output = &session->attachment_runtime.output,
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
    auto& session = *static_cast<SessionRecord*>(target.context);
    const auto status = target.status;
    if (status == ClientFrameFlushStatus::hard_error ||
        status == ClientFrameFlushStatus::deadline_exceeded ||
        (status == ClientFrameFlushStatus::drained &&
         session.attachment_runtime.client_close_state ==
             ConnectionCloseState::disconnect_queued)) {
      detach_attachment(session, runtimes);
    } else if (status == ClientFrameFlushStatus::drained) {
      if (session.attachment_runtime.clipboard_write.redraw_after_write) {
        session.attachment_runtime.clipboard_write.redraw_after_write = false;
        schedule_frame(session, FrameUrgency::state_change, true);
      }
      queue_client_disconnect_if_ready(session, runtimes);
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

[[nodiscard]] auto empty_pending_slot(PendingConnections& pending_connections,
                                      const PendingConnectionGenerations& generations) noexcept
    -> std::optional<std::size_t> {
  for (std::size_t slot = 0; slot < pending_connections.size(); ++slot) {
    if (std::span(pending_connections).subspan(slot, 1).front() == nullptr &&
        std::span(generations).subspan(slot, 1).front() <
            std::numeric_limits<std::uint32_t>::max()) {
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
    const auto available = empty_pending_slot(pending_connections, generations);
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
  SessionId session;
  TabId tab;
  PaneId pane;
  ConnectionId connection;
  std::size_t auxiliary_slot{0};
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
  std::unique_ptr<PaneRuntimeStore> pane_runtimes;
  try {
    pane_runtimes = std::make_unique<PaneRuntimeStore>();
  } catch (const std::bad_alloc&) {
    return 1;
  }
  auto& runtimes = *pane_runtimes;
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
      for (const auto& pane_slot : session->panes) {
        const auto& pane = pane_slot.pane;
        if (pane == nullptr) {
          continue;
        }
        const auto address = pane_address(*session, *pane);
        const auto* const runtime = runtimes.get(address);
        LEMMA_ASSERT(runtime != nullptr);
        if (!runtime->live()) {
          continue;
        }
        const auto pane_events = static_cast<short>(
            POLLIN | (!runtime->pending_writes.empty() ? static_cast<short>(POLLOUT) : 0));
        std::span(descriptors).subspan(descriptor_count, 1).front() = {
            .fd = runtime->pty, .events = pane_events, .revents = 0};
        std::span(owners).subspan(descriptor_count, 1).front() = {.session = address.session,
                                                                  .tab = pane->tab,
                                                                  .pane = address.pane,
                                                                  .connection = {},
                                                                  .auxiliary_slot = 0,
                                                                  .kind = DescriptorKind::pane};
        ++descriptor_count;
      }
      if (session->attachment_runtime.client >= 0) {
        const auto client_events = static_cast<short>(
            (session->attachment_runtime.input_backpressured ||
                     session->attachment_runtime.client_work_pending ||
                     session->attachment_runtime.client_close_state != ConnectionCloseState::none
                 ? 0
                 : POLLIN) |
            (session->attachment_runtime.output.busy() ? static_cast<short>(POLLOUT) : 0));
        std::span(descriptors).subspan(descriptor_count, 1).front() = {
            .fd = session->attachment_runtime.client, .events = client_events, .revents = 0};
        std::span(owners).subspan(descriptor_count, 1).front() = {
            .session = session->id,
            .tab = {},
            .pane = {},
            .connection = session->attachment_runtime.connection_id,
            .auxiliary_slot = 0,
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
      std::span(owners).subspan(descriptor_count, 1).front() = {.session = {},
                                                                .tab = {},
                                                                .pane = {},
                                                                .connection = {},
                                                                .auxiliary_slot = slot,
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
          .session = {},
          .tab = {},
          .pane = {},
          .connection = {},
          .auxiliary_slot = slot,
          .kind = DescriptorKind::capacity_rejection};
      ++descriptor_count;
    }
    if (extensions != nullptr && extensions->descriptor() >= 0) {
      std::span(descriptors).subspan(descriptor_count, 1).front() = {
          .fd = extensions->descriptor(), .events = POLLIN, .revents = 0};
      std::span(owners).subspan(descriptor_count, 1).front() = {.session = {},
                                                                .tab = {},
                                                                .pane = {},
                                                                .connection = {},
                                                                .auxiliary_slot = 0,
                                                                .kind = DescriptorKind::extension};
      ++descriptor_count;
    }

    const auto poll_result = ::poll(descriptors.data(), static_cast<nfds_t>(descriptor_count),
                                    poll_timeout(sessions, runtimes, pending_connections,
                                                 capacity_rejections, extensions.get()));
    if (poll_result < 0) {
      if (errno == EINTR) {
        continue;
      }
      return 1;
    }
    expire_attached_client_frames(sessions, runtimes, std::chrono::steady_clock::now());

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
          auto* const session = sessions.get(owner.session);
          auto* const tab = session == nullptr ? nullptr : find_tab(*session, owner.tab);
          auto* const pane = tab == nullptr ? nullptr : find_pane(*session, *tab, owner.pane);
          auto* const runtime = runtimes.get({.session = owner.session, .pane = owner.pane});
          LEMMA_ASSERT(session != nullptr && tab != nullptr && pane != nullptr &&
                       runtime != nullptr);
          const auto& events = std::span(descriptors).subspan(index, 1).front();
          auto& blocked_session_budget =
              std::span(blocked_session_read_budgets).subspan(owner.session.slot(), 1).front();
          process_pane_events(*session, *tab, *pane, *runtime, runtimes, events, pty_read_budget,
                              blocked_session_budget);
        }
      }
      pty_read_cursor = (pty_read_cursor + visited) % ready_owner_count;
    } else {
      pty_read_cursor = 0;
    }
    for (auto& session : sessions) {
      if (session != nullptr && session->active) {
        reclaim_dead_panes(*session, runtimes);
        service_copy_input_timeout(*session, runtimes, std::chrono::steady_clock::now());
      }
    }
    std::array<std::size_t, static_cast<std::size_t>(limits::sessions_hard_max)>
        client_message_budgets{};
    std::array<std::size_t, static_cast<std::size_t>(limits::sessions_hard_max)>
        client_geometry_budgets{};
    std::array<std::size_t, static_cast<std::size_t>(limits::sessions_hard_max)>
        client_input_budgets{};
    client_message_budgets.fill(client_messages_per_turn_max);
    client_geometry_budgets.fill(client_geometry_messages_per_turn_max);
    client_input_budgets.fill(client_input_steps_per_turn_max);
    for (std::size_t index = 1; index < descriptor_count; ++index) {
      const auto owner = std::span(owners).subspan(index, 1).front();
      if (owner.kind == DescriptorKind::client) {
        auto* const session = sessions.get(owner.session);
        if (session == nullptr || !session->active ||
            session->attachment_runtime.connection_id != owner.connection) {
          continue;
        }
        const auto& events = std::span(descriptors).subspan(index, 1).front();
        if ((events.revents & (POLLOUT | POLLHUP | POLLERR)) != 0) {
          session->attachment_runtime.output.mark_write_ready();
        }
        auto& message_budget =
            std::span(client_message_budgets).subspan(session->id.slot(), 1).front();
        auto& geometry_budget =
            std::span(client_geometry_budgets).subspan(session->id.slot(), 1).front();
        auto& input_budget = std::span(client_input_budgets).subspan(session->id.slot(), 1).front();
        process_client_events(*session, runtimes, events, message_budget, geometry_budget,
                              input_budget, &session_name_conflict, &sessions);
      }
    }
    std::array<SessionRecord*, static_cast<std::size_t>(limits::sessions_hard_max)>
        search_sessions{};
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
        static_cast<void>(service_copy_search(*session, runtimes, search_work_budget));
      }
    }
    search_cursor = (search_cursor + visited) % search_sessions.size();
    for (std::size_t index = 1; index < descriptor_count; ++index) {
      const auto owner = std::span(owners).subspan(index, 1).front();
      if (owner.kind == DescriptorKind::pending) {
        const auto& pending =
            std::span(pending_connections).subspan(owner.auxiliary_slot, 1).front();
        if (pending == nullptr || !pending->active()) {
          continue;
        }
        const auto events = std::span(descriptors).subspan(index, 1).front().revents;
        if (pending->state != PendingState::flush_response &&
            (events & (POLLIN | POLLHUP | POLLERR)) != 0) {
          process_pending_read(pending_connections, sessions, runtimes, extensions.get(),
                               owner.auxiliary_slot);
        }
      } else if (owner.kind == DescriptorKind::capacity_rejection) {
        const auto& rejection =
            std::span(capacity_rejections).subspan(owner.auxiliary_slot, 1).front();
        const auto events = std::span(descriptors).subspan(index, 1).front().revents;
        if (rejection.active() && !rejection.flush_response &&
            (events & (POLLIN | POLLHUP | POLLERR)) != 0) {
          process_capacity_rejection_read(capacity_rejections, owner.auxiliary_slot);
        }
      }
    }

    // Writes are attempted only from retained queue bytes and are bounded both per pane and across
    // this turn. A hard descriptor error retires the pane; EAGAIN leaves all bytes queued.
    std::size_t pty_write_budget = std::size_t{1} * 1'024U * 1'024U;
    std::array<PaneWriteTarget, static_cast<std::size_t>(limits::panes_hard_max)> writable_panes{};
    std::size_t writable_pane_count = 0;
    for (auto& session : sessions) {
      if (session == nullptr || !session->active) {
        continue;
      }
      for (auto& pane_slot : session->panes) {
        if (pane_slot.pane == nullptr) {
          continue;
        }
        auto* const runtime = find_pane_runtime(runtimes, *session, *pane_slot.pane);
        LEMMA_ASSERT(runtime != nullptr);
        if (runtime->live() && !runtime->pending_writes.empty()) {
          std::span(writable_panes).subspan(writable_pane_count, 1).front() = {
              .session = session.get(), .pane = pane_slot.pane.get(), .runtime = runtime};
          ++writable_pane_count;
        }
      }
    }
    if (writable_pane_count > 0) {
      pty_flush_cursor %= writable_pane_count;
      std::size_t writable_visited = 0;
      for (; writable_visited < writable_pane_count && pty_write_budget > 0; ++writable_visited) {
        const auto index = (pty_flush_cursor + writable_visited) % writable_pane_count;
        auto& target = std::span(writable_panes).subspan(index, 1).front();
        if (!flush_pane_writes(*target.runtime, pty_write_budget)) {
          target.runtime->fail(PaneRuntimeFailure::pty_write_error);
        }
      }
      pty_flush_cursor = (pty_flush_cursor + writable_visited) % writable_pane_count;
    } else {
      pty_flush_cursor = 0;
    }
    process_interactive_followups(std::span(writable_panes).first(writable_pane_count), runtimes);
    for (auto& session : sessions) {
      if (session != nullptr && session->active) {
        reclaim_dead_panes(*session, runtimes);
      }
    }
    // Capacity may have become available without new client socket readiness.
    const pollfd no_events{.fd = -1, .events = 0, .revents = 0};
    for (auto& session : sessions) {
      if (session != nullptr && session->active && session->attachment_runtime.client >= 0 &&
          session->attachment_runtime.input_backpressured) {
        auto& message_budget =
            std::span(client_message_budgets).subspan(session->id.slot(), 1).front();
        auto& geometry_budget =
            std::span(client_geometry_budgets).subspan(session->id.slot(), 1).front();
        auto& input_budget = std::span(client_input_budgets).subspan(session->id.slot(), 1).front();
        process_client_events(*session, runtimes, no_events, message_budget, geometry_budget,
                              input_budget, &session_name_conflict, &sessions);
      }
    }

    std::size_t pending_output_budget = std::size_t{256} * 1'024U;
    bool shutdown_after_outputs = false;
    for (std::size_t index = 1; index < descriptor_count; ++index) {
      const auto owner = std::span(owners).subspan(index, 1).front();
      const auto events = std::span(descriptors).subspan(index, 1).front().revents;
      if (owner.kind == DescriptorKind::pending) {
        const auto& pending =
            std::span(pending_connections).subspan(owner.auxiliary_slot, 1).front();
        if (pending == nullptr || !pending->active() ||
            pending->state != PendingState::flush_response) {
          continue;
        }
        if ((events & (POLLOUT | POLLHUP | POLLERR)) != 0 &&
            flush_pending_output(pending_connections, owner.auxiliary_slot, pending_output_budget,
                                 sessions, runtimes)) {
          shutdown_after_outputs = true;
          break;
        }
      } else if (owner.kind == DescriptorKind::capacity_rejection) {
        const auto& rejection =
            std::span(capacity_rejections).subspan(owner.auxiliary_slot, 1).front();
        if (rejection.active() && rejection.flush_response &&
            (events & (POLLOUT | POLLHUP | POLLERR)) != 0) {
          flush_capacity_rejection_output(capacity_rejections, owner.auxiliary_slot,
                                          pending_output_budget);
        }
      }
    }

    run_due_scrollback_compression(sessions, runtimes, compression_cursor);
    release_expired_presentation_gates(sessions, runtimes);
    queue_due_frames(sessions, runtimes);
    // Attached frame writes are core-owned, daemon-wide bounded, and round-robin fair. Newly
    // composed and newly handed-off attach frames get one immediate attempt; a blocked frame is
    // retried only after poll reports write readiness or its progress deadline expires.
    flush_attached_client_frames(sessions, runtimes, client_flush_targets, client_flush_cursor,
                                 std::chrono::steady_clock::now());
    if (shutdown_after_outputs) {
      return 0;
    }
    expire_pending_connections(pending_connections, sessions);
    expire_capacity_rejections(capacity_rejections);
    reclaim_inactive_sessions(sessions, runtimes);

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
    reclaim_inactive_sessions(sessions, runtimes);
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
