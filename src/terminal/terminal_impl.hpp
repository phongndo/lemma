#ifndef LEMMA_TERMINAL_TERMINAL_IMPL_HPP
#define LEMMA_TERMINAL_TERMINAL_IMPL_HPP

#include "lemma/terminal/terminal.hpp"

#include <ghostty/vt.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <memory>
#include <optional>
#include <span>

namespace lemma::vt {
namespace detail {

class AnsiWriter;

// These shifts are accepted only after Terminal::create validates them against the exact linked
// ghostty_type_json manifest and the corresponding typed accessors. Keeping the decoder here gives
// hot row projection direct packed-cell reads without making the pin-specific layout public.
struct PackedCellDecoder final {
  static constexpr std::size_t content_shift = 0;
  static constexpr std::size_t content_bits_shift = 2;
  static constexpr std::size_t style_shift = 26;
  static constexpr std::size_t wide_shift = 42;
  static constexpr std::uint64_t content_mask = 0x3U;
  static constexpr std::uint64_t codepoint_mask = 0x1F'FFFFU;
  static constexpr std::uint64_t style_mask = 0xFFFFU;
  static constexpr std::uint64_t wide_mask = 0x3U;

  [[nodiscard]] static constexpr auto content_tag(const GhosttyCell cell) noexcept
      -> GhosttyCellContentTag {
    return static_cast<GhosttyCellContentTag>((cell >> content_shift) & content_mask);
  }
  [[nodiscard]] static constexpr auto wide(const GhosttyCell cell) noexcept -> GhosttyCellWide {
    return static_cast<GhosttyCellWide>((cell >> wide_shift) & wide_mask);
  }
  [[nodiscard]] static constexpr auto style_id(const GhosttyCell cell) noexcept -> GhosttyStyleId {
    return static_cast<GhosttyStyleId>((cell >> style_shift) & style_mask);
  }
  [[nodiscard]] static constexpr auto has_styling(const GhosttyCell cell) noexcept -> bool {
    return style_id(cell) != 0;
  }
  [[nodiscard]] static constexpr auto codepoint(const GhosttyCell cell) noexcept -> std::uint32_t {
    return static_cast<std::uint32_t>((cell >> content_bits_shift) & codepoint_mask);
  }
  [[nodiscard]] static constexpr auto background_palette(const GhosttyCell cell) noexcept
      -> GhosttyColorPaletteIndex {
    return static_cast<GhosttyColorPaletteIndex>(cell >> content_bits_shift);
  }
  [[nodiscard]] static constexpr auto background_rgb(const GhosttyCell cell) noexcept
      -> GhosttyColorRgb {
    const auto content = cell >> content_bits_shift;
    return {
        .r = static_cast<std::uint8_t>(content),
        .g = static_cast<std::uint8_t>(content >> 8U),
        .b = static_cast<std::uint8_t>(content >> 16U),
    };
  }
};

// Covers allocations routed through Ghostty's C allocator. The render and other adapter-owned
// buffers remain independently bounded by their owning Lemma components.
class QuotaAllocator final {
public:
  explicit QuotaAllocator(std::size_t bytes_max) noexcept;

  [[nodiscard]] auto native() const noexcept -> const GhosttyAllocator*;
  [[nodiscard]] auto stats() const noexcept -> AllocationStats;

private:
  static void* allocate(void* context, std::size_t length, std::uint8_t alignment,
                        std::uintptr_t return_address) noexcept;
  static auto resize(void* context, void* memory, std::size_t memory_length, std::uint8_t alignment,
                     std::size_t new_length, std::uintptr_t return_address) noexcept -> bool;
  static void* remap(void* context, void* memory, std::size_t memory_length, std::uint8_t alignment,
                     std::size_t new_length, std::uintptr_t return_address) noexcept;
  static void deallocate(void* context, void* memory, std::size_t memory_length,
                         std::uint8_t alignment, std::uintptr_t return_address) noexcept;

  void record_allocation(std::size_t length) noexcept;
  void record_failure() noexcept;
  void record_total_allocation() noexcept;
  void assert_allocation(const void* memory, std::size_t memory_length,
                         std::uint8_t alignment) const noexcept;

  [[nodiscard]] static auto allocate_raw(std::size_t length, std::uint8_t alignment) noexcept
      -> void*;
  static void assert_valid_alignment(std::uint8_t alignment) noexcept;

  static const GhosttyAllocatorVtable vtable;

  std::size_t bytes_max_;
  AllocationStats stats_{};
  GhosttyAllocator native_;
};

using CellHashStorage = std::unique_ptr<std::uint64_t[]>; // NOLINT

[[nodiscard]] auto map_error(GhosttyResult result) noexcept -> Error;

} // namespace detail

// This definition is private to lemma_terminal. Ghostty handles never enter Lemma's public headers
// or any target that does not explicitly belong to the terminal adapter.
struct Terminal::Impl final {
  explicit Impl(const TerminalOptions& terminal_options) noexcept;
  ~Impl();

  Impl(const Impl&) = delete;
  auto operator=(const Impl&) -> Impl& = delete;
  Impl(Impl&&) = delete;
  auto operator=(Impl&&) -> Impl& = delete;

