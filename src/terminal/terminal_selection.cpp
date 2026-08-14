#include "terminal/terminal_impl.hpp"

#include "lemma/assert.hpp"
#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <limits>
#include <optional>
#include <span>
#include <string_view>

namespace lemma::vt {
namespace {

[[nodiscard]] auto formatter_format(const ScreenFormat format) noexcept -> GhosttyFormatterFormat {
  switch (format) {
  case ScreenFormat::plain:
    return GHOSTTY_FORMATTER_FORMAT_PLAIN;
  case ScreenFormat::vt:
  case ScreenFormat::vt_full:
    return GHOSTTY_FORMATTER_FORMAT_VT;
  }
  return GHOSTTY_FORMATTER_FORMAT_PLAIN;
}

[[nodiscard]] constexpr auto point_tag(const PointSpace space) noexcept -> GhosttyPointTag {
  switch (space) {
  case PointSpace::active:
    return GHOSTTY_POINT_TAG_ACTIVE;
  case PointSpace::viewport:
    return GHOSTTY_POINT_TAG_VIEWPORT;
  case PointSpace::screen:
    return GHOSTTY_POINT_TAG_SCREEN;
  case PointSpace::history:
    return GHOSTTY_POINT_TAG_HISTORY;
  }
  return GHOSTTY_POINT_TAG_VIEWPORT;
}

[[nodiscard]] constexpr auto ghostty_point(const TerminalPoint point) noexcept -> GhosttyPoint {
  return {
      .tag = point_tag(point.space),
      .value = {.coordinate = {.x = point.column, .y = point.row}},
  };
}

[[nodiscard]] auto grid_ref(const GhosttyTerminal terminal, const TerminalPoint point) noexcept
    -> std::expected<GhosttyGridRef, Error> {
  GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  const auto result = ghostty_terminal_grid_ref(terminal, ghostty_point(point), &ref);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  return ref;
}

[[nodiscard]] auto active_selection(const GhosttyTerminal terminal) noexcept
    -> std::expected<std::optional<GhosttySelection>, Error> {
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  const auto result = ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_SELECTION, &selection);
  if (result == GHOSTTY_NO_VALUE) {
    return std::optional<GhosttySelection>{};
  }
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  return std::optional<GhosttySelection>{selection};
}

[[nodiscard]] auto install_selection(const GhosttyTerminal terminal,
                                     const GhosttySelection& selection) noexcept
    -> std::expected<void, Error> {
  const auto result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_SELECTION, &selection);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  return {};
}

[[nodiscard]] auto selection_adjustment(const SelectionAdjustment adjustment) noexcept
    -> std::optional<GhosttySelectionAdjust> {
  switch (adjustment) {
  case SelectionAdjustment::left:
    return GHOSTTY_SELECTION_ADJUST_LEFT;
  case SelectionAdjustment::right:
    return GHOSTTY_SELECTION_ADJUST_RIGHT;
  case SelectionAdjustment::up:
    return GHOSTTY_SELECTION_ADJUST_UP;
  case SelectionAdjustment::down:
    return GHOSTTY_SELECTION_ADJUST_DOWN;
  case SelectionAdjustment::home:
    return GHOSTTY_SELECTION_ADJUST_HOME;
  case SelectionAdjustment::end:
    return GHOSTTY_SELECTION_ADJUST_END;
  case SelectionAdjustment::page_up:
    return GHOSTTY_SELECTION_ADJUST_PAGE_UP;
  case SelectionAdjustment::page_down:
    return GHOSTTY_SELECTION_ADJUST_PAGE_DOWN;
  case SelectionAdjustment::beginning_of_line:
    return GHOSTTY_SELECTION_ADJUST_BEGINNING_OF_LINE;
  case SelectionAdjustment::end_of_line:
    return GHOSTTY_SELECTION_ADJUST_END_OF_LINE;
  case SelectionAdjustment::word_left:
  case SelectionAdjustment::word_right:
    return std::nullopt;
  }
  return std::nullopt;
}

[[nodiscard]] auto total_rows(const GhosttyTerminal terminal) noexcept
    -> std::expected<std::size_t, Error> {
  std::size_t rows = 0;
  const auto result = ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_TOTAL_ROWS, &rows);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  return rows;
}

[[nodiscard]] auto point_from_ref(const GhosttyTerminal terminal, const GhosttyGridRef& ref,
                                  const PointSpace space) noexcept
    -> std::expected<TerminalPoint, Error> {
  GhosttyPointCoordinate coordinate{};
  const auto result =
      ghostty_terminal_point_from_grid_ref(terminal, &ref, point_tag(space), &coordinate);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  return TerminalPoint{.space = space, .column = coordinate.x, .row = coordinate.y};
}

