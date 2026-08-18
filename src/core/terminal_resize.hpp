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

// Reports the requested geometry to the child PTY before resizing Ghostty. If Ghostty rejects the
// resize, restores the PTY geometry; consistency_lost is the fail-closed rollback failure.
[[nodiscard]] auto resize_terminal_transaction(vt::Terminal& terminal,
                                               const vt::TerminalSize& requested,
                                               PtyResizeOperation resize_pty,
                                               void* context) noexcept -> TerminalResizeStatus;

} // namespace lemma::core

#endif // LEMMA_CORE_TERMINAL_RESIZE_HPP
