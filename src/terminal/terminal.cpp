#include "lemma/terminal/terminal.hpp"

#include "diagnostic/latency_trace.hpp"
#include "lemma/assert.hpp"
#include "lemma/bounded_byte_queue.hpp"

#include <ghostty/vt.h>

#include <algorithm>
#include <array>
#include <bit>
#include <charconv>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <iterator>
#include <limits>
#include <memory>
#include <new>
#include <span>
#include <string_view>
#include <system_error>
#include <utility>

namespace lemma::vt {

[[nodiscard]] auto library_version() noexcept -> std::span<const std::uint8_t> {
  GhosttyString version{};
  if (ghostty_build_info(GHOSTTY_BUILD_INFO_VERSION_STRING, &version) != GHOSTTY_SUCCESS) {
    return {};
  }
  return {version.ptr, version.len};
}

namespace {

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

  [[nodiscard]] auto size() const noexcept -> std::size_t { return used_; }
  void rewind(const std::size_t size) noexcept {
    LEMMA_ASSERT(size <= used_);
    used_ = size;
  }

private:
  std::span<std::byte> output_;
  std::size_t used_{0};
};

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

[[nodiscard]] auto ansi_color(const GhosttyStyleColor color) noexcept -> AnsiColor {
  switch (color.tag) {
  case GHOSTTY_STYLE_COLOR_NONE:
    return {};
  case GHOSTTY_STYLE_COLOR_PALETTE:
    return {.tag = AnsiColorTag::palette, .index = color.value.palette};
  case GHOSTTY_STYLE_COLOR_RGB:
    return {
        .tag = AnsiColorTag::rgb,
        .red = color.value.rgb.r,
        .green = color.value.rgb.g,
        .blue = color.value.rgb.b,
    };
  case GHOSTTY_STYLE_COLOR_TAG_MAX_VALUE:
    return {};
  }
  return {};
}

[[nodiscard]] auto ansi_style(const GhosttyStyle& style) noexcept -> AnsiStyle {
  return {
      .foreground = ansi_color(style.fg_color),
      .background = ansi_color(style.bg_color),
      .underline_color = ansi_color(style.underline_color),
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

[[nodiscard]] constexpr auto ghostty_key_action(const KeyAction action) noexcept
    -> GhosttyKeyAction {
  switch (action) {
  case KeyAction::release:
    return GHOSTTY_KEY_ACTION_RELEASE;
  case KeyAction::press:
    return GHOSTTY_KEY_ACTION_PRESS;
  case KeyAction::repeat:
    return GHOSTTY_KEY_ACTION_REPEAT;
  }
  return GHOSTTY_KEY_ACTION_PRESS;
}

[[nodiscard]] auto ghostty_key(const Key key) noexcept -> GhosttyKey {
  constexpr std::array mapping{
      GHOSTTY_KEY_UNIDENTIFIED,
      GHOSTTY_KEY_A,
      GHOSTTY_KEY_B,
      GHOSTTY_KEY_C,
      GHOSTTY_KEY_D,
      GHOSTTY_KEY_E,
      GHOSTTY_KEY_F,
      GHOSTTY_KEY_G,
      GHOSTTY_KEY_H,
      GHOSTTY_KEY_I,
      GHOSTTY_KEY_J,
      GHOSTTY_KEY_K,
      GHOSTTY_KEY_L,
      GHOSTTY_KEY_M,
      GHOSTTY_KEY_N,
      GHOSTTY_KEY_O,
      GHOSTTY_KEY_P,
      GHOSTTY_KEY_Q,
      GHOSTTY_KEY_R,
      GHOSTTY_KEY_S,
      GHOSTTY_KEY_T,
      GHOSTTY_KEY_U,
      GHOSTTY_KEY_V,
      GHOSTTY_KEY_W,
      GHOSTTY_KEY_X,
      GHOSTTY_KEY_Y,
      GHOSTTY_KEY_Z,
      GHOSTTY_KEY_ENTER,
      GHOSTTY_KEY_TAB,
      GHOSTTY_KEY_BACKSPACE,
      GHOSTTY_KEY_ESCAPE,
      GHOSTTY_KEY_SPACE,
      GHOSTTY_KEY_ARROW_UP,
      GHOSTTY_KEY_ARROW_DOWN,
      GHOSTTY_KEY_ARROW_LEFT,
      GHOSTTY_KEY_ARROW_RIGHT,
      GHOSTTY_KEY_HOME,
      GHOSTTY_KEY_END,
      GHOSTTY_KEY_INSERT,
      GHOSTTY_KEY_DELETE,
      GHOSTTY_KEY_PAGE_UP,
      GHOSTTY_KEY_PAGE_DOWN,
      GHOSTTY_KEY_F1,
      GHOSTTY_KEY_F2,
      GHOSTTY_KEY_F3,
      GHOSTTY_KEY_F4,
      GHOSTTY_KEY_F5,
      GHOSTTY_KEY_F6,
      GHOSTTY_KEY_F7,
      GHOSTTY_KEY_F8,
      GHOSTTY_KEY_F9,
      GHOSTTY_KEY_F10,
      GHOSTTY_KEY_F11,
      GHOSTTY_KEY_F12,
  };
  static_assert(static_cast<std::size_t>(Key::f12) + 1U == mapping.size());
  const auto index = static_cast<std::size_t>(key);
  return index < mapping.size() ? std::span(mapping).subspan(index, 1).front()
                                : GHOSTTY_KEY_UNIDENTIFIED;
}

[[nodiscard]] auto terminal_mode_enabled(const GhosttyTerminal terminal,
                                         const GhosttyMode mode) noexcept
    -> std::expected<bool, Error> {
  bool enabled = false;
  const auto result = ghostty_terminal_mode_get(terminal, mode, &enabled);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(Error::invalid_state);
  }
  return enabled;
}

[[nodiscard]] constexpr auto hash_byte(std::uint64_t hash, const std::uint8_t value) noexcept
    -> std::uint64_t {
  return (hash ^ value) * 1'099'511'628'211ULL;
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

// The allocator ABI necessarily uses explicit allocation and deallocation.
// NOLINTBEGIN(cppcoreguidelines-no-malloc)
class QuotaAllocator final {
public:
  explicit QuotaAllocator(const std::size_t bytes_max) noexcept
      : bytes_max_(bytes_max), native_{.ctx = this, .vtable = &vtable} {
    LEMMA_ASSERT(bytes_max_ > 0);
    LEMMA_ASSERT(bytes_max_ <= limits::terminal_allocation_bytes_hard_max);
  }

  [[nodiscard]] auto native() const noexcept -> const GhosttyAllocator* { return &native_; }
  [[nodiscard]] auto stats() const noexcept -> AllocationStats { return stats_; }

private:
  static void* allocate(void* context, const std::size_t length, const std::uint8_t alignment,
                        [[maybe_unused]] const std::uintptr_t return_address) noexcept {
    auto& allocator = *static_cast<QuotaAllocator*>(context);
    assert_valid_alignment(alignment);

    if (length == 0 || length > allocator.bytes_max_ - allocator.stats_.bytes_current) {
      allocator.record_failure();
      return nullptr;
    }

    void* const memory = allocate_raw(length, alignment);
    if (memory == nullptr) {
      allocator.record_failure();
      return nullptr;
    }

    allocator.record_allocation(length);
    return memory;
  }

  static auto resize(void* context, void* memory, const std::size_t memory_length,
                     const std::uint8_t alignment, const std::size_t new_length,
                     [[maybe_unused]] const std::uintptr_t return_address) noexcept -> bool {
    auto& allocator = *static_cast<QuotaAllocator*>(context);
    allocator.assert_allocation(memory, memory_length, alignment);
    LEMMA_ASSERT(new_length > 0);

    if (new_length > memory_length) {
      return false;
    }

    allocator.stats_.bytes_current -= memory_length - new_length;
    return true;
  }

  static void* remap(void* context, void* memory, const std::size_t memory_length,
                     const std::uint8_t alignment, const std::size_t new_length,
                     [[maybe_unused]] const std::uintptr_t return_address) noexcept {
    auto& allocator = *static_cast<QuotaAllocator*>(context);
    allocator.assert_allocation(memory, memory_length, alignment);
    LEMMA_ASSERT(new_length > 0);

    if (new_length <= memory_length) {
      allocator.stats_.bytes_current -= memory_length - new_length;
      return memory;
    }

    // Relocation temporarily owns both allocations, so the quota must cover both.
    if (new_length > allocator.bytes_max_ - allocator.stats_.bytes_current) {
      allocator.record_failure();
      return nullptr;
    }

    void* const resized_memory = allocate_raw(new_length, alignment);
    if (resized_memory == nullptr) {
      allocator.record_failure();
      return nullptr;
    }

    const auto bytes_transient = allocator.stats_.bytes_current + new_length;
    allocator.stats_.bytes_peak = std::max(allocator.stats_.bytes_peak, bytes_transient);
    std::memcpy(resized_memory, memory, memory_length);
    std::free(memory);
    allocator.stats_.bytes_current += new_length - memory_length;
    allocator.record_total_allocation();
    return resized_memory;
  }

  static void deallocate(void* context, void* memory, const std::size_t memory_length,
                         const std::uint8_t alignment,
                         [[maybe_unused]] const std::uintptr_t return_address) noexcept {
    auto& allocator = *static_cast<QuotaAllocator*>(context);
    allocator.assert_allocation(memory, memory_length, alignment);

    std::free(memory);
    allocator.stats_.bytes_current -= memory_length;
    --allocator.stats_.allocations_current;
  }

  void record_allocation(const std::size_t length) noexcept {
    LEMMA_ASSERT(length <= bytes_max_ - stats_.bytes_current);
    LEMMA_ASSERT(stats_.allocations_current < std::numeric_limits<std::size_t>::max());

    stats_.bytes_current += length;
    stats_.bytes_peak = std::max(stats_.bytes_peak, stats_.bytes_current);
    ++stats_.allocations_current;
    record_total_allocation();
  }

  void record_failure() noexcept {
    if (stats_.failures_total < std::numeric_limits<std::size_t>::max()) {
      ++stats_.failures_total;
    }
  }

  void record_total_allocation() noexcept {
    if (stats_.allocations_total < std::numeric_limits<std::size_t>::max()) {
      ++stats_.allocations_total;
    }
  }

  void assert_allocation(const void* memory, const std::size_t memory_length,
                         const std::uint8_t alignment) const noexcept {
    LEMMA_ASSERT(memory != nullptr);
    LEMMA_ASSERT(memory_length > 0);
    LEMMA_ASSERT(memory_length <= stats_.bytes_current);
    LEMMA_ASSERT(stats_.allocations_current > 0);
    assert_valid_alignment(alignment);
  }

  [[nodiscard]] static auto allocate_raw(const std::size_t length,
                                         const std::uint8_t alignment) noexcept -> void* {
    assert_valid_alignment(alignment);
    const auto alignment_bytes = std::size_t{1} << alignment;
    if (alignment_bytes <= alignof(std::max_align_t)) {
      return std::malloc(length);
    }

    void* memory = nullptr;
    if (posix_memalign(&memory, alignment_bytes, length) != 0) {
      return nullptr;
    }
    return memory;
  }

  static void assert_valid_alignment(const std::uint8_t alignment) noexcept {
    // Ghostty forwards Zig's log2 alignment enum despite the current C header describing bytes.
    LEMMA_ASSERT(std::has_single_bit(alignof(std::max_align_t)));
    LEMMA_ASSERT(alignment < std::numeric_limits<std::size_t>::digits);
  }

  static constexpr GhosttyAllocatorVtable vtable{
      .alloc = &QuotaAllocator::allocate,
      .resize = &QuotaAllocator::resize,
      .remap = &QuotaAllocator::remap,
      .free = &QuotaAllocator::deallocate,
  };

  std::size_t bytes_max_;
  AllocationStats stats_{};
  GhosttyAllocator native_;
};
// NOLINTEND(cppcoreguidelines-no-malloc)

[[nodiscard]] auto valid_size(const TerminalSize& size) noexcept -> bool {
  if (size.columns == 0 || size.rows == 0 || size.columns > limits::terminal_columns_hard_max ||
      size.rows > limits::terminal_rows_hard_max) {
    return false;
  }

  const auto width_max = std::numeric_limits<std::uint32_t>::max() / size.columns;
  const auto height_max = std::numeric_limits<std::uint32_t>::max() / size.rows;
  return size.cell_width_px <= width_max && size.cell_height_px <= height_max;
}

[[nodiscard]] auto valid_options(const TerminalOptions& options) noexcept -> bool {
  if (!valid_size(options.size)) {
    return false;
  }
  if (options.scrollback_bytes_max > limits::terminal_scrollback_bytes_hard_max) {
    return false;
  }
  return options.allocation_bytes_max > 0 &&
         options.allocation_bytes_max <= limits::terminal_allocation_bytes_hard_max;
}

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

[[nodiscard]] auto map_error(const GhosttyResult result) noexcept -> Error {
  switch (result) {
  case GHOSTTY_OUT_OF_MEMORY:
    return Error::out_of_memory;
  case GHOSTTY_OUT_OF_SPACE:
    return Error::out_of_space;
  case GHOSTTY_INVALID_VALUE:
  case GHOSTTY_NO_VALUE:
  case GHOSTTY_SUCCESS:
  case GHOSTTY_RESULT_MAX_VALUE:
    return Error::invalid_state;
  }
  return Error::invalid_state;
}

// Dynamically sized physical state is allocated only at pane creation and resize.
using CellHashStorage = std::unique_ptr<std::uint64_t[]>; // NOLINT

template <typename Function>
[[nodiscard]] auto callback_pointer(const Function function) noexcept -> const void* {
  static_assert(sizeof(Function) == sizeof(const void*));
  return std::bit_cast<const void*>(function); // NOLINT(bugprone-bitwise-pointer-cast)
}

} // namespace

struct Terminal::Impl final {
  explicit Impl(const TerminalOptions& terminal_options) noexcept
      : options(terminal_options), allocator(terminal_options.allocation_bytes_max) {}

  ~Impl() {
    ghostty_key_event_free(key_event);
    ghostty_key_encoder_free(key_encoder);
    ghostty_render_state_row_cells_free(row_cells);
    ghostty_render_state_row_iterator_free(row_iterator);
    ghostty_render_state_free(render_state);
    ghostty_terminal_free(terminal);
    LEMMA_ASSERT(allocator.stats().bytes_current == 0);
    LEMMA_ASSERT(allocator.stats().allocations_current == 0);
  }

  Impl(const Impl&) = delete;
  auto operator=(const Impl&) -> Impl& = delete;
  Impl(Impl&&) = delete;
  auto operator=(Impl&&) -> Impl& = delete;

  static void write_pty([[maybe_unused]] GhosttyTerminal terminal_handle, void* userdata,
                        const std::uint8_t* data, const std::size_t length) noexcept {
    auto& impl = *static_cast<Impl*>(userdata);
    const auto bytes = std::as_bytes(std::span(data, length));
    if (!impl.pty_responses.append(bytes)) {
      impl.effects.pty_response_overflowed = true;
    }
  }

  static void bell([[maybe_unused]] GhosttyTerminal terminal_handle, void* userdata) noexcept {
    auto& impl = *static_cast<Impl*>(userdata);
    if (impl.effects.bells < std::numeric_limits<std::uint64_t>::max()) {
      ++impl.effects.bells;
    }
  }

  static void title_changed([[maybe_unused]] GhosttyTerminal terminal_handle,
                            void* userdata) noexcept {
    auto& impl = *static_cast<Impl*>(userdata);
    if (impl.effects.title_changes < std::numeric_limits<std::uint64_t>::max()) {
      ++impl.effects.title_changes;
    }
  }

  [[nodiscard]] auto dirty_state() const noexcept -> std::expected<DirtyState, Error> {
    GhosttyRenderStateDirty ghostty_dirty = GHOSTTY_RENDER_STATE_DIRTY_FALSE;
    const auto result =
        ghostty_render_state_get(render_state, GHOSTTY_RENDER_STATE_DATA_DIRTY, &ghostty_dirty);
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(map_error(result));
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

  [[nodiscard]] auto set_dirty_state(const DirtyState dirty) const noexcept
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
      return std::unexpected(map_error(result));
    }
    return {};
  }

  [[nodiscard]] auto populate_render_metadata(RenderUpdate& update) const noexcept
      -> std::expected<void, Error> {
    const std::array keys{
        GHOSTTY_RENDER_STATE_DATA_COLS,
        GHOSTTY_RENDER_STATE_DATA_ROWS,
        GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X,
        GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y,
        GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE,
        GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE,
    };
    std::array<void*, keys.size()> values{
        &update.columns,    &update.rows,           &update.cursor_column,
        &update.cursor_row, &update.cursor_visible, &update.cursor_in_viewport,
    };
    std::size_t values_written = 0;
    const auto result = ghostty_render_state_get_multi(render_state, keys.size(), keys.data(),
                                                       values.data(), &values_written);
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(map_error(result));
    }
    if (values_written != keys.size()) {
      return std::unexpected(Error::invalid_state);
    }
    return {};
  }

