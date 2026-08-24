#include "lemma/lemma.hpp"

#include "lemma/terminal/terminal.hpp"

#include <cstdint>
#include <span>
#include <string_view>

#include <zstd.h>

namespace lemma {

[[nodiscard]] auto greeting() noexcept -> std::string_view { return "Hello, world!"; }

[[nodiscard]] auto ghostty_version() noexcept -> std::span<const std::uint8_t> {
  return vt::library_version();
}

[[nodiscard]] auto zstd_version() noexcept -> std::string_view { return ZSTD_versionString(); }

} // namespace lemma
