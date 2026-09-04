#include "terminal/terminal_impl.hpp"

#include "lemma/assert.hpp"
#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <expected>
#include <limits>
#include <memory>
#include <new>
#include <optional>
#include <span>
#include <string_view>
#include <utility>

namespace lemma::vt {

[[nodiscard]] auto library_build_info() noexcept -> std::expected<LibraryBuildInfo, Error> {
  GhosttyString version{};
  bool simd = false;
  bool kitty_graphics = false;
  bool tmux_control_mode = false;
  GhosttyOptimizeMode optimize = GHOSTTY_OPTIMIZE_DEBUG;

  if (ghostty_build_info(GHOSTTY_BUILD_INFO_VERSION_STRING, &version) != GHOSTTY_SUCCESS ||
      ghostty_build_info(GHOSTTY_BUILD_INFO_SIMD, &simd) != GHOSTTY_SUCCESS ||
      ghostty_build_info(GHOSTTY_BUILD_INFO_KITTY_GRAPHICS, &kitty_graphics) != GHOSTTY_SUCCESS ||
      ghostty_build_info(GHOSTTY_BUILD_INFO_TMUX_CONTROL_MODE, &tmux_control_mode) !=
          GHOSTTY_SUCCESS ||
      ghostty_build_info(GHOSTTY_BUILD_INFO_OPTIMIZE, &optimize) != GHOSTTY_SUCCESS) {
    return std::unexpected(Error::invalid_state);
  }

  const auto optimization = [optimize]() noexcept -> std::expected<BuildOptimization, Error> {
    switch (optimize) {
    case GHOSTTY_OPTIMIZE_DEBUG:
      return BuildOptimization::debug;
    case GHOSTTY_OPTIMIZE_RELEASE_SAFE:
      return BuildOptimization::release_safe;
    case GHOSTTY_OPTIMIZE_RELEASE_SMALL:
      return BuildOptimization::release_small;
    case GHOSTTY_OPTIMIZE_RELEASE_FAST:
      return BuildOptimization::release_fast;
    case GHOSTTY_OPTIMIZE_MODE_MAX_VALUE:
      return std::unexpected(Error::invalid_state);
    }
    return std::unexpected(Error::invalid_state);
  }();
  if (!optimization.has_value()) {
    return std::unexpected(optimization.error());
  }

  return LibraryBuildInfo{
      .version = std::span(version.ptr, version.len),
      .optimization = *optimization,
      .simd = simd,
      .kitty_graphics = kitty_graphics,
      .tmux_control_mode = tmux_control_mode,
  };
}

[[nodiscard]] auto library_version() noexcept -> std::span<const std::uint8_t> {
  const auto info = library_build_info();
  return info.has_value() ? info->version : std::span<const std::uint8_t>{};
}

[[nodiscard]] auto default_theme() noexcept -> TerminalTheme {
  std::array<GhosttyColorRgb, 256> native_palette{};
  ghostty_color_palette_default(native_palette.data());

  TerminalTheme theme;
  for (std::size_t index = 0; index < theme.palette.size(); ++index) {
    const auto color = std::span(native_palette).subspan(index, 1).front();
    std::span(theme.palette).subspan(index, 1).front() = {
        .red = color.r,
        .green = color.g,
        .blue = color.b,
    };
  }
  theme.foreground = std::span(theme.palette).subspan(GHOSTTY_COLOR_NAMED_WHITE, 1).front();
  theme.background = std::span(theme.palette).subspan(GHOSTTY_COLOR_NAMED_BLACK, 1).front();
  theme.cursor = theme.foreground;
  return theme;
}

namespace {

[[nodiscard]] auto packed_cell_layout_matches_contract() noexcept -> bool {
  const auto* const encoded_manifest = ghostty_type_json();
  if (encoded_manifest == nullptr) {
    return false;
  }
  const std::string_view manifest(encoded_manifest);
  const auto cell_offset =
      manifest.find("\"GhosttyCell\":{\"kind\":\"packed\",\"size\":8,\"align\":8,"
                    "\"underlying\":\"u64\",\"bits\":{");
  if (cell_offset == std::string_view::npos) {
    return false;
  }
  constexpr std::size_t cell_descriptor_bytes_max = 1'200;
  const auto descriptor = manifest.substr(
      cell_offset, std::min(cell_descriptor_bytes_max, manifest.size() - cell_offset));
  const std::array required_fields{
      std::string_view{"\"content_tag\":{\"lsb\":0,\"width\":2,"
                       "\"type\":\"GhosttyCellContentTag\"}"},
      std::string_view{R"("content":{"lsb":2,"width":24,"kind":"union")"},
      std::string_view{R"("codepoint":{"lsb":0,"width":21,"type":"u21"})"},
      std::string_view{"\"style_id\":{\"lsb\":26,\"width\":16,"
                       "\"type\":\"GhosttyStyleId\"}"},
      std::string_view{"\"wide\":{\"lsb\":42,\"width\":2,"
                       "\"type\":\"GhosttyCellWide\"}"},
      std::string_view{R"("r":{"lsb":0,"width":8,"type":"u8"})"},
      std::string_view{R"("g":{"lsb":8,"width":8,"type":"u8"})"},
      std::string_view{R"("b":{"lsb":16,"width":8,"type":"u8"})"},
  };
  if (!std::ranges::all_of(required_fields, [&descriptor](const auto field) noexcept {
        return descriptor.find(field) != std::string_view::npos;
      })) {
    return false;
  }

  constexpr GhosttyStyleId expected_style = 0xA55AU;
  constexpr GhosttyCellWide expected_wide = GHOSTTY_CELL_WIDE_SPACER_TAIL;
  constexpr GhosttyColorRgb expected_rgb{.r = 0x12U, .g = 0x34U, .b = 0x56U};
  constexpr auto rgb_content = static_cast<GhosttyCell>(expected_rgb.r) |
                               (static_cast<GhosttyCell>(expected_rgb.g) << 8U) |
                               (static_cast<GhosttyCell>(expected_rgb.b) << 16U);
  constexpr GhosttyCell sample =
      static_cast<GhosttyCell>(GHOSTTY_CELL_CONTENT_BG_COLOR_RGB) |
      (rgb_content << detail::PackedCellDecoder::content_bits_shift) |
      (static_cast<GhosttyCell>(expected_style) << detail::PackedCellDecoder::style_shift) |
      (static_cast<GhosttyCell>(expected_wide) << detail::PackedCellDecoder::wide_shift);
  constexpr std::uint32_t expected_codepoint = 0x1F642U;
  constexpr GhosttyCell codepoint_sample = static_cast<GhosttyCell>(expected_codepoint)
                                           << detail::PackedCellDecoder::content_bits_shift;
  constexpr GhosttyColorPaletteIndex expected_palette = 0xABU;
  constexpr GhosttyCell palette_sample =
      static_cast<GhosttyCell>(GHOSTTY_CELL_CONTENT_BG_COLOR_PALETTE) |
      (static_cast<GhosttyCell>(expected_palette) << detail::PackedCellDecoder::content_bits_shift);
  GhosttyCellContentTag content_tag = GHOSTTY_CELL_CONTENT_CODEPOINT;
  GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
  GhosttyStyleId style_id = 0;
  GhosttyColorRgb rgb{};
  std::uint32_t codepoint = 0;
  GhosttyColorPaletteIndex palette = 0;
  return ghostty_cell_get(sample, GHOSTTY_CELL_DATA_CONTENT_TAG, &content_tag) == GHOSTTY_SUCCESS &&
         ghostty_cell_get(sample, GHOSTTY_CELL_DATA_WIDE, &wide) == GHOSTTY_SUCCESS &&
         ghostty_cell_get(sample, GHOSTTY_CELL_DATA_STYLE_ID, &style_id) == GHOSTTY_SUCCESS &&
         ghostty_cell_get(sample, GHOSTTY_CELL_DATA_COLOR_RGB, &rgb) == GHOSTTY_SUCCESS &&
         ghostty_cell_get(codepoint_sample, GHOSTTY_CELL_DATA_CODEPOINT, &codepoint) ==
             GHOSTTY_SUCCESS &&
         ghostty_cell_get(palette_sample, GHOSTTY_CELL_DATA_COLOR_PALETTE, &palette) ==
             GHOSTTY_SUCCESS &&
         content_tag == detail::PackedCellDecoder::content_tag(sample) &&
         wide == detail::PackedCellDecoder::wide(sample) &&
         style_id == detail::PackedCellDecoder::style_id(sample) &&
         detail::PackedCellDecoder::has_styling(sample) &&
         !detail::PackedCellDecoder::has_styling(codepoint_sample) &&
         codepoint == detail::PackedCellDecoder::codepoint(codepoint_sample) &&
         palette == detail::PackedCellDecoder::background_palette(palette_sample) &&
         rgb.r == detail::PackedCellDecoder::background_rgb(sample).r &&
         rgb.g == detail::PackedCellDecoder::background_rgb(sample).g &&
         rgb.b == detail::PackedCellDecoder::background_rgb(sample).b;
}

[[nodiscard]] auto ghostty_build_matches_contract() noexcept -> bool {
  const auto info = library_build_info();
  if (!info.has_value()) {
    return false;
  }
  constexpr std::string_view expected_version = LEMMA_GHOSTTY_EXPECT_VERSION;
  const auto version_matches =
      info->version.size() == expected_version.size() &&
      std::memcmp(info->version.data(), expected_version.data(), expected_version.size()) == 0;
  return version_matches && info->simd == (LEMMA_GHOSTTY_EXPECT_SIMD != 0) &&
         info->kitty_graphics == (LEMMA_GHOSTTY_EXPECT_KITTY_GRAPHICS != 0) &&
         info->tmux_control_mode == (LEMMA_GHOSTTY_EXPECT_TMUX_CONTROL_MODE != 0) &&
         info->optimization == static_cast<BuildOptimization>(LEMMA_GHOSTTY_EXPECT_OPTIMIZE) &&
         packed_cell_layout_matches_contract();
}

[[nodiscard]] auto valid_size(const TerminalSize& size) noexcept -> bool {
  if (size.columns == 0 || size.rows == 0 || size.columns > limits::terminal_columns_hard_max ||
      size.rows > limits::terminal_rows_hard_max) {
    return false;
  }

  const auto width_max = std::numeric_limits<std::uint32_t>::max() / size.columns;
  const auto height_max = std::numeric_limits<std::uint32_t>::max() / size.rows;
  return size.cell_width_px <= width_max && size.cell_height_px <= height_max;
}

[[nodiscard]] constexpr auto hash_capacity(const std::size_t current, const std::size_t required,
                                           const std::size_t maximum) noexcept -> std::size_t {
  LEMMA_ASSERT(required > current && required <= maximum);
  const auto geometric = current + std::max(current / 2U, std::size_t{1});
  return std::min(maximum, std::max(required, geometric));
}

[[nodiscard]] auto valid_options(const TerminalOptions& options) noexcept -> bool {
  if (!valid_size(options.size)) {
    return false;
  }
  if (options.scrollback_bytes_max > limits::terminal_scrollback_bytes_hard_max ||
      (options.scrollback_lines_max.has_value() &&
       *options.scrollback_lines_max > limits::terminal_scrollback_lines_hard_max)) {
    return false;
  }
  return options.allocation_bytes_max > 0 &&
         options.allocation_bytes_max <= limits::terminal_allocation_bytes_hard_max &&
         options.snapshot_continuation_bytes_max <= limits::snapshot_continuation_bytes_max;
}

struct ResizeViewportState final {
  ViewportState active;
  std::optional<ViewportState> primary;
  bool active_alternate{false};
};

constexpr std::string_view enter_alternate_for_resize = "\x1B[?47h";
constexpr std::string_view leave_alternate_for_resize = "\x1B[?47l";

void write_terminal_control(Terminal& terminal, const std::string_view control) noexcept {
  terminal.write(std::as_bytes(std::span(control.data(), control.size())));
}

[[nodiscard]] auto normalize_resize_viewports(Terminal& terminal) noexcept
    -> std::expected<ResizeViewportState, Error> {
  const auto inspected = terminal.inspection();
  if (!inspected.has_value()) {
    return std::unexpected(inspected.error());
  }
  ResizeViewportState state{
      .active = inspected->viewport,
      .primary = std::nullopt,
      .active_alternate = inspected->active_screen == ActiveScreen::alternate,
  };
  if (state.active_alternate) {
    write_terminal_control(terminal, leave_alternate_for_resize);
    const auto primary = terminal.viewport_state();
    if (!primary.has_value()) {
      write_terminal_control(terminal, enter_alternate_for_resize);
      return std::unexpected(primary.error());
    }
    state.primary = *primary;
    terminal.scroll_viewport(ViewportScroll::bottom);
    write_terminal_control(terminal, enter_alternate_for_resize);
  }
  // Normalize even an active viewport: Ghostty may retain an internal pin after a prior historical
  // viewport returned to the bottom, and resize still validates that stale pin.
  terminal.scroll_viewport(ViewportScroll::bottom);
  return state;
}

void restore_viewport_row(Terminal& terminal, const ViewportState& viewport) noexcept {
  if (!viewport.follows_output) {
    terminal.scroll_viewport(ViewportScroll::row,
                             static_cast<std::int64_t>(std::min<std::uint64_t>(
                                 viewport.offset, std::numeric_limits<std::int64_t>::max())));
  }
}

void restore_resize_viewports(Terminal& terminal, const ResizeViewportState& state) noexcept {
  if (state.active_alternate) {
    write_terminal_control(terminal, leave_alternate_for_resize);
    LEMMA_ASSERT(state.primary.has_value());
    restore_viewport_row(terminal, *state.primary);
    write_terminal_control(terminal, enter_alternate_for_resize);
  }
  restore_viewport_row(terminal, state.active);
}

template <typename Function>
[[nodiscard]] auto callback_pointer(const Function function) noexcept -> const void* {
  static_assert(sizeof(Function) == sizeof(const void*));
  return std::bit_cast<const void*>(function); // NOLINT(bugprone-bitwise-pointer-cast)
}

[[nodiscard]] constexpr auto ghostty_color(const RgbColor color) noexcept -> GhosttyColorRgb {
  return {.r = color.red, .g = color.green, .b = color.blue};
}

[[nodiscard]] auto apply_theme(const GhosttyTerminal terminal, const TerminalTheme& theme) noexcept
    -> GhosttyResult {
  const auto foreground = ghostty_color(theme.foreground);
  const auto background = ghostty_color(theme.background);
  const auto cursor = ghostty_color(theme.cursor);
  std::array<GhosttyColorRgb, 256> palette{};
  for (std::size_t index = 0; index < palette.size(); ++index) {
    std::span(palette).subspan(index, 1).front() =
        ghostty_color(std::span(theme.palette).subspan(index, 1).front());
  }
  auto result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &foreground);
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &background);
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &cursor);
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, palette.data());
  }
  return result;
}

