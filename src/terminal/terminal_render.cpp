#include "terminal/terminal_impl.hpp"

#include "diagnostic/latency_trace.hpp"
#include "lemma/assert.hpp"
#include "lemma/terminal/terminal.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <iterator>
#include <limits>
#include <span>
#include <string_view>
#include <system_error>
#include <utility>

namespace lemma::vt {
namespace detail {

class AnsiWriter final {
public:
  explicit AnsiWriter(const std::span<std::byte> output) noexcept : output_(output) {}

  [[nodiscard]] auto append(const std::string_view text) noexcept -> bool {
    return append(std::as_bytes(std::span(text.data(), text.size())));
  }

  [[nodiscard]] auto append(const std::span<const std::byte> bytes) noexcept -> bool {
    if (bytes.size() > output_.size() - used_) {
      return false;
    }
    if (!bytes.empty()) {
      std::memcpy(output_.subspan(used_, bytes.size()).data(), bytes.data(), bytes.size());
      used_ += bytes.size();
    }
    return true;
  }

  template <typename Integer>
  [[nodiscard]] auto append_integer(const Integer value) noexcept -> bool {
    std::array<char, 32> buffer{};
    const auto result = std::to_chars(buffer.begin(), buffer.end(), value);
    if (result.ec != std::errc{}) {
      return false;
    }
    const auto size = static_cast<std::size_t>(std::distance(buffer.begin(), result.ptr));
    return append(std::string_view(buffer.data(), size));
  }

  [[nodiscard]] auto append_hex_byte(const std::uint8_t value) noexcept -> bool {
    constexpr std::array digits{'0', '1', '2', '3', '4', '5', '6', '7',
                                '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'};
    const std::array encoded{
        std::span(digits).subspan(static_cast<std::size_t>(value >> 4U), 1).front(),
        std::span(digits).subspan(static_cast<std::size_t>(value & 0x0FU), 1).front(),
    };
    return append(std::string_view(encoded.data(), encoded.size()));
  }

  [[nodiscard]] auto size() const noexcept -> std::size_t { return used_; }
  void rewind(const std::size_t size) noexcept {
    LEMMA_ASSERT(size <= used_);
    used_ = size;
  }

private:
  std::span<std::byte> output_;
  std::size_t used_{0};
};

} // namespace detail

namespace {

using detail::AnsiWriter;

enum class AnsiColorTag : std::uint8_t {
  none,
  palette,
  rgb,
};

struct AnsiColor final {
  AnsiColorTag tag{AnsiColorTag::none};
  std::uint8_t index{0};
  std::uint8_t red{0};
  std::uint8_t green{0};
  std::uint8_t blue{0};

  friend constexpr auto operator==(const AnsiColor&, const AnsiColor&) noexcept -> bool = default;
};

struct AnsiStyle final {
  AnsiColor foreground{};
  AnsiColor background{};
  AnsiColor underline_color{};
  std::uint8_t underline{0};
  bool bold{false};
  bool italic{false};
  bool faint{false};
  bool blink{false};
  bool inverse{false};
  bool invisible{false};
  bool strikethrough{false};
  bool overline{false};

