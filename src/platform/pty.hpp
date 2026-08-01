#ifndef LEMMA_PLATFORM_PTY_HPP
#define LEMMA_PLATFORM_PTY_HPP

#include <cstddef>
#include <cstdint>
#include <span>

#include <sys/types.h>

namespace lemma::platform {

// Spawns the account's login shell with a new controlling PTY. The parent receives the child PID
// and master descriptor; the child replaces itself or exits with status 127.
[[nodiscard]] auto spawn_login_shell(int& pty_descriptor) noexcept -> pid_t;

[[nodiscard]] auto resize_pty(int pty_descriptor, std::uint16_t columns,
                              std::uint16_t rows) noexcept -> bool;

// Returns the bounded process name for the PTY's foreground process group, or zero when the
// foreground process cannot be inspected.
[[nodiscard]] auto foreground_process_name(int pty_descriptor, std::span<char> output) noexcept
    -> std::size_t;

} // namespace lemma::platform

#endif // LEMMA_PLATFORM_PTY_HPP
