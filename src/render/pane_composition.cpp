#include "render/pane_composition.hpp"

#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <iterator>
#include <span>
#include <string_view>
#include <system_error>

namespace lemma::render {
namespace {

[[nodiscard]] auto append(std::span<std::byte> output, std::size_t& used,
                          const std::string_view text) noexcept -> bool {
  if (text.size() > output.size() - used) {
    return false;
  }
  std::memcpy(output.subspan(used).data(), text.data(), text.size());
  used += text.size();
  return true;
}

[[nodiscard]] auto append_integer(const std::span<std::byte> output, std::size_t& used,
                                  const std::uint16_t value) noexcept -> bool {
  std::array<char, 8> encoded{};
  const auto result = std::to_chars(encoded.begin(), encoded.end(), value);
  if (result.ec != std::errc{}) {
    return false;
  }
  const auto size = static_cast<std::size_t>(std::distance(encoded.begin(), result.ptr));
  return append(output, used, std::string_view(encoded.data(), size));
}

[[nodiscard]] auto append_position(const std::span<std::byte> output, std::size_t& used,
                                   const std::uint16_t row, const std::uint16_t column) noexcept
    -> bool {
  return append(output, used, "\x1B[") && append_integer(output, used, row) &&
         append(output, used, ";") && append_integer(output, used, column) &&
         append(output, used, "H");
}

constexpr std::size_t status_title_columns_max = 16;
constexpr std::size_t status_session_columns_max = 32;
constexpr std::size_t status_label_bytes_max = status_session_columns_max + 2U;
constexpr std::string_view status_style = "\x1B[0;2m";
constexpr std::string_view status_session_style = "\x1B[0;1;7m";

struct StatusLabel final {
  std::array<char, status_label_bytes_max> text{};
  std::size_t size{0};
};

[[nodiscard]] auto sanitized_title(const std::string_view title,
                                   const std::span<char> output) noexcept -> std::size_t {
  const auto used = std::min(title.size(), output.size());
  std::size_t index = 0;
  for (const char character : std::span(title).first(used)) {
    const auto value = static_cast<unsigned char>(character);
    output.subspan(index, 1).front() = value >= 0x20U && value < 0x7FU ? character : '?';
    ++index;
  }
  if (used == 0) {
    constexpr std::string_view fallback = "shell";
    const auto fallback_size = std::min(fallback.size(), output.size());
    std::ranges::copy(std::span(fallback).first(fallback_size), output.begin());
    if (fallback_size < fallback.size()) {
      output.subspan(fallback_size - 1U, 1).front() = '~';
    }
    return fallback_size;
  }
  if (title.size() > used) {
    output.subspan(used - 1U, 1).front() = '~';
  }
  return used;
}

[[nodiscard]] auto
status_label(const StatusTab& tab,
             const std::size_t title_columns_max = status_title_columns_max) noexcept
    -> StatusLabel {
  StatusLabel label;
  const auto append_character = [&](const char character) {
    std::span(label.text).subspan(label.size, 1).front() = character;
    ++label.size;
  };
  if (tab.active) {
    append_character('[');
  }
  const auto result =
      std::to_chars(std::span(label.text).subspan(label.size).data(), label.text.end(), tab.number);
  if (result.ec != std::errc{}) {
    return {};
  }
  label.size = static_cast<std::size_t>(std::distance(label.text.begin(), result.ptr));
  if (title_columns_max > 0) {
    append_character(':');
    label.size += sanitized_title(
        tab.title, std::span(label.text).subspan(label.size).first(title_columns_max));
  }
  if (tab.active) {
    append_character(']');
  }
  return label;
}

[[nodiscard]] auto session_label(const std::string_view session_name,
                                 const std::size_t columns_max) noexcept -> StatusLabel {
  StatusLabel label;
  const auto bounded_columns = std::min(columns_max, status_session_columns_max + std::size_t{2});
  if (session_name.empty() || bounded_columns < 3U) {
    return label;
  }
  label.text.front() = ' ';
  label.size = 1U;
  label.size += sanitized_title(
      session_name,
      std::span(label.text).subspan(label.size).first(bounded_columns - std::size_t{2}));
  std::span(label.text).subspan(label.size, 1).front() = ' ';
  ++label.size;
  return label;
}

[[nodiscard]] auto status_width(const std::span<const StatusLabel> labels, const std::size_t begin,
                                const std::size_t end) noexcept -> std::size_t {
  std::size_t width = begin > 0 ? 2U : 0U;
  for (std::size_t index = begin; index <= end; ++index) {
    width += std::span(labels).subspan(index, 1).front().size;
    if (index < end) {
      width += 2U;
    }
  }
  if (end + 1U < labels.size()) {
    width += 2U;
  }
  return width;
}

[[nodiscard]] auto append_spaces(const std::span<std::byte> output, std::size_t& used,
                                 std::size_t count) noexcept -> bool {
  constexpr std::string_view spaces =
      "                                                                ";
  while (count > 0) {
    const auto chunk = std::min(count, spaces.size());
    // The explicit length bounds this non-null-terminated view.
    // NOLINTNEXTLINE(bugprone-suspicious-stringview-data-usage)
    if (!append(output, used, std::string_view(spaces.data(), chunk))) {
      return false;
    }
    count -= chunk;
  }
  return true;
}

[[nodiscard]] auto append_status_range(const std::span<std::byte> output, std::size_t& used,
                                       const std::span<const StatusLabel> labels,
                                       const std::size_t begin, const std::size_t end) noexcept
    -> bool {
  if (begin > 0 && !append(output, used, "… ")) {
    return false;
  }
  for (std::size_t index = begin; index <= end; ++index) {
    const auto& label = std::span(labels).subspan(index, 1).front();
    if (!append(output, used, std::string_view(label.text.data(), label.size)) ||
        (index < end && !append(output, used, "  "))) {
      return false;
    }
  }
  return end + 1U >= labels.size() || append(output, used, " …");
}

// The visible status range is a pure function of the active tab, labels, and viewport width.
// Its branches implement bounded bidirectional fitting and narrow-terminal degradation.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto render_status_line(const StatusLine status, const Viewport viewport,
                                      const std::span<std::byte> output, std::size_t& used) noexcept
    -> bool {
  if (status.tabs.empty() || viewport.rows < 2) {
    return true;
  }

  std::array<StatusLabel, status_tabs_max> label_storage{};
  auto labels = std::span(label_storage).first(status.tabs.size());
  std::size_t active = 0;
  for (std::size_t index = 0; index < status.tabs.size(); ++index) {
    const auto& tab = status.tabs.subspan(index, 1).front();
    labels.subspan(index, 1).front() = status_label(tab);
    if (tab.active) {
      active = index;
    }
  }

  const auto active_width = labels.subspan(active, 1).front().size;
  const auto session_columns_max =
      active_width < viewport.columns ? viewport.columns - active_width : 0U;
  const auto session = session_label(status.session_name, session_columns_max);
  const auto tab_columns = viewport.columns - session.size;

  if (labels.subspan(active, 1).front().size > tab_columns) {
    const auto number_columns = status.tabs.subspan(active, 1).front().number < 10 ? 1U : 2U;
    const auto title_columns =
        tab_columns > number_columns + 3U ? tab_columns - number_columns - 3U : 0U;
    labels.subspan(active, 1).front() =
        status_label(status.tabs.subspan(active, 1).front(), title_columns);
  }
  if (labels.subspan(active, 1).front().size > tab_columns) {
    auto& label = labels.subspan(active, 1).front();
    const auto result = std::to_chars(label.text.begin(), label.text.end(),
                                      status.tabs.subspan(active, 1).front().number);
    label.size =
        result.ec == std::errc{}
            ? std::min(tab_columns,
                       static_cast<std::size_t>(std::distance(label.text.begin(), result.ptr)))
            : 0;
  }

  std::size_t begin = active;
  std::size_t end = active;
  if (status_width(labels, begin, end) <= tab_columns) {
    bool try_left = true;
    bool left_blocked = begin == 0;
    bool right_blocked = end + 1U == labels.size();
    while (!left_blocked || !right_blocked) {
      const bool use_left = (try_left && !left_blocked) || right_blocked;
      const auto candidate_begin = use_left ? begin - 1U : begin;
      const auto candidate_end = use_left ? end : end + 1U;
      if (status_width(labels, candidate_begin, candidate_end) <= tab_columns) {
        begin = candidate_begin;
        end = candidate_end;
      } else if (use_left) {
        left_blocked = true;
      } else {
        right_blocked = true;
      }
      left_blocked = left_blocked || begin == 0;
      right_blocked = right_blocked || end + 1U == labels.size();
      try_left = !try_left;
    }
  }

  auto width = status_width(labels, begin, end);
  bool show_range = width <= tab_columns;
  if (!show_range) {
    begin = active;
    end = active;
    width = labels.subspan(active, 1).front().size;
  }
  const auto centered_column = ((viewport.columns - width) / 2U) + std::size_t{1};
  const auto start_column =
      static_cast<std::uint16_t>(std::max(centered_column, session.size + std::size_t{1}));
  constexpr std::uint16_t status_row = 1;
  if (!append_position(output, used, status_row, 1) || !append(output, used, status_style) ||
      !append_spaces(output, used, viewport.columns)) {
    return false;
  }
  if (session.size > 0 &&
      (!append_position(output, used, status_row, 1) ||
       !append(output, used, status_session_style) ||
       !append(output, used, std::string_view(session.text.data(), session.size)) ||
       !append(output, used, status_style))) {
    return false;
  }
  if (!append_position(output, used, status_row, start_column)) {
    return false;
  }
  if (show_range) {
    if (!append_status_range(output, used, labels, begin, end)) {
      return false;
    }
  } else {
    const auto& label = labels.subspan(active, 1).front();
    if (!append(output, used, std::string_view(label.text.data(), label.size))) {
      return false;
    }
  }
  return append(output, used, "\x1B[0m");
}

[[nodiscard]] auto valid_viewport(const Viewport viewport) noexcept -> bool {
  return viewport.columns > 0 && viewport.rows > 0 &&
         viewport.columns <= limits::terminal_columns_hard_max &&
         viewport.rows <= limits::terminal_rows_hard_max;
}

void invalidate_panes(const std::span<const PaneSurface> panes) noexcept {
  for (const auto& pane : panes) {
    pane.terminal->invalidate_ansi_render_state();
  }
}

[[nodiscard]] auto valid_pane(const PaneSurface& pane, const Viewport viewport) noexcept -> bool {
  if (pane.terminal == nullptr || pane.rectangle.columns == 0 || pane.rectangle.rows == 0) {
    return false;
  }
  const auto right = static_cast<std::uint32_t>(pane.rectangle.column) + pane.rectangle.columns;
  const auto bottom = static_cast<std::uint32_t>(pane.rectangle.row) + pane.rectangle.rows;
  if (right > viewport.columns || bottom > viewport.rows ||
      (pane.border_right && right >= viewport.columns) ||
      (pane.border_bottom && bottom >= viewport.rows)) {
    return false;
  }
  const auto terminal_size = pane.terminal->size();
  return terminal_size.columns == pane.rectangle.columns &&
         terminal_size.rows == pane.rectangle.rows &&
         (!pane.cursor_override ||
          (pane.focused && pane.cursor_override_column < terminal_size.columns &&
           pane.cursor_override_row < terminal_size.rows));
}

[[nodiscard]] auto panes_overlap(const PaneSurface& first, const PaneSurface& second) noexcept
    -> bool {
  const auto first_right = static_cast<std::uint32_t>(first.rectangle.column) +
                           first.rectangle.columns + (first.border_right ? 1U : 0U);
  const auto first_bottom = static_cast<std::uint32_t>(first.rectangle.row) + first.rectangle.rows +
                            (first.border_bottom ? 1U : 0U);
  const auto second_right = static_cast<std::uint32_t>(second.rectangle.column) +
                            second.rectangle.columns + (second.border_right ? 1U : 0U);
  const auto second_bottom = static_cast<std::uint32_t>(second.rectangle.row) +
                             second.rectangle.rows + (second.border_bottom ? 1U : 0U);
  return first.rectangle.column < second_right && second.rectangle.column < first_right &&
         first.rectangle.row < second_bottom && second.rectangle.row < first_bottom;
}

[[nodiscard]] auto valid_status(const StatusLine status) noexcept -> bool {
  return status.tabs.size() <= status_tabs_max &&
         (status.tabs.empty() || std::ranges::count(status.tabs, true, &StatusTab::active) == 1) &&
         std::ranges::none_of(status.tabs, [](const StatusTab& tab) { return tab.number == 0; });
}

[[nodiscard]] constexpr auto has_visible_status(const Viewport viewport,
                                                const StatusLine status) noexcept -> bool {
  return !status.tabs.empty() && viewport.rows >= 2;
}

[[nodiscard]] auto pane_viewport(const Viewport viewport, const StatusLine status) noexcept
    -> Viewport {
  return {
      .columns = viewport.columns,
      .rows = static_cast<std::uint16_t>(viewport.rows -
                                         (has_visible_status(viewport, status) ? 1U : 0U)),
  };
}

// Composition validation deliberately keeps geometry, overlap, and focus checks in one pass.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto validate_composition(const std::span<const PaneSurface> panes,
                                        const Viewport viewport, const StatusLine status) noexcept
    -> std::expected<bool, CompositionError> {
  if (!valid_viewport(viewport)) {
    return std::unexpected(CompositionError::invalid_viewport);
  }
  if (panes.size() > limits::panes_hard_max) {
    return std::unexpected(CompositionError::too_many_panes);
  }
  if (!valid_status(status)) {
    return std::unexpected(CompositionError::invalid_status);
  }
  bool has_focus = false;
  bool has_presented_focus = false;
  const auto content_viewport = pane_viewport(viewport, status);
  for (auto current = panes.begin(); current != panes.end(); ++current) {
    if (!valid_pane(*current, content_viewport)) {
      return std::unexpected(CompositionError::invalid_pane);
    }
    for (auto previous = panes.begin(); previous != current; ++previous) {
      if (panes_overlap(*previous, *current)) {
        return std::unexpected(CompositionError::invalid_pane);
      }
    }
    if (current->focused && has_focus) {
      return std::unexpected(CompositionError::multiple_focused_panes);
    }
    has_focus = has_focus || current->focused;
    has_presented_focus =
        has_presented_focus || (current->focused && !current->presentation_suppressed);
  }
  return has_presented_focus;
}

