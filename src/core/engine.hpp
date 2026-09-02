#ifndef LEMMA_CORE_ENGINE_HPP
#define LEMMA_CORE_ENGINE_HPP

#include <chrono>
#include <cstddef>
#include <optional>
#include <span>
#include <string_view>

#include <poll.h>

namespace lemma::input {
class CompiledInputMap;
}

namespace lemma::core {

using EndpointRelease = void (*)(void* context) noexcept;

struct ChildExit final {
  int process{-1};
  int status{0};
};

using StopRequested = bool (*)() noexcept;
using ReapChild = std::optional<ChildExit> (*)(void* context) noexcept;

struct ChildReaper final {
  int wake_descriptor{-1};
  ReapChild reap{nullptr};
  void* context{nullptr};

  [[nodiscard]] constexpr auto valid() const noexcept -> bool {
    return wake_descriptor >= 0 && reap != nullptr;
  }
};

using ReactorClock = std::chrono::steady_clock;

struct ReactorIoResult final {
  std::ptrdiff_t bytes{0};
  int error{0};
};

using ReactorPoll = int (*)(void* context, std::span<pollfd> descriptors,
                            int timeout_milliseconds) noexcept;
using ReactorNow = ReactorClock::time_point (*)(void* context) noexcept;
using ReactorSend = ReactorIoResult (*)(void* context, int descriptor,
                                        std::span<const std::byte> bytes, int flags) noexcept;

// The production environment delegates directly to poll(2), send(2), and steady_clock.
// Deterministic tests may instead provide one scripted readiness/I/O/clock authority. The
// callbacks are turn-local and must not retain borrowed spans.
struct ReactorEnvironment final {
  void* context{nullptr};
  ReactorPoll poll{nullptr};
  ReactorNow now{nullptr};
  ReactorSend send{nullptr};
  // Immutable startup configuration. Null or empty values select built-in behavior. Every borrowed
  // value must outlive run_server_with_environment and every Session created by it.
  const input::CompiledInputMap* input_map{nullptr};
  std::optional<std::size_t> scrollback_lines;
  std::span<const std::byte> default_program;
  std::string_view default_cwd;
  std::string_view command_history_file;
  bool status_line{true};

  [[nodiscard]] constexpr auto valid() const noexcept -> bool {
    return poll != nullptr && now != nullptr && send != nullptr;
  }
};

[[nodiscard]] auto production_reactor_environment() noexcept -> ReactorEnvironment;

// Runs the same production reactor with injected readiness, outbound-I/O, and monotonic-time
// sources. This is a narrow deterministic-test seam: descriptor ownership, command execution,
// inbound I/O, and all reactor state remain production code.
[[nodiscard]] auto run_server_with_environment(int listener, EndpointRelease release_endpoint,
                                               void* release_context, StopRequested stop_requested,
                                               ChildReaper child_reaper,
                                               ReactorEnvironment environment) noexcept -> int;

// Runs the authoritative bounded reactor for every session. The engine invokes release_endpoint
// exactly once after it stops using the borrowed listener; the daemon retains ownership of the
// listener and its filesystem lifecycle. Child process exits must have a pollable wake source so a
// signal observed immediately before poll cannot strand an exited child.
[[nodiscard]] auto run_server(int listener, EndpointRelease release_endpoint, void* release_context,
                              StopRequested stop_requested, ChildReaper child_reaper) noexcept
    -> int;

} // namespace lemma::core

#endif // LEMMA_CORE_ENGINE_HPP