  friend constexpr auto operator==(const AnsiStyle&, const AnsiStyle&) noexcept -> bool = default;
};

[[nodiscard]] constexpr auto ansi_rgb(const GhosttyColorRgb color) noexcept -> AnsiColor {
  return {
      .tag = AnsiColorTag::rgb,
      .red = color.r,
      .green = color.g,
      .blue = color.b,
  };
}

[[nodiscard]] constexpr auto ansi_rgb(const RgbColor color) noexcept -> AnsiColor {
  return {
      .tag = AnsiColorTag::rgb,
      .red = color.red,
      .green = color.green,
      .blue = color.blue,
  };
}

[[nodiscard]] constexpr auto mix_channel(const std::uint8_t from,
                                         const std::uint8_t toward) noexcept -> std::uint8_t {
  constexpr int weight = 72;
  const auto delta = static_cast<int>(toward) - static_cast<int>(from);
  return static_cast<std::uint8_t>(static_cast<int>(from) + ((delta * weight) / 256));
}

[[nodiscard]] constexpr auto derived_selection_background(const TerminalTheme& theme) noexcept
    -> RgbColor {
  return {
      .red = mix_channel(theme.background.red, theme.foreground.red),
      .green = mix_channel(theme.background.green, theme.foreground.green),
      .blue = mix_channel(theme.background.blue, theme.foreground.blue),
  };
}

void apply_selection_highlight(AnsiStyle& style, const bool selected,
                               const TerminalTheme& theme) noexcept {
  if (!selected) {
    return;
  }
  if (style.inverse) {
    std::swap(style.foreground, style.background);
    style.inverse = false;
  }
  style.background =
      ansi_rgb(theme.selection_background.value_or(derived_selection_background(theme)));
  if (theme.selection_foreground.has_value()) {
    style.foreground = ansi_rgb(*theme.selection_foreground);
  }
}

[[nodiscard]] constexpr auto ansi_palette(const GhosttyColorPaletteIndex index) noexcept
    -> AnsiColor {
  return {
      .tag = AnsiColorTag::palette,
      .index = index,
  };
}

[[nodiscard]] constexpr auto same_color(const GhosttyColorRgb native,
                                        const RgbColor configured) noexcept -> bool {
  return native.r == configured.red && native.g == configured.green && native.b == configured.blue;
}

[[nodiscard]] auto palette_color(const GhosttyColorPaletteIndex index,
                                 const GhosttyRenderStateColors& colors,
                                 const TerminalTheme& theme) noexcept -> AnsiColor {
  const auto current = std::span(colors.palette).subspan(index, 1).front();
  const auto configured = std::span(theme.palette).subspan(index, 1).front();
  // Attach queries establish equivalence only for the configurable ANSI colors. Extended palette
  // entries may differ in the outer terminal, so preserve their canonical RGB rather than relying
  // on an unverified physical index.
  constexpr GhosttyColorPaletteIndex host_palette_colors_queried = 16;
  if (index >= host_palette_colors_queried) {
    return ansi_rgb(current);
  }
  // An OSC 4 override is pane-local and must not mutate the outer terminal's global palette.
  // Preserve the index only while Ghostty's effective entry still equals its configured default.
  return same_color(current, configured) ? ansi_palette(index) : ansi_rgb(current);
}

[[nodiscard]] constexpr auto default_color(const GhosttyColorRgb current,
                                           const RgbColor configured) noexcept -> AnsiColor {
  // A missing color after SGR 0 means the outer terminal's default. Only a pane-local OSC 10/11
  // override requires an explicit RGB projection.
  return same_color(current, configured) ? AnsiColor{} : ansi_rgb(current);
}

[[nodiscard]] auto style_color(const GhosttyStyleColor color,
                               const GhosttyRenderStateColors& colors, const TerminalTheme& theme,
                               const AnsiColor fallback = {}) noexcept -> AnsiColor {
  switch (color.tag) {
  case GHOSTTY_STYLE_COLOR_NONE:
    return fallback;
  case GHOSTTY_STYLE_COLOR_PALETTE:
    return palette_color(color.value.palette, colors, theme);
  case GHOSTTY_STYLE_COLOR_RGB:
    return ansi_rgb(color.value.rgb);
  case GHOSTTY_STYLE_COLOR_TAG_MAX_VALUE:
    return fallback;
  }
  return fallback;
}

[[nodiscard]] auto ansi_style(const GhosttyCell raw_cell, const GhosttyCellContentTag content_tag,
                              const GhosttyStyle& style, const GhosttyRenderStateColors& colors,
                              const TerminalTheme& theme) noexcept
    -> std::expected<AnsiStyle, Error> {
  const auto foreground = style_color(style.fg_color, colors, theme,
                                      default_color(colors.foreground, theme.foreground));
  auto background = style_color(style.bg_color, colors, theme,
                                default_color(colors.background, theme.background));

  GhosttyResult result = GHOSTTY_SUCCESS;
  if (content_tag == GHOSTTY_CELL_CONTENT_BG_COLOR_PALETTE) {
    GhosttyColorPaletteIndex index = 0;
    result = ghostty_cell_get(raw_cell, GHOSTTY_CELL_DATA_COLOR_PALETTE, &index);
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(detail::map_error(result));
    }
    background = palette_color(index, colors, theme);
  } else if (content_tag == GHOSTTY_CELL_CONTENT_BG_COLOR_RGB) {
    GhosttyColorRgb color{};
    result = ghostty_cell_get(raw_cell, GHOSTTY_CELL_DATA_COLOR_RGB, &color);
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(detail::map_error(result));
    }
    background = ansi_rgb(color);
  }

  const auto underline = style.underline_color.tag == GHOSTTY_STYLE_COLOR_NONE
                             ? AnsiColor{}
                             : style_color(style.underline_color, colors, theme);
  return AnsiStyle{
      .foreground = foreground,
      .background = background,
      .underline_color = underline,
      .underline = static_cast<std::uint8_t>(style.underline),
      .bold = style.bold,
      .italic = style.italic,
      .faint = style.faint,
      .blink = style.blink,
      .inverse = style.inverse,
      .invisible = style.invisible,
      .strikethrough = style.strikethrough,
      .overline = style.overline,
  };
}

[[nodiscard]] auto append_color(AnsiWriter& writer, const AnsiColor color,
                                const std::string_view prefix) noexcept -> bool {
  if (color.tag == AnsiColorTag::none) {
    return true;
  }
  if (!writer.append(";") || !writer.append(prefix)) {
    return false;
  }
  if (color.tag == AnsiColorTag::palette) {
    return writer.append(";5;") && writer.append_integer(color.index);
  }
  return writer.append(";2;") && writer.append_integer(color.red) && writer.append(";") &&
         writer.append_integer(color.green) && writer.append(";") &&
         writer.append_integer(color.blue);
}

[[nodiscard]] auto append_cursor_color(AnsiWriter& writer, const GhosttyColorRgb color,
                                       const RgbColor configured) noexcept -> bool {
  if (same_color(color, configured)) {
    return writer.append("\x1B]112\x1B\\");
  }
  return writer.append("\x1B]12;#") && writer.append_hex_byte(color.r) &&
         writer.append_hex_byte(color.g) && writer.append_hex_byte(color.b) &&
         writer.append("\x1B\\");
}

[[nodiscard]] auto append_style(AnsiWriter& writer, const AnsiStyle& style) noexcept -> bool {
  if (!writer.append("\x1B[0")) {
    return false;
  }
  const auto append_flag = [&writer](const bool enabled, const std::string_view code) noexcept {
    return !enabled || (writer.append(";") && writer.append(code));
  };
  if (!append_flag(style.bold, "1") || !append_flag(style.faint, "2") ||
      !append_flag(style.italic, "3") || !append_flag(style.blink, "5") ||
      !append_flag(style.inverse, "7") || !append_flag(style.invisible, "8") ||
      !append_flag(style.strikethrough, "9") || !append_flag(style.overline, "53")) {
    return false;
  }
  if (style.underline != 0 && (!writer.append(";4:") || !writer.append_integer(style.underline))) {
    return false;
  }
  return append_color(writer, style.foreground, "38") &&
         append_color(writer, style.background, "48") &&
         append_color(writer, style.underline_color, "58") && writer.append("m");
}

