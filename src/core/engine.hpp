#ifndef LEMMA_CORE_ENGINE_HPP
#define LEMMA_CORE_ENGINE_HPP

#include <optional>

namespace lemma::core {

using EndpointRelease = void (*)(void* context) noexcept;

struct ChildExit final {
  int process{-1};
  int status{0};
};

using StopRequested = bool (*)() noexcept;
using ReapChild = std::optional<ChildExit> (*)(void* context) noexcept;

// Runs the authoritative bounded reactor for every session. The engine invokes release_endpoint
// exactly once after it stops using the borrowed listener; the daemon retains ownership of the
// listener and its filesystem lifecycle.
[[nodiscard]] auto run_server(int listener, EndpointRelease release_endpoint, void* release_context,
                              StopRequested stop_requested = nullptr,
                              ReapChild reap_child = nullptr,
                              void* reap_child_context = nullptr) noexcept -> int;

} // namespace lemma::core

#endif // LEMMA_CORE_ENGINE_HPP