[[nodiscard]] auto begin_frame(const std::span<std::byte> output, std::size_t& used,
                               const bool force_full) noexcept -> bool {
  return append(output, used, "\x1B[?2026h\x1B[?25l\x1B[?7l") &&
         (!force_full || append(output, used, "\x1B[2J\x1B[H"));
}

[[nodiscard]] auto is_single_full_viewport(const std::span<const PaneSurface> panes,
                                           const Viewport viewport) noexcept -> bool {
  return panes.size() == 1 && panes.front().rectangle.column == 0 &&
         panes.front().rectangle.row == 0 && panes.front().rectangle.columns == viewport.columns &&
         panes.front().rectangle.rows == viewport.rows;
}

[[nodiscard]] auto render_surface(const PaneSurface& pane, const std::span<std::byte> output,
                                  std::size_t& used, const bool force_full,
                                  const bool allow_terminal_scroll, const std::uint16_t row_offset,
                                  CompositionResult& composition) noexcept
    -> std::expected<void, CompositionError> {
  const vt::PaneRenderOptions options{
      .column = pane.rectangle.column,
      .row = static_cast<std::uint16_t>(pane.rectangle.row + row_offset),
      .cursor_override_column = pane.cursor_override_column,
      .cursor_override_row = pane.cursor_override_row,
      .force_full = force_full,
      .focused = pane.focused,
      .cursor_override = pane.cursor_override,
      .allow_terminal_scroll = allow_terminal_scroll,
  };
  const auto rendered = pane.terminal->render_pane_ansi(output.subspan(used), options);
  if (!rendered.has_value()) {
    return std::unexpected(rendered.error() == vt::Error::out_of_space
                               ? CompositionError::output_exhausted
                               : CompositionError::terminal_error);
  }
  used += rendered->bytes;
  composition.rows += rendered->rows;
  composition.full = composition.full || rendered->full;
  return {};
}

