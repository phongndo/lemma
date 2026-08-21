#ifndef LEMMA_DAEMON_SERVER_HPP
#define LEMMA_DAEMON_SERVER_HPP

#include "api/action.hpp"
#include "lemma/id.hpp"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>

namespace lemma::daemon {

// Immutable process runtime routing. Socket naming policy stays in the daemon boundary; callers
// may only construct a validated absolute endpoint and pass it through component APIs.
class RuntimeEndpoint final {
public:
  [[nodiscard]] static auto create(std::string_view socket_path) -> std::optional<RuntimeEndpoint>;
  [[nodiscard]] auto socket_path() const noexcept -> std::string_view { return socket_path_; }
  [[nodiscard]] auto socket_path_storage() const noexcept -> const std::string& {
    return socket_path_;
  }

private:
  explicit RuntimeEndpoint(std::string socket_path) : socket_path_(std::move(socket_path)) {}

  std::string socket_path_;
};

using StopRequested = bool (*)() noexcept;

struct ServeOptions final {
  bool extensions_enabled{true};
  // Foreground/test owners may request a normal reactor unwind after waking its poll.
  StopRequested stop_requested{nullptr};
};

[[nodiscard]] auto default_runtime_endpoint() -> RuntimeEndpoint;
[[nodiscard]] auto validate_session(std::string_view session) noexcept -> bool;

// Runs the production listener/core path in the calling process. The endpoint is owned until the
// core reactor exits. Tests use this entry point with extensions disabled.
[[nodiscard]] auto serve(const RuntimeEndpoint& endpoint, ServeOptions options = {}) noexcept
    -> int;

// Connects to the selected daemon. Ownership of the returned descriptor transfers to the caller;
// -1 means the daemon is unavailable.
[[nodiscard]] auto open_server_connection(const RuntimeEndpoint& endpoint) -> int;
// Encodes one concrete Action onto the public lock-step control connection and prints its JSON
// result. start_daemon is valid only for session.start bootstrap.
[[nodiscard]] auto run_action(const RuntimeEndpoint& endpoint, const api::Action& action,
                              bool start_daemon = false) -> int;
[[nodiscard]] auto run_proc(const RuntimeEndpoint& endpoint, std::string_view document) -> int;

struct LaunchOptions final {
  std::string_view working_directory;
  std::span<const std::string_view> command;
  bool hold{false};
};

enum class OperationStatus : std::uint8_t {
  applied,
  no_effect,
  missing,
  conflict,
  capacity,
  unavailable,
  timeout,
  unexpected_exit,
  failed,
};

struct SurfaceResult final {
  OperationStatus status{OperationStatus::failed};
  std::string session;
  TabId tab;
  PaneId pane;