[[nodiscard]] auto disable_unsupported_graphics(const GhosttyTerminal terminal) noexcept
    -> GhosttyResult {
  constexpr std::uint64_t storage_limit = 0;
  constexpr bool disabled = false;
  constexpr std::size_t kitty_apc_limit = 0;
  auto result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT,
                                     &storage_limit);
  if (result == GHOSTTY_SUCCESS) {
    result =
        ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_FILE, &disabled);
  }
  if (result == GHOSTTY_SUCCESS) {
    result =
        ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_TEMP_FILE, nullptr);
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_SHARED_MEM,
                                  &disabled);
  }
  if (result == GHOSTTY_SUCCESS) {
    result =
        ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES_KITTY, &kitty_apc_limit);
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_GLYPH_PROTOCOL, &disabled);
  }
  return result;
}

[[nodiscard]] auto configure_terminal(const GhosttyTerminal terminal,
                                      const std::size_t scrollback_bytes_max,
                                      const std::optional<std::size_t> scrollback_lines_max,
                                      const TerminalTheme& theme,
                                      const std::size_t snapshot_continuation_bytes_max) noexcept
    -> GhosttyResult {
  auto result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES,
                                     &scrollback_bytes_max);
  if (result == GHOSTTY_SUCCESS) {
    result =
        ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES,
                             scrollback_lines_max.has_value() ? &*scrollback_lines_max : nullptr);
  }
  if (result == GHOSTTY_SUCCESS) {
    result = apply_theme(terminal, theme);
  }
  if (result == GHOSTTY_SUCCESS && snapshot_continuation_bytes_max != 0) {
    result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_CONTINUATION_MAX_BYTES,
                                  &snapshot_continuation_bytes_max);
  }
  if (result == GHOSTTY_SUCCESS) {
    result = disable_unsupported_graphics(terminal);
  }
  if (result == GHOSTTY_SUCCESS) {
    constexpr std::size_t unknown_sequence_bytes_max = limits::unknown_sequence_bytes_max;
    result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_UNKNOWN_MAX_BYTES,
                                  &unknown_sequence_bytes_max);
  }
  if (result == GHOSTTY_SUCCESS) {
    static constexpr std::array<std::uint8_t, 14> terminfo_name{'x', 't', 'e', 'r', 'm', '-', '2',
                                                                '5', '6', 'c', 'o', 'l', 'o', 'r'};
    const GhosttyString name{.ptr = terminfo_name.data(), .len = terminfo_name.size()};
    result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_TERMINFO_NAME, &name);
  }
  return result;
}

} // namespace

