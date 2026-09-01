#ifndef LEMMA_EXTENSION_LUA_HOST_HPP
#define LEMMA_EXTENSION_LUA_HOST_HPP

#include "config/config.hpp"

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

namespace lemma::extension {

enum class ConfigurationStatus : std::uint8_t {
  absent,
  loaded,
  invalid,
};

class HostProcess final {
public:
  HostProcess() noexcept = default;
  HostProcess(const HostProcess&) = delete;
  auto operator=(const HostProcess&) -> HostProcess& = delete;
  HostProcess(HostProcess&& other) noexcept;
  auto operator=(HostProcess&& other) noexcept -> HostProcess&;
  ~HostProcess();

  [[nodiscard]] auto active() const noexcept -> bool { return descriptor_ >= 0 && process_ > 0; }

  // Process creation is internal to the extension runtime; this value constructor only transfers
  // already-created descriptor and process ownership.
  HostProcess(int descriptor, int process) noexcept : descriptor_(descriptor), process_(process) {}

private:
  void reset() noexcept;

  int descriptor_{-1};
  int process_{-1};
};

struct ConfigurationLoad final {
  HostProcess host;
  std::unique_ptr<const config::Generation> generation;
  std::string path;
  std::string diagnostic;
  ConfigurationStatus status{ConfigurationStatus::absent};
};

// An omitted path discovers $XDG_CONFIG_HOME/lemma/init.lua (or ~/.config/lemma/init.lua).
// A discovered missing file is not an error; an explicit missing path is.
[[nodiscard]] auto load_configuration(std::optional<std::string_view> path = std::nullopt) noexcept
    -> ConfigurationLoad;

} // namespace lemma::extension

#endif // LEMMA_EXTENSION_LUA_HOST_HPP
