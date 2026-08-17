#include "core/copy_mode.hpp"

#include "core/session.hpp"

#include <algorithm>
#include <cstdint>

namespace lemma::core {

// Search placement is Core UI policy over Runtime-observed canonical terminal coordinates. Small
// panes naturally retain a wider safe zone because they cannot represent quarter-pane margins.
auto copy_search_viewport_offset(const std::uint64_t match_row, const std::uint64_t current_offset,
                                 const std::uint64_t visible_rows,
                                 const std::uint64_t total_rows) noexcept -> std::uint64_t {
  if (visible_rows == 0 || total_rows <= visible_rows) {
    return 0;
  }
  const auto maximum_offset = total_rows - visible_rows;
  const auto offset = std::min(current_offset, maximum_offset);
  const auto row = std::min(match_row, total_rows - 1U);
  const auto safe_margin = visible_rows / 4U;
  const auto safe_begin = offset + safe_margin;
  const auto safe_end = offset + visible_rows - safe_margin;
  if (row >= safe_begin && row < safe_end) {
    return offset;
  }
  const auto half_viewport = visible_rows / 2U;
  const auto centered = row > half_viewport ? row - half_viewport : 0U;
  return std::min(centered, maximum_offset);
}

[[nodiscard]] constexpr auto byte_is(const CopyKey key, const std::uint8_t value) noexcept -> bool {
  return key.kind == CopyKeyKind::byte && key.byte == value;
}

// The table is intentionally Vim-shaped rather than a byte-level terminal parser. Physical keys
// stay typed so navigation keys cannot accidentally become search-query text.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto copy_action_for_key(CopyModeState& state, const CopyKey key) noexcept -> CopyAction {
  if (state.phase == CopyModePhase::searching) {
    if (key.kind == CopyKeyKind::escape || byte_is(key, 0x1B)) {
      return {.kind = CopyActionKind::cancel_search};
    }
    if (byte_is(key, 0x03) || byte_is(key, 0x07) || byte_is(key, static_cast<std::uint8_t>('q'))) {
      return {.kind = CopyActionKind::leave};
    }
    return {};
  }

  if (state.phase == CopyModePhase::search_prompt) {
    if (key.kind == CopyKeyKind::escape || byte_is(key, 0x1B)) {
      return {.kind = CopyActionKind::cancel_search};
    }
    if (key.kind == CopyKeyKind::backspace || byte_is(key, 0x7F) || byte_is(key, 0x08)) {
      return {.kind = CopyActionKind::query_backspace};
    }
    if (key.kind == CopyKeyKind::enter || byte_is(key, static_cast<std::uint8_t>('\r')) ||
        byte_is(key, static_cast<std::uint8_t>('\n'))) {
      return {.kind = CopyActionKind::commit_search};
    }
    return key.kind == CopyKeyKind::byte && key.byte >= 0x20
               ? CopyAction{.kind = CopyActionKind::query_append, .byte = key.byte}
               : CopyAction{};
  }

  if (state.pending_chord == CopyPendingChord::go) {
    state.pending_chord = CopyPendingChord::none;
    if (byte_is(key, static_cast<std::uint8_t>('g'))) {
      return {.kind = CopyActionKind::history_top};
    }
  }

  switch (key.kind) {
  case CopyKeyKind::escape:
    return {.kind = state.selecting() ? CopyActionKind::cancel_selection : CopyActionKind::leave};
  case CopyKeyKind::enter:
    return {.kind = CopyActionKind::copy};
  case CopyKeyKind::arrow_up:
    return {.kind = CopyActionKind::move_up};
  case CopyKeyKind::arrow_down:
    return {.kind = CopyActionKind::move_down};
  case CopyKeyKind::arrow_left:
    return {.kind = CopyActionKind::move_left};
  case CopyKeyKind::arrow_right:
    return {.kind = CopyActionKind::move_right};
  case CopyKeyKind::home:
    return {.kind = CopyActionKind::line_start};
  case CopyKeyKind::end:
    return {.kind = CopyActionKind::line_end};
  case CopyKeyKind::page_up:
    return {.kind = CopyActionKind::page_up};
  case CopyKeyKind::page_down:
    return {.kind = CopyActionKind::page_down};
  case CopyKeyKind::backspace:
    return {};
  case CopyKeyKind::byte:
    break;
  }

