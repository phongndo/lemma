#ifndef LEMMA_GEOMETRY_HPP
#define LEMMA_GEOMETRY_HPP

#include <cstdint>

namespace lemma {

struct PaneRectangle final {
  std::uint16_t column{0};
  std::uint16_t row{0};
  std::uint16_t columns{0};
  std::uint16_t rows{0};

  friend constexpr auto operator==(const PaneRectangle&, const PaneRectangle&) noexcept
      -> bool = default;
};

} // namespace lemma

#endif // LEMMA_GEOMETRY_HPP
