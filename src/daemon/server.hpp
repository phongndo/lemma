#ifndef LEMMA_DAEMON_SERVER_HPP
#define LEMMA_DAEMON_SERVER_HPP

#include <optional>
#include <string>
#include <string_view>
#include <utility>

namespace lemma::daemon {

inline constexpr std::string_view default_session = "default";

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

[[nodiscard]] auto ensure(const RuntimeEndpoint& endpoint, std::string_view session) -> int;
[[nodiscard]] auto start(const RuntimeEndpoint& endpoint,
                         std::string_view session = default_session) -> int;
[[nodiscard]] auto list(const RuntimeEndpoint& endpoint) -> int;
[[nodiscard]] auto list(const RuntimeEndpoint& endpoint, std::string_view session) -> int;
[[nodiscard]] auto list_tabs(const RuntimeEndpoint& endpoint,
                             std::string_view session = default_session) -> int;
[[nodiscard]] auto kill(const RuntimeEndpoint& endpoint, std::string_view session = default_session)
    -> int;
[[nodiscard]] auto kill_all(const RuntimeEndpoint& endpoint) -> int;
[[nodiscard]] auto shutdown(const RuntimeEndpoint& endpoint) -> int;

} // namespace lemma::daemon

#endif // LEMMA_DAEMON_SERVER_HPP