  [[nodiscard]] auto dirty_row_count() noexcept -> std::expected<std::size_t, Error> {
    auto result = ghostty_render_state_get(render_state, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
                                           static_cast<void*>(&row_iterator));
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(map_error(result));
    }

    std::size_t count = 0;
    while (ghostty_render_state_row_iterator_next(row_iterator)) {
      bool row_dirty = false;
      result = ghostty_render_state_row_get(row_iterator, GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY,
                                            &row_dirty);
      if (result != GHOSTTY_SUCCESS) {
        return std::unexpected(map_error(result));
      }
      if (row_dirty) {
        ++count;
      }
    }
    return count;
  }

  [[nodiscard]] auto calculate_row_hash() noexcept -> std::expected<std::uint64_t, Error> {
    auto result = ghostty_render_state_row_get(row_iterator, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
                                               static_cast<void*>(&row_cells));
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(map_error(result));
    }

    constexpr std::uint64_t hash_initial = 14'695'981'039'346'656'037ULL;
    std::uint64_t row_hash = hash_initial;
    std::size_t cell_count = 0;
    while (ghostty_render_state_row_cells_next(row_cells)) {
      GhosttyCell raw_cell = 0;
      result = ghostty_render_state_row_cells_get(
          row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw_cell);
      if (result != GHOSTTY_SUCCESS) {
        return std::unexpected(map_error(result));
      }
      for (std::size_t shift = 0; shift < 64; shift += 8) {
        row_hash = hash_byte(row_hash, static_cast<std::uint8_t>(raw_cell >> shift));
      }
      ++cell_count;
    }
    LEMMA_ASSERT(cell_count == options.size.columns);
    return row_hash;
  }

  [[nodiscard]] auto detect_scroll() const noexcept -> std::int32_t {
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

  void apply_physical_scroll(const std::int32_t scroll) noexcept {
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
  [[nodiscard]] auto encode_row(AnsiWriter& writer, const std::size_t row_index, const bool force,
                                const std::uint16_t origin_column, const std::uint16_t origin_row,
                                const bool erase_line_tail) noexcept -> std::expected<bool, Error> {
    LEMMA_ASSERT(row_index < row_hash_count);
    LEMMA_ASSERT(physical_cell_hashes != nullptr);
    const auto checkpoint = writer.size();
    auto result = ghostty_render_state_row_get(row_iterator, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
                                               static_cast<void*>(&row_cells));
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(map_error(result));
    }

    constexpr std::uint64_t hash_initial = 14'695'981'039'346'656'037ULL;
    std::uint64_t row_hash = hash_initial;
    AnsiStyle active_style{};
    bool active_style_valid = false;
    bool span_started = false;
    std::size_t changed_end = checkpoint;
    std::size_t trailing_blank_start = std::numeric_limits<std::size_t>::max();
    bool trailing_blank_changed = false;
    std::size_t cell_count = 0;
    while (ghostty_render_state_row_cells_next(row_cells)) {
      GhosttyCell raw_cell = 0;
      GhosttyStyle ghostty_style{};
      ghostty_style.size = sizeof(ghostty_style);
      result = ghostty_render_state_row_cells_get(
          row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw_cell);
      if (result != GHOSTTY_SUCCESS) {
        return std::unexpected(map_error(result));
      }
      for (std::size_t shift = 0; shift < 64; shift += 8) {
        row_hash = hash_byte(row_hash, static_cast<std::uint8_t>(raw_cell >> shift));
      }
      result = ghostty_render_state_row_cells_get(
          row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &ghostty_style);
      if (result != GHOSTTY_SUCCESS) {
        return std::unexpected(map_error(result));
      }

      GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
      result = ghostty_cell_get(raw_cell, GHOSTTY_CELL_DATA_WIDE, &wide);
      if (result != GHOSTTY_SUCCESS) {
        return std::unexpected(map_error(result));
      }
      const auto style = ansi_style(ghostty_style);

      std::array<std::uint8_t, pane_ansi_grapheme_bytes_max> grapheme{};
      GhosttyBuffer grapheme_buffer{
          .ptr = grapheme.data(),
          .cap = grapheme.size(),
          .len = 0,
      };
      result = ghostty_render_state_row_cells_get(
          row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &grapheme_buffer);
      const bool replacement = result == GHOSTTY_OUT_OF_SPACE;
      if (!replacement && result != GHOSTTY_SUCCESS) {
        return std::unexpected(map_error(result));
      }

      std::uint64_t cell_hash = hash_style(hash_initial, style);
      cell_hash = hash_byte(cell_hash, static_cast<std::uint8_t>(wide));
      if (replacement) {
        constexpr std::string_view replacement_text = "\xEF\xBF\xBD";
        for (const char byte : replacement_text) {
          cell_hash = hash_byte(cell_hash, static_cast<std::uint8_t>(byte));
        }
      } else if (grapheme_buffer.len == 0) {
        cell_hash = hash_byte(cell_hash, 0);
      } else {
        const auto bytes = std::as_bytes(std::span(grapheme).first(grapheme_buffer.len));
        for (const auto byte : bytes) {
          cell_hash = hash_byte(cell_hash, std::to_integer<std::uint8_t>(byte));
        }
      }
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
        if ((!active_style_valid || style != active_style) && !append_style(writer, style)) {
          return std::unexpected(Error::out_of_space);
        }
        active_style = style;
        active_style_valid = true;

        const bool default_blank = !replacement && grapheme_buffer.len == 0 &&
                                   wide != GHOSTTY_CELL_WIDE_SPACER_TAIL && style == AnsiStyle{};
        if (default_blank) {
          if (trailing_blank_start == std::numeric_limits<std::size_t>::max()) {
            trailing_blank_start = cell_checkpoint;
            trailing_blank_changed = false;
          }
          trailing_blank_changed = trailing_blank_changed || changed;
        } else {
          trailing_blank_start = std::numeric_limits<std::size_t>::max();
          trailing_blank_changed = false;
        }

        if (replacement) {
          if (wide != GHOSTTY_CELL_WIDE_SPACER_TAIL && !writer.append("\xEF\xBF\xBD")) {
            return std::unexpected(Error::out_of_space);
          }
        } else if (grapheme_buffer.len == 0) {
          if (wide != GHOSTTY_CELL_WIDE_SPACER_TAIL && !writer.append(" ")) {
            return std::unexpected(Error::out_of_space);
          }
        } else if (wide != GHOSTTY_CELL_WIDE_SPACER_TAIL &&
                   !writer.append(std::as_bytes(std::span(grapheme).first(grapheme_buffer.len)))) {
          return std::unexpected(Error::out_of_space);
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
      if (!writer.append("\x1B[0m\x1B[K")) {
        return std::unexpected(Error::out_of_space);
      }
    } else {
      writer.rewind(changed_end);
    }
    return true;
  }

  TerminalOptions options;
  QuotaAllocator allocator;
  GhosttyTerminal terminal{nullptr};
  GhosttyKeyEncoder key_encoder{nullptr};
  GhosttyKeyEvent key_event{nullptr};
  GhosttyRenderState render_state{nullptr};
  GhosttyRenderStateRowIterator row_iterator{nullptr};
  GhosttyRenderStateRowCells row_cells{nullptr};
  std::array<std::uint64_t, limits::terminal_rows_hard_max> row_hashes{};
  std::array<std::uint64_t, limits::terminal_rows_hard_max> current_row_hashes{};
  CellHashStorage physical_cell_hashes;
  std::size_t physical_cell_count{0};
  std::size_t row_hash_count{0};
  std::array<bool, 12> mirrored_mode_values{};
  bool mirrored_modes_valid{false};
  bool ansi_physical_valid{false};
  BoundedByteQueue<limits::terminal_pty_response_bytes_max> pty_responses;
  EffectBatch effects{};
};

Terminal::Terminal(std::unique_ptr<Impl> impl) noexcept : impl_(std::move(impl)) {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
}

Terminal::Terminal(Terminal&& other) noexcept = default;

auto Terminal::operator=(Terminal&& other) noexcept -> Terminal& = default;

Terminal::~Terminal() = default;

auto Terminal::create(const TerminalOptions& options) noexcept -> std::expected<Terminal, Error> {
  if (!valid_options(options)) {
    return std::unexpected(Error::invalid_options);
  }

  std::unique_ptr<Impl> impl;
  try {
    impl = std::make_unique<Impl>(options);
  } catch (const std::bad_alloc&) {
    return std::unexpected(Error::out_of_memory);
  }

  const GhosttyTerminalOptions ghostty_options{
      .cols = options.size.columns,
      .rows = options.size.rows,
      .max_scrollback = options.scrollback_bytes_max,
  };
  auto result = ghostty_terminal_new(impl->allocator.native(), &impl->terminal, ghostty_options);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }

  result = ghostty_key_encoder_new(impl->allocator.native(), &impl->key_encoder);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }
  result = ghostty_key_event_new(impl->allocator.native(), &impl->key_event);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }
  result = ghostty_render_state_new(impl->allocator.native(), &impl->render_state);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }

  result = ghostty_render_state_row_iterator_new(impl->allocator.native(), &impl->row_iterator);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }

  result = ghostty_render_state_row_cells_new(impl->allocator.native(), &impl->row_cells);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }

  impl->row_hash_count = options.size.rows;
  impl->physical_cell_count = static_cast<std::size_t>(options.size.columns) * options.size.rows;
  try {
    // Runtime-sized cell storage cannot use std::array.
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
    impl->physical_cell_hashes = std::make_unique<std::uint64_t[]>(impl->physical_cell_count);
  } catch (const std::bad_alloc&) {
    return std::unexpected(Error::out_of_memory);
  }

  result = ghostty_terminal_set(impl->terminal, GHOSTTY_TERMINAL_OPT_USERDATA, impl.get());
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }

  result = ghostty_terminal_set(
      impl->terminal, GHOSTTY_TERMINAL_OPT_WRITE_PTY,
      callback_pointer(static_cast<GhosttyTerminalWritePtyFn>(&Impl::write_pty)));
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }

  result = ghostty_terminal_set(impl->terminal, GHOSTTY_TERMINAL_OPT_BELL,
                                callback_pointer(static_cast<GhosttyTerminalBellFn>(&Impl::bell)));
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }

  result = ghostty_terminal_set(
      impl->terminal, GHOSTTY_TERMINAL_OPT_TITLE_CHANGED,
      callback_pointer(static_cast<GhosttyTerminalTitleChangedFn>(&Impl::title_changed)));
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }

  return Terminal(std::move(impl));
}

