#ifndef LEMMA_RENDER_PANE_COMPOSITION_HPP
#define LEMMA_RENDER_PANE_COMPOSITION_HPP

#include "lemma/geometry.hpp"
#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"

#include <cstddef>
#include <cstdint>
#include <expected>
#include <optional>
#include <span>
#include <string_view>

namespace lemma::render {

inline constexpr std::size_t status_tabs_max = 16;
inline constexpr std::size_t status_context_bytes_max = limits::search_query_bytes_max + 64U;
inline constexpr std::size_t message_view_line_bytes_max = limits::status_message_bytes_max + 32U;

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

enum class StatusPromptTarget : std::uint8_t {
  none,
  session,
  active_tab,
  command_line,
  copy_search_forward,
  copy_search_backward,
  message,
};

enum class StatusPromptFeedback : std::uint8_t {
  none,
  invalid,
  conflict,
};

struct StatusLine final {
  std::string_view session_name;
  std::span<const StatusTab> tabs;
  StatusPromptTarget prompt_target{StatusPromptTarget::none};
  StatusPromptFeedback prompt_feedback{StatusPromptFeedback::none};
  std::string_view prompt_value;
  std::string_view input_context;
  std::size_t prompt_cursor{0};
  bool dirty{false};

  [[nodiscard]] constexpr auto prompting() const noexcept -> bool {
    return prompt_target != StatusPromptTarget::none &&
           prompt_target != StatusPromptTarget::message;
  }
};

struct MessageViewLine final {
  std::string_view text;
  bool error{false};
};

struct MessageView final {
  std::span<const MessageViewLine> lines;
  bool active{false};
};

enum class OuterModeProjection : std::uint8_t {
  neutral,
  button_mouse,
  any_mouse,
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
  OuterModeProjection outer_modes{OuterModeProjection::neutral};
  bool full{false};
  bool status{false};
};

enum class StatusTargetKind : std::uint8_t {
  tab,
  create_tab,
};

struct StatusTarget final {
  StatusTargetKind kind{StatusTargetKind::tab};
  std::size_t tab_position{0};

  [[nodiscard]] constexpr auto operator==(const StatusTarget&) const noexcept -> bool = default;
};

// Returns the status control owning the zero-based outer-terminal column. Session cells,
// separators, overflow markers, spacing, prompts, and modal status rows are not targets.
// The hit test and status renderer share one bounded projection.
[[nodiscard]] auto status_target_at_column(StatusLine status, Viewport viewport,
                                           std::uint16_t column) noexcept
    -> std::optional<StatusTarget>;

// Composes already-resolved content-area pane rectangles into one synchronized outer-terminal
// update. A visible status line occupies the top row, and pane content and separators are offset
// below it. The focused surface owns cursor and terminal modes unless a status prompt is active.
// Callers must force a full frame after changing pane geometry.
[[nodiscard]] auto
compose_frame(std::span<const PaneSurface> panes, Viewport viewport, std::span<std::byte> output,
              bool force_full, StatusLine status = {},
              std::optional<OuterModeProjection> previous_outer_modes = std::nullopt,
              MessageView message_view = {}) noexcept
    -> std::expected<CompositionResult, CompositionError>;

} // namespace lemma::render

#endif // LEMMA_RENDER_PANE_COMPOSITION_HPP