[[nodiscard]] auto terminal_mode_enabled(const GhosttyTerminal terminal,
                                         const GhosttyMode mode) noexcept
    -> std::expected<bool, Error> {
  GhosttyTerminalModeConfig config{.mode = mode, .value = false};
  const auto result = ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_MODE, &config);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(Error::invalid_state);
  }
  return config.value;
}

[[nodiscard]] constexpr auto utf8_codepoint_bytes(const std::uint8_t first) noexcept
    -> std::size_t {
  if ((first & 0x80U) == 0) {
    return 1;
  }
  if ((first & 0xE0U) == 0xC0U) {
    return 2;
  }
  if ((first & 0xF0U) == 0xE0U) {
    return 3;
  }
  if ((first & 0xF8U) == 0xF0U) {
    return 4;
  }
  return 1;
}

[[nodiscard]] constexpr auto hash_byte(std::uint64_t hash, const std::uint8_t value) noexcept
    -> std::uint64_t {
  return (hash ^ value) * 1'099'511'628'211ULL;
}

[[nodiscard]] constexpr auto hash_u64(std::uint64_t hash, const std::uint64_t value) noexcept
    -> std::uint64_t {
  for (std::size_t shift = 0; shift < 64; shift += 8) {
    hash = hash_byte(hash, static_cast<std::uint8_t>(value >> shift));
  }
  return hash;
}

[[nodiscard]] auto hash_style(std::uint64_t hash, const AnsiStyle& style) noexcept
    -> std::uint64_t {
  const auto hash_color = [](std::uint64_t value, const AnsiColor& color) noexcept {
    value = hash_byte(value, static_cast<std::uint8_t>(color.tag));
    value = hash_byte(value, color.index);
    value = hash_byte(value, color.red);
    value = hash_byte(value, color.green);
    return hash_byte(value, color.blue);
  };
  hash = hash_color(hash, style.foreground);
  hash = hash_color(hash, style.background);
  hash = hash_color(hash, style.underline_color);
  hash = hash_byte(hash, style.underline);
  const std::array flags{style.bold,    style.italic,    style.faint,         style.blink,
                         style.inverse, style.invisible, style.strikethrough, style.overline};
  for (const bool flag : flags) {
    hash = hash_byte(hash, static_cast<std::uint8_t>(flag));
  }
  return hash;
}

[[nodiscard]] auto rendered_cell_hash(const AnsiStyle& style, const GhosttyCellWide wide,
                                      const std::span<const std::uint8_t> grapheme) noexcept
    -> std::uint64_t {
  constexpr std::uint64_t hash_initial = 14'695'981'039'346'656'037ULL;
  auto hash = hash_style(hash_initial, style);
  hash = hash_byte(hash, static_cast<std::uint8_t>(wide));
  if (grapheme.empty()) {
    hash = hash_byte(hash, 0);
  } else {
    for (const auto byte : grapheme) {
      hash = hash_byte(hash, byte);
    }
  }
  return hash;
}

} // namespace

[[nodiscard]] auto Terminal::Impl::dirty_state() const noexcept
    -> std::expected<DirtyState, Error> {
  GhosttyRenderStateDirty ghostty_dirty = GHOSTTY_RENDER_STATE_DIRTY_FALSE;
  const auto result =
      ghostty_render_state_get(render_state, GHOSTTY_RENDER_STATE_DATA_DIRTY, &ghostty_dirty);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }

  switch (ghostty_dirty) {
  case GHOSTTY_RENDER_STATE_DIRTY_FALSE:
    return DirtyState::clean;
  case GHOSTTY_RENDER_STATE_DIRTY_PARTIAL:
    return DirtyState::partial;
  case GHOSTTY_RENDER_STATE_DIRTY_FULL:
    return DirtyState::full;
  case GHOSTTY_RENDER_STATE_DIRTY_MAX_VALUE:
    return std::unexpected(Error::invalid_state);
  }
  return std::unexpected(Error::invalid_state);
}

[[nodiscard]] auto Terminal::Impl::set_dirty_state(const DirtyState dirty) const noexcept
    -> std::expected<void, Error> {
  auto ghostty_dirty = [dirty]() noexcept {
    switch (dirty) {
    case DirtyState::clean:
      return GHOSTTY_RENDER_STATE_DIRTY_FALSE;
    case DirtyState::partial:
      return GHOSTTY_RENDER_STATE_DIRTY_PARTIAL;
    case DirtyState::full:
      return GHOSTTY_RENDER_STATE_DIRTY_FULL;
    }
    return GHOSTTY_RENDER_STATE_DIRTY_FALSE;
  }();
  const auto result =
      ghostty_render_state_set(render_state, GHOSTTY_RENDER_STATE_OPTION_DIRTY, &ghostty_dirty);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  return {};
}