void Terminal::write(const std::span<const std::byte> bytes) noexcept {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  if (!bytes.empty()) {
    // std::byte and uint8_t are both byte views; Ghostty's C ABI uses the latter.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    const auto* data = reinterpret_cast<const std::uint8_t*>(bytes.data());
    ghostty_terminal_vt_write(impl_->terminal, data, bytes.size());
  }
}

auto Terminal::write_and_report_damage(const std::span<const std::byte> bytes) noexcept
    -> std::expected<DirtyState, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  LEMMA_ASSERT(impl_->render_state != nullptr);

  auto result = ghostty_render_state_update(impl_->render_state, impl_->terminal);
  if (result != GHOSTTY_SUCCESS) {
    write(bytes);
    return std::unexpected(map_error(result));
  }
  const auto prior_damage = impl_->dirty_state();
  if (!prior_damage.has_value()) {
    write(bytes);
    return std::unexpected(prior_damage.error());
  }
  const auto cleared = impl_->set_dirty_state(DirtyState::clean);
  if (!cleared.has_value()) {
    write(bytes);
    return std::unexpected(cleared.error());
  }

  write(bytes);
  result = ghostty_render_state_update(impl_->render_state, impl_->terminal);
  if (result != GHOSTTY_SUCCESS) {
    const auto restored = impl_->set_dirty_state(*prior_damage);
    if (!restored.has_value()) {
      return std::unexpected(restored.error());
    }
    return std::unexpected(map_error(result));
  }
  const auto acquired_damage = impl_->dirty_state();
  if (!acquired_damage.has_value()) {
    const auto restored = impl_->set_dirty_state(*prior_damage);
    if (!restored.has_value()) {
      return std::unexpected(restored.error());
    }
    return std::unexpected(acquired_damage.error());
  }
  const auto accumulated_damage = std::max(*prior_damage, *acquired_damage);
  const auto restored = impl_->set_dirty_state(accumulated_damage);
  if (!restored.has_value()) {
    return std::unexpected(restored.error());
  }
  return *acquired_damage;
}

