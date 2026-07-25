#ifndef FIBER_EXTENSION_HOST_HPP
#define FIBER_EXTENSION_HOST_HPP

#include <span>
#include <string>
#include <string_view>

namespace fiber::extension {

struct HostConnection final {
  int descriptor{-1};
  int process{-1};
};

// Resolves the daemon-side Lua entry point. The path is not required to exist.
[[nodiscard]] auto default_config_path() -> std::string;

// Starts one isolated Lua host. The child closes every valid descriptor in close_in_child before
// loading config_path. The parent owns the returned descriptor and process id.
[[nodiscard]] auto spawn_host(std::string_view config_path,
                              std::span<const int> close_in_child) noexcept -> HostConnection;

} // namespace fiber::extension

#endif // FIBER_EXTENSION_HOST_HPP
