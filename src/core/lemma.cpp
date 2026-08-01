#include "lemma/lemma.hpp"

#include "lemma/terminal/terminal.hpp"
#include <lua.h>
#include <zstd.h>

namespace lemma {

[[nodiscard]] auto greeting() noexcept -> std::string_view { return "Hello, world!"; }

[[nodiscard]] auto ghostty_version() noexcept -> std::span<const std::uint8_t> {
  return vt::library_version();
}

[[nodiscard]] auto lua_version() noexcept -> std::string_view { return LUA_VERSION; }

[[nodiscard]] auto zstd_version() noexcept -> std::string_view { return ZSTD_versionString(); }

} // namespace lemma