auto Terminal::resize(const TerminalSize& size) noexcept -> std::expected<void, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  if (!valid_size(size)) {
    return std::unexpected(Error::invalid_options);
  }

  const auto physical_cell_count = static_cast<std::size_t>(size.columns) * size.rows;
  CellHashStorage physical_cell_hashes;
  try {
    // Runtime-sized cell storage cannot use std::array.
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
    physical_cell_hashes = std::make_unique<std::uint64_t[]>(physical_cell_count);
  } catch (const std::bad_alloc&) {
    return std::unexpected(Error::out_of_memory);
  }

  const auto result = ghostty_terminal_resize(impl_->terminal, size.columns, size.rows,
                                              size.cell_width_px, size.cell_height_px);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }

  impl_->physical_cell_hashes = std::move(physical_cell_hashes);
  impl_->physical_cell_count = physical_cell_count;
  impl_->row_hashes.fill(0);
  impl_->row_hash_count = size.rows;
  impl_->mirrored_modes_valid = false;
  impl_->ansi_physical_valid = false;
  impl_->options.size = size;
  return {};
}

auto Terminal::update_render_state() noexcept -> std::expected<RenderUpdate, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->render_state != nullptr);

  const auto result = ghostty_render_state_update(impl_->render_state, impl_->terminal);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
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

  auto result =
      ghostty_render_state_get(impl_->render_state, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
                               static_cast<void*>(&impl_->row_iterator));
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }

  const bool clean = false;
  while (ghostty_render_state_row_iterator_next(impl_->row_iterator)) {
    result = ghostty_render_state_row_set(impl_->row_iterator,
                                          GHOSTTY_RENDER_STATE_ROW_OPTION_DIRTY, &clean);
    if (result != GHOSTTY_SUCCESS) {
      return std::unexpected(map_error(result));
    }
  }

  const auto clean_state = GHOSTTY_RENDER_STATE_DIRTY_FALSE;
  result = ghostty_render_state_set(impl_->render_state, GHOSTTY_RENDER_STATE_OPTION_DIRTY,
                                    &clean_state);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }
  return {};
}