[[nodiscard]] auto word_candidate(const GhosttyGridRef& ref) noexcept
    -> std::expected<bool, Error> {
  GhosttyCell cell = 0;
  auto result = ghostty_grid_ref_cell(&ref, &cell);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  bool has_text = false;
  std::uint32_t codepoint = 0;
  const std::array keys{GHOSTTY_CELL_DATA_HAS_TEXT, GHOSTTY_CELL_DATA_CODEPOINT};
  std::array<void*, keys.size()> values{&has_text, &codepoint};
  std::size_t written = 0;
  result = ghostty_cell_get_multi(cell, keys.size(), keys.data(), values.data(), &written);
  if (result != GHOSTTY_SUCCESS || written != keys.size()) {
    return std::unexpected(detail::map_error(result));
  }
  const bool whitespace = codepoint == static_cast<std::uint32_t>(' ') ||
                          codepoint == static_cast<std::uint32_t>('\t') ||
                          codepoint == static_cast<std::uint32_t>('\r') ||
                          codepoint == static_cast<std::uint32_t>('\n');
  return has_text && !whitespace;
}

[[nodiscard]] auto select_word_at(const GhosttyTerminal terminal,
                                  const GhosttyGridRef& ref) noexcept
    -> std::expected<std::optional<GhosttySelection>, Error> {
  const auto selectable = word_candidate(ref);
  if (!selectable.has_value()) {
    return std::unexpected(selectable.error());
  }
  if (!*selectable) {
    return std::optional<GhosttySelection>{};
  }
  GhosttyTerminalSelectWordOptions options = GHOSTTY_INIT_SIZED(GhosttyTerminalSelectWordOptions);
  options.ref = ref;
  GhosttySelection word = GHOSTTY_INIT_SIZED(GhosttySelection);
  const auto result = ghostty_terminal_select_word(terminal, &options, &word);
  if (result == GHOSTTY_NO_VALUE) {
    return std::optional<GhosttySelection>{};
  }
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  return std::optional<GhosttySelection>{word};
}

[[nodiscard]] auto
install_selection_endpoint(const GhosttyTerminal terminal, GhosttySelection& selection,
                           const GhosttyGridRef& endpoint, const bool extend) noexcept
    -> std::expected<bool, Error> {
  selection.end = endpoint;
  if (!extend) {
    selection.start = endpoint;
  }
  const auto installed = install_selection(terminal, selection);
  if (!installed.has_value()) {
    return std::unexpected(installed.error());
  }
  return true;
}

// Word movement validates tracked endpoint state, directional boundaries, and Ghostty outcomes.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto select_word_from_endpoint(const GhosttyTerminal terminal,
                                             GhosttySelection& selection,
                                             const std::uint16_t columns, const bool forward,
                                             const bool extend) noexcept
    -> std::expected<bool, Error> {
  const auto endpoint = point_from_ref(terminal, selection.end, PointSpace::screen);
  if (!endpoint.has_value()) {
    return std::unexpected(endpoint.error());
  }
  const auto rows = total_rows(terminal);
  if (!rows.has_value()) {
    return std::unexpected(rows.error());
  }
  if (*rows == 0) {
    return false;
  }

  const auto current_result = select_word_at(terminal, selection.end);
  if (!current_result.has_value()) {
    return std::unexpected(current_result.error());
  }
  const auto current_optional = current_result.value_or(std::optional<GhosttySelection>{});
  const auto current_word = current_optional.value_or(GHOSTTY_INIT_SIZED(GhosttySelection));
  std::optional<TerminalPoint> current_start;
  if (current_optional.has_value()) {
    const auto start = point_from_ref(terminal, current_word.start, PointSpace::screen);
    if (!start.has_value()) {
      return std::unexpected(start.error());
    }
    current_start = *start;
    if (!forward && *endpoint != *start) {
      return install_selection_endpoint(terminal, selection, current_word.start, extend);
    }
  }

  auto candidate = *endpoint;
  const auto advance = [columns, total_row_count = *rows, forward](TerminalPoint& point) noexcept {
    if (forward) {
      if (point.column + 1U < columns) {
        ++point.column;
        return true;
      }
      if (static_cast<std::size_t>(point.row) + 1U >= total_row_count) {
        return false;
      }
      point.column = 0;
      ++point.row;
      return true;
    }
    if (point.column > 0) {
      --point.column;
      return true;
    }
    if (point.row == 0) {
      return false;
    }
    point.column = static_cast<std::uint16_t>(columns - 1U);
    --point.row;
    return true;
  };
  if (!advance(candidate)) {
    return false;
  }

  for (std::size_t inspected = 0; inspected < limits::search_candidates_per_step; ++inspected) {
    const auto candidate_ref = grid_ref(terminal, candidate);
    if (!candidate_ref.has_value()) {
      return std::unexpected(candidate_ref.error());
    }
    const auto word_result = select_word_at(terminal, *candidate_ref);
    if (!word_result.has_value()) {
      return std::unexpected(word_result.error());
    }
    const auto word_optional = word_result.value_or(std::optional<GhosttySelection>{});
    if (word_optional.has_value()) {
      const auto word = word_optional.value_or(GHOSTTY_INIT_SIZED(GhosttySelection));
      const auto start = point_from_ref(terminal, word.start, PointSpace::screen);
      if (!start.has_value()) {
        return std::unexpected(start.error());
      }
      if (!current_start.has_value() || *start != *current_start) {
        return install_selection_endpoint(terminal, selection, word.start, extend);
      }
    }
    // A navigation key remains bounded, but installs its progress so another key can continue
    // across a blank run instead of restarting from the same endpoint forever.
    if (inspected + 1U == limits::search_candidates_per_step) {
      return install_selection_endpoint(terminal, selection, *candidate_ref, extend);
    }
    if (!advance(candidate)) {
      return false;
    }
  }
  return false;
}