namespace detail {

QuotaAllocator::QuotaAllocator(const std::size_t bytes_max) noexcept
    : bytes_max_(bytes_max), native_{.ctx = this, .vtable = &vtable} {
  LEMMA_ASSERT(bytes_max_ > 0);
  LEMMA_ASSERT(bytes_max_ <= limits::terminal_allocation_bytes_hard_max);
}

[[nodiscard]] auto QuotaAllocator::native() const noexcept -> const GhosttyAllocator* {
  return &native_;
}

[[nodiscard]] auto QuotaAllocator::stats() const noexcept -> AllocationStats { return stats_; }

// The allocator ABI necessarily uses explicit allocation and deallocation.
// NOLINTBEGIN(cppcoreguidelines-no-malloc)
void* QuotaAllocator::allocate(void* context, const std::size_t length,
                               const std::uint8_t alignment,
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

auto QuotaAllocator::resize(void* context, void* memory, const std::size_t memory_length,
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

void* QuotaAllocator::remap(void* context, void* memory, const std::size_t memory_length,
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

void QuotaAllocator::deallocate(void* context, void* memory, const std::size_t memory_length,
                                const std::uint8_t alignment,
                                [[maybe_unused]] const std::uintptr_t return_address) noexcept {
  auto& allocator = *static_cast<QuotaAllocator*>(context);
  allocator.assert_allocation(memory, memory_length, alignment);

  std::free(memory);
  allocator.stats_.bytes_current -= memory_length;
  --allocator.stats_.allocations_current;
}

void QuotaAllocator::record_allocation(const std::size_t length) noexcept {
  LEMMA_ASSERT(length <= bytes_max_ - stats_.bytes_current);
  LEMMA_ASSERT(stats_.allocations_current < std::numeric_limits<std::size_t>::max());

  stats_.bytes_current += length;
  stats_.bytes_peak = std::max(stats_.bytes_peak, stats_.bytes_current);
  ++stats_.allocations_current;
  record_total_allocation();
}

void QuotaAllocator::record_failure() noexcept {
  if (stats_.failures_total < std::numeric_limits<std::size_t>::max()) {
    ++stats_.failures_total;
  }
}

void QuotaAllocator::record_total_allocation() noexcept {
  if (stats_.allocations_total < std::numeric_limits<std::size_t>::max()) {
    ++stats_.allocations_total;
  }
}

void QuotaAllocator::assert_allocation(const void* memory, const std::size_t memory_length,
                                       const std::uint8_t alignment) const noexcept {
  LEMMA_ASSERT(memory != nullptr);
  LEMMA_ASSERT(memory_length > 0);
  LEMMA_ASSERT(memory_length <= stats_.bytes_current);
  LEMMA_ASSERT(stats_.allocations_current > 0);
  assert_valid_alignment(alignment);
}

[[nodiscard]] auto QuotaAllocator::allocate_raw(const std::size_t length,
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

void QuotaAllocator::assert_valid_alignment(const std::uint8_t alignment) noexcept {
  // Ghostty forwards Zig's log2 alignment enum despite the C header describing bytes.
  LEMMA_ASSERT(std::has_single_bit(alignof(std::max_align_t)));
  LEMMA_ASSERT(alignment < std::numeric_limits<std::size_t>::digits);
}

const GhosttyAllocatorVtable QuotaAllocator::vtable{
    .alloc = &QuotaAllocator::allocate,
    .resize = &QuotaAllocator::resize,
    .remap = &QuotaAllocator::remap,
    .free = &QuotaAllocator::deallocate,
};
// NOLINTEND(cppcoreguidelines-no-malloc)

[[nodiscard]] auto map_error(const GhosttyResult result) noexcept -> Error {
  switch (result) {
  case GHOSTTY_OUT_OF_MEMORY:
    return Error::out_of_memory;
  case GHOSTTY_OUT_OF_SPACE:
    return Error::out_of_space;
  case GHOSTTY_IO_ERROR:
    return Error::io_error;
  case GHOSTTY_LIMIT_EXCEEDED:
    return Error::limit_exceeded;
  case GHOSTTY_INVALID_VALUE:
  case GHOSTTY_NO_VALUE:
  case GHOSTTY_SUCCESS:
  case GHOSTTY_RESULT_MAX_VALUE:
    return Error::invalid_state;
  }
  return Error::invalid_state;
}

} // namespace detail

Terminal::Impl::Impl(const TerminalOptions& terminal_options) noexcept
    : options(terminal_options), session_theme(terminal_options.theme.value_or(default_theme())),
      allocator(terminal_options.allocation_bytes_max) {
  render_colors.size = sizeof(render_colors);
}

Terminal::Impl::~Impl() {
  ghostty_tracked_grid_ref_free(selection_checkpoint_start);
  ghostty_tracked_grid_ref_free(selection_checkpoint_end);
  for (auto* const event : selection_events) {
    ghostty_selection_gesture_event_free(event);
  }
  ghostty_selection_gesture_free(selection_gesture, terminal);
  ghostty_mouse_event_free(mouse_event);
  ghostty_mouse_encoder_free(mouse_encoder);
  ghostty_key_event_free(key_event);
  ghostty_key_encoder_free(key_encoder);
  ghostty_render_state_row_cells_free(row_cells);
  ghostty_render_state_row_iterator_free(row_iterator);
  ghostty_render_state_free(render_state);
  ghostty_terminal_free(terminal);
  LEMMA_ASSERT(allocator.stats().bytes_current == 0);
  LEMMA_ASSERT(allocator.stats().allocations_current == 0);
}

Terminal::Terminal(std::unique_ptr<Impl> impl) noexcept : impl_(std::move(impl)) {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
}

Terminal::Terminal(Terminal&& other) noexcept = default;

auto Terminal::operator=(Terminal&& other) noexcept -> Terminal& = default;

Terminal::~Terminal() = default;

// Logical constness cannot apply: callers mutate the owned projection through this view.
// NOLINTNEXTLINE(readability-make-member-function-const)
auto Terminal::Impl::physical_cells() noexcept -> std::span<std::uint64_t> {
  LEMMA_ASSERT(physical_hashes != nullptr);
  return std::span(physical_hashes.get(), physical_cell_capacity + row_hash_capacity)
      .first(physical_cell_count);
}

// NOLINTNEXTLINE(readability-make-member-function-const)
auto Terminal::Impl::row_hashes() noexcept -> std::span<std::uint64_t> {
  LEMMA_ASSERT(physical_hashes != nullptr);
  return std::span(physical_hashes.get(), physical_cell_capacity + row_hash_capacity)
      .subspan(physical_cell_capacity, row_hash_count);
}

auto Terminal::Impl::row_hashes() const noexcept -> std::span<const std::uint64_t> {
  LEMMA_ASSERT(physical_hashes != nullptr);
  return std::span(physical_hashes.get(), physical_cell_capacity + row_hash_capacity)
      .subspan(physical_cell_capacity, row_hash_count);
}

void Terminal::Impl::begin_pty_response_write(const PtyResponseSink responses) noexcept {
  LEMMA_ASSERT(!pty_response_write_active);
  active_pty_responses = responses;
  pty_response_bytes_current_write = 0;
  pty_response_write_active = true;
}

void Terminal::Impl::end_pty_response_write() noexcept {
  LEMMA_ASSERT(pty_response_write_active);
  active_pty_responses = {};
  pty_response_bytes_current_write = 0;
  pty_response_write_active = false;
}

// Callback installation is shared by fresh and snapshot-restored terminal handles.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto Terminal::Impl::install_callbacks() noexcept -> GhosttyResult {
  auto result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_USERDATA, this);
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(
        terminal, GHOSTTY_TERMINAL_OPT_WRITE_PTY,
        callback_pointer(static_cast<GhosttyTerminalWritePtyFn>(&Impl::write_pty)));
  }
  if (result == GHOSTTY_SUCCESS) {
    result =
        ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_BELL,
                             callback_pointer(static_cast<GhosttyTerminalBellFn>(&Impl::bell)));
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(
        terminal, GHOSTTY_TERMINAL_OPT_TITLE_CHANGED,
        callback_pointer(static_cast<GhosttyTerminalTitleChangedFn>(&Impl::title_changed)));
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(
        terminal, GHOSTTY_TERMINAL_OPT_PWD_CHANGED,
        callback_pointer(static_cast<GhosttyTerminalPwdChangedFn>(&Impl::pwd_changed)));
  }
  if (result == GHOSTTY_SUCCESS) {
    result =
        ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_DESKTOP_NOTIFICATION,
                             callback_pointer(static_cast<GhosttyTerminalDesktopNotificationFn>(
                                 &Impl::desktop_notification)));
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(
        terminal, GHOSTTY_TERMINAL_OPT_PROGRESS_REPORT,
        callback_pointer(static_cast<GhosttyTerminalProgressReportFn>(&Impl::progress_report)));
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(
        terminal, GHOSTTY_TERMINAL_OPT_UNKNOWN_SEQUENCE,
        callback_pointer(static_cast<GhosttyTerminalUnknownSequenceFn>(&Impl::unknown_sequence)));
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(
        terminal, GHOSTTY_TERMINAL_OPT_ENQUIRY,
        callback_pointer(static_cast<GhosttyTerminalEnquiryFn>(&Impl::enquiry)));
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(
        terminal, GHOSTTY_TERMINAL_OPT_CLIPBOARD_WRITE,
        callback_pointer(static_cast<GhosttyTerminalClipboardWriteFn>(&Impl::clipboard_write)));
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(
        terminal, GHOSTTY_TERMINAL_OPT_COLOR_SCHEME,
        callback_pointer(static_cast<GhosttyTerminalColorSchemeFn>(&Impl::color_scheme)));
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(
        terminal, GHOSTTY_TERMINAL_OPT_DEVICE_ATTRIBUTES,
        callback_pointer(static_cast<GhosttyTerminalDeviceAttributesFn>(&Impl::device_attributes)));
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(
        terminal, GHOSTTY_TERMINAL_OPT_SIZE,
        callback_pointer(static_cast<GhosttyTerminalSizeFn>(&Impl::size_report)));
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(
        terminal, GHOSTTY_TERMINAL_OPT_XTVERSION,
        callback_pointer(static_cast<GhosttyTerminalXtversionFn>(&Impl::xtversion)));
  }
  return result;
}