  [[nodiscard]] auto succeeded() const noexcept -> bool {
    return status == OperationStatus::applied;
  }
};

enum class SurfaceCreateKind : std::uint8_t {
  tab,
  split_right,
  split_down,
};

struct SurfaceOptions final {
  std::string_view working_directory;
  std::span<const std::string_view> command;
  std::string_view title;
  bool hold{false};
};

enum class SemanticAction : std::uint8_t {
  tab_select,
  tab_move,
  tab_kill,
  pane_focus,
  pane_swap,
  pane_resize_left,
  pane_resize_right,
  pane_resize_up,
  pane_resize_down,
  pane_zoom_on,
  pane_zoom_off,
  pane_kill,
  session_kill,
};

struct ActionTarget final {
  TabId tab;
  PaneId pane;
  PaneId peer_pane;
  std::uint16_t tab_position{0};
  std::uint16_t value{0};
};

enum class ProcessState : std::uint8_t {
  running,
  exited_unknown,
  exited,
  signaled,
};

enum class QueryKind : std::uint8_t {
  sessions,
  session,
  tabs,
  panes,
};

struct TextResult final {
  OperationStatus status{OperationStatus::failed};
  std::string text;
};

struct PaneStatus final {
  OperationStatus status{OperationStatus::failed};
  ProcessState process{ProcessState::running};
  std::uint32_t value{0};
};

enum class ProcessExpectationKind : std::uint8_t {
  any,
  exit_code,
  signal,
};

struct ProcessExpectation final {
  ProcessExpectationKind kind{ProcessExpectationKind::any};
  std::uint32_t value{0};
};

struct PaneWaitOptions final {
  std::string_view contains;
  std::optional<ProcessExpectation> process;
  std::chrono::milliseconds timeout{30'000};
};

struct PaneWaitResult final {
  OperationStatus status{OperationStatus::failed};
  std::optional<PaneStatus> process;
};

// Creates one new Session and returns its assigned name. An empty optional name requests the
// daemon's bounded numeric allocator. Creation is strict: an explicit duplicate is a conflict.
[[nodiscard]] auto create_detailed(const RuntimeEndpoint& endpoint,
                                   std::optional<std::string_view> session,
                                   LaunchOptions options = {}) -> SurfaceResult;
[[nodiscard]] auto create(const RuntimeEndpoint& endpoint, std::optional<std::string_view> session,
                          LaunchOptions options = {}) -> std::optional<std::string>;
[[nodiscard]] auto start(const RuntimeEndpoint& endpoint,
                         std::optional<std::string_view> session = std::nullopt,
                         LaunchOptions options = {}) -> int;
[[nodiscard]] auto query(const RuntimeEndpoint& endpoint, QueryKind kind,
                         std::string_view session = {}) -> TextResult;
[[nodiscard]] auto list(const RuntimeEndpoint& endpoint) -> int;
[[nodiscard]] auto list(const RuntimeEndpoint& endpoint, std::string_view session) -> int;
[[nodiscard]] auto list_tabs(const RuntimeEndpoint& endpoint, std::string_view session) -> int;
[[nodiscard]] auto list_panes(const RuntimeEndpoint& endpoint, std::string_view session) -> int;
[[nodiscard]] auto create_surface(const RuntimeEndpoint& endpoint, std::string_view session,
                                  SurfaceCreateKind kind, PaneId target,
                                  SurfaceOptions options = {}) -> SurfaceResult;
[[nodiscard]] auto perform_action(const RuntimeEndpoint& endpoint, std::string_view session,
                                  SemanticAction action, ActionTarget target) -> OperationStatus;
[[nodiscard]] auto send_pane(const RuntimeEndpoint& endpoint, std::string_view session, PaneId pane,
                             std::string_view text) -> OperationStatus;
[[nodiscard]] auto capture_pane(const RuntimeEndpoint& endpoint, std::string_view session,
                                PaneId pane) -> std::pair<OperationStatus, std::string>;
[[nodiscard]] auto pane_status(const RuntimeEndpoint& endpoint, std::string_view session,
                               PaneId pane) -> PaneStatus;
[[nodiscard]] auto wait_pane(const RuntimeEndpoint& endpoint, std::string_view session, PaneId pane,
                             PaneWaitOptions options) -> PaneWaitResult;
// Streams NDJSON observations until the daemon closes the subscription or the output fails.
[[nodiscard]] auto events(const RuntimeEndpoint& endpoint, std::optional<std::string_view> session,
                          std::optional<PaneId> pane, bool screen) -> int;
[[nodiscard]] auto rename_session_status(const RuntimeEndpoint& endpoint, std::string_view session,
                                         std::string_view new_name) -> OperationStatus;
[[nodiscard]] auto rename_session(const RuntimeEndpoint& endpoint, std::string_view session,
                                  std::string_view new_name) -> int;
[[nodiscard]] auto rename_tab_status(const RuntimeEndpoint& endpoint, std::string_view session,
                                     std::size_t one_based_position, std::string_view title)
    -> OperationStatus;
[[nodiscard]] auto rename_tab(const RuntimeEndpoint& endpoint, std::string_view session,
                              std::size_t one_based_position, std::string_view title) -> int;
[[nodiscard]] auto kill(const RuntimeEndpoint& endpoint, std::string_view session) -> int;
[[nodiscard]] auto kill_all(const RuntimeEndpoint& endpoint) -> int;
[[nodiscard]] auto shutdown(const RuntimeEndpoint& endpoint) -> int;

} // namespace lemma::daemon

#endif // LEMMA_DAEMON_SERVER_HPP
