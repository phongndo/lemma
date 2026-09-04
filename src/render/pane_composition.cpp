#include "render/pane_composition.hpp"

#include "lemma/assert.hpp"
#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"
#include "render/ui.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <iterator>
#include <optional>
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
constexpr std::size_t status_label_bytes_max = status_session_columns_max + 4U;
constexpr std::string_view status_group_separator = " | ";
constexpr std::string_view status_create_button = "  +";

[[nodiscard]] constexpr auto status_leading_columns(const std::size_t session_columns) noexcept
    -> std::size_t {
  return session_columns == 0 ? 0U : session_columns + status_group_separator.size();
}

struct StatusLabel final {
  std::array<char, status_label_bytes_max> text{};
  std::size_t size{0};
  bool active{false};
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
  label.active = tab.active;
  const auto append_character = [&](const char character) {
    std::span(label.text).subspan(label.size, 1).front() = character;
    ++label.size;
  };
  if (tab.active) {
    append_character('[');
    append_character(' ');
    const auto result = std::to_chars(std::span(label.text).subspan(label.size).data(),
                                      label.text.end(), tab.number);
    if (result.ec != std::errc{}) {
      return {};
    }
    label.size = static_cast<std::size_t>(std::distance(label.text.begin(), result.ptr));
    append_character(':');
    if (title_columns_max > 0) {
      label.size += sanitized_title(
          tab.title, std::span(label.text).subspan(label.size).first(title_columns_max));
    }
    append_character(' ');
    append_character(']');
    return label;
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

struct PromptValueProjection final {
  std::size_t begin{0};
  std::size_t size{0};
  std::size_t cursor{0};
};

[[nodiscard]] constexpr auto prompt_value_projection(const StatusLine status,
                                                     const std::size_t capacity) noexcept
    -> PromptValueProjection {
  if (capacity == 0) {
    return {};
  }
  const auto cursor = std::min(status.prompt_cursor, status.prompt_value.size());
  const auto begin = cursor > capacity ? cursor - capacity : 0U;
  return {
      .begin = begin,
      .size = std::min(status.prompt_value.size() - begin, capacity),
      .cursor = std::min(cursor - begin, capacity),
  };
}

[[nodiscard]] constexpr auto bounded_status_view(std::string_view value, const std::size_t begin,
                                                 const std::size_t size) noexcept
    -> std::string_view {
  value.remove_prefix(std::min(begin, value.size()));
  value.remove_suffix(value.size() - std::min(size, value.size()));
  return value;
}

struct PromptField final {
  StatusLabel label;
  std::size_t edit_offset{0};
  std::size_t edit_size{0};
  std::size_t cursor_offset{0};
};

void append_label_character(StatusLabel& label, const char character) noexcept {
  LEMMA_ASSERT(label.size < label.text.size());
  std::span(label.text).subspan(label.size, 1).front() = character;
  ++label.size;
}

void append_label_text(StatusLabel& label, const std::string_view text) noexcept {
  LEMMA_ASSERT(text.size() <= label.text.size() - label.size);
  std::memcpy(std::span(label.text).subspan(label.size).data(), text.data(), text.size());
  label.size += text.size();
}

[[nodiscard]] auto editable_session_label(const StatusLine status,
                                          const std::size_t value_capacity) noexcept
    -> PromptField {
  PromptField field;
  append_label_character(field.label, ' ');
  field.edit_offset = field.label.size;
  const auto value =
      prompt_value_projection(status, std::min(value_capacity, status_session_columns_max));
  append_label_text(field.label, bounded_status_view(status.prompt_value, value.begin, value.size));
  field.edit_size = value.size;
  field.cursor_offset = field.edit_offset + value.cursor;
  append_label_character(field.label, ' ');
  return field;
}

[[nodiscard]] auto editable_tab_label(const StatusLine status, const std::uint16_t tab_number,
                                      const std::size_t value_capacity) noexcept -> PromptField {
  PromptField field;
  field.label.active = true;
  append_label_character(field.label, '[');
  append_label_character(field.label, ' ');
  const auto result = std::to_chars(std::span(field.label.text).subspan(field.label.size).data(),
                                    field.label.text.end(), tab_number);
  if (result.ec != std::errc{}) {
    return {};
  }
  field.label.size = static_cast<std::size_t>(std::distance(field.label.text.begin(), result.ptr));
  append_label_character(field.label, ':');
  field.edit_offset = field.label.size;
  const auto value =
      prompt_value_projection(status, std::min(value_capacity, status_title_columns_max));
  append_label_text(field.label, bounded_status_view(status.prompt_value, value.begin, value.size));
  field.edit_size = value.size;
  field.cursor_offset = field.edit_offset + value.cursor;
  append_label_character(field.label, ' ');
  append_label_character(field.label, ']');
  return field;
}

[[nodiscard]] auto editable_bare_label(const StatusLine status, const std::size_t capacity) noexcept
    -> PromptField {
  PromptField field;
  if (capacity == 0) {
    return field;
  }
  const auto value = prompt_value_projection(status, capacity - 1U);
  append_label_text(field.label, bounded_status_view(status.prompt_value, value.begin, value.size));
  field.edit_size = value.size;
  field.cursor_offset = value.cursor;
  append_label_character(field.label, ' ');
  return field;
}

[[nodiscard]] constexpr auto prompt_message(const StatusLine status) noexcept -> std::string_view {
  switch (status.prompt_feedback) {
  case StatusPromptFeedback::none:
    return {};
  case StatusPromptFeedback::conflict:
    return "Session already exists";
  case StatusPromptFeedback::invalid:
    return status.prompt_target == StatusPromptTarget::session ? "Invalid session name"
                                                               : "Invalid tab title";
  }
  return {};
}

struct InlineStatusPromptProjection final {
  StatusLabel session;
  std::array<StatusLabel, status_tabs_max> labels{};
  PromptField field;
  std::string_view message;
  std::size_t label_count{0};
  std::size_t active{0};
  std::size_t begin{0};
  std::size_t end{0};
  std::uint16_t tab_column{1};
  std::uint16_t cursor_column{1};
  bool show_tabs{false};
  bool show_message{false};
  bool bare_field{false};
};

// Prompt projection prioritizes the edited identity, then the active context, then neighboring
// tabs and feedback. Narrow terminals degrade to the horizontally-scrolled field alone.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto inline_status_prompt_projection(const StatusLine status,
                                                   const Viewport viewport) noexcept
    -> InlineStatusPromptProjection {
  InlineStatusPromptProjection projection;
  projection.label_count = status.tabs.size();
  auto labels = std::span(projection.labels).first(projection.label_count);
  for (std::size_t index = 0; index < status.tabs.size(); ++index) {
    const auto& tab = status.tabs.subspan(index, 1).front();
    labels.subspan(index, 1).front() = status_label(tab);
    if (tab.active) {
      projection.active = index;
    }
  }

  const auto columns = static_cast<std::size_t>(viewport.columns);
  if (status.prompt_target == StatusPromptTarget::session) {
    projection.field = editable_session_label(status, status_session_columns_max);
    projection.session = projection.field.label;
  } else {
    projection.session = session_label(status.session_name, columns);
    projection.field = editable_tab_label(
        status, status.tabs.subspan(projection.active, 1).front().number, status_title_columns_max);
    labels.subspan(projection.active, 1).front() = projection.field.label;
  }

  const auto tab_columns_for = [](const std::size_t available,
                                  const std::size_t session_columns) noexcept {
    const auto leading_columns = status_leading_columns(session_columns);
    return leading_columns < available ? available - leading_columns : std::size_t{0};
  };
  projection.message = prompt_message(status);
  auto active_width = labels.subspan(projection.active, 1).front().size;
  const auto minimum_left = status_leading_columns(projection.session.size) + active_width;
  projection.show_message =
      !projection.message.empty() && minimum_left + 2U + projection.message.size() <= columns;
  auto left_columns = projection.show_message ? columns - projection.message.size() - 2U : columns;

  if (status.prompt_target == StatusPromptTarget::active_tab && minimum_left > left_columns) {
    const auto reserved_columns = active_width + status_group_separator.size();
    const auto session_columns =
        left_columns > reserved_columns ? left_columns - reserved_columns : 0U;
    projection.session = session_label(status.session_name, session_columns);
  }

  auto tab_columns = tab_columns_for(left_columns, projection.session.size);
  if (status.prompt_target == StatusPromptTarget::active_tab && active_width > tab_columns) {
    auto capacity = status_title_columns_max;
    while (capacity > 1U && projection.field.label.size > tab_columns) {
      --capacity;
      projection.field = editable_tab_label(
          status, status.tabs.subspan(projection.active, 1).front().number, capacity);
    }
    labels.subspan(projection.active, 1).front() = projection.field.label;
    active_width = projection.field.label.size;
  }

  if (status.prompt_target == StatusPromptTarget::session &&
      projection.session.size > left_columns) {
    projection.field = left_columns >= 3U ? editable_session_label(status, left_columns - 2U)
                                          : editable_bare_label(status, left_columns);
    projection.session = projection.field.label;
    projection.show_tabs = false;
    projection.show_message = false;
    left_columns = columns;
  } else {
    tab_columns = tab_columns_for(left_columns, projection.session.size);
    projection.show_tabs = active_width <= tab_columns &&
                           (status.prompt_target != StatusPromptTarget::active_tab ||
                            status.prompt_value.empty() || projection.field.edit_size > 0);
  }

  if (status.prompt_target == StatusPromptTarget::active_tab && !projection.show_tabs) {
    projection.session = {};
    projection.field = editable_bare_label(status, left_columns);
    labels.subspan(projection.active, 1).front() = projection.field.label;
    projection.show_tabs = projection.field.label.size <= left_columns;
    projection.show_message = false;
    projection.bare_field = true;
    tab_columns = left_columns;
  }

  projection.tab_column =
      static_cast<std::uint16_t>(status_leading_columns(projection.session.size) + 1U);
  projection.begin = projection.active;
  projection.end = projection.active;
  if (projection.show_tabs && !projection.bare_field) {
    bool try_left = true;
    bool left_blocked = projection.begin == 0;
    bool right_blocked = projection.end + 1U == labels.size();
    while (!left_blocked || !right_blocked) {
      const bool use_left = (try_left && !left_blocked) || right_blocked;
      const auto candidate_begin = use_left ? projection.begin - 1U : projection.begin;
      const auto candidate_end = use_left ? projection.end : projection.end + 1U;
      if (status_width(labels, candidate_begin, candidate_end) <= tab_columns) {
        projection.begin = candidate_begin;
        projection.end = candidate_end;
      } else if (use_left) {
        left_blocked = true;
      } else {
        right_blocked = true;
      }
      left_blocked = left_blocked || projection.begin == 0;
      right_blocked = right_blocked || projection.end + 1U == labels.size();
      try_left = !try_left;
    }
  }

  std::size_t cursor_column = 1U;
  if (status.prompt_target == StatusPromptTarget::session) {
    cursor_column += projection.field.cursor_offset;
  } else {
    cursor_column = projection.tab_column;
    cursor_column += projection.begin > 0 && !projection.bare_field ? 2U : 0U;
    for (std::size_t index = projection.begin; index < projection.active; ++index) {
      cursor_column += labels.subspan(index, 1).front().size + 2U;
    }
    cursor_column += projection.field.cursor_offset;
  }
  projection.cursor_column =
      static_cast<std::uint16_t>(std::clamp(cursor_column, std::size_t{1}, columns));
  return projection;
}

struct StatusLineProjection final {
  std::array<StatusLabel, status_tabs_max> labels{};
  StatusLabel session;
  std::size_t label_count{0};
  std::size_t begin{0};
  std::size_t end{0};
  std::uint16_t tab_column{1};
  std::uint16_t create_column{0};
  bool show_range{false};
  bool show_create{false};
};

// Rendering and mouse hit testing consume this same bounded projection so visible labels have one
// geometry owner. Its branches preserve the active tab under narrow-terminal degradation.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto status_line_projection(const StatusLine status, const Viewport viewport) noexcept
    -> StatusLineProjection {
  StatusLineProjection projection;
  projection.label_count = status.tabs.size();
  auto labels = std::span(projection.labels).first(projection.label_count);
  std::size_t active = 0;
  for (std::size_t index = 0; index < status.tabs.size(); ++index) {
    const auto& tab = status.tabs.subspan(index, 1).front();
    labels.subspan(index, 1).front() = status_label(tab);
    if (tab.active) {
      active = index;
    }
  }

  const auto content_columns = static_cast<std::size_t>(viewport.columns);
  const auto active_width = labels.subspan(active, 1).front().size;
  const auto separator_reservation =
      status.session_name.empty() ? 0U : status_group_separator.size();
  const bool create_available = status.tabs.size() < status_tabs_max;
  const auto create_reservation =
      create_available && active_width + status_create_button.size() <= content_columns
          ? status_create_button.size()
          : 0U;
  const auto session_reservation = active_width + separator_reservation + create_reservation;
  const auto session_columns_max =
      session_reservation < content_columns ? content_columns - session_reservation : 0U;
  projection.session = session_label(status.session_name, session_columns_max);
  const auto leading_columns = status_leading_columns(projection.session.size);
  const auto available_tab_columns = content_columns - leading_columns;
  projection.show_create =
      create_available && active_width + status_create_button.size() <= available_tab_columns;
  const auto tab_columns =
      available_tab_columns - (projection.show_create ? status_create_button.size() : 0U);

  auto title_columns = status_title_columns_max;
  while (labels.subspan(active, 1).front().size > tab_columns && title_columns > 0U) {
    --title_columns;
    labels.subspan(active, 1).front() =
        status_label(status.tabs.subspan(active, 1).front(), title_columns);
  }
  if (labels.subspan(active, 1).front().size > tab_columns) {
    auto& label = labels.subspan(active, 1).front();
    constexpr std::string_view empty_active = "[  ]";
    label.size = std::min(tab_columns, empty_active.size());
    std::ranges::copy(std::span(empty_active.data(), empty_active.size()).first(label.size),
                      label.text.begin());
  }

  projection.begin = active;
  projection.end = active;
  if (status_width(labels, projection.begin, projection.end) <= tab_columns) {
    bool try_left = true;
    bool left_blocked = projection.begin == 0;
    bool right_blocked = projection.end + 1U == labels.size();
    while (!left_blocked || !right_blocked) {
      const bool use_left = (try_left && !left_blocked) || right_blocked;
      const auto candidate_begin = use_left ? projection.begin - 1U : projection.begin;
      const auto candidate_end = use_left ? projection.end : projection.end + 1U;
      if (status_width(labels, candidate_begin, candidate_end) <= tab_columns) {
        projection.begin = candidate_begin;
        projection.end = candidate_end;
      } else if (use_left) {
        left_blocked = true;
      } else {
        right_blocked = true;
      }
      left_blocked = left_blocked || projection.begin == 0;
      right_blocked = right_blocked || projection.end + 1U == labels.size();
      try_left = !try_left;
    }
  }

  projection.show_range = status_width(labels, projection.begin, projection.end) <= tab_columns;
  if (!projection.show_range) {
    projection.begin = active;
    projection.end = active;
  }
  projection.tab_column = static_cast<std::uint16_t>(leading_columns + 1U);
  const auto rendered_tab_columns = projection.show_range
                                        ? status_width(labels, projection.begin, projection.end)
                                        : labels.subspan(projection.begin, 1).front().size;
  if (projection.show_create) {
    projection.create_column = static_cast<std::uint16_t>(
        projection.tab_column - 1U + rendered_tab_columns + status_create_button.size() - 1U);
  }
  return projection;
}

constexpr ui::Style status_default_cell_style{};
constexpr ui::Style status_identity_cell_style{.attributes = ui::attribute_bold};
constexpr ui::Style status_prompt_cell_style{.attributes =
                                                 ui::attribute_bold | ui::attribute_underline};

[[nodiscard]] constexpr auto utf8_scalar_size(const std::uint8_t first) noexcept -> std::size_t {
  if (first < 0x80U) {
    return 1;
  }
  if (first < 0xE0U) {
    return 2;
  }
  if (first < 0xF0U) {
    return 3;
  }
  return 4;
}

[[nodiscard]] auto write_status_text(const std::span<ui::Cell> cells, std::size_t& column,
                                     const std::string_view text, const ui::Style style) noexcept
    -> bool {
  const std::span text_bytes(text.data(), text.size());
  std::size_t offset = 0;
  while (offset < text_bytes.size()) {
    if (column >= cells.size()) {
      return false;
    }
    const auto first = static_cast<std::uint8_t>(text_bytes.subspan(offset, 1).front());
    const auto size = utf8_scalar_size(first);
    if (size > text_bytes.size() - offset || size > ui::cell_text_bytes_max) {
      return false;
    }
    auto& cell = cells.subspan(column, 1).front();
    std::memcpy(cell.text.data(), text_bytes.subspan(offset, size).data(), size);
    cell.style = style;
    cell.text_size = static_cast<std::uint8_t>(size);
    cell.painted = true;
    ++column;
    offset += size;
  }
  return true;
}

[[nodiscard]] auto write_status_label(const std::span<ui::Cell> cells, std::size_t& column,
                                      const StatusLabel& label, const ui::Style style) noexcept
    -> bool {
  return write_status_text(cells, column, std::string_view(label.text.data(), label.size), style);
}

[[nodiscard]] auto write_prompt_field(const std::span<ui::Cell> cells, std::size_t& column,
                                      const PromptField& field, const ui::Style base,
                                      const ui::Style edit) noexcept -> bool {
  const auto text = std::string_view(field.label.text.data(), field.label.size);
  return write_status_text(cells, column, bounded_status_view(text, 0, field.edit_offset), base) &&
         write_status_text(cells, column,
                           bounded_status_view(text, field.edit_offset, field.edit_size), edit) &&
         write_status_text(
             cells, column,
             bounded_status_view(text, field.edit_offset + field.edit_size, text.size()), base);
}

struct ModalPromptProjection final {
  PromptValueProjection value;
  std::uint16_t cursor_column{1};
};

[[nodiscard]] constexpr auto modal_prompt_projection(const StatusLine status,
                                                     const Viewport viewport) noexcept
    -> ModalPromptProjection {
  ModalPromptProjection projection;
  const auto columns = static_cast<std::size_t>(viewport.columns);
  const auto capacity = columns > 1U ? columns - 1U : 0U;
  projection.value = prompt_value_projection(status, capacity);
  projection.cursor_column = static_cast<std::uint16_t>(
      std::clamp(std::size_t{2} + projection.value.cursor, std::size_t{1}, columns));
  return projection;
}

[[nodiscard]] constexpr auto is_modal_prompt(const StatusPromptTarget target) noexcept -> bool {
  return target == StatusPromptTarget::command_line ||
         target == StatusPromptTarget::copy_search_forward ||
         target == StatusPromptTarget::copy_search_backward;
}

[[nodiscard]] constexpr auto modal_prompt_prefix(const StatusPromptTarget target) noexcept
    -> std::string_view {
  switch (target) {
  case StatusPromptTarget::command_line:
    return ":";
  case StatusPromptTarget::copy_search_forward:
    return "/";
  case StatusPromptTarget::copy_search_backward:
    return "?";
  case StatusPromptTarget::none:
  case StatusPromptTarget::session:
  case StatusPromptTarget::active_tab:
  case StatusPromptTarget::message:
    return {};
  }
  return {};
}

[[nodiscard]] auto build_modal_prompt_cells(const StatusLine status, const Viewport viewport,
                                            const std::span<ui::Cell> cells) noexcept -> bool {
  const auto projection = modal_prompt_projection(status, viewport);
  std::size_t column = 0;
  return write_status_text(cells, column, modal_prompt_prefix(status.prompt_target),
                           status_identity_cell_style) &&
         write_status_text(cells, column,
                           bounded_status_view(status.prompt_value, projection.value.begin,
                                               projection.value.size),
                           status_identity_cell_style);
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto build_status_prompt_cells(const StatusLine status, const Viewport viewport,
                                             const std::span<ui::Cell> cells) noexcept -> bool {
  if (is_modal_prompt(status.prompt_target)) {
    return build_modal_prompt_cells(status, viewport, cells);
  }
  const auto projection = inline_status_prompt_projection(status, viewport);
  std::size_t column = 0;
  if (projection.session.size > 0) {
    if (status.prompt_target == StatusPromptTarget::session) {
      if (!write_prompt_field(cells, column, projection.field, status_identity_cell_style,
                              status_prompt_cell_style)) {
        return false;
      }
    } else if (!write_status_label(cells, column, projection.session, status_identity_cell_style)) {
      return false;
    }
  }
  if (projection.session.size > 0 && projection.show_tabs &&
      !write_status_text(cells, column, status_group_separator, status_default_cell_style)) {
    return false;
  }
  if (projection.show_tabs) {
    column = projection.tab_column - 1U;
    const auto labels = std::span(projection.labels).first(projection.label_count);
    if (!projection.bare_field && projection.begin > 0 &&
        !write_status_text(cells, column, "… ", status_default_cell_style)) {
      return false;
    }
    for (std::size_t index = projection.begin; index <= projection.end; ++index) {
      const auto& label = labels.subspan(index, 1).front();
      const bool editable =
          status.prompt_target == StatusPromptTarget::active_tab && index == projection.active;
      if ((editable && !write_prompt_field(cells, column, projection.field,
                                           status_identity_cell_style, status_prompt_cell_style)) ||
          (!editable && !write_status_label(cells, column, label,
                                            label.active ? status_identity_cell_style
                                                         : status_default_cell_style)) ||
          (index < projection.end &&
           !write_status_text(cells, column, "  ", status_default_cell_style))) {
        return false;
      }
    }
    if (!projection.bare_field && projection.end + 1U < labels.size() &&
        !write_status_text(cells, column, " …", status_default_cell_style)) {
      return false;
    }
  }
  if (projection.show_message) {
    column = viewport.columns - projection.message.size();
    if (!write_status_text(cells, column, projection.message, status_identity_cell_style)) {
      return false;
    }
  }
  return true;
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto build_status_cells(const StatusLine status, const Viewport viewport,
                                      const std::span<ui::Cell> cells) noexcept -> bool {
  if (status.prompt_target == StatusPromptTarget::message) {
    std::size_t column = 0;
    return write_status_text(
        cells, column,
        bounded_status_view(
            status.input_context, 0,
            std::min(status.input_context.size(), static_cast<std::size_t>(viewport.columns))),
        status_identity_cell_style);
  }
  if (status.prompting()) {
    return build_status_prompt_cells(status, viewport, cells);
  }
  if (!status.input_context.empty()) {
    std::size_t column = 0;
    return write_status_text(
        cells, column,
        bounded_status_view(
            status.input_context, 0,
            std::min(status.input_context.size(), static_cast<std::size_t>(viewport.columns))),
        status_identity_cell_style);
  }
  const auto projection = status_line_projection(status, viewport);
  const auto labels = std::span(projection.labels).first(projection.label_count);
  std::size_t column = 0;
  if (projection.session.size > 0 &&
      (!write_status_label(cells, column, projection.session, status_identity_cell_style) ||
       !write_status_text(cells, column, status_group_separator, status_default_cell_style))) {
    return false;
  }
  column = projection.tab_column - 1U;
  if (projection.show_range) {
    if (projection.begin > 0 &&
        !write_status_text(cells, column, "… ", status_default_cell_style)) {
      return false;
    }
    for (std::size_t index = projection.begin; index <= projection.end; ++index) {
      const auto& label = labels.subspan(index, 1).front();
      if (!write_status_label(cells, column, label,
                              label.active ? status_identity_cell_style
                                           : status_default_cell_style) ||
          (index < projection.end &&
           !write_status_text(cells, column, "  ", status_default_cell_style))) {
        return false;
      }
    }
    if (projection.end + 1U < labels.size() &&
        !write_status_text(cells, column, " …", status_default_cell_style)) {
      return false;
    }
  } else if (!write_status_label(cells, column, labels.subspan(projection.begin, 1).front(),
                                 status_identity_cell_style)) {
    return false;
  }
  return !projection.show_create ||
         write_status_text(cells, column, status_create_button, status_default_cell_style);
}

// Default status and prompt content share one bounded cell projection and painter.
[[nodiscard]] auto render_status_line(const StatusLine status, const Viewport viewport,
                                      const std::span<std::byte> output, std::size_t& used) noexcept
    -> bool {
  if (status.tabs.empty() || viewport.rows < 2) {
    return true;
  }
  std::array<ui::Cell, limits::terminal_columns_hard_max> storage{};
  const auto cells = std::span(storage).first(viewport.columns);
  return build_status_cells(status, viewport, cells) &&
         ui::paint_cells({.columns = viewport.columns, .rows = 1}, viewport.columns, 1, cells,
                         output, used);
}

void build_message_view_cells(const MessageViewLine line,
                              const std::span<ui::Cell> cells) noexcept {
  const auto text = std::span(line.text).first(std::min(line.text.size(), cells.size()));
  auto destination = cells.begin();
  for (const char character : text) {
    auto& cell = *destination;
    ++destination;
    cell.text.front() = character;
    cell.text_size = 1;
    cell.painted = true;
    cell.style.attributes = line.error ? ui::attribute_bold : 0;
  }
}

[[nodiscard]] auto message_view_line_at_row(const MessageView message_view, const std::uint16_t row,
                                            const std::size_t first_line_row) noexcept
    -> std::optional<MessageViewLine> {
  if (row < first_line_row) {
    return std::nullopt;
  }
  const auto index = static_cast<std::size_t>(row) - first_line_row;
  return index < message_view.lines.size()
             ? std::optional{message_view.lines.subspan(index, 1U).front()}
             : std::nullopt;
}

[[nodiscard]] auto render_message_view(const MessageView message_view, const PaneRectangle content,
                                       const std::span<std::byte> output,
                                       std::size_t& used) noexcept -> bool {
  if (!message_view.active) {
    return true;
  }
  std::array<ui::Cell, limits::terminal_columns_hard_max> storage{};
  const auto cells = std::span(storage).first(content.columns);
  const auto first_line_row =
      content.rows > message_view.lines.size() ? content.rows - message_view.lines.size() : 0U;
  for (std::uint16_t row = 0; row < content.rows; ++row) {
    std::ranges::fill(cells, ui::Cell{});
    if (const auto line = message_view_line_at_row(message_view, row, first_line_row);
        line.has_value()) {
      build_message_view_cells(*line, cells);
    }
    if (!ui::paint_cells({.row = static_cast<std::uint16_t>(content.row + row),
                          .columns = content.columns,
                          .rows = 1},
                         content.columns, 1, cells, output, used)) {
      return false;
    }
  }
  return true;
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

void invalidate_pane_mode_projections(const std::span<const PaneSurface> panes) noexcept {
  for (const auto& pane : panes) {
    pane.terminal->invalidate_ansi_mode_projection();
  }
}

void invalidate_focused_cursor_projection(const std::span<const PaneSurface> panes) noexcept {
  const auto focused = std::ranges::find(panes, true, &PaneSurface::focused);
  if (focused != panes.end()) {
    focused->terminal->invalidate_ansi_cursor_projection();
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

[[nodiscard]] constexpr auto valid_prompt_target(const StatusPromptTarget target) noexcept -> bool {
  switch (target) {
  case StatusPromptTarget::none:
  case StatusPromptTarget::session:
  case StatusPromptTarget::active_tab:
  case StatusPromptTarget::command_line:
  case StatusPromptTarget::copy_search_forward:
  case StatusPromptTarget::copy_search_backward:
  case StatusPromptTarget::message:
    return true;
  }
  return false;
}

[[nodiscard]] constexpr auto valid_prompt_feedback(const StatusPromptFeedback feedback) noexcept
    -> bool {
  switch (feedback) {
  case StatusPromptFeedback::none:
  case StatusPromptFeedback::invalid:
  case StatusPromptFeedback::conflict:
    return true;
  }
  return false;
}

[[nodiscard]] constexpr auto prompt_capacity(const StatusPromptTarget target) noexcept
    -> std::size_t {
  switch (target) {
  case StatusPromptTarget::session:
    return limits::session_name_bytes_max;
  case StatusPromptTarget::command_line:
    return limits::command_line_bytes_max;
  case StatusPromptTarget::copy_search_forward:
  case StatusPromptTarget::copy_search_backward:
    return limits::search_query_bytes_max;
  case StatusPromptTarget::active_tab:
    return limits::tab_title_bytes_max;
  case StatusPromptTarget::none:
  case StatusPromptTarget::message:
    return 0;
  }
  return 0;
}

[[nodiscard]] auto valid_prompt_value(const StatusLine status) noexcept -> bool {
  if (!status.prompting()) {
    return status.prompt_value.empty() && status.prompt_cursor == 0;
  }
  const auto valid_character = [target = status.prompt_target](const char character) {
    const auto byte = static_cast<unsigned char>(character);
    if (target == StatusPromptTarget::session) {
      return (byte >= static_cast<unsigned char>('a') && byte <= static_cast<unsigned char>('z')) ||
             (byte >= static_cast<unsigned char>('A') && byte <= static_cast<unsigned char>('Z')) ||
             (byte >= static_cast<unsigned char>('0') && byte <= static_cast<unsigned char>('9')) ||
             byte == static_cast<unsigned char>('_') || byte == static_cast<unsigned char>('-');
    }
    return byte >= 0x20U && byte <= 0x7eU;
  };
  return status.prompt_value.size() <= prompt_capacity(status.prompt_target) &&
         std::ranges::all_of(status.prompt_value, valid_character);
}

[[nodiscard]] auto valid_status(const StatusLine status) noexcept -> bool {
  const auto printable = [](const char character) {
    const auto byte = static_cast<unsigned char>(character);
    return byte >= 0x20U && byte <= 0x7eU;
  };
  const auto context_capacity = status.prompt_target == StatusPromptTarget::message
                                    ? limits::status_message_bytes_max
                                    : status_context_bytes_max;
  const bool valid_context =
      status.input_context.size() <= context_capacity &&
      (!is_modal_prompt(status.prompt_target) || status.input_context.empty()) &&
      (status.prompt_target != StatusPromptTarget::message || !status.input_context.empty()) &&
      std::ranges::all_of(status.input_context, printable);
  return valid_context && valid_prompt_target(status.prompt_target) &&
         valid_prompt_feedback(status.prompt_feedback) && valid_prompt_value(status) &&
         status.tabs.size() <= status_tabs_max &&
         (status.tabs.empty() || std::ranges::count(status.tabs, true, &StatusTab::active) == 1) &&
         std::ranges::none_of(status.tabs, [](const StatusTab& tab) { return tab.number == 0; }) &&
         status.prompt_cursor <= status.prompt_value.size() &&
         (!status.prompting() || !status.tabs.empty()) &&
         (status.prompting() || status.prompt_feedback == StatusPromptFeedback::none);
}

[[nodiscard]] constexpr auto has_visible_status(const Viewport viewport,
                                                const StatusLine status) noexcept -> bool {
  return !status.tabs.empty() && viewport.rows >= 2;
}

[[nodiscard]] auto valid_message_view(const MessageView message_view) noexcept -> bool {
  const auto printable = [](const char character) {
    const auto byte = static_cast<unsigned char>(character);
    return byte >= 0x20U && byte <= 0x7eU;
  };
  return message_view.lines.size() <= limits::status_message_history_max &&
         (message_view.active || message_view.lines.empty()) &&
         std::ranges::all_of(message_view.lines, [&](const MessageViewLine& line) {
           return !line.text.empty() && line.text.size() <= message_view_line_bytes_max &&
                  std::ranges::all_of(line.text, printable);
         });
}

// Composition validation deliberately keeps geometry, overlap, and focus checks in one pass.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto validate_composition(const std::span<const PaneSurface> panes,
                                        const Viewport viewport, const Viewport content_viewport,
                                        const StatusLine status,
                                        const MessageView message_view) noexcept
    -> std::expected<bool, CompositionError> {
  if (!valid_viewport(viewport)) {
    return std::unexpected(CompositionError::invalid_viewport);
  }
  if (panes.size() > limits::panes_hard_max) {
    return std::unexpected(CompositionError::too_many_panes);
  }
  if (!valid_status(status) || !valid_message_view(message_view)) {
    return std::unexpected(CompositionError::invalid_status);
  }
  bool has_focus = false;
  bool has_presented_focus = false;
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
                                  const bool allow_terminal_scroll, const bool allow_line_erase,
                                  const std::uint16_t column_offset, const std::uint16_t row_offset,
                                  CompositionResult& composition) noexcept
    -> std::expected<void, CompositionError> {
  const vt::PaneRenderOptions options{
      .column = static_cast<std::uint16_t>(pane.rectangle.column + column_offset),
      .row = static_cast<std::uint16_t>(pane.rectangle.row + row_offset),
      .cursor_override_column = pane.cursor_override_column,
      .cursor_override_row = pane.cursor_override_row,
      .force_full = force_full,
      .focused = pane.focused,
      .cursor_override = pane.cursor_override,
      .allow_terminal_scroll = allow_terminal_scroll,
      .allow_line_erase = allow_line_erase,
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
                                const bool force_full, const std::uint16_t column_offset,
                                const std::uint16_t row_offset,
                                CompositionResult& composition) noexcept
    -> std::expected<void, CompositionError> {
  // Hardware scrolling is safe only when the pane owns the outer terminal's full origin and width;
  // otherwise it would move status or neighboring content.
  const bool allow_terminal_scroll =
      column_offset == 0 && row_offset == 0 && is_single_full_viewport(panes, viewport);
  for (const auto& pane : panes) {
    if (!pane.focused && !pane.presentation_suppressed) {
      const bool allow_line_erase =
          pane.rectangle.column + pane.rectangle.columns == viewport.columns;
      const auto rendered =
          render_surface(pane, output, used, force_full, allow_terminal_scroll, allow_line_erase,
                         column_offset, row_offset, composition);
      if (!rendered.has_value()) {
        invalidate_panes(panes);
        return rendered;
      }
    }
  }
  for (const auto& pane : panes) {
    if (pane.focused && !pane.presentation_suppressed) {
      const bool allow_line_erase =
          pane.rectangle.column + pane.rectangle.columns == viewport.columns;
      const auto rendered =
          render_surface(pane, output, used, force_full, allow_terminal_scroll, allow_line_erase,
                         column_offset, row_offset, composition);
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
                                     const std::uint16_t column_offset,
                                     const std::uint16_t row_offset) noexcept -> bool {
  if (!pane.border_right) {
    return true;
  }
  const auto column = static_cast<std::uint16_t>(pane.rectangle.column + pane.rectangle.columns);
  const auto bottom = static_cast<std::uint16_t>(pane.rectangle.row + pane.rectangle.rows);
  for (std::uint16_t row = pane.rectangle.row; row < bottom; ++row) {
    if (!append_position(output, used, static_cast<std::uint16_t>(row + row_offset + 1U),
                         static_cast<std::uint16_t>(column + column_offset + 1U)) ||
        !append(output, used, border_glyph(panes, row, column))) {
      return false;
    }
  }
  return true;
}

[[nodiscard]] auto draw_bottom_border(const PaneSurface& pane,
                                      const std::span<const PaneSurface> panes,
                                      const std::span<std::byte> output, std::size_t& used,
                                      const std::uint16_t column_offset,
                                      const std::uint16_t row_offset) noexcept -> bool {
  if (!pane.border_bottom) {
    return true;
  }
  const auto row = static_cast<std::uint16_t>(pane.rectangle.row + pane.rectangle.rows);
  const auto right = static_cast<std::uint16_t>(pane.rectangle.column + pane.rectangle.columns);
  for (std::uint16_t column = pane.rectangle.column; column < right; ++column) {
    if (!append_position(output, used, static_cast<std::uint16_t>(row + row_offset + 1U),
                         static_cast<std::uint16_t>(column + column_offset + 1U)) ||
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
                                  const std::uint16_t column_offset,
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
                                static_cast<std::uint16_t>(column + column_offset + 1U)) ||
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
                                const std::uint16_t column_offset,
                                const std::uint16_t row_offset) noexcept -> bool {
  if (!append(output, used, "\x1B[90m")) {
    return false;
  }
  for (const auto& pane : panes) {
    if (!draw_right_border(pane, panes, output, used, column_offset, row_offset) ||
        !draw_bottom_border(pane, panes, output, used, column_offset, row_offset)) {
      return false;
    }
  }
  return draw_junctions(panes, output, used, column_offset, row_offset) &&
         append(output, used, "\x1B[0m");
}

struct CompositionPolicy final {
  OuterModeProjection outer_modes{OuterModeProjection::neutral};
};

[[nodiscard]] auto composition_policy(const std::span<const PaneSurface> panes,
                                      const Viewport viewport, const Viewport content_viewport,
                                      const StatusLine status,
                                      const MessageView message_view) noexcept
    -> std::expected<CompositionPolicy, CompositionError> {
  const auto validation =
      validate_composition(panes, viewport, content_viewport, status, message_view);
  if (!validation.has_value()) {
    return std::unexpected(validation.error());
  }
  if (!*validation || message_view.active) {
    return CompositionPolicy{};
  }
  const auto focused = std::ranges::find(panes, true, &PaneSurface::focused);
  if (focused == panes.end()) {
    return CompositionPolicy{};
  }
  const auto tracking = focused->terminal->mouse_tracking();
  if (!tracking.has_value()) {
    return std::unexpected(CompositionError::terminal_error);
  }
  return CompositionPolicy{
      .outer_modes = tracking->unbuttoned_motion ? OuterModeProjection::any_mouse
                                                 : OuterModeProjection::button_mouse,
  };
}

[[nodiscard]] auto render_status_prompt_cursor(const StatusLine status, const Viewport viewport,
                                               const std::span<std::byte> output,
                                               std::size_t& used) noexcept -> bool {
  if (!status.prompting() || viewport.rows < 2) {
    return true;
  }
  const auto cursor_column = is_modal_prompt(status.prompt_target)
                                 ? modal_prompt_projection(status, viewport).cursor_column
                                 : inline_status_prompt_projection(status, viewport).cursor_column;
  // A steady block marks the insertion point without styling the cursor cell.
  return append_position(output, used, 1, cursor_column) &&
         append(output, used, "\x1B[2 q\x1B[?25h");
}

[[nodiscard]] auto finish_frame(const std::span<std::byte> output, std::size_t& used,
                                const OuterModeProjection outer_modes,
                                const bool project_outer_modes) noexcept -> bool {
  constexpr std::string_view neutral_modes =
      "\x1B[?1l\x1B[?9l\x1B[?1000l\x1B[?1002l\x1B[?1003l\x1B[?1004l"
      "\x1B[?1005l\x1B[?1006l\x1B[?1007l\x1B[?1015l\x1B[?1016l\x1B[?2004l";
  // Mouse event and encoding modes are each mutually exclusive. Disable competing modes before
  // enabling the desired one: a later reset would otherwise replace the active mode with `none`
  // or the legacy X10 encoding in terminals such as Ghostty.
  constexpr std::string_view button_mouse_capture =
      "\x1B[?9l\x1B[?1000l\x1B[?1003l\x1B[?1002h\x1B[?1005l\x1B[?1015l"
      "\x1B[?1016l\x1B[?1006h";
  constexpr std::string_view any_mouse_capture =
      "\x1B[?9l\x1B[?1000l\x1B[?1002l\x1B[?1003h\x1B[?1005l\x1B[?1015l"
      "\x1B[?1016l\x1B[?1006h";
  const auto projected = [=, &output, &used]() noexcept {
    switch (outer_modes) {
    case OuterModeProjection::neutral:
      return append(output, used, neutral_modes) && append(output, used, button_mouse_capture);
    case OuterModeProjection::button_mouse:
      return append(output, used, button_mouse_capture);
    case OuterModeProjection::any_mouse:
      return append(output, used, any_mouse_capture);
    }
    return false;
  };
  return append(output, used, "\x1B[0m\x1B[?7h") &&
         (outer_modes != OuterModeProjection::neutral || append(output, used, "\x1B[?25l")) &&
         (!project_outer_modes || projected()) && append(output, used, "\x1B[?2026l");
}

[[nodiscard]] auto finish_composition(const std::span<const PaneSurface> panes,
                                      const StatusLine status, const Viewport viewport,
                                      const std::span<std::byte> output, std::size_t used,
                                      const bool force_full, const bool complete_frame,
                                      const std::optional<OuterModeProjection> previous_outer_modes,
                                      CompositionResult composition) noexcept
    -> std::expected<CompositionResult, CompositionError> {
  if (!render_status_prompt_cursor(status, viewport, output, used)) {
    invalidate_panes(panes);
    return std::unexpected(CompositionError::output_exhausted);
  }
  // A pane-level repair does not make the protocol frame complete when suppression omitted a
  // surface. In that case no full-screen clear was emitted and the full-redraw generation must not
  // advance.
  composition.full = composition.full && complete_frame;
  const bool project_outer_modes = force_full || previous_outer_modes != composition.outer_modes;
  if (!finish_frame(output, used, composition.outer_modes, project_outer_modes)) {
    invalidate_panes(panes);
    return std::unexpected(CompositionError::output_exhausted);
  }
  // Neutral projection resets child-owned non-mouse modes after pane rendering. Invalidate those
  // physical shadows so a normally released synchronized pane restores its canonical modes.
  if (project_outer_modes && composition.outer_modes == OuterModeProjection::neutral) {
    invalidate_pane_mode_projections(panes);
  }
  // The status editor projects a steady block after pane rendering. The next frame must restore
  // the child's canonical blink mode even when no terminal damage occurred.
  if (status.prompting() && viewport.rows >= 2) {
    invalidate_focused_cursor_projection(panes);
  }
  composition.bytes = used;
  return composition;
}

} // namespace

[[nodiscard]] auto status_target_at_column(const StatusLine status, const Viewport viewport,
                                           const std::uint16_t column) noexcept
    -> std::optional<StatusTarget> {
  if (!valid_viewport(viewport) || !valid_status(status) || !has_visible_status(viewport, status) ||
      status.prompting() || status.prompt_target == StatusPromptTarget::message ||
      !status.input_context.empty() || column >= viewport.columns) {
    return std::nullopt;
  }
  const auto projection = status_line_projection(status, viewport);
  if (projection.show_create && column == projection.create_column) {
    return StatusTarget{.kind = StatusTargetKind::create_tab, .tab_position = 0};
  }
  const auto labels = std::span(projection.labels).first(projection.label_count);
  auto current_column = static_cast<std::size_t>(projection.tab_column - 1U);
  if (projection.show_range && projection.begin > 0) {
    current_column += 2U;
  }
  for (std::size_t index = projection.begin; index <= projection.end; ++index) {
    const auto label_columns = labels.subspan(index, 1).front().size;
    if (column >= current_column && column < current_column + label_columns) {
      return StatusTarget{.kind = StatusTargetKind::tab, .tab_position = index};
    }
    current_column += label_columns;
    if (projection.show_range && index < projection.end) {
      current_column += 2U;
    }
  }
  return std::nullopt;
}

// Validation is a separate pass so malformed composition input cannot partially consume terminal
// damage or alter retained pane state. The bounded branches preserve all-or-nothing composition.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto compose_frame(const std::span<const PaneSurface> panes, const Viewport viewport,
                                 const std::span<std::byte> output, const bool force_full,
                                 const StatusLine status,
                                 const std::optional<OuterModeProjection> previous_outer_modes,
                                 const MessageView message_view) noexcept
    -> std::expected<CompositionResult, CompositionError> {
  const auto status_rows =
      has_visible_status(viewport, status) ? std::uint16_t{1} : std::uint16_t{0};
  const PaneRectangle content{
      .row = status_rows,
      .columns = viewport.columns,
      .rows = static_cast<std::uint16_t>(viewport.rows - status_rows),
  };
  const Viewport content_viewport{.columns = content.columns, .rows = content.rows};
  const auto policy = composition_policy(panes, viewport, content_viewport, status, message_view);
  if (!policy.has_value()) {
    return std::unexpected(policy.error());
  }

  const bool complete_frame =
      message_view.active || std::ranges::none_of(panes, &PaneSurface::presentation_suppressed);
  const bool complete_full = force_full && complete_frame;
  std::size_t used = 0;
  if (!begin_frame(output, used, complete_full)) {
    return std::unexpected(CompositionError::output_exhausted);
  }
  CompositionResult composition{
      .panes = message_view.active ? 0U : panes.size(),
      .outer_modes = status.prompting() ? OuterModeProjection::button_mouse : policy->outer_modes,
      .full = complete_full,
  };
  // Separators are outside every pane surface and can only change with a layout/full redraw.
  // Re-emitting them for ordinary pane damage wastes bytes and CPU without changing presentation.
  if (force_full && !message_view.active &&
      !draw_borders(panes, output, used, content.column, content.row)) {
    return std::unexpected(CompositionError::output_exhausted);
  }
  if ((force_full || status.dirty) && !render_status_line(status, viewport, output, used)) {
    return std::unexpected(CompositionError::output_exhausted);
  }
  composition.status = has_visible_status(viewport, status) && (force_full || status.dirty);
  if (message_view.active) {
    if (!render_message_view(message_view, content, output, used)) {
      return std::unexpected(CompositionError::output_exhausted);
    }
  } else {
    const auto rendered = render_panes(panes, content_viewport, output, used, force_full,
                                       content.column, content.row, composition);
    if (!rendered.has_value()) {
      return std::unexpected(rendered.error());
    }
  }
  return finish_composition(panes, status, viewport, output, used, force_full, complete_frame,
                            previous_outer_modes, composition);
}

} // namespace lemma::render