auto Terminal::render_ansi(const std::span<std::byte> output, const bool force_full) noexcept
    -> std::expected<AnsiRenderResult, Error> {
  return render_ansi_impl(output, force_full, 0, 0, false, true, true);
}

auto Terminal::render_pane_ansi(const std::span<std::byte> output,
                                const PaneRenderOptions& options) noexcept
    -> std::expected<AnsiRenderResult, Error> {
  return render_ansi_impl(output, options.force_full, options.column, options.row, true,
                          options.focused, options.allow_terminal_scroll);
}

void Terminal::invalidate_ansi_render_state() noexcept {
  LEMMA_ASSERT(impl_ != nullptr);
  impl_->ansi_physical_valid = false;
}

// Rendering is an explicit bounded pass over rows and cells owned by Ghostty's snapshot.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto Terminal::render_ansi_impl(const std::span<std::byte> output, const bool force_full,
                                const std::uint16_t origin_column, const std::uint16_t origin_row,
                                const bool composed, const bool focused,
                                const bool allow_terminal_scroll) noexcept
    -> std::expected<AnsiRenderResult, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->render_state != nullptr);

  auto result = ghostty_render_state_update(impl_->render_state, impl_->terminal);
  if (result != GHOSTTY_SUCCESS) {
    impl_->ansi_physical_valid = false;
    return std::unexpected(map_error(result));
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
      return std::unexpected(map_error(result));
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

  result = ghostty_render_state_get(impl_->render_state, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
                                    static_cast<void*>(&impl_->row_iterator));
  if (result != GHOSTTY_SUCCESS) {
    impl_->ansi_physical_valid = false;
    return std::unexpected(map_error(result));
  }

  std::size_t row_index = 0;
  std::size_t rendered_rows = 0;
  const bool clean = false;
  while (ghostty_render_state_row_iterator_next(impl_->row_iterator)) {
    bool row_dirty = false;
    result = ghostty_render_state_row_get(impl_->row_iterator, GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY,
                                          &row_dirty);
    if (result != GHOSTTY_SUCCESS) {
      impl_->ansi_physical_valid = false;
      return std::unexpected(map_error(result));
    }
    const bool scroll_row_unchanged =
        scrolled_rows != 0 &&
        std::span(impl_->row_hashes).subspan(row_index, 1).front() ==
            std::span(impl_->current_row_hashes).subspan(row_index, 1).front();
    if ((full || row_dirty) && !scroll_row_unchanged) {
      const auto encoded =
          impl_->encode_row(writer, row_index, full, origin_column, origin_row, !composed);
      if (!encoded.has_value()) {
        impl_->ansi_physical_valid = false;
        return std::unexpected(encoded.error());
      }
      rendered_rows += static_cast<std::size_t>(*encoded);
    }
    result = ghostty_render_state_row_set(impl_->row_iterator,
                                          GHOSTTY_RENDER_STATE_ROW_OPTION_DIRTY, &clean);
    if (result != GHOSTTY_SUCCESS) {
      impl_->ansi_physical_valid = false;
      return std::unexpected(map_error(result));
    }
    ++row_index;
  }

  if (!writer.append(composed ? "\x1B[0m" : "\x1B[0m\x1B[?7h")) {
    impl_->ansi_physical_valid = false;
    return std::unexpected(Error::out_of_space);
  }
  if ((!composed || focused) && metadata.cursor_visible && metadata.cursor_in_viewport) {
    if (!writer.append("\x1B[") ||
        !writer.append_integer(static_cast<std::size_t>(origin_row) + metadata.cursor_row + 1U) ||
        !writer.append(";") ||
        !writer.append_integer(static_cast<std::size_t>(origin_column) + metadata.cursor_column +
                               1U) ||
        !writer.append("H\x1B[?25h")) {
      impl_->ansi_physical_valid = false;
      return std::unexpected(Error::out_of_space);
    }
  }
  if ((!composed || focused) && (!metadata.cursor_visible || !metadata.cursor_in_viewport) &&
      !writer.append("\x1B[?25l")) {
    impl_->ansi_physical_valid = false;
    return std::unexpected(Error::out_of_space);
  }

  struct MirroredMode final {
    GhosttyMode mode;
    std::uint16_t number;
  };
  const std::array mirrored_modes{
      MirroredMode{.mode = GHOSTTY_MODE_DECCKM, .number = 1},
      MirroredMode{.mode = GHOSTTY_MODE_X10_MOUSE, .number = 9},
      MirroredMode{.mode = GHOSTTY_MODE_NORMAL_MOUSE, .number = 1000},
      MirroredMode{.mode = GHOSTTY_MODE_BUTTON_MOUSE, .number = 1002},
      MirroredMode{.mode = GHOSTTY_MODE_ANY_MOUSE, .number = 1003},
      MirroredMode{.mode = GHOSTTY_MODE_FOCUS_EVENT, .number = 1004},
      MirroredMode{.mode = GHOSTTY_MODE_UTF8_MOUSE, .number = 1005},
      MirroredMode{.mode = GHOSTTY_MODE_SGR_MOUSE, .number = 1006},
      MirroredMode{.mode = GHOSTTY_MODE_ALT_SCROLL, .number = 1007},
      MirroredMode{.mode = GHOSTTY_MODE_URXVT_MOUSE, .number = 1015},
      MirroredMode{.mode = GHOSTTY_MODE_SGR_PIXELS_MOUSE, .number = 1016},
      MirroredMode{.mode = GHOSTTY_MODE_BRACKETED_PASTE, .number = 2004},
  };
  static_assert(mirrored_modes.size() == 12);
  if (!composed || focused) {
    std::size_t mode_index = 0;
    for (const auto mode : mirrored_modes) {
      const auto enabled = terminal_mode_enabled(impl_->terminal, mode.mode);
      if (!enabled.has_value()) {
        impl_->ansi_physical_valid = false;
        return std::unexpected(enabled.error());
      }
      auto& physical_value = std::span(impl_->mirrored_mode_values).subspan(mode_index, 1).front();
      if ((composed || full || !impl_->mirrored_modes_valid || physical_value != *enabled) &&
          (!writer.append("\x1B[?") || !writer.append_integer(mode.number) ||
           !writer.append(*enabled ? "h" : "l"))) {
        impl_->ansi_physical_valid = false;
        return std::unexpected(Error::out_of_space);
      }
      physical_value = *enabled;
      ++mode_index;
    }
    impl_->mirrored_modes_valid = true;
  }

  if (!composed && !writer.append("\x1B[?2026l")) {
    impl_->ansi_physical_valid = false;
    return std::unexpected(Error::out_of_space);
  }

  const auto clean_state = GHOSTTY_RENDER_STATE_DIRTY_FALSE;
  result = ghostty_render_state_set(impl_->render_state, GHOSTTY_RENDER_STATE_OPTION_DIRTY,
                                    &clean_state);
  if (result != GHOSTTY_SUCCESS) {
    impl_->ansi_physical_valid = false;
    return std::unexpected(map_error(result));
  }

  impl_->ansi_physical_valid = true;
  return AnsiRenderResult{
      .bytes = writer.size(),
      .rows = rendered_rows,
      .scrolled_rows = scrolled_rows,
      .full = full,
  };
}