[[nodiscard]] constexpr auto gesture_event_index(const SelectionGesturePhase phase) noexcept
    -> std::size_t {
  switch (phase) {
  case SelectionGesturePhase::press:
    return 0;
  case SelectionGesturePhase::drag:
    return 1;
  case SelectionGesturePhase::release:
    return 2;
  case SelectionGesturePhase::autoscroll_tick:
    return 3;
  case SelectionGesturePhase::deep_press:
    return 4;
  }
  return 0;
}

[[nodiscard]] auto set_gesture_option(const GhosttySelectionGestureEvent event,
                                      const GhosttySelectionGestureEventOption option,
                                      const void* value) noexcept -> std::expected<void, Error> {
  const auto result = ghostty_selection_gesture_event_set(event, option, value);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  return {};
}

[[nodiscard]] auto gesture_autoscroll(const GhosttySelectionGestureAutoscroll value) noexcept
    -> std::expected<SelectionAutoscroll, Error> {
  switch (value) {
  case GHOSTTY_SELECTION_GESTURE_AUTOSCROLL_NONE:
    return SelectionAutoscroll::none;
  case GHOSTTY_SELECTION_GESTURE_AUTOSCROLL_UP:
    return SelectionAutoscroll::up;
  case GHOSTTY_SELECTION_GESTURE_AUTOSCROLL_DOWN:
    return SelectionAutoscroll::down;
  case GHOSTTY_SELECTION_GESTURE_AUTOSCROLL_MAX_VALUE:
    return std::unexpected(Error::invalid_state);
  }
  return std::unexpected(Error::invalid_state);
}

[[nodiscard]] constexpr auto ascii_fold(const std::uint8_t value) noexcept -> std::uint8_t {
  return value >= static_cast<std::uint8_t>('A') && value <= static_cast<std::uint8_t>('Z')
             ? static_cast<std::uint8_t>(value + ('a' - 'A'))
             : value;
}

struct SearchTextCursor final {
  TerminalPoint point{.space = PointSpace::screen};
  std::array<std::uint8_t, pane_ansi_grapheme_bytes_max> grapheme{};
  std::size_t grapheme_size{0};
};

[[nodiscard]] auto append_utf8(const std::uint32_t codepoint,
                               const std::span<std::uint8_t> output) noexcept
    -> std::optional<std::size_t> {
  if (codepoint <= 0x7FU && !output.empty()) {
    output.front() = static_cast<std::uint8_t>(codepoint);
    return 1;
  }
  if (codepoint <= 0x7FFU && output.size() >= 2) {
    output.subspan(0, 1).front() = static_cast<std::uint8_t>(0xC0U | (codepoint >> 6U));
    output.subspan(1, 1).front() = static_cast<std::uint8_t>(0x80U | (codepoint & 0x3FU));
    return 2;
  }
  if (codepoint <= 0xFFFFU && output.size() >= 3) {
    output.subspan(0, 1).front() = static_cast<std::uint8_t>(0xE0U | (codepoint >> 12U));
    output.subspan(1, 1).front() = static_cast<std::uint8_t>(0x80U | ((codepoint >> 6U) & 0x3FU));
    output.subspan(2, 1).front() = static_cast<std::uint8_t>(0x80U | (codepoint & 0x3FU));
    return 3;
  }
  if (codepoint <= 0x10FFFFU && output.size() >= 4) {
    output.subspan(0, 1).front() = static_cast<std::uint8_t>(0xF0U | (codepoint >> 18U));
    output.subspan(1, 1).front() = static_cast<std::uint8_t>(0x80U | ((codepoint >> 12U) & 0x3FU));
    output.subspan(2, 1).front() = static_cast<std::uint8_t>(0x80U | ((codepoint >> 6U) & 0x3FU));
    output.subspan(3, 1).front() = static_cast<std::uint8_t>(0x80U | (codepoint & 0x3FU));
    return 4;
  }
  return std::nullopt;
}

[[nodiscard]] auto load_grapheme(const GhosttyTerminal terminal, SearchTextCursor& cursor) noexcept
    -> std::expected<void, Error> {
  const auto ref = grid_ref(terminal, cursor.point);
  if (!ref.has_value()) {
    return std::unexpected(ref.error());
  }
  constexpr std::size_t codepoints_max = pane_ansi_grapheme_bytes_max / 4U;
  std::array<std::uint32_t, codepoints_max> codepoints{};
  std::size_t codepoint_count = 0;
  const auto result =
      ghostty_grid_ref_graphemes(&*ref, codepoints.data(), codepoints.size(), &codepoint_count);
  if (result == GHOSTTY_OUT_OF_SPACE) {
    return std::unexpected(Error::limit_exceeded);
  }
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }

  cursor.grapheme_size = 0;
  for (const auto codepoint : std::span(codepoints).first(codepoint_count)) {
    const auto encoded =
        append_utf8(codepoint, std::span(cursor.grapheme).subspan(cursor.grapheme_size));
    if (!encoded.has_value()) {
      return std::unexpected(Error::limit_exceeded);
    }
    cursor.grapheme_size += *encoded;
  }
  return {};
}