[[nodiscard]] auto render_panes(const std::span<const PaneSurface> panes, const Viewport viewport,
                                const std::span<std::byte> output, std::size_t& used,
                                const bool force_full, const std::uint16_t row_offset,
                                CompositionResult& composition) noexcept
    -> std::expected<void, CompositionError> {
  const bool allow_terminal_scroll = row_offset == 0 && is_single_full_viewport(panes, viewport);
  for (const auto& pane : panes) {
    if (!pane.focused && !pane.presentation_suppressed) {
      const auto rendered = render_surface(pane, output, used, force_full, allow_terminal_scroll,
                                           row_offset, composition);
      if (!rendered.has_value()) {
        invalidate_panes(panes);
        return rendered;
      }
    }
  }
  for (const auto& pane : panes) {
    if (pane.focused && !pane.presentation_suppressed) {
      const auto rendered = render_surface(pane, output, used, force_full, allow_terminal_scroll,
                                           row_offset, composition);
      if (!rendered.has_value()) {
        invalidate_panes(panes);
        return rendered;
      }
    }
  }
  return {};
}

[[nodiscard]] auto border_cell(const std::span<const PaneSurface> panes, const std::uint16_t row,
                               const std::uint16_t column) noexcept -> bool {
  return std::ranges::any_of(panes, [row, column](const PaneSurface& pane) {
    const auto right = static_cast<std::uint16_t>(pane.rectangle.column + pane.rectangle.columns);
    const auto bottom = static_cast<std::uint16_t>(pane.rectangle.row + pane.rectangle.rows);
    const bool on_right =
        pane.border_right && column == right && row >= pane.rectangle.row && row < bottom;
    const bool on_bottom =
        pane.border_bottom && row == bottom && column >= pane.rectangle.column && column < right;
    return on_right || on_bottom;
  });
}