[[nodiscard]] auto Terminal::Impl::populate_render_metadata(RenderUpdate& update) noexcept
    -> std::expected<void, Error> {
  const std::array keys{
      GHOSTTY_RENDER_STATE_DATA_COLS,
      GHOSTTY_RENDER_STATE_DATA_ROWS,
  };
  std::array<void*, keys.size()> values{&update.columns, &update.rows};
  std::size_t values_written = 0;
  auto result = ghostty_render_state_get_multi(render_state, keys.size(), keys.data(),
                                               values.data(), &values_written);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  if (values_written != keys.size()) {
    return std::unexpected(Error::invalid_state);
  }

  GhosttyRenderStateCursor cursor = GHOSTTY_INIT_SIZED(GhosttyRenderStateCursor);
  result = ghostty_render_state_get(render_state, GHOSTTY_RENDER_STATE_DATA_CURSOR, &cursor);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  update.cursor_visible = cursor.visible;
  update.cursor_in_viewport = cursor.viewport_has_value;
  update.cursor_column = cursor.viewport_has_value ? cursor.viewport_x : std::uint16_t{0};
  update.cursor_row = cursor.viewport_has_value ? cursor.viewport_y : std::uint16_t{0};
  render_cursor_blinking = cursor.blinking;
  return {};
}

[[nodiscard]] auto Terminal::Impl::dirty_row_count() noexcept -> std::expected<std::size_t, Error> {
  auto result = ghostty_render_state_get(render_state, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
                                         static_cast<void*>(&row_iterator));
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }

  std::size_t count = 0;
  std::uint16_t row_y = 0;
  while (ghostty_render_state_row_iterator_next_dirty(row_iterator, &row_y)) {
    ++count;
  }
  return count;
}

// Grapheme/style hashing is intentionally explicit so unsafe scroll equivalence is never inferred.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto Terminal::Impl::calculate_row_hash() noexcept
    -> std::expected<std::uint64_t, Error> {
  auto result = ghostty_render_state_row_get(row_iterator, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
                                             static_cast<void*>(&row_cells));
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }

  constexpr std::uint64_t hash_initial = 14'695'981'039'346'656'037ULL;
  std::uint64_t row_hash = hash_initial;
  std::size_t cell_count = 0;
  while (ghostty_render_state_row_cells_next(row_cells)) {
    GhosttyCell raw_cell = 0;
    GhosttyStyle ghostty_style{};
    ghostty_style.size = sizeof(ghostty_style);
    result = ghostty_render_state_row_cells_get(row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW,
                                                &raw_cell);
    if (result == GHOSTTY_SUCCESS) {
      result = ghostty_render_state_row_cells_get(
          row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &ghostty_style);
    }
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(detail::map_error(result));
    }

    GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
    GhosttyCellContentTag content_tag = GHOSTTY_CELL_CONTENT_CODEPOINT;
    const std::array cell_keys{GHOSTTY_CELL_DATA_WIDE, GHOSTTY_CELL_DATA_CONTENT_TAG};
    std::array<void*, cell_keys.size()> cell_values{&wide, &content_tag};
    std::size_t values_written = 0;
    result = ghostty_cell_get_multi(raw_cell, cell_keys.size(), cell_keys.data(),
                                    cell_values.data(), &values_written);
    if (result != GHOSTTY_SUCCESS || values_written != cell_keys.size()) {
      return std::unexpected(detail::map_error(result));
    }
    auto style = ansi_style(raw_cell, content_tag, ghostty_style, render_colors, session_theme);
    if (!style.has_value()) {
      return std::unexpected(style.error());
    }
    bool selected = false;
    result = ghostty_render_state_row_cells_get(
        row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_SELECTED, &selected);
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(detail::map_error(result));
    }
    apply_selection_highlight(*style, selected, session_theme);

    std::array<std::uint8_t, pane_ansi_grapheme_bytes_max> grapheme{};
    GhosttyBuffer grapheme_buffer{
        .ptr = grapheme.data(),
        .cap = grapheme.size(),
        .len = 0,
    };
    result = ghostty_render_state_row_cells_get(
        row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &grapheme_buffer);
    if (result == GHOSTTY_OUT_OF_SPACE) {
      return std::unexpected(Error::limit_exceeded);
    }
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(detail::map_error(result));
    }
    const auto bytes = std::span(grapheme).first(grapheme_buffer.len);
    row_hash = hash_u64(row_hash, rendered_cell_hash(*style, wide, bytes));
    ++cell_count;
  }
  LEMMA_ASSERT(cell_count == options.size.columns);
  return row_hash;
}

[[nodiscard]] auto Terminal::Impl::detect_scroll() const noexcept -> std::int32_t {
  if (row_hash_count < 3) {
    return 0;
  }
  const auto previous = std::span(row_hashes).first(row_hash_count);
  const auto current = std::span(current_row_hashes).first(row_hash_count);
  for (std::size_t amount = 1; amount + 1 < row_hash_count; ++amount) {
    const auto overlap = row_hash_count - amount;
    if (std::equal(current.first(overlap).begin(), current.first(overlap).end(),
                   previous.subspan(amount).begin())) {
      return static_cast<std::int32_t>(amount);
    }
    if (std::equal(current.subspan(amount).begin(), current.subspan(amount).end(),
                   previous.first(overlap).begin())) {
      return -static_cast<std::int32_t>(amount);
    }
  }
  return 0;
}

void Terminal::Impl::apply_physical_scroll(const std::int32_t scroll) noexcept {
  LEMMA_ASSERT(scroll != 0);
  const auto amount = static_cast<std::size_t>(scroll > 0 ? scroll : -scroll);
  const auto columns = static_cast<std::size_t>(options.size.columns);
  const auto shifted_cells = amount * columns;
  auto cells = std::span(physical_cell_hashes.get(), physical_cell_count);
  auto hashes = std::span(row_hashes).first(row_hash_count);
  if (scroll > 0) {
    std::memmove(cells.data(), cells.subspan(shifted_cells).data(),
                 (cells.size() - shifted_cells) * sizeof(std::uint64_t));
    std::fill(cells.end() - static_cast<std::ptrdiff_t>(shifted_cells), cells.end(), 0);
    std::memmove(hashes.data(), hashes.subspan(amount).data(),
                 (hashes.size() - amount) * sizeof(std::uint64_t));
    std::fill(hashes.end() - static_cast<std::ptrdiff_t>(amount), hashes.end(), 0);
    return;
  }
  std::memmove(cells.subspan(shifted_cells).data(), cells.data(),
               (cells.size() - shifted_cells) * sizeof(std::uint64_t));
  std::fill(cells.begin(), cells.begin() + static_cast<std::ptrdiff_t>(shifted_cells), 0);
  std::memmove(hashes.subspan(amount).data(), hashes.data(),
               (hashes.size() - amount) * sizeof(std::uint64_t));
  std::fill(hashes.begin(), hashes.begin() + static_cast<std::ptrdiff_t>(amount), 0);
}