// Construction validates and installs each independent Ghostty option before ownership escapes.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto Terminal::create(const TerminalOptions& options) noexcept -> std::expected<Terminal, Error> {
  if (!ghostty_build_matches_contract()) {
    return std::unexpected(Error::invalid_state);
  }
  if (!valid_options(options)) {
    return std::unexpected(Error::invalid_options);
  }

  std::unique_ptr<Impl> impl;
  try {
    impl = std::make_unique<Impl>(options);
  } catch (const std::bad_alloc&) {
    return std::unexpected(Error::out_of_memory);
  }

  auto result = ghostty_terminal_new(impl->allocator.native(), &impl->terminal,
                                     options.size.columns, options.size.rows);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  result =
      configure_terminal(impl->terminal, options.scrollback_bytes_max, options.scrollback_lines_max,
                         impl->session_theme, options.snapshot_continuation_bytes_max);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }

  result = ghostty_key_encoder_new(impl->allocator.native(), &impl->key_encoder);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  result = ghostty_key_event_new(impl->allocator.native(), &impl->key_event);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  result = ghostty_mouse_encoder_new(impl->allocator.native(), &impl->mouse_encoder);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  result = ghostty_mouse_event_new(impl->allocator.native(), &impl->mouse_event);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  result = ghostty_render_state_new(impl->allocator.native(), &impl->render_state);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }

  result = ghostty_render_state_row_iterator_new(impl->allocator.native(), &impl->row_iterator);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }

  result = ghostty_render_state_row_cells_new(impl->allocator.native(), &impl->row_cells);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }

  impl->row_hash_count = options.size.rows;
  impl->row_hash_capacity = impl->row_hash_count;
  impl->physical_cell_count = static_cast<std::size_t>(options.size.columns) * options.size.rows;
  impl->physical_cell_capacity = impl->physical_cell_count;
  try {
    // Runtime-sized hash storage cannot use std::array.
    // NOLINTBEGIN(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
    impl->physical_hashes = std::make_unique_for_overwrite<std::uint64_t[]>(
        impl->physical_cell_capacity + impl->row_hash_capacity);
    // NOLINTEND(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
    LEMMA_ASSERT(impl->physical_cell_capacity >= impl->physical_cell_count);
    LEMMA_ASSERT(impl->row_hash_capacity >= impl->row_hash_count);
  } catch (const std::bad_alloc&) {
    return std::unexpected(Error::out_of_memory);
  }

  result = impl->install_callbacks();
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }

  return Terminal(std::move(impl));
}