// The branches map the four neighboring separator segments to one box-drawing junction.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto border_glyph(const std::span<const PaneSurface> panes, const std::uint16_t row,
                                const std::uint16_t column) noexcept -> std::string_view {
  const bool left = column > 0 && border_cell(panes, row, static_cast<std::uint16_t>(column - 1U));
  const bool right = border_cell(panes, row, static_cast<std::uint16_t>(column + 1U));
  const bool up = row > 0 && border_cell(panes, static_cast<std::uint16_t>(row - 1U), column);
  const bool down = border_cell(panes, static_cast<std::uint16_t>(row + 1U), column);
  if (left && right && up && down) {
    return "┼";
  }
  if (left && right && down) {
    return "┬";
  }
  if (left && right && up) {
    return "┴";
  }
  if (up && down && right) {
    return "├";
  }
  if (up && down && left) {
    return "┤";
  }
  if (right && down) {
    return "┌";
  }
  if (left && down) {
    return "┐";
  }
  if (right && up) {
    return "└";
  }
  if (left && up) {
    return "┘";
  }
  return left || right ? std::string_view{"─"} : std::string_view{"│"};
}

[[nodiscard]] auto draw_right_border(const PaneSurface& pane,
                                     const std::span<const PaneSurface> panes,
                                     const std::span<std::byte> output, std::size_t& used,
                                     const std::uint16_t row_offset) noexcept -> bool {
  if (!pane.border_right) {
    return true;
  }
  const auto column = static_cast<std::uint16_t>(pane.rectangle.column + pane.rectangle.columns);
  const auto bottom = static_cast<std::uint16_t>(pane.rectangle.row + pane.rectangle.rows);
  for (std::uint16_t row = pane.rectangle.row; row < bottom; ++row) {
    if (!append_position(output, used, static_cast<std::uint16_t>(row + row_offset + 1U),
                         static_cast<std::uint16_t>(column + 1U)) ||
        !append(output, used, border_glyph(panes, row, column))) {
      return false;
    }
  }
  return true;
}

