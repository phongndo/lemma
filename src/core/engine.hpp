#ifndef LEMMA_CORE_ENGINE_HPP
#define LEMMA_CORE_ENGINE_HPP

#include <string_view>

namespace lemma::core {

using EndpointRelease = void (*)(void* context) noexcept;

struct ExtensionConnection final {
  int descriptor{-1};
};

using ExtensionAcquire = ExtensionConnection (*)(void* context) noexcept;
using ExtensionErrorReporter = void (*)(void* context, std::string_view error) noexcept;
using StopRequested = bool (*)() noexcept;

// Runs the authoritative bounded reactor for every workspace. The engine invokes release_endpoint
// exactly once after it stops using the borrowed listener; the daemon retains ownership of the
// listener and its filesystem lifecycle. acquire_extension may be null; otherwise the reactor uses
// it to start and restart an isolated extension host without waiting for extension execution.
[[nodiscard]] auto run_server(int listener, EndpointRelease release_endpoint, void* release_context,
                              ExtensionAcquire acquire_extension = nullptr,
                              void* extension_context = nullptr,
                              ExtensionErrorReporter report_extension_error = nullptr,
                              void* extension_error_context = nullptr,
                              StopRequested stop_requested = nullptr) noexcept -> int;

} // namespace lemma::core

#endif // LEMMA_CORE_ENGINE_HPP