  static void write_pty(GhosttyTerminal terminal_handle, void* userdata, const std::uint8_t* data,
                        std::size_t length) noexcept;
  static void bell(GhosttyTerminal terminal_handle, void* userdata) noexcept;
  static void title_changed(GhosttyTerminal terminal_handle, void* userdata) noexcept;
  static void pwd_changed(GhosttyTerminal terminal_handle, void* userdata) noexcept;
  static void desktop_notification(GhosttyTerminal terminal_handle, void* userdata,
                                   const GhosttyTerminalDesktopNotification* notification) noexcept;
  static void progress_report(GhosttyTerminal terminal_handle, void* userdata,
                              const GhosttyTerminalProgressReport* report) noexcept;
  static void unknown_sequence(GhosttyTerminal terminal_handle, void* userdata,
                               const GhosttyTerminalUnknownSequence* sequence) noexcept;
  static auto enquiry(GhosttyTerminal terminal_handle, void* userdata) noexcept -> GhosttyString;
  static auto clipboard_write(GhosttyTerminal terminal_handle, void* userdata,
                              const GhosttyClipboardWrite* write) noexcept
      -> GhosttyClipboardWriteResult;
  static auto color_scheme(GhosttyTerminal terminal_handle, void* userdata,
                           GhosttyColorScheme* output) noexcept -> bool;
  static auto device_attributes(GhosttyTerminal terminal_handle, void* userdata,
                                GhosttyDeviceAttributes* output) noexcept -> bool;
  static auto size_report(GhosttyTerminal terminal_handle, void* userdata,
                          GhosttySizeReportSize* output) noexcept -> bool;
  static auto xtversion(GhosttyTerminal terminal_handle, void* userdata) noexcept -> GhosttyString;

  [[nodiscard]] auto install_callbacks() noexcept -> GhosttyResult;
  void begin_pty_response_write(PtyResponseSink responses) noexcept;
  void end_pty_response_write() noexcept;
  [[nodiscard]] auto physical_cells() noexcept -> std::span<std::uint64_t>;
  [[nodiscard]] auto row_hashes() noexcept -> std::span<std::uint64_t>;
  [[nodiscard]] auto row_hashes() const noexcept -> std::span<const std::uint64_t>;
  [[nodiscard]] auto dirty_state() const noexcept -> std::expected<DirtyState, Error>;
  [[nodiscard]] auto set_dirty_state(DirtyState dirty) const noexcept -> std::expected<void, Error>;
  [[nodiscard]] auto populate_render_metadata(RenderUpdate& update) noexcept
      -> std::expected<void, Error>;
  [[nodiscard]] auto dirty_row_count() noexcept -> std::expected<std::size_t, Error>;
  [[nodiscard]] auto calculate_row_hash(std::uint64_t context_hash) noexcept
      -> std::expected<std::uint64_t, Error>;
  [[nodiscard]] auto detect_scroll(std::span<const std::uint64_t> current) const noexcept
      -> std::int32_t;
  void apply_physical_scroll(std::int32_t scroll) noexcept;
  [[nodiscard]] auto encode_row(detail::AnsiWriter& writer, std::size_t row_index, bool force,
                                std::uint16_t origin_column, std::uint16_t origin_row,
                                bool position_from_previous_row, bool erase_line_tail,
                                std::optional<std::uint64_t> scroll_context,
                                std::optional<std::uint64_t> precomputed_row_hash) noexcept
      -> std::expected<bool, Error>;

  TerminalOptions options;
  TerminalTheme session_theme{};
  detail::QuotaAllocator allocator;
  GhosttyTerminal terminal{nullptr};
  GhosttyKeyEncoder key_encoder{nullptr};
  GhosttyKeyEvent key_event{nullptr};
  GhosttyMouseEncoder mouse_encoder{nullptr};
  GhosttyMouseEvent mouse_event{nullptr};
  GhosttyRenderState render_state{nullptr};
  GhosttyRenderStateRowIterator row_iterator{nullptr};
  GhosttyRenderStateRowCells row_cells{nullptr};
  GhosttySelectionGesture selection_gesture{nullptr};
  std::array<GhosttySelectionGestureEvent, 5> selection_events{};
  GhosttyTrackedGridRef selection_checkpoint_start{nullptr};
  GhosttyTrackedGridRef selection_checkpoint_end{nullptr};
  GhosttyRenderStateColors render_colors{};
  // One right-sized allocation stores retained physical cell hashes followed by retained row
  // hashes. Current-row hashes are operation-scoped render scratch.
  detail::CellHashStorage physical_hashes;
  std::size_t physical_cell_count{0};
  std::size_t physical_cell_capacity{0};
  std::size_t row_hash_count{0};
  std::size_t row_hash_capacity{0};
  std::array<bool, 12> mirrored_mode_values{};
  GhosttyColorRgb projected_cursor_color{};
  std::uint8_t projected_cursor_code{0};
  bool render_cursor_blinking{false};
  bool mirrored_modes_valid{false};
  bool mirrored_mouse_modes_valid{false};
  bool projected_cursor_valid{false};
  bool ansi_physical_valid{false};
  bool scroll_hashes_valid{false};
  bool selection_checkpoint_rectangle{false};
  PtyResponseSink active_pty_responses{};
  std::size_t pty_response_bytes_current_write{0};
  EffectBatch effects{};
  bool pty_response_write_active{false};
  bool pty_response_integrity_failed{false};
};

} // namespace lemma::vt

#endif // LEMMA_TERMINAL_TERMINAL_IMPL_HPP