[[nodiscard]] auto draw_bottom_border(const PaneSurface& pane,
                                      const std::span<const PaneSurface> panes,
                                      const std::span<std::byte> output, std::size_t& used,
                                      const std::uint16_t row_offset) noexcept -> bool {
  if (!pane.border_bottom) {
    return true;
  }
  const auto row = static_cast<std::uint16_t>(pane.rectangle.row + pane.rectangle.rows);
  const auto right = static_cast<std::uint16_t>(pane.rectangle.column + pane.rectangle.columns);
  for (std::uint16_t column = pane.rectangle.column; column < right; ++column) {
    if (!append_position(output, used, static_cast<std::uint16_t>(row + row_offset + 1U),
                         static_cast<std::uint16_t>(column + 1U)) ||
        !append(output, used, border_glyph(panes, row, column))) {
      return false;
    }
  }
  return true;
}

// Junction candidates are bounded by the visible pane count squared.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto draw_junctions(const std::span<const PaneSurface> panes,
                                  const std::span<std::byte> output, std::size_t& used,
                                  const std::uint16_t row_offset) noexcept -> bool {
  for (const auto& vertical : panes) {
    if (vertical.border_right) {
      const auto column =
          static_cast<std::uint16_t>(vertical.rectangle.column + vertical.rectangle.columns);
      for (const auto& horizontal : panes) {
        if (horizontal.border_bottom) {
          const auto row =
              static_cast<std::uint16_t>(horizontal.rectangle.row + horizontal.rectangle.rows);
          const bool horizontal_neighbor =
              (column > 0 && border_cell(panes, row, static_cast<std::uint16_t>(column - 1U))) ||
              border_cell(panes, row, static_cast<std::uint16_t>(column + 1U));
          const bool vertical_neighbor =
              (row > 0 && border_cell(panes, static_cast<std::uint16_t>(row - 1U), column)) ||
              border_cell(panes, static_cast<std::uint16_t>(row + 1U), column);
          if (horizontal_neighbor && vertical_neighbor &&
              (!append_position(output, used, static_cast<std::uint16_t>(row + row_offset + 1U),
                                static_cast<std::uint16_t>(column + 1U)) ||
               !append(output, used, border_glyph(panes, row, column)))) {
            return false;
          }
        }
      }
    }
  }
  return true;
}