struct TerminalSnapshotRestore::Impl final {
  enum class State : std::uint8_t {
    restoring,
    complete,
    failed,
  };

  Impl(const GhosttySnapshotDecoder decoder_handle, const std::size_t bytes) noexcept
      : decoder(decoder_handle), source_bytes(bytes) {}

  Impl(const Impl&) = delete;
  auto operator=(const Impl&) -> Impl& = delete;
  Impl(Impl&&) = delete;
  auto operator=(Impl&&) -> Impl& = delete;

  ~Impl() { ghostty_snapshot_decoder_free(decoder); }

  GhosttySnapshotDecoder decoder{nullptr};
  std::size_t source_bytes{0};
  State state{State::restoring};
};

TerminalSnapshotRestore::TerminalSnapshotRestore(Terminal terminal, std::unique_ptr<Impl> impl,
                                                 const SnapshotReadyInfo ready_info) noexcept
    : terminal_(std::move(terminal)), impl_(std::move(impl)), ready_info_(ready_info) {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->decoder != nullptr);
}

TerminalSnapshotRestore::TerminalSnapshotRestore(TerminalSnapshotRestore&& other) noexcept =
    default;

TerminalSnapshotRestore::~TerminalSnapshotRestore() = default;

auto TerminalSnapshotRestore::terminal() noexcept -> Terminal& { return terminal_; }

auto TerminalSnapshotRestore::terminal() const noexcept -> const Terminal& { return terminal_; }

auto TerminalSnapshotRestore::ready_info() const noexcept -> SnapshotReadyInfo {
  return ready_info_;
}

auto TerminalSnapshotRestore::complete() const noexcept -> bool {
  return impl_ != nullptr && impl_->state == Impl::State::complete;
}