// Encode the minimal prefix/suffix-differing span while refreshing bounded physical state.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto Terminal::Impl::encode_row(AnsiWriter& writer, const std::size_t row_index,
                                              const bool force, const std::uint16_t origin_column,
                                              const std::uint16_t origin_row,
                                              const bool erase_line_tail) noexcept
    -> std::expected<bool, Error> {
  LEMMA_ASSERT(row_index < row_hash_count);
  LEMMA_ASSERT(physical_cell_hashes != nullptr);
  const auto checkpoint = writer.size();
  auto result = ghostty_render_state_row_get(row_iterator, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
                                             static_cast<void*>(&row_cells));
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }

  constexpr std::uint64_t hash_initial = 14'695'981'039'346'656'037ULL;
  std::uint64_t row_hash = hash_initial;
  AnsiStyle active_style{};
  bool active_style_valid = false;
  bool span_started = false;
  std::size_t changed_end = checkpoint;
  std::size_t trailing_blank_start = std::numeric_limits<std::size_t>::max();
  AnsiStyle trailing_blank_style{};
  bool trailing_blank_changed = false;
  std::size_t cell_count = 0;
  while (ghostty_render_state_row_cells_next(row_cells)) {
    GhosttyCell raw_cell = 0;
    GhosttyStyle ghostty_style{};
    ghostty_style.size = sizeof(ghostty_style);
    result = ghostty_render_state_row_cells_get(row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW,
                                                &raw_cell);
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(detail::map_error(result));
    }
    result = ghostty_render_state_row_cells_get(
        row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &ghostty_style);
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(detail::map_error(result));
    }

    GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
    result = ghostty_cell_get(raw_cell, GHOSTTY_CELL_DATA_WIDE, &wide);
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(detail::map_error(result));
    }
    GhosttyCellContentTag content_tag = GHOSTTY_CELL_CONTENT_CODEPOINT;
    result = ghostty_cell_get(raw_cell, GHOSTTY_CELL_DATA_CONTENT_TAG, &content_tag);
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(detail::map_error(result));
    }
    auto style = ansi_style(raw_cell, content_tag, ghostty_style, render_colors, session_theme);
    if (!style.has_value()) {
      return std::unexpected(style.error());
    }
    bool selected = false;
    result = ghostty_render_state_row_cells_get(
        row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_SELECTED, &selected);
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(detail::map_error(result));
    }
    apply_selection_highlight(*style, selected, session_theme);

    std::array<std::uint8_t, pane_ansi_grapheme_bytes_max> grapheme{};
    GhosttyBuffer grapheme_buffer{
        .ptr = grapheme.data(),
        .cap = grapheme.size(),
        .len = 0,
    };
    result = ghostty_render_state_row_cells_get(
        row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &grapheme_buffer);
    if (result == GHOSTTY_OUT_OF_SPACE) {
      return std::unexpected(Error::limit_exceeded);
    }
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(detail::map_error(result));
    }

    const auto grapheme_bytes = std::span(grapheme).first(grapheme_buffer.len);
    const auto cell_hash = rendered_cell_hash(*style, wide, grapheme_bytes);
    row_hash = hash_u64(row_hash, cell_hash);
    const auto physical_index = (row_index * options.size.columns) + cell_count;
    LEMMA_ASSERT(physical_index < physical_cell_count);
    auto physical_cells = std::span(physical_cell_hashes.get(), physical_cell_count);
    auto& physical_hash = physical_cells.subspan(physical_index, 1).front();
    const bool changed = force || !ansi_physical_valid || physical_hash != cell_hash;
    physical_hash = cell_hash;
    if (span_started || changed) {
      if (!span_started) {
        if (!writer.append("\x1B[") ||
            !writer.append_integer(static_cast<std::size_t>(origin_row) + row_index + 1U) ||
            !writer.append(";") ||
            !writer.append_integer(static_cast<std::size_t>(origin_column) + cell_count + 1U) ||
            !writer.append("H")) {
          return std::unexpected(Error::out_of_space);
        }
        span_started = true;
      }

      const auto cell_checkpoint = writer.size();
      if ((!active_style_valid || *style != active_style) && !append_style(writer, *style)) {
        return std::unexpected(Error::out_of_space);
      }
      active_style = *style;
      active_style_valid = true;

      const bool default_blank = !selected && grapheme_buffer.len == 0 &&
                                 wide != GHOSTTY_CELL_WIDE_SPACER_TAIL &&
                                 ghostty_style_is_default(&ghostty_style) &&
                                 content_tag != GHOSTTY_CELL_CONTENT_BG_COLOR_PALETTE &&
                                 content_tag != GHOSTTY_CELL_CONTENT_BG_COLOR_RGB;
      if (default_blank) {
        if (trailing_blank_start == std::numeric_limits<std::size_t>::max()) {
          trailing_blank_start = cell_checkpoint;
          trailing_blank_changed = false;
        }
        trailing_blank_style = *style;
        trailing_blank_changed = trailing_blank_changed || changed;
      } else {
        trailing_blank_start = std::numeric_limits<std::size_t>::max();
        trailing_blank_changed = false;
      }

      if (grapheme_buffer.len == 0) {
        if (wide != GHOSTTY_CELL_WIDE_SPACER_TAIL && !writer.append(" ")) {
          return std::unexpected(Error::out_of_space);
        }
      } else if (wide != GHOSTTY_CELL_WIDE_SPACER_TAIL) {
        const auto base_bytes = utf8_codepoint_bytes(grapheme.front());
        const bool last_column_with_suffix =
            cell_count + 1U == options.size.columns && base_bytes < grapheme_bytes.size();
        if (!last_column_with_suffix) {
          if (!writer.append(std::as_bytes(grapheme_bytes))) {
            return std::unexpected(Error::out_of_space);
          }
        } else {
          // The compositor normally disables autowrap. At the final column, Ghostty needs pending
          // wrap state while parsing suffix codepoints or it can attach them to the preceding wide
          // cell. Bound the exception to this one complete grapheme, then restore frame policy.
          if (!writer.append("\x1B[?7h") || !writer.append(std::as_bytes(grapheme_bytes)) ||
              !writer.append("\x1B[?7l")) {
            return std::unexpected(Error::out_of_space);
          }
        }
      }
      if (changed) {
        changed_end = writer.size();
      }
    }
    ++cell_count;
  }

  LEMMA_ASSERT(cell_count == options.size.columns);
  std::span(row_hashes).subspan(row_index, 1).front() = row_hash;
  if (!span_started) {
    LEMMA_ASSERT(writer.size() == checkpoint);
    return false;
  }
  if (erase_line_tail && trailing_blank_start != std::numeric_limits<std::size_t>::max() &&
      trailing_blank_changed) {
    writer.rewind(trailing_blank_start);
    // EL paints with the active background. Re-emit the pane's semantic default style so the
    // attaching terminal supplies its own default unless the pane has an OSC 10/11 override.
    if (!append_style(writer, trailing_blank_style) || !writer.append("\x1B[K")) {
      return std::unexpected(Error::out_of_space);
    }
  } else {
    writer.rewind(changed_end);
  }
  return true;
}