  switch (key.byte) {
  case 0x1B:
    return {.kind = state.selecting() ? CopyActionKind::cancel_selection : CopyActionKind::leave};
  case 0x03: // Ctrl-C
  case 0x07: // Ctrl-G
  case static_cast<std::uint8_t>('q'):
    return {.kind = CopyActionKind::leave};
  case static_cast<std::uint8_t>('h'):
    return {.kind = CopyActionKind::move_left};
  case static_cast<std::uint8_t>('j'):
    return {.kind = CopyActionKind::move_down};
  case static_cast<std::uint8_t>('k'):
    return {.kind = CopyActionKind::move_up};
  case static_cast<std::uint8_t>('l'):
    return {.kind = CopyActionKind::move_right};
  case static_cast<std::uint8_t>('b'):
    return {.kind = CopyActionKind::word_left};
  case static_cast<std::uint8_t>('w'):
    return {.kind = CopyActionKind::word_right};
  case static_cast<std::uint8_t>('e'):
    return {.kind = CopyActionKind::word_end};
  case static_cast<std::uint8_t>('0'):
    return {.kind = CopyActionKind::line_start};
  case static_cast<std::uint8_t>('^'):
    return {.kind = CopyActionKind::line_first_nonblank};
  case static_cast<std::uint8_t>('$'):
    return {.kind = CopyActionKind::line_end};
  case static_cast<std::uint8_t>('g'):
    state.pending_chord = CopyPendingChord::go;
    return {};
  case static_cast<std::uint8_t>('G'):
    return {.kind = CopyActionKind::history_bottom};
  case static_cast<std::uint8_t>('H'):
    return {.kind = CopyActionKind::viewport_top};
  case static_cast<std::uint8_t>('M'):
    return {.kind = CopyActionKind::viewport_middle};
  case static_cast<std::uint8_t>('L'):
    return {.kind = CopyActionKind::viewport_bottom};
  case 0x15: // Ctrl-U
    return {.kind = CopyActionKind::half_page_up};
  case 0x04: // Ctrl-D
    return {.kind = CopyActionKind::half_page_down};
  case 0x02: // Ctrl-B
    return {.kind = CopyActionKind::page_up};
  case 0x06: // Ctrl-F
    return {.kind = CopyActionKind::page_down};
  case static_cast<std::uint8_t>(' '):
  case static_cast<std::uint8_t>('v'):
    return {.kind = CopyActionKind::visual_character};
  case static_cast<std::uint8_t>('V'):
    return {.kind = CopyActionKind::visual_line};
  case 0x16: // Ctrl-V
    return {.kind = CopyActionKind::visual_block};
  case static_cast<std::uint8_t>('o'):
    return {.kind = CopyActionKind::swap_endpoint};
  case static_cast<std::uint8_t>('y'):
  case static_cast<std::uint8_t>('\r'):
  case static_cast<std::uint8_t>('\n'):
    return {.kind = CopyActionKind::copy};
  case static_cast<std::uint8_t>('/'):
    return {.kind = CopyActionKind::begin_search_forward};
  case static_cast<std::uint8_t>('?'):
    return {.kind = CopyActionKind::begin_search_backward};
  case static_cast<std::uint8_t>('n'):
    return {.kind = CopyActionKind::repeat_search};
  case static_cast<std::uint8_t>('N'):
    return {.kind = CopyActionKind::reverse_search};
  default:
    return {};
  }
}

} // namespace lemma::core