// READY restoration intentionally reuses ordinary adapter construction, then replaces only its
// fresh Ghostty terminal handle. This keeps helper ownership and teardown identical.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto TerminalSnapshotRestore::begin(const TerminalOptions& options,
                                    const std::span<const std::byte> snapshot) noexcept
    -> std::expected<TerminalSnapshotRestore, Error> {
  if (snapshot.empty()) {
    return std::unexpected(Error::invalid_state);
  }
  if (snapshot.size() > limits::snapshot_bytes_max) {
    return std::unexpected(Error::limit_exceeded);
  }

  auto created = Terminal::create(options);
  if (!created.has_value()) {
    return std::unexpected(created.error());
  }
  auto restored = std::move(*created);
  auto& terminal_impl = *restored.impl_;
  ghostty_terminal_free(terminal_impl.terminal);
  terminal_impl.terminal = nullptr;

  GhosttySnapshotDecoder decoder = nullptr;
  // std::byte and uint8_t are both byte views; Ghostty's C ABI uses the latter.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const auto* const bytes = reinterpret_cast<const std::uint8_t*>(snapshot.data());
  auto result = ghostty_snapshot_decoder_new_buf(terminal_impl.allocator.native(), &decoder, bytes,
                                                 snapshot.size());
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }

  const auto continuation_max = options.snapshot_continuation_bytes_max;
  const bool retain_continuation = continuation_max != 0;
  result = ghostty_snapshot_decoder_set(
      decoder, GHOSTTY_SNAPSHOT_DECODER_OPT_MAX_CONTINUATION_BYTES, &continuation_max);
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_snapshot_decoder_set(decoder, GHOSTTY_SNAPSHOT_DECODER_OPT_RETAIN_CONTINUATION,
                                          &retain_continuation);
  }

  GhosttyTerminal decoded = nullptr;
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_snapshot_decoder_ready(decoder, &decoded);
  }
  if (result != GHOSTTY_SUCCESS) {
    ghostty_snapshot_decoder_free(decoder);
    ghostty_terminal_free(decoded);
    return std::unexpected(detail::map_error(result));
  }

  std::uint16_t columns = 0;
  std::uint16_t rows = 0;
  const std::array geometry_keys{
      GHOSTTY_TERMINAL_DATA_COLS,
      GHOSTTY_TERMINAL_DATA_ROWS,
  };
  std::array<void*, geometry_keys.size()> geometry_values{
      &columns,
      &rows,
  };
  std::size_t geometry_written = 0;
  result = ghostty_terminal_get_multi(decoded, geometry_keys.size(), geometry_keys.data(),
                                      geometry_values.data(), &geometry_written);
  if (result != GHOSTTY_SUCCESS || geometry_written != geometry_keys.size() ||
      columns != options.size.columns || rows != options.size.rows) {
    ghostty_snapshot_decoder_free(decoder);
    ghostty_terminal_free(decoded);
    return std::unexpected(result == GHOSTTY_SUCCESS ? Error::invalid_options
                                                     : detail::map_error(result));
  }

  SnapshotReadyInfo ready_info;
  result = ghostty_snapshot_decoder_get(decoder, GHOSTTY_SNAPSHOT_DECODER_DATA_HISTORY_ROWS_PRIMARY,
                                        &ready_info.primary_history_rows);
  if (result == GHOSTTY_SUCCESS) {
    std::uint64_t alternate_rows = 0;
    result = ghostty_snapshot_decoder_get(
        decoder, GHOSTTY_SNAPSHOT_DECODER_DATA_HISTORY_ROWS_ALTERNATE, &alternate_rows);
    if (result == GHOSTTY_SUCCESS) {
      ready_info.alternate_history_rows = alternate_rows;
    } else if (result == GHOSTTY_NO_VALUE) {
      result = GHOSTTY_SUCCESS;
    }
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_snapshot_decoder_get(decoder, GHOSTTY_SNAPSHOT_DECODER_DATA_SOURCE_OFFSET,
                                          &ready_info.source_bytes_consumed);
  }
  if (result != GHOSTTY_SUCCESS) {
    ghostty_snapshot_decoder_free(decoder);
    ghostty_terminal_free(decoded);
    return std::unexpected(detail::map_error(result));
  }

  terminal_impl.terminal = decoded;
  result = configure_terminal(terminal_impl.terminal, options.scrollback_bytes_max,
                              options.scrollback_lines_max, terminal_impl.session_theme,
                              options.snapshot_continuation_bytes_max);
  if (result == GHOSTTY_SUCCESS) {
    result = terminal_impl.install_callbacks();
  }
  if (result != GHOSTTY_SUCCESS) {
    ghostty_snapshot_decoder_free(decoder);
    return std::unexpected(detail::map_error(result));
  }

  std::unique_ptr<Impl> restore_impl;
  try {
    restore_impl = std::make_unique<Impl>(decoder, snapshot.size());
  } catch (const std::bad_alloc&) {
    ghostty_snapshot_decoder_free(decoder);
    return std::unexpected(Error::out_of_memory);
  }
  return TerminalSnapshotRestore(std::move(restored), std::move(restore_impl), ready_info);
}