auto Terminal::update_render_state() noexcept -> std::expected<RenderUpdate, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->render_state != nullptr);

  const auto result = ghostty_render_state_update(impl_->render_state, impl_->terminal);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }

  RenderUpdate update{};
  const auto dirty = impl_->dirty_state();
  if (!dirty.has_value()) {
    return std::unexpected(dirty.error());
  }
  update.dirty = *dirty;

  const auto metadata_result = impl_->populate_render_metadata(update);
  if (!metadata_result.has_value()) {
    return std::unexpected(metadata_result.error());
  }

  const auto dirty_rows = impl_->dirty_row_count();
  if (!dirty_rows.has_value()) {
    return std::unexpected(dirty_rows.error());
  }
  update.dirty_rows = *dirty_rows;

  LEMMA_ASSERT(update.columns == impl_->options.size.columns);
  LEMMA_ASSERT(update.rows == impl_->options.size.rows);
  return update;
}

auto Terminal::mark_rendered() noexcept -> std::expected<void, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->render_state != nullptr);

  const auto result = ghostty_render_state_clean(impl_->render_state);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  return {};
}

auto Terminal::render_ansi(const std::span<std::byte> output, const bool force_full) noexcept
    -> std::expected<AnsiRenderResult, Error> {
  return render_ansi_impl(output, force_full, 0, 0, false, true, false, 0, 0, true);
}

auto Terminal::render_pane_ansi(const std::span<std::byte> output,
                                const PaneRenderOptions& options) noexcept
    -> std::expected<AnsiRenderResult, Error> {
  return render_ansi_impl(output, options.force_full, options.column, options.row, true,
                          options.focused, options.cursor_override, options.cursor_override_column,
                          options.cursor_override_row, options.allow_terminal_scroll);
}

void Terminal::invalidate_ansi_render_state() noexcept {
  LEMMA_ASSERT(impl_ != nullptr);
  impl_->ansi_physical_valid = false;
  impl_->mirrored_modes_valid = false;
  impl_->mirrored_mouse_modes_valid = false;
  impl_->projected_cursor_valid = false;
}

void Terminal::invalidate_ansi_mode_projection() noexcept {
  LEMMA_ASSERT(impl_ != nullptr);
  impl_->mirrored_modes_valid = false;
  impl_->mirrored_mouse_modes_valid = false;
}

void Terminal::invalidate_ansi_cursor_projection() noexcept {
  LEMMA_ASSERT(impl_ != nullptr);
  impl_->projected_cursor_valid = false;
}

