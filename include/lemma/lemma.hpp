#ifndef LEMMA_LEMMA_HPP
#define LEMMA_LEMMA_HPP

#include <cstdint>
#include <span>
#include <string_view>

namespace lemma {

[[nodiscard]] auto greeting() noexcept -> std::string_view;
[[nodiscard]] auto ghostty_version() noexcept -> std::span<const std::uint8_t>;
[[nodiscard]] auto zstd_version() noexcept -> std::string_view;

} // namespace lemma

#endif // LEMMA_LEMMA_HPP