auto Terminal::encode_key(const KeyEvent& event, const std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  LEMMA_ASSERT(impl_->key_encoder != nullptr);
  LEMMA_ASSERT(impl_->key_event != nullptr);

  constexpr std::uint16_t modifiers_valid =
      key_modifier_shift | key_modifier_control | key_modifier_alt | key_modifier_super;
  if ((event.modifiers & ~modifiers_valid) != 0 ||
      (event.consumed_modifiers & ~modifiers_valid) != 0 || event.text.size() > 256) {
    return std::unexpected(Error::invalid_options);
  }

  ghostty_key_encoder_setopt_from_terminal(impl_->key_encoder, impl_->terminal);
  ghostty_key_event_set_action(impl_->key_event, ghostty_key_action(event.action));
  ghostty_key_event_set_key(impl_->key_event, ghostty_key(event.key));
  ghostty_key_event_set_mods(impl_->key_event, static_cast<GhosttyMods>(event.modifiers));
  ghostty_key_event_set_consumed_mods(impl_->key_event,
                                      static_cast<GhosttyMods>(event.consumed_modifiers));
  ghostty_key_event_set_composing(impl_->key_event, event.composing);
  ghostty_key_event_set_unshifted_codepoint(impl_->key_event, event.unshifted_codepoint);
  ghostty_key_event_set_utf8(impl_->key_event, event.text.data(), event.text.size());

  // std::byte and char are both byte views; Ghostty's C ABI uses the latter.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  auto* encoded = reinterpret_cast<char*>(output.data());
  std::size_t bytes_written = 0;
  const auto result = ghostty_key_encoder_encode(impl_->key_encoder, impl_->key_event, encoded,
                                                 output.size(), &bytes_written);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }
  LEMMA_ASSERT(bytes_written <= output.size());
  return bytes_written;
}

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
    return std::unexpected(map_error(result));
  }

  // std::byte and uint8_t are both byte views; Ghostty's C ABI uses the latter.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  auto* output_data = reinterpret_cast<std::uint8_t*>(output.data());
  std::size_t bytes_written = 0;
  result = ghostty_formatter_format_buf(formatter, output_data, output.size(), &bytes_written);
  ghostty_formatter_free(formatter);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }
  LEMMA_ASSERT(bytes_written <= output.size());
  return bytes_written;
}