// Rendering is an explicit bounded pass over rows and cells owned by Ghostty's snapshot.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto Terminal::render_ansi_impl(const std::span<std::byte> output, const bool force_full,
                                const std::uint16_t origin_column, const std::uint16_t origin_row,
                                const bool composed, const bool focused, const bool cursor_override,
                                const std::uint16_t cursor_override_column,
                                const std::uint16_t cursor_override_row,
                                const bool allow_terminal_scroll) noexcept
    -> std::expected<AnsiRenderResult, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->render_state != nullptr);

  auto result = ghostty_render_state_update(impl_->render_state, impl_->terminal);
  if (result != GHOSTTY_SUCCESS) {
    impl_->ansi_physical_valid = false;
    return std::unexpected(detail::map_error(result));
  }

  RenderUpdate metadata{};
  const auto metadata_result = impl_->populate_render_metadata(metadata);
  if (!metadata_result.has_value()) {
    impl_->ansi_physical_valid = false;
    return std::unexpected(metadata_result.error());
  }
  const auto dirty = impl_->dirty_state();
  if (!dirty.has_value()) {
    impl_->ansi_physical_valid = false;
    return std::unexpected(dirty.error());
  }
  if (focused) {
    diagnostic::record_latency_trace(diagnostic::LatencyTraceStage::ghostty_damage_reported, 0,
                                     static_cast<std::uint64_t>(*dirty));
  }
  const bool full = force_full || !impl_->ansi_physical_valid;
  // Cursor/default colors can change without cell damage, so every frame acquires the scalar
  // prefix. Ghostty guarantees palette mutations force redraw; clean frames can therefore avoid
  // copying the 256-entry suffix while retaining the previously acquired palette.
  impl_->render_colors.size = full || *dirty != DirtyState::clean
                                  ? sizeof(impl_->render_colors)
                                  : offsetof(GhosttyRenderStateColors, palette);
  result = ghostty_render_state_get(impl_->render_state, GHOSTTY_RENDER_STATE_DATA_COLORS,
                                    &impl_->render_colors);
  if (result != GHOSTTY_SUCCESS) {
    impl_->ansi_physical_valid = false;
    return std::unexpected(detail::map_error(result));
  }

  AnsiWriter writer(output);
  if (!composed && (!writer.append("\x1B[?2026h\x1B[?25l\x1B[?7l") ||
                    (full && !writer.append("\x1B[2J\x1B[H")))) {
    impl_->ansi_physical_valid = false;
    return std::unexpected(Error::out_of_space);
  }

  std::int32_t scrolled_rows = 0;
  if (allow_terminal_scroll && !full && *dirty == DirtyState::full) {
    result = ghostty_render_state_get(impl_->render_state, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
                                      static_cast<void*>(&impl_->row_iterator));
    if (result != GHOSTTY_SUCCESS) {
      impl_->ansi_physical_valid = false;
      return std::unexpected(detail::map_error(result));
    }
    std::size_t hash_index = 0;
    while (ghostty_render_state_row_iterator_next(impl_->row_iterator)) {
      const auto hash = impl_->calculate_row_hash();
      if (!hash.has_value()) {
        impl_->ansi_physical_valid = false;
        return std::unexpected(hash.error());
      }
      std::span(impl_->current_row_hashes).subspan(hash_index, 1).front() = *hash;
      ++hash_index;
    }
    LEMMA_ASSERT(hash_index == impl_->row_hash_count);
    scrolled_rows = impl_->detect_scroll();
    if (scrolled_rows != 0) {
      const auto amount = scrolled_rows > 0 ? scrolled_rows : -scrolled_rows;
      if (!writer.append("\x1B[") || !writer.append_integer(amount) ||
          !writer.append(scrolled_rows > 0 ? "S" : "T")) {
        impl_->ansi_physical_valid = false;
        return std::unexpected(Error::out_of_space);
      }
      impl_->apply_physical_scroll(scrolled_rows);
    }
  }

  std::size_t rendered_rows = 0;
  if (full || *dirty != DirtyState::clean) {
    result = ghostty_render_state_get(impl_->render_state, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
                                      static_cast<void*>(&impl_->row_iterator));
    if (result != GHOSTTY_SUCCESS) {
      impl_->ansi_physical_valid = false;
      return std::unexpected(detail::map_error(result));
    }

    const auto encode_changed_row =
        [&](const std::size_t row_index) noexcept -> std::expected<void, Error> {
      const bool scroll_row_unchanged =
          scrolled_rows != 0 &&
          std::span(impl_->row_hashes).subspan(row_index, 1).front() ==
              std::span(impl_->current_row_hashes).subspan(row_index, 1).front();
      if (scroll_row_unchanged) {
        return {};
      }
      const auto encoded =
          impl_->encode_row(writer, row_index, full, origin_column, origin_row, !composed);
      if (!encoded.has_value()) {
        return std::unexpected(encoded.error());
      }
      rendered_rows += static_cast<std::size_t>(*encoded);
      return {};
    };

    if (full) {
      std::size_t row_index = 0;
      while (ghostty_render_state_row_iterator_next(impl_->row_iterator)) {
        const auto encoded = encode_changed_row(row_index);
        if (!encoded.has_value()) {
          impl_->ansi_physical_valid = false;
          return std::unexpected(encoded.error());
        }
        ++row_index;
      }
    } else {
      std::uint16_t row_index = 0;
      while (ghostty_render_state_row_iterator_next_dirty(impl_->row_iterator, &row_index)) {
        const auto encoded = encode_changed_row(row_index);
        if (!encoded.has_value()) {
          impl_->ansi_physical_valid = false;
          return std::unexpected(encoded.error());
        }
      }
    }
  }

  if (!writer.append(composed ? "\x1B[0m" : "\x1B[0m\x1B[?7h")) {
    impl_->ansi_physical_valid = false;
    return std::unexpected(Error::out_of_space);
  }
  const bool canonical_cursor_visible = metadata.cursor_visible && metadata.cursor_in_viewport;
  const bool presented_cursor_visible = cursor_override || canonical_cursor_visible;
  const auto presented_cursor_column =
      cursor_override ? cursor_override_column : metadata.cursor_column;
  const auto presented_cursor_row = cursor_override ? cursor_override_row : metadata.cursor_row;
  if ((!composed || focused) && presented_cursor_visible) {
    if (!writer.append("\x1B[") ||
        !writer.append_integer(static_cast<std::size_t>(origin_row) + presented_cursor_row + 1U) ||
        !writer.append(";") ||
        !writer.append_integer(static_cast<std::size_t>(origin_column) + presented_cursor_column +
                               1U) ||
        !writer.append("H\x1B[?25h")) {
      impl_->ansi_physical_valid = false;
      return std::unexpected(Error::out_of_space);
    }
  }
  if ((!composed || focused) && !presented_cursor_visible && !writer.append("\x1B[?25l")) {
    impl_->ansi_physical_valid = false;
    return std::unexpected(Error::out_of_space);
  }
  if (!composed || focused) {
    const bool cursor_blinking = !cursor_override && impl_->render_cursor_blinking;
    const auto cursor_code = static_cast<std::uint8_t>(cursor_blinking ? 1U : 2U);
    const auto cursor_color = impl_->render_colors.cursor_has_value
                                  ? impl_->render_colors.cursor
                                  : impl_->render_colors.foreground;
    const bool cursor_projection_changed = cursor_override || full ||
                                           !impl_->projected_cursor_valid ||
                                           impl_->projected_cursor_code != cursor_code ||
                                           impl_->projected_cursor_color.r != cursor_color.r ||
                                           impl_->projected_cursor_color.g != cursor_color.g ||
                                           impl_->projected_cursor_color.b != cursor_color.b;
    if (cursor_projection_changed) {
      if (!append_cursor_color(writer, cursor_color, impl_->session_theme.cursor) ||
          !writer.append("\x1B[") || !writer.append_integer(cursor_code) || !writer.append(" q")) {
        impl_->ansi_physical_valid = false;
        return std::unexpected(Error::out_of_space);
      }
      impl_->projected_cursor_color = cursor_color;
      impl_->projected_cursor_code = cursor_code;
      impl_->projected_cursor_valid = true;
    }
  }

  struct MirroredMode final {
    GhosttyMode mode;
    std::uint16_t number;
    bool mouse{false};
  };
  const std::array mirrored_modes{
      MirroredMode{.mode = GHOSTTY_MODE_DECCKM, .number = 1},
      MirroredMode{.mode = GHOSTTY_MODE_X10_MOUSE, .number = 9, .mouse = true},
      MirroredMode{.mode = GHOSTTY_MODE_NORMAL_MOUSE, .number = 1000, .mouse = true},
      MirroredMode{.mode = GHOSTTY_MODE_BUTTON_MOUSE, .number = 1002, .mouse = true},
      MirroredMode{.mode = GHOSTTY_MODE_ANY_MOUSE, .number = 1003, .mouse = true},
      MirroredMode{.mode = GHOSTTY_MODE_FOCUS_EVENT, .number = 1004},
      MirroredMode{.mode = GHOSTTY_MODE_UTF8_MOUSE, .number = 1005, .mouse = true},
      MirroredMode{.mode = GHOSTTY_MODE_SGR_MOUSE, .number = 1006, .mouse = true},
      MirroredMode{.mode = GHOSTTY_MODE_ALT_SCROLL, .number = 1007},
      MirroredMode{.mode = GHOSTTY_MODE_URXVT_MOUSE, .number = 1015, .mouse = true},
      MirroredMode{.mode = GHOSTTY_MODE_SGR_PIXELS_MOUSE, .number = 1016, .mouse = true},
      MirroredMode{.mode = GHOSTTY_MODE_BRACKETED_PASTE, .number = 2004},
  };
  static_assert(mirrored_modes.size() == 12);
  if (!composed || focused) {
    std::size_t mode_index = 0;
    for (const auto mode : mirrored_modes) {
      // A composed frame receives normalized physical mouse input for both Lemma and the child.
      // The compositor owns that outer capture policy; only standalone rendering mirrors the
      // child's mouse modes directly.
      if (composed && mode.mouse) {
        impl_->mirrored_mouse_modes_valid = false;
        ++mode_index;
        continue;
      }
      const auto enabled = terminal_mode_enabled(impl_->terminal, mode.mode);
      if (!enabled.has_value()) {
        impl_->ansi_physical_valid = false;
        return std::unexpected(enabled.error());
      }
      auto& physical_value = std::span(impl_->mirrored_mode_values).subspan(mode_index, 1).front();
      const bool must_emit = full || !impl_->mirrored_modes_valid ||
                             (mode.mouse && !impl_->mirrored_mouse_modes_valid) ||
                             physical_value != *enabled;
      if (must_emit && (!writer.append("\x1B[?") || !writer.append_integer(mode.number) ||
                        !writer.append(*enabled ? "h" : "l"))) {
        impl_->ansi_physical_valid = false;
        return std::unexpected(Error::out_of_space);
      }
      physical_value = *enabled;
      ++mode_index;
    }
    impl_->mirrored_modes_valid = true;
    if (!composed) {
      impl_->mirrored_mouse_modes_valid = true;
    }
  }

  if (!composed && !writer.append("\x1B[?2026l")) {
    impl_->ansi_physical_valid = false;
    return std::unexpected(Error::out_of_space);
  }

  result = ghostty_render_state_clean(impl_->render_state);
  if (result != GHOSTTY_SUCCESS) {
    impl_->ansi_physical_valid = false;
    return std::unexpected(detail::map_error(result));
  }

  impl_->ansi_physical_valid = true;
  return AnsiRenderResult{
      .bytes = writer.size(),
      .rows = rendered_rows,
      .scrolled_rows = scrolled_rows,
      .full = full,
  };
}

} // namespace lemma::vt
