#ifndef LEMMA_CORE_TERMINAL_RESIZE_HPP
#define LEMMA_CORE_TERMINAL_RESIZE_HPP

#include "lemma/terminal/terminal.hpp"

#include <cstdint>

namespace lemma::core {

enum class TerminalResizeStatus : std::uint8_t {
  unchanged,
  applied,
  rejected,
  rolled_back,
  consistency_lost,
};

using PtyResizeOperation = bool (*)(void* context, const vt::TerminalSize& size) noexcept;

// Resizes canonical Ghostty state before the PTY and restores the old canonical geometry if the
// PTY operation fails. consistency_lost is the fail-closed outcome when that last rollback fails.
[[nodiscard]] auto resize_terminal_transaction(vt::Terminal& terminal,
                                               const vt::TerminalSize& requested,
                                               PtyResizeOperation resize_pty,
                                               void* context) noexcept -> TerminalResizeStatus;

} // namespace lemma::core

#endif // LEMMA_CORE_TERMINAL_RESIZE_HPP
