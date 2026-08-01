#ifndef LEMMA_RENDER_PANE_COMPOSITION_HPP
#define LEMMA_RENDER_PANE_COMPOSITION_HPP

#include "lemma/terminal/terminal.hpp"

#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>
#include <string_view>

namespace lemma::render {

inline constexpr std::size_t status_windows_max = 16;

struct Viewport final {
  std::uint16_t columns{0};
  std::uint16_t rows{0};
};

struct PaneRectangle final {
  std::uint16_t column{0};
  std::uint16_t row{0};
  std::uint16_t columns{0};
  std::uint16_t rows{0};

  friend constexpr auto operator==(const PaneRectangle&, const PaneRectangle&) noexcept
      -> bool = default;
};

struct PaneSurface final {
  vt::Terminal* terminal{nullptr};
  PaneRectangle rectangle{};
  bool focused{false};
  bool border_right{false};
  bool border_bottom{false};
};

struct StatusWindow final {
  std::uint16_t number{0};
  std::string_view title;
  bool active{false};
};

struct StatusLine final {
  std::span<const StatusWindow> windows;
  bool dirty{false};
};

enum class CompositionError : std::uint8_t {
  invalid_viewport,
  too_many_panes,
  invalid_pane,
  multiple_focused_panes,
  invalid_status,
  output_exhausted,
  terminal_error,
};

struct CompositionResult final {
  std::size_t bytes{0};
  std::size_t panes{0};
  std::size_t rows{0};
  bool full{false};
  bool status{false};
};

// Composes already-resolved pane rectangles into one synchronized outer-terminal update. The
// focused surface is encoded last so its cursor and terminal modes remain authoritative. Callers
// must force a full frame after changing pane geometry.
[[nodiscard]] auto compose_frame(std::span<const PaneSurface> panes, Viewport viewport,
                                 std::span<std::byte> output, bool force_full,
                                 StatusLine status = {}) noexcept
    -> std::expected<CompositionResult, CompositionError>;

} // namespace lemma::render

#endif // LEMMA_RENDER_PANE_COMPOSITION_HPP