[[nodiscard]] auto advance_search_candidate(TerminalPoint& point, const SearchDirection direction,
                                            const std::size_t rows,
                                            const std::uint16_t columns) noexcept -> bool {
  if (direction == SearchDirection::forward) {
    if (point.column + 1U < columns) {
      ++point.column;
      return true;
    }
    if (static_cast<std::size_t>(point.row) + 1U >= rows) {
      return false;
    }
    point.column = 0;
    ++point.row;
    return true;
  }
  if (point.column > 0) {
    --point.column;
    return true;
  }
  if (point.row == 0) {
    return false;
  }
  point.column = static_cast<std::uint16_t>(columns - 1U);
  --point.row;
  return true;
}

} // namespace

auto Terminal::format_screen(const ScreenFormat format, const std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  GhosttyFormatterTerminalOptions options{};
  options.size = sizeof(options);
  options.emit = formatter_format(format);
  options.trim = format != ScreenFormat::vt_full;
  options.extra.size = sizeof(options.extra);
  options.extra.screen.size = sizeof(options.extra.screen);
  const bool styled = format != ScreenFormat::plain;
  options.extra.screen.cursor = styled;
  options.extra.screen.style = styled;
  options.extra.screen.hyperlink = styled;

  GhosttyFormatter formatter = nullptr;
  auto result = ghostty_formatter_terminal_new(impl_->allocator.native(), &formatter,
                                               impl_->terminal, options);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }

  // std::byte and uint8_t are both byte views; Ghostty's C ABI uses the latter.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  auto* output_data = reinterpret_cast<std::uint8_t*>(output.data());
  std::size_t bytes_written = 0;
  result = ghostty_formatter_format_buf(formatter, output_data, output.size(), &bytes_written);
  ghostty_formatter_free(formatter);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  LEMMA_ASSERT(bytes_written <= output.size());
  return bytes_written;
}