// Each call consumes exactly one bounded Ghostty history page or validates FINISH.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto TerminalSnapshotRestore::next_history() noexcept
    -> std::expected<std::optional<SnapshotHistoryProgress>, Error> {
  if (impl_ == nullptr || impl_->state == Impl::State::failed) {
    return std::unexpected(Error::invalid_state);
  }
  if (impl_->state == Impl::State::complete) {
    return std::optional<SnapshotHistoryProgress>{};
  }

  const auto result = ghostty_snapshot_decoder_next(impl_->decoder);
  if (result == GHOSTTY_NO_VALUE) {
    std::size_t source_offset = 0;
    const auto offset_result = ghostty_snapshot_decoder_get(
        impl_->decoder, GHOSTTY_SNAPSHOT_DECODER_DATA_SOURCE_OFFSET, &source_offset);
    ghostty_snapshot_decoder_free(impl_->decoder);
    impl_->decoder = nullptr;
    if (offset_result != GHOSTTY_SUCCESS || source_offset != impl_->source_bytes) {
      impl_->state = Impl::State::failed;
      return std::unexpected(offset_result == GHOSTTY_SUCCESS ? Error::invalid_state
                                                              : detail::map_error(offset_result));
    }
    impl_->state = Impl::State::complete;
    return std::optional<SnapshotHistoryProgress>{};
  }
  if (result != GHOSTTY_SUCCESS) {
    ghostty_snapshot_decoder_free(impl_->decoder);
    impl_->decoder = nullptr;
    impl_->state = Impl::State::failed;
    return std::unexpected(detail::map_error(result));
  }

  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  SnapshotHistoryProgress progress;
  const std::array keys{
      GHOSTTY_SNAPSHOT_DECODER_DATA_PROGRESS_SCREEN,
      GHOSTTY_SNAPSHOT_DECODER_DATA_PROGRESS_ROWS,
      GHOSTTY_SNAPSHOT_DECODER_DATA_PROGRESS_REMAINING,
      GHOSTTY_SNAPSHOT_DECODER_DATA_SOURCE_OFFSET,
  };
  std::array<void*, keys.size()> values{
      &screen,
      &progress.rows_restored,
      &progress.pages_remaining_on_screen,
      &progress.source_bytes_consumed,
  };
  std::size_t written = 0;
  const auto progress_result = ghostty_snapshot_decoder_get_multi(
      impl_->decoder, keys.size(), keys.data(), values.data(), &written);
  if (progress_result != GHOSTTY_SUCCESS || written != keys.size()) {
    ghostty_snapshot_decoder_free(impl_->decoder);
    impl_->decoder = nullptr;
    impl_->state = Impl::State::failed;
    return std::unexpected(detail::map_error(progress_result));
  }
  switch (screen) {
  case GHOSTTY_TERMINAL_SCREEN_PRIMARY:
    progress.screen = ActiveScreen::primary;
    break;
  case GHOSTTY_TERMINAL_SCREEN_ALTERNATE:
    progress.screen = ActiveScreen::alternate;
    break;
  case GHOSTTY_TERMINAL_SCREEN_MAX_VALUE:
    ghostty_snapshot_decoder_free(impl_->decoder);
    impl_->decoder = nullptr;
    impl_->state = Impl::State::failed;
    return std::unexpected(Error::invalid_state);
  }
  return std::optional<SnapshotHistoryProgress>{progress};
}

auto TerminalSnapshotRestore::take_terminal() && noexcept -> std::expected<Terminal, Error> {
  if (!complete()) {
    return std::unexpected(Error::invalid_state);
  }
  return std::move(terminal_);
}

auto Terminal::restore_snapshot(const TerminalOptions& options,
                                const std::span<const std::byte> snapshot) noexcept
    -> std::expected<Terminal, Error> {
  auto restore = TerminalSnapshotRestore::begin(options, snapshot);
  if (!restore.has_value()) {
    return std::unexpected(restore.error());
  }
  while (true) {
    const auto progress = restore->next_history();
    if (!progress.has_value()) {
      return std::unexpected(progress.error());
    }
    if (!progress->has_value()) {
      break;
    }
  }
  return std::move(*restore).take_terminal();
}

auto Terminal::snapshot_size() noexcept -> std::expected<std::size_t, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  const auto selected = selection_active();
  if (!selected.has_value()) {
    return std::unexpected(selected.error());
  }
  if (*selected) {
    // This Ghostty snapshot version omits its tracked selection. Rejecting the snapshot keeps
    // selection/style projection authoritative instead of silently publishing incomplete state.
    return std::unexpected(Error::invalid_state);
  }
  std::size_t required = 0;
  const auto result = ghostty_snapshot_encode_buf(impl_->terminal, nullptr, 0, &required);
  if (required > limits::snapshot_bytes_max) {
    return std::unexpected(Error::limit_exceeded);
  }
  if (result == GHOSTTY_OUT_OF_SPACE || result == GHOSTTY_SUCCESS) {
    return required;
  }
  return std::unexpected(detail::map_error(result));
}

auto Terminal::encode_snapshot(const std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  const auto selected = selection_active();
  if (!selected.has_value()) {
    return std::unexpected(selected.error());
  }
  if (*selected) {
    return std::unexpected(Error::invalid_state);
  }
  const auto capacity = std::min(output.size(), limits::snapshot_bytes_max);
  // std::byte and uint8_t are both byte views; Ghostty's C ABI uses the latter.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  auto* const bytes = capacity == 0 ? nullptr : reinterpret_cast<std::uint8_t*>(output.data());
  std::size_t written = 0;
  const auto result = ghostty_snapshot_encode_buf(impl_->terminal, bytes, capacity, &written);
  if (written > limits::snapshot_bytes_max) {
    return std::unexpected(Error::limit_exceeded);
  }
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  return written;
}

void Terminal::write(const std::span<const std::byte> bytes,
                     const PtyResponseSink responses) noexcept {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  if (!bytes.empty()) {
    impl_->begin_pty_response_write(responses);
    // std::byte and uint8_t are both byte views; Ghostty's C ABI uses the latter.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    const auto* data = reinterpret_cast<const std::uint8_t*>(bytes.data());
    ghostty_terminal_vt_write(impl_->terminal, data, bytes.size());
    impl_->end_pty_response_write();
  }
}

