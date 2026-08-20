#ifndef LEMMA_CORE_ENGINE_HPP
#define LEMMA_CORE_ENGINE_HPP

#include <optional>
#include <string_view>

namespace lemma::core {

using EndpointRelease = void (*)(void* context) noexcept;

struct ExtensionConnection final {
  int descriptor{-1};
};

struct ChildExit final {
  int process{-1};
  int status{0};
};

using ExtensionAcquire = ExtensionConnection (*)(void* context) noexcept;
using ExtensionErrorReporter = void (*)(void* context, std::string_view error) noexcept;
using StopRequested = bool (*)() noexcept;
using ReapChild = std::optional<ChildExit> (*)(void* context) noexcept;

// Runs the authoritative bounded reactor for every session. The engine invokes release_endpoint
// exactly once after it stops using the borrowed listener; the daemon retains ownership of the
// listener and its filesystem lifecycle. acquire_extension may be null; otherwise the reactor uses
// it to start and restart an isolated extension host without waiting for extension execution.
[[nodiscard]] auto
run_server(int listener, EndpointRelease release_endpoint, void* release_context,
           ExtensionAcquire acquire_extension = nullptr, void* extension_context = nullptr,
           ExtensionErrorReporter report_extension_error = nullptr,
           void* extension_error_context = nullptr, StopRequested stop_requested = nullptr,
           ReapChild reap_child = nullptr, void* reap_child_context = nullptr) noexcept -> int;

} // namespace lemma::core

#endif // LEMMA_CORE_ENGINE_HPP