// Event phases have intentionally distinct Ghostty option contracts.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto Terminal::selection_gesture(const SelectionGestureEvent& event) noexcept
    -> std::expected<SelectionGestureResult, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  if (event.cell_width == 0 || event.screen_height == 0 ||
      ((!event.has_point) && (event.phase == SelectionGesturePhase::press ||
                              event.phase == SelectionGesturePhase::drag)) ||
      (event.phase == SelectionGesturePhase::autoscroll_tick &&
       event.point.space != PointSpace::viewport)) {
    return std::unexpected(Error::invalid_options);
  }

  if (impl_->selection_gesture == nullptr) {
    const auto result =
        ghostty_selection_gesture_new(impl_->allocator.native(), &impl_->selection_gesture);
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(detail::map_error(result));
    }
  }
  constexpr std::array event_types{
      GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_PRESS,
      GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_DRAG,
      GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_RELEASE,
      GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_AUTOSCROLL_TICK,
      GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_DEEP_PRESS,
  };
  for (std::size_t index = 0; index < event_types.size(); ++index) {
    auto& native_event = std::span(impl_->selection_events).subspan(index, 1).front();
    if (native_event != nullptr) {
      continue;
    }
    const auto result = ghostty_selection_gesture_event_new(
        impl_->allocator.native(), &native_event, std::span(event_types).subspan(index, 1).front());
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(detail::map_error(result));
    }
  }

  auto* const native_event =
      std::span(impl_->selection_events).subspan(gesture_event_index(event.phase), 1).front();
  GhosttySelectionGestureGeometry geometry{
      .columns = impl_->options.size.columns,
      .cell_width = event.cell_width,
      .padding_left = event.padding_left,
      .screen_height = event.screen_height,
  };
  GhosttySurfacePosition position{
      .x = event.pointer_x,
      .y = event.pointer_y,
  };
  const auto ref = event.has_point && event.phase != SelectionGesturePhase::autoscroll_tick &&
                           event.phase != SelectionGesturePhase::deep_press
                       ? grid_ref(impl_->terminal, event.point)
                       : std::expected<GhosttyGridRef, Error>{GHOSTTY_INIT_SIZED(GhosttyGridRef)};
  if (!ref.has_value()) {
    return std::unexpected(ref.error());
  }

  auto configured = std::expected<void, Error>{};
  switch (event.phase) {
  case SelectionGesturePhase::press:
    configured = set_gesture_option(native_event, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF, &*ref);
    if (configured.has_value()) {
      configured = set_gesture_option(
          native_event, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_POSITION,
          event.has_pointer_position ? static_cast<const void*>(&position) : nullptr);
    }
    if (configured.has_value()) {
      configured = set_gesture_option(native_event, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_TIME_NS,
                                      event.time_ns != 0 ? static_cast<const void*>(&event.time_ns)
                                                         : nullptr);
    }
    if (configured.has_value()) {
      configured = set_gesture_option(
          native_event, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REPEAT_INTERVAL_NS,
          event.repeat_interval_ns != 0 ? static_cast<const void*>(&event.repeat_interval_ns)
                                        : nullptr);
    }
    if (configured.has_value()) {
      configured = set_gesture_option(
          native_event, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REPEAT_DISTANCE,
          event.repeat_distance > 0 ? static_cast<const void*>(&event.repeat_distance) : nullptr);
    }
    break;
  case SelectionGesturePhase::drag:
    configured = set_gesture_option(native_event, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF, &*ref);
    if (configured.has_value()) {
      configured =
          set_gesture_option(native_event, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_GEOMETRY, &geometry);
    }
    if (configured.has_value()) {
      configured = set_gesture_option(
          native_event, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_POSITION,
          event.has_pointer_position ? static_cast<const void*>(&position) : nullptr);
    }
    if (configured.has_value()) {
      configured = set_gesture_option(native_event, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_RECTANGLE,
                                      &event.rectangle);
    }
    break;
  case SelectionGesturePhase::release:
    configured = set_gesture_option(native_event, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF,
                                    event.has_point ? static_cast<const void*>(&*ref) : nullptr);
    break;
  case SelectionGesturePhase::autoscroll_tick: {
    const GhosttyPointCoordinate viewport{.x = event.point.column, .y = event.point.row};
    configured =
        set_gesture_option(native_event, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_VIEWPORT, &viewport);
    if (configured.has_value()) {
      configured =
          set_gesture_option(native_event, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_GEOMETRY, &geometry);
    }
    if (configured.has_value()) {
      configured = set_gesture_option(
          native_event, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_POSITION,
          event.has_pointer_position ? static_cast<const void*>(&position) : nullptr);
    }
    if (configured.has_value()) {
      configured = set_gesture_option(native_event, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_RECTANGLE,
                                      &event.rectangle);
    }
    break;
  }
  case SelectionGesturePhase::deep_press:
    break;
  }
  if (!configured.has_value()) {
    return std::unexpected(configured.error());
  }

  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  const auto result = ghostty_selection_gesture_event(impl_->selection_gesture, impl_->terminal,
                                                      native_event, &selection);
  bool selection_changed = false;
  if (result == GHOSTTY_SUCCESS) {
    const auto installed = install_selection(impl_->terminal, selection);
    if (!installed.has_value()) {
      return std::unexpected(installed.error());
    }
    selection_changed = true;
  } else if (result != GHOSTTY_NO_VALUE) {
    return std::unexpected(detail::map_error(result));
  }

  bool dragged = false;
  GhosttySelectionGestureAutoscroll autoscroll = GHOSTTY_SELECTION_GESTURE_AUTOSCROLL_NONE;
  const std::array keys{GHOSTTY_SELECTION_GESTURE_DATA_DRAGGED,
                        GHOSTTY_SELECTION_GESTURE_DATA_AUTOSCROLL};
  std::array<void*, keys.size()> values{&dragged, &autoscroll};
  std::size_t written = 0;
  const auto state_result = ghostty_selection_gesture_get_multi(
      impl_->selection_gesture, impl_->terminal, keys.size(), keys.data(), values.data(), &written);
  if (state_result != GHOSTTY_SUCCESS || written != keys.size()) {
    return std::unexpected(detail::map_error(state_result));
  }
  const auto mapped_autoscroll = gesture_autoscroll(autoscroll);
  if (!mapped_autoscroll.has_value()) {
    return std::unexpected(mapped_autoscroll.error());
  }
  return SelectionGestureResult{
      .autoscroll = *mapped_autoscroll,
      .selection_changed = selection_changed,
      .dragged = dragged,
  };
}

void Terminal::reset_selection_gesture() noexcept {
  LEMMA_ASSERT(impl_ != nullptr);
  ghostty_selection_gesture_reset(impl_->selection_gesture, impl_->terminal);
}

auto Terminal::select(const SelectionUnit unit, const TerminalPoint point) noexcept
    -> std::expected<bool, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  GhosttyResult result = GHOSTTY_INVALID_VALUE;
  if (unit == SelectionUnit::all) {
    result = ghostty_terminal_select_all(impl_->terminal, &selection);
  } else {
    const auto ref = grid_ref(impl_->terminal, point);
    if (!ref.has_value()) {
      return std::unexpected(ref.error());
    }
    switch (unit) {
    case SelectionUnit::cell:
      selection.start = *ref;
      selection.end = *ref;
      result = GHOSTTY_SUCCESS;
      break;
    case SelectionUnit::word: {
      GhosttyTerminalSelectWordOptions options =
          GHOSTTY_INIT_SIZED(GhosttyTerminalSelectWordOptions);
      options.ref = *ref;
      result = ghostty_terminal_select_word(impl_->terminal, &options, &selection);
      break;
    }
    case SelectionUnit::line: {
      GhosttyTerminalSelectLineOptions options =
          GHOSTTY_INIT_SIZED(GhosttyTerminalSelectLineOptions);
      options.ref = *ref;
      options.semantic_prompt_boundary = true;
      result = ghostty_terminal_select_line(impl_->terminal, &options, &selection);
      break;
    }
    case SelectionUnit::output:
      result = ghostty_terminal_select_output(impl_->terminal, *ref, &selection);
      break;
    case SelectionUnit::all:
      break;
    }
  }
  if (result == GHOSTTY_NO_VALUE) {
    return false;
  }
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  const auto installed = install_selection(impl_->terminal, selection);
  if (!installed.has_value()) {
    return std::unexpected(installed.error());
  }
  return true;
}

