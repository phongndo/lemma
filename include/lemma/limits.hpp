#ifndef LEMMA_LIMITS_HPP
#define LEMMA_LIMITS_HPP

#include <chrono>
#include <cstddef>
#include <cstdint>

namespace lemma::limits {

inline constexpr std::uint32_t sessions_hard_max = 64;
inline constexpr std::uint32_t tabs_hard_max = 1'024;
inline constexpr std::uint32_t panes_hard_max = 4'096;
inline constexpr std::uint32_t clients_hard_max = 128;
inline constexpr std::uint32_t layout_depth_hard_max = 64;

inline constexpr std::size_t command_bytes_hard_max = std::size_t{64} * 1'024U;

// Presentation transaction limits. A frame can span chunks, but queued bytes never retain a
// Ghostty RenderState snapshot while waiting for socket writability.
inline constexpr std::size_t frame_chunk_bytes_max = std::size_t{4} * 1'024U * 1'024U;
inline constexpr std::size_t frame_transaction_bytes_max = std::size_t{64} * 1'024U * 1'024U;
inline constexpr std::size_t frame_output_queue_bytes_max = std::size_t{8} * 1'024U * 1'024U;
// Retained frame storage is shared across all attached and pending-attached sessions. This bound
// admits several protocol-maximum viewports while preventing the session limit from multiplying
// the per-frame transaction ceiling into multi-gigabyte daemon retention.
inline constexpr std::size_t frame_retained_bytes_aggregate_max =
    std::size_t{256} * 1'024U * 1'024U;
inline constexpr auto render_snapshot_hold_max = std::chrono::milliseconds{50};
inline constexpr auto frame_transaction_progress_deadline = std::chrono::seconds{5};
inline constexpr auto frame_transaction_total_deadline = std::chrono::seconds{30};
inline constexpr auto synchronized_output_presentation_timeout = std::chrono::seconds{1};
static_assert(frame_chunk_bytes_max <= frame_output_queue_bytes_max);
static_assert(frame_output_queue_bytes_max < frame_transaction_bytes_max);
static_assert(frame_transaction_bytes_max <= frame_retained_bytes_aggregate_max);

inline constexpr std::size_t client_queue_bytes_hard_max = frame_output_queue_bytes_max;

// Expanded semantic input and child-controlled data limits. Serialized envelopes remain subject to
// their own smaller protocol-version bounds until protocol v2 is implemented.
inline constexpr std::size_t structured_input_payload_bytes_max = std::size_t{1} * 1'024U * 1'024U;
inline constexpr std::size_t structured_event_batch_expanded_max = 4'096;
inline constexpr std::size_t pixel_mouse_report_bytes_max = 128;
inline constexpr std::size_t paste_payload_bytes_max = std::size_t{1} * 1'024U * 1'024U;
inline constexpr std::size_t terminal_effect_text_bytes_max = std::size_t{4} * 1'024U;
inline constexpr std::size_t clipboard_decoded_bytes_max = std::size_t{1} * 1'024U * 1'024U;
inline constexpr std::size_t hyperlink_uri_bytes_max = std::size_t{8} * 1'024U;
inline constexpr std::size_t unknown_sequence_bytes_max = std::size_t{4} * 1'024U;
inline constexpr std::size_t snapshot_bytes_max = std::size_t{64} * 1'024U * 1'024U;
inline constexpr std::size_t snapshot_continuation_bytes_max = std::size_t{1} * 1'024U * 1'024U;
inline constexpr std::size_t graphics_command_chunk_bytes_max = frame_chunk_bytes_max;
inline constexpr std::size_t graphics_decoded_image_bytes_max = std::size_t{64} * 1'024U * 1'024U;
inline constexpr std::size_t graphics_image_pixels_max = std::size_t{4'096} * 4'096U;
inline constexpr std::size_t graphics_placements_per_pane_max = 4'096;
inline constexpr std::size_t graphics_session_bytes_max = std::size_t{256} * 1'024U * 1'024U;

inline constexpr std::size_t terminal_pty_response_bytes_max = std::size_t{64} * 1'024U;
// One pane queue can retain the terminal adapter's complete response bound plus one maximally
// expanded 8 KiB client input packet (128 encoded bytes per normalized legacy key). Queue storage
// is allocated lazily under this daemon-wide budget, while accepted-input delivery remains an
// all-or-nothing operation.
inline constexpr std::size_t normalized_client_input_bytes_max = std::size_t{8} * 1'024U * 128U;
inline constexpr std::size_t pane_pty_write_queue_bytes_max =
    terminal_pty_response_bytes_max + normalized_client_input_bytes_max;
inline constexpr std::size_t pane_pty_write_queue_bytes_aggregate_max =
    std::size_t{128} * 1'024U * 1'024U;
static_assert(pane_pty_write_queue_bytes_aggregate_max >= pane_pty_write_queue_bytes_max);
inline constexpr std::size_t pending_connections_hard_max = 128;
inline constexpr std::size_t pending_connection_output_bytes_max = std::size_t{64} * 1'024U;
inline constexpr std::size_t terminal_allocation_bytes_default = std::size_t{64} * 1'024U * 1'024U;
inline constexpr std::size_t terminal_allocation_bytes_hard_max =
    std::size_t{1} * 1'024U * 1'024U * 1'024U;
inline constexpr std::uint16_t terminal_columns_hard_max = 1'000;
inline constexpr std::uint16_t terminal_rows_hard_max = 1'000;
// The pinned Ghostty implementation interprets max_scrollback as bytes despite its C header naming
// lines. Its page allocator bypasses QuotaAllocator, so keep this independent exposure bounded.
inline constexpr std::size_t terminal_scrollback_bytes_default = 10'000;
inline constexpr std::size_t terminal_scrollback_bytes_hard_max = 1'000'000;
static_assert(terminal_scrollback_bytes_hard_max <= terminal_allocation_bytes_default);

} // namespace lemma::limits

#endif // LEMMA_LIMITS_HPP
