#ifndef LEMMA_RENDER_PANE_COMPOSITION_HPP
#define LEMMA_RENDER_PANE_COMPOSITION_HPP

#include "lemma/geometry.hpp"
#include "lemma/terminal/terminal.hpp"

#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>
#include <string_view>

namespace lemma::render {

inline constexpr std::size_t status_tabs_max = 16;

struct Viewport final {
  std::uint16_t columns{0};
  std::uint16_t rows{0};
};

using PaneRectangle = lemma::PaneRectangle;

struct PaneSurface final {
  vt::Terminal* terminal{nullptr};
  PaneRectangle rectangle{};
  std::uint16_t cursor_override_column{0};
  std::uint16_t cursor_override_row{0};
  bool focused{false};
  bool cursor_override{false};
  bool presentation_suppressed{false};
  bool border_right{false};
  bool border_bottom{false};
};

struct StatusTab final {
  std::uint16_t number{0};
  std::string_view title;
  bool active{false};
};

struct StatusLine final {
  std::string_view session_name;
  std::span<const StatusTab> tabs;
  bool dirty{false};
};

struct PaneOverlay final {
  vt::Terminal* terminal{nullptr};
  std::string_view top_right;
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

// Composes already-resolved content-area pane rectangles into one synchronized outer-terminal
// update. A visible status line occupies the top row, and pane content and separators are offset
// below it. One optional bounded overlay is projected after pane rendering, then restores the copy
// cursor. The focused surface otherwise owns cursor and terminal modes. Callers must force a full
// frame after changing pane geometry.
[[nodiscard]] auto compose_frame(std::span<const PaneSurface> panes, Viewport viewport,
                                 std::span<std::byte> output, bool force_full,
                                 StatusLine status = {}, PaneOverlay overlay = {}) noexcept
    -> std::expected<CompositionResult, CompositionError>;

} // namespace lemma::render

#endif // LEMMA_RENDER_PANE_COMPOSITION_HPP