auto Terminal::selection_adjust(const SelectionAdjustment adjustment, const bool extend) noexcept
    -> std::expected<bool, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  const auto current = active_selection(impl_->terminal);
  if (!current.has_value()) {
    return std::unexpected(current.error());
  }
  if (!current->has_value()) {
    return false;
  }
  auto selection = **current;
  if (adjustment == SelectionAdjustment::word_left ||
      adjustment == SelectionAdjustment::word_right) {
    return select_word_from_endpoint(impl_->terminal, selection, impl_->options.size.columns,
                                     adjustment == SelectionAdjustment::word_right, extend);
  }
  const auto native = selection_adjustment(adjustment);
  LEMMA_ASSERT(native.has_value());
  const auto result = ghostty_terminal_selection_adjust(impl_->terminal, &selection, *native);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  if (!extend) {
    selection.start = selection.end;
  }
  const auto installed = install_selection(impl_->terminal, selection);
  if (!installed.has_value()) {
    return std::unexpected(installed.error());
  }
  return true;
}

auto Terminal::collapse_selection_to_endpoint() noexcept -> std::expected<bool, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  const auto current = active_selection(impl_->terminal);
  if (!current.has_value()) {
    return std::unexpected(current.error());
  }
  if (!current->has_value()) {
    return false;
  }
  auto selection = **current;
  selection.start = selection.end;
  const auto installed = install_selection(impl_->terminal, selection);
  if (!installed.has_value()) {
    return std::unexpected(installed.error());
  }
  return true;
}

auto Terminal::selection_active() const noexcept -> std::expected<bool, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  const auto selection = active_selection(impl_->terminal);
  if (!selection.has_value()) {
    return std::unexpected(selection.error());
  }
  return selection->has_value();
}

auto Terminal::selection_endpoint(const PointSpace space) const noexcept
    -> std::expected<std::optional<TerminalPoint>, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  const auto selection = active_selection(impl_->terminal);
  if (!selection.has_value()) {
    return std::unexpected(selection.error());
  }
  if (!selection->has_value()) {
    return std::optional<TerminalPoint>{};
  }
  GhosttyPointCoordinate coordinate{};
  const auto result = ghostty_terminal_point_from_grid_ref(impl_->terminal, &(**selection).end,
                                                           point_tag(space), &coordinate);
  if (result == GHOSTTY_NO_VALUE) {
    return std::optional<TerminalPoint>{};
  }
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  return std::optional<TerminalPoint>{
      {.space = space, .column = coordinate.x, .row = coordinate.y}};
}

auto Terminal::refresh_selection() noexcept -> std::expected<bool, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  const auto selection = active_selection(impl_->terminal);
  if (!selection.has_value()) {
    return std::unexpected(selection.error());
  }
  if (!selection->has_value()) {
    return false;
  }
  const auto start = point_from_ref(impl_->terminal, (**selection).start, PointSpace::screen);
  const auto end = point_from_ref(impl_->terminal, (**selection).end, PointSpace::screen);
  if (!start.has_value() || !end.has_value()) {
    return std::unexpected(!start.has_value() ? start.error() : end.error());
  }
  const auto start_ref = grid_ref(impl_->terminal, *start);
  const auto end_ref = grid_ref(impl_->terminal, *end);
  if (!start_ref.has_value() || !end_ref.has_value()) {
    return std::unexpected(!start_ref.has_value() ? start_ref.error() : end_ref.error());
  }
  auto refreshed = **selection;
  refreshed.start = *start_ref;
  refreshed.end = *end_ref;
  const auto installed = install_selection(impl_->terminal, refreshed);
  if (!installed.has_value()) {
    return std::unexpected(installed.error());
  }
  return true;
}

void Terminal::clear_selection() noexcept {
  LEMMA_ASSERT(impl_ != nullptr);
  static_cast<void>(ghostty_terminal_set(impl_->terminal, GHOSTTY_TERMINAL_OPT_SELECTION, nullptr));
}

auto Terminal::format_selection(const ScreenFormat format,
                                const std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  if (output.size() > limits::selection_format_bytes_max) {
    return std::unexpected(Error::limit_exceeded);
  }
  GhosttyTerminalSelectionFormatOptions options =
      GHOSTTY_INIT_SIZED(GhosttyTerminalSelectionFormatOptions);
  options.emit = formatter_format(format);
  options.unwrap = true;
  options.trim = true;
  options.selection = nullptr;
  // std::byte and uint8_t are both byte views; Ghostty's C ABI uses the latter.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  auto* output_data = reinterpret_cast<std::uint8_t*>(output.data());
  std::size_t written = 0;
  const auto result = ghostty_terminal_selection_format_buf(impl_->terminal, options, output_data,
                                                            output.size(), &written);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  LEMMA_ASSERT(written <= output.size());
  return written;
}