auto Terminal::write_and_report_damage(const std::span<const std::byte> bytes,
                                       const PtyResponseSink responses) noexcept
    -> std::expected<DirtyState, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  LEMMA_ASSERT(impl_->render_state != nullptr);

  auto result = ghostty_render_state_update(impl_->render_state, impl_->terminal);
  if (result != GHOSTTY_SUCCESS) {
    write(bytes, responses);
    return std::unexpected(detail::map_error(result));
  }
  const auto prior_damage = impl_->dirty_state();
  if (!prior_damage.has_value()) {
    write(bytes, responses);
    return std::unexpected(prior_damage.error());
  }
  const auto cleared = impl_->set_dirty_state(DirtyState::clean);
  if (!cleared.has_value()) {
    write(bytes, responses);
    return std::unexpected(cleared.error());
  }

  write(bytes, responses);
  result = ghostty_render_state_update(impl_->render_state, impl_->terminal);
  if (result != GHOSTTY_SUCCESS) {
    const auto restored = impl_->set_dirty_state(*prior_damage);
    if (!restored.has_value()) {
      return std::unexpected(restored.error());
    }
    return std::unexpected(detail::map_error(result));
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

auto Terminal::resize(const TerminalSize& size, const PtyResponseSink responses) noexcept
    -> std::expected<void, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  if (!valid_size(size)) {
    return std::unexpected(Error::invalid_options);
  }

  const auto physical_cell_count = static_cast<std::size_t>(size.columns) * size.rows;
  auto target_cell_capacity = impl_->physical_cell_capacity;
  auto target_row_capacity = impl_->row_hash_capacity;
  if (physical_cell_count > target_cell_capacity) {
    constexpr auto cell_capacity_max = static_cast<std::size_t>(limits::terminal_columns_hard_max) *
                                       limits::terminal_rows_hard_max;
    target_cell_capacity =
        hash_capacity(target_cell_capacity, physical_cell_count, cell_capacity_max);
  }
  if (size.rows > target_row_capacity) {
    target_row_capacity =
        hash_capacity(target_row_capacity, size.rows, limits::terminal_rows_hard_max);
  }
  detail::CellHashStorage physical_hashes;
  if (target_cell_capacity != impl_->physical_cell_capacity ||
      target_row_capacity != impl_->row_hash_capacity) {
    try {
      // Runtime-sized hash storage cannot use std::array.
      // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
      physical_hashes = std::make_unique_for_overwrite<std::uint64_t[]>(target_cell_capacity +
                                                                        target_row_capacity);
    } catch (const std::bad_alloc&) {
      return std::unexpected(Error::out_of_memory);
    }
  }

  // The pinned Ghostty PageList can violate its viewport-pin precondition when either screen keeps
  // a historical viewport across row growth or reflow. Normalize both PageLists before resize,
  // then restore their bounded absolute rows.
  const auto viewports = normalize_resize_viewports(*this);
  if (!viewports.has_value()) {
    return std::unexpected(viewports.error());
  }
  impl_->begin_pty_response_write(responses);
  const auto result = ghostty_terminal_resize(impl_->terminal, size.columns, size.rows,
                                              size.cell_width_px, size.cell_height_px);
  impl_->end_pty_response_write();
  restore_resize_viewports(*this, *viewports);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }

  if (physical_hashes != nullptr) {
    impl_->physical_hashes = std::move(physical_hashes);
    impl_->physical_cell_capacity = target_cell_capacity;
    impl_->row_hash_capacity = target_row_capacity;
  }
  impl_->physical_cell_count = physical_cell_count;
  impl_->row_hash_count = size.rows;
  LEMMA_ASSERT(impl_->physical_cell_capacity >= impl_->physical_cell_count);
  LEMMA_ASSERT(impl_->row_hash_capacity >= impl_->row_hash_count);
  std::ranges::fill(impl_->row_hashes(), 0);
  impl_->mirrored_modes_valid = false;
  impl_->mirrored_mouse_modes_valid = false;
  impl_->ansi_physical_valid = false;
  ghostty_mouse_encoder_reset(impl_->mouse_encoder);
  impl_->options.size = size;
  return {};
}

auto Terminal::size() const noexcept -> TerminalSize {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  return impl_->options.size;
}

auto Terminal::theme() const noexcept -> TerminalTheme {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  return impl_->session_theme;
}

auto Terminal::set_theme(const TerminalTheme& theme) noexcept -> std::expected<void, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  const auto result = apply_theme(impl_->terminal, theme);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  impl_->session_theme = theme;
  impl_->ansi_physical_valid = false;
  return {};
}

auto Terminal::cursor_at_prompt() const noexcept -> std::expected<bool, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  bool value = false;
  const auto result =
      ghostty_terminal_get(impl_->terminal, GHOSTTY_TERMINAL_DATA_CURSOR_AT_PROMPT, &value);
  return result == GHOSTTY_SUCCESS ? std::expected<bool, Error>{value}
                                   : std::unexpected(detail::map_error(result));
}

auto Terminal::inspection() const noexcept -> std::expected<TerminalInspection, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  GhosttyTerminalScrollbar scrollbar{};
  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  std::size_t scrollback = 0;
  std::uint16_t cursor_x = 0;
  std::uint16_t cursor_y = 0;
  bool viewport_active = true;
  bool cursor_visible = false;
  bool cursor_at_prompt = false;
  const std::array keys{
      GHOSTTY_TERMINAL_DATA_SCROLLBAR,       GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN,
      GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS, GHOSTTY_TERMINAL_DATA_CURSOR_X,
      GHOSTTY_TERMINAL_DATA_CURSOR_Y,        GHOSTTY_TERMINAL_DATA_VIEWPORT_ACTIVE,
      GHOSTTY_TERMINAL_DATA_CURSOR_VISIBLE,  GHOSTTY_TERMINAL_DATA_CURSOR_AT_PROMPT,
  };
  std::array<void*, keys.size()> values{&scrollbar,      &screen,          &scrollback,
                                        &cursor_x,       &cursor_y,        &viewport_active,
                                        &cursor_visible, &cursor_at_prompt};
  std::size_t written = 0;
  const auto result = ghostty_terminal_get_multi(impl_->terminal, keys.size(), keys.data(),
                                                 values.data(), &written);
  if (result != GHOSTTY_SUCCESS || written != keys.size()) {
    return std::unexpected(detail::map_error(result));
  }
  ActiveScreen active_screen{ActiveScreen::primary};
  switch (screen) {
  case GHOSTTY_TERMINAL_SCREEN_PRIMARY:
    active_screen = ActiveScreen::primary;
    break;
  case GHOSTTY_TERMINAL_SCREEN_ALTERNATE:
    active_screen = ActiveScreen::alternate;
    break;
  case GHOSTTY_TERMINAL_SCREEN_MAX_VALUE:
    return std::unexpected(Error::invalid_state);
  }
  return TerminalInspection{
      .viewport = {.total_rows = scrollbar.total,
                   .offset = scrollbar.offset,
                   .visible_rows = scrollbar.len,
                   .follows_output = viewport_active},
      .scrollback_rows = scrollback,
      .cursor_column = cursor_x,
      .cursor_row = cursor_y,
      .active_screen = active_screen,
      .cursor_visible = cursor_visible,
      .cursor_at_prompt = cursor_at_prompt,
  };
}

auto Terminal::scrollback_rows() const noexcept -> std::expected<std::size_t, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  std::size_t rows = 0;
  const auto result =
      ghostty_terminal_get(impl_->terminal, GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS, &rows);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  return rows;
}

auto Terminal::integrity_failed() const noexcept -> bool {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  if (impl_->pty_response_integrity_failed) {
    return true;
  }
  bool processing_error = true;
  const auto result = ghostty_terminal_get(
      impl_->terminal, GHOSTTY_TERMINAL_DATA_VT_PROCESSING_ERROR, &processing_error);
  return result != GHOSTTY_SUCCESS || processing_error;
}

auto Terminal::allocation_stats() const noexcept -> AllocationStats {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  return impl_->allocator.stats();
}

} // namespace lemma::vt