auto Terminal::size() const noexcept -> TerminalSize {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  return impl_->options.size;
}

auto Terminal::title() const noexcept -> std::expected<std::string_view, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  GhosttyString title{};
  const auto result = ghostty_terminal_get(impl_->terminal, GHOSTTY_TERMINAL_DATA_TITLE, &title);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }
  // Ghostty exposes UTF-8 as uint8_t while string_view uses char.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  return std::string_view(reinterpret_cast<const char*>(title.ptr), title.len);
}

auto Terminal::scrollback_rows() const noexcept -> std::expected<std::size_t, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  std::size_t rows = 0;
  const auto result =
      ghostty_terminal_get(impl_->terminal, GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS, &rows);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(map_error(result));
  }
  return rows;
}

auto Terminal::take_effects() noexcept -> EffectBatch {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  const auto effects = impl_->effects;
  impl_->effects = {};
  return effects;
}

auto Terminal::pending_pty_response_bytes() const noexcept -> std::size_t {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  return impl_->pty_responses.size();
}

auto Terminal::read_pty_responses(const std::span<std::byte> output) noexcept -> std::size_t {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  return impl_->pty_responses.read(output);
}

auto Terminal::allocation_stats() const noexcept -> AllocationStats {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  return impl_->allocator.stats();
}

} // namespace lemma::vt