[[nodiscard]] auto draw_borders(const std::span<const PaneSurface> panes,
                                const std::span<std::byte> output, std::size_t& used,
                                const std::uint16_t row_offset) noexcept -> bool {
  if (!append(output, used, "\x1B[90m")) {
    return false;
  }
  for (const auto& pane : panes) {
    if (!draw_right_border(pane, panes, output, used, row_offset) ||
        !draw_bottom_border(pane, panes, output, used, row_offset)) {
      return false;
    }
  }
  return draw_junctions(panes, output, used, row_offset) && append(output, used, "\x1B[0m");
}

[[nodiscard]] auto finish_frame(const std::span<std::byte> output, std::size_t& used,
                                const bool has_focus) noexcept -> bool {
  constexpr std::string_view neutral_modes =
      "\x1B[?1l\x1B[?9l\x1B[?1000l\x1B[?1002l\x1B[?1003l\x1B[?1004l"
      "\x1B[?1005l\x1B[?1006l\x1B[?1007l\x1B[?1015l\x1B[?1016l\x1B[?2004l";
  return append(output, used, "\x1B[0m\x1B[?7h") &&
         (has_focus ||
          (append(output, used, "\x1B[?25l") && append(output, used, neutral_modes))) &&
         append(output, used, "\x1B[?2026l");
}

} // namespace

// Validation is a separate pass so malformed composition input cannot partially consume terminal
// damage or alter retained pane state.
[[nodiscard]] auto compose_frame(const std::span<const PaneSurface> panes, const Viewport viewport,
                                 const std::span<std::byte> output, const bool force_full,
                                 const StatusLine status) noexcept
    -> std::expected<CompositionResult, CompositionError> {
  const auto validation = validate_composition(panes, viewport, status);
  if (!validation.has_value()) {
    return std::unexpected(validation.error());
  }

  const bool complete_frame = std::ranges::none_of(panes, &PaneSurface::presentation_suppressed);
  const bool complete_full = force_full && complete_frame;
  std::size_t used = 0;
  if (!begin_frame(output, used, complete_full)) {
    return std::unexpected(CompositionError::output_exhausted);
  }
  CompositionResult composition{
      .panes = panes.size(),
      .full = complete_full,
  };
  const std::uint16_t row_offset = has_visible_status(viewport, status) ? 1U : 0U;
  // Separators are outside every pane surface and can only change with a layout/full redraw.
  // Re-emitting them for ordinary pane damage wastes bytes and CPU without changing presentation.
  if (force_full && !draw_borders(panes, output, used, row_offset)) {
    return std::unexpected(CompositionError::output_exhausted);
  }
  if ((force_full || status.dirty) && !render_status_line(status, viewport, output, used)) {
    return std::unexpected(CompositionError::output_exhausted);
  }
  composition.status = has_visible_status(viewport, status) && (force_full || status.dirty);
  const auto rendered =
      render_panes(panes, viewport, output, used, force_full, row_offset, composition);
  if (!rendered.has_value()) {
    return std::unexpected(rendered.error());
  }
  // A pane-level repair does not make the protocol frame complete when suppression omitted a
  // surface. In that case no full-screen clear was emitted and the full-redraw generation must not
  // advance.
  composition.full = composition.full && complete_frame;
  if (!finish_frame(output, used, *validation)) {
    invalidate_panes(panes);
    return std::unexpected(CompositionError::output_exhausted);
  }
  composition.bytes = used;
  return composition;
}

} // namespace lemma::render
