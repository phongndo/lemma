#ifndef FIBER_LIMITS_HPP
#define FIBER_LIMITS_HPP

#include <cstddef>
#include <cstdint>

namespace fiber::limits {

inline constexpr std::uint32_t workspaces_hard_max = 64;
inline constexpr std::uint32_t windows_hard_max = 1'024;
inline constexpr std::uint32_t panes_hard_max = 4'096;
inline constexpr std::uint32_t clients_hard_max = 128;
inline constexpr std::uint32_t layout_depth_hard_max = 64;

inline constexpr std::size_t command_bytes_hard_max = std::size_t{64} * 1'024U;
inline constexpr std::size_t client_queue_bytes_hard_max = std::size_t{8} * 1'024U * 1'024U;
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
inline constexpr std::size_t terminal_scrollback_rows_default = 10'000;
inline constexpr std::size_t terminal_scrollback_rows_hard_max = 1'000'000;

} // namespace fiber::limits

#endif // FIBER_LIMITS_HPP
