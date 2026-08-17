#ifndef LEMMA_CORE_COPY_MODE_HPP
#define LEMMA_CORE_COPY_MODE_HPP

#include "core/session.hpp"

#include <cstdint>

namespace lemma::core {

enum class CopyActionKind : std::uint8_t {
  none,
  leave,
  cancel_selection,
  move_left,
  move_down,
  move_up,
  move_right,
  word_left,
  word_right,
  word_end,
  line_start,
  line_first_nonblank,
  line_end,
  history_top,
  history_bottom,
  viewport_top,
  viewport_middle,
  viewport_bottom,
  half_page_up,
  half_page_down,
  page_up,
  page_down,
  visual_character,
  visual_line,
  visual_block,
  swap_endpoint,
  copy,
  begin_search_forward,
  begin_search_backward,
  repeat_search,
  reverse_search,
  cancel_search,
  commit_search,
  query_backspace,
  query_append,
};

struct CopyAction final {
  CopyActionKind kind{CopyActionKind::none};
  std::uint8_t byte{0};
};

enum class CopyKeyKind : std::uint8_t {
  byte,
  escape,
  enter,
  backspace,
  arrow_up,
  arrow_down,
  arrow_left,
  arrow_right,
  home,
  end,
  page_up,
  page_down,
};

struct CopyKey final {
  CopyKeyKind kind{CopyKeyKind::byte};
  std::uint8_t byte{0};
};

// Maps one normalized copy-mode key to semantic intent. The only state consumed here is the
// bounded multi-key grammar; terminal operations and their outcomes remain outside this pure Core
// transition.
[[nodiscard]] auto copy_action_for_key(CopyModeState& state, CopyKey key) noexcept -> CopyAction;

// Keeps a search match stable while it remains in the middle half of the viewport, otherwise
// returns an offset that centers it. Runtime applies the resulting offset through the terminal
// adapter, which remains authoritative for canonical viewport state.
[[nodiscard]] auto copy_search_viewport_offset(std::uint64_t match_row,
                                               std::uint64_t current_offset,
                                               std::uint64_t visible_rows,
                                               std::uint64_t total_rows) noexcept -> std::uint64_t;

} // namespace lemma::core

#endif // LEMMA_CORE_COPY_MODE_HPP