void Terminal::scroll_viewport(const ViewportScroll behavior, const std::int64_t value) noexcept {
  LEMMA_ASSERT(impl_ != nullptr);
  GhosttyTerminalScrollViewport scroll{};
  switch (behavior) {
  case ViewportScroll::top:
    scroll.tag = GHOSTTY_SCROLL_VIEWPORT_TOP;
    break;
  case ViewportScroll::bottom:
    scroll.tag = GHOSTTY_SCROLL_VIEWPORT_BOTTOM;
    break;
  case ViewportScroll::delta:
    scroll.tag = GHOSTTY_SCROLL_VIEWPORT_DELTA;
    scroll.value.delta = static_cast<std::intptr_t>(
        std::clamp<std::int64_t>(value, std::numeric_limits<std::intptr_t>::min(),
                                 std::numeric_limits<std::intptr_t>::max()));
    break;
  case ViewportScroll::row:
    scroll.tag = GHOSTTY_SCROLL_VIEWPORT_ROW;
    scroll.value.row = value <= 0 ? 0 : static_cast<std::size_t>(value);
    break;
  }
  ghostty_terminal_scroll_viewport(impl_->terminal, scroll);
}

auto Terminal::viewport_state() const noexcept -> std::expected<ViewportState, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  GhosttyTerminalScrollbar scrollbar{};
  bool active = true;
  const std::array keys{GHOSTTY_TERMINAL_DATA_SCROLLBAR, GHOSTTY_TERMINAL_DATA_VIEWPORT_ACTIVE};
  std::array<void*, keys.size()> values{&scrollbar, &active};
  std::size_t written = 0;
  const auto result = ghostty_terminal_get_multi(impl_->terminal, keys.size(), keys.data(),
                                                 values.data(), &written);
  if (result != GHOSTTY_SUCCESS || written != keys.size()) {
    return std::unexpected(detail::map_error(result));
  }
  return ViewportState{
      .total_rows = scrollbar.total,
      .offset = scrollbar.offset,
      .visible_rows = scrollbar.len,
      .follows_output = active,
  };
}

auto Terminal::scroll_selection_into_view() noexcept -> std::expected<bool, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  const auto selection = active_selection(impl_->terminal);
  const auto viewport = viewport_state();
  if (!selection.has_value() || !viewport.has_value()) {
    return std::unexpected(!selection.has_value() ? selection.error() : viewport.error());
  }
  if (!selection->has_value()) {
    return false;
  }
  const auto endpoint = point_from_ref(impl_->terminal, (**selection).end, PointSpace::screen);
  if (!endpoint.has_value()) {
    return std::unexpected(endpoint.error());
  }
  std::uint64_t target = viewport->offset;
  if (endpoint->row < viewport->offset) {
    target = endpoint->row;
  } else if (viewport->visible_rows > 0 &&
             endpoint->row >= viewport->offset + viewport->visible_rows) {
    target = static_cast<std::uint64_t>(endpoint->row) - viewport->visible_rows + 1U;
  } else {
    return false;
  }
  scroll_viewport(ViewportScroll::row, static_cast<std::int64_t>(target));
  return true;
}

auto Terminal::compression_activity() const noexcept -> std::expected<std::uint64_t, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  std::uint64_t activity = 0;
  const auto result = ghostty_terminal_compression_activity(impl_->terminal, &activity);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  return activity;
}

auto Terminal::compress_scrollback() noexcept -> std::expected<CompressionResult, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  GhosttyTerminalCompressionResult compression = GHOSTTY_TERMINAL_COMPRESSION_RESULT_COMPLETE;
  const auto result = ghostty_terminal_compress(
      impl_->terminal, GHOSTTY_TERMINAL_COMPRESSION_MODE_INCREMENTAL, &compression);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  switch (compression) {
  case GHOSTTY_TERMINAL_COMPRESSION_RESULT_UNSUPPORTED:
    return CompressionResult::unsupported;
  case GHOSTTY_TERMINAL_COMPRESSION_RESULT_PENDING:
    return CompressionResult::pending;
  case GHOSTTY_TERMINAL_COMPRESSION_RESULT_COMPLETE:
    return CompressionResult::complete;
  case GHOSTTY_TERMINAL_COMPRESSION_RESULT_MAX_VALUE:
    return std::unexpected(Error::invalid_state);
  }
  return std::unexpected(Error::invalid_state);
}

// One search slice validates bounds, scans candidates, and returns explicit continuation state.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto Terminal::search_literal_step(const std::string_view query, const SearchDirection direction,
                                   const std::optional<SearchCursor> start,
                                   const std::size_t work_limit) const noexcept
    -> std::expected<SearchStepResult, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  if (query.empty() || query.size() > limits::search_query_bytes_max || work_limit == 0 ||
      work_limit > limits::search_candidates_per_step) {
    return std::unexpected(Error::invalid_options);
  }
  const auto rows = total_rows(impl_->terminal);
  if (!rows.has_value()) {
    return std::unexpected(rows.error());
  }
  const auto columns = impl_->options.size.columns;
  if (*rows == 0 || columns == 0) {
    return SearchStepResult{.status = SearchStepStatus::not_found};
  }

  const TerminalPoint boundary{
      .space = PointSpace::screen,
      .column = direction == SearchDirection::forward ? std::uint16_t{0}
                                                      : static_cast<std::uint16_t>(columns - 1U),
      .row = direction == SearchDirection::forward ? std::uint32_t{0}
                                                   : static_cast<std::uint32_t>(*rows - 1U),
  };
  auto cursor = start.value_or(SearchCursor{.candidate = boundary});
  const auto point_in_grid = [row_count = *rows, columns](const TerminalPoint point) noexcept {
    return point.space == PointSpace::screen && point.column < columns &&
           static_cast<std::size_t>(point.row) < row_count;
  };
  if (!point_in_grid(cursor.candidate) ||
      (cursor.matching &&
       (!point_in_grid(cursor.match_end) || cursor.text.space != PointSpace::screen ||
        cursor.text.column > columns || static_cast<std::size_t>(cursor.text.row) >= *rows ||
        cursor.query_offset >= query.size()))) {
    return std::unexpected(Error::invalid_options);
  }

  const auto query_byte = [query](const std::size_t offset) noexcept {
    return static_cast<std::uint8_t>(static_cast<unsigned char>(
        std::span<const char>(query.data(), query.size()).subspan(offset, 1).front()));
  };
  std::size_t work = 0;
  for (;;) {
    if (!cursor.matching) {
      cursor.text = cursor.candidate;
      cursor.match_end = cursor.candidate;
      cursor.query_offset = 0;
      cursor.matching = true;
    }

    bool mismatch = false;
    while (!mismatch && static_cast<std::size_t>(cursor.text.row) < *rows) {
      if (cursor.text.column < columns) {
        if (work >= work_limit) {
          return SearchStepResult{.status = SearchStepStatus::pending, .next = cursor};
        }
        SearchTextCursor text{.point = cursor.text};
        const auto loaded = load_grapheme(impl_->terminal, text);
        ++work;
        if (!loaded.has_value()) {
          return std::unexpected(loaded.error());
        }
        if (text.grapheme_size == 0) {
          // An empty starting cell cannot begin a literal, but empty cells after matched text are
          // skipped so wrapped visual padding does not split a logical line.
          if (cursor.query_offset == 0 && cursor.text == cursor.candidate) {
            mismatch = true;
          } else {
            ++cursor.text.column;
          }
          continue;
        }
        for (const auto value : std::span(text.grapheme).first(text.grapheme_size)) {
          if (ascii_fold(value) != ascii_fold(query_byte(cursor.query_offset))) {
            mismatch = true;
            break;
          }
          cursor.match_end = cursor.text;
          ++cursor.query_offset;
          if (cursor.query_offset == query.size()) {
            return SearchStepResult{
                .status = SearchStepStatus::found,
                .match = {.start = cursor.candidate, .end = cursor.match_end},
                .next = cursor,
            };
          }
        }
        ++cursor.text.column;
        continue;
      }

      if (work >= work_limit) {
        return SearchStepResult{.status = SearchStepStatus::pending, .next = cursor};
      }
      const TerminalPoint row_point{
          .space = PointSpace::screen,
          .column = static_cast<std::uint16_t>(columns - 1U),
          .row = cursor.text.row,
      };
      const auto ref = grid_ref(impl_->terminal, row_point);
      ++work;
      if (!ref.has_value()) {
        return std::unexpected(ref.error());
      }
      GhosttyRow row = 0;
      auto result = ghostty_grid_ref_row(&*ref, &row);
      if (result != GHOSTTY_SUCCESS) {
        return std::unexpected(detail::map_error(result));
      }
      bool wrapped = false;
      result = ghostty_row_get(row, GHOSTTY_ROW_DATA_WRAP, &wrapped);
      if (result != GHOSTTY_SUCCESS) {
        return std::unexpected(detail::map_error(result));
      }
      ++cursor.text.row;
      cursor.text.column = 0;
      if (!wrapped) {
        if (ascii_fold(static_cast<std::uint8_t>('\n')) !=
            ascii_fold(query_byte(cursor.query_offset))) {
          mismatch = true;
        } else {
          cursor.match_end = row_point;
          ++cursor.query_offset;
          if (cursor.query_offset == query.size()) {
            return SearchStepResult{
                .status = SearchStepStatus::found,
                .match = {.start = cursor.candidate, .end = cursor.match_end},
                .next = cursor,
            };
          }
        }
      }
    }

    auto next_candidate = cursor.candidate;
    if (!advance_search_candidate(next_candidate, direction, *rows, columns)) {
      return SearchStepResult{.status = SearchStepStatus::not_found};
    }
    cursor = SearchCursor{.candidate = next_candidate};
  }
}

auto Terminal::select_search_match(const SearchMatch& match) noexcept
    -> std::expected<void, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  if (match.start.space != PointSpace::screen || match.end.space != PointSpace::screen) {
    return std::unexpected(Error::invalid_options);
  }
  const auto start = grid_ref(impl_->terminal, match.start);
  const auto end = grid_ref(impl_->terminal, match.end);
  if (!start.has_value() || !end.has_value()) {
    return std::unexpected(!start.has_value() ? start.error() : end.error());
  }
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  selection.start = *start;
  selection.end = *end;
  return install_selection(impl_->terminal, selection);
}

} // namespace lemma::vt
