#include "platform/terminal_mode.hpp"

#include <algorithm>

#include <sys/ioctl.h>
#include <unistd.h>

namespace lemma::platform {

[[nodiscard]] auto terminal_size(const int descriptor, const std::uint16_t columns_max,
                                 const std::uint16_t rows_max) noexcept -> WindowSize {
  winsize native_size{};
  // ioctl is variadic because its third argument depends on the request.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  if (::ioctl(descriptor, TIOCGWINSZ, &native_size) != 0 || native_size.ws_col == 0 ||
      native_size.ws_row == 0) {
    return {};
  }
  return {
      .columns = std::min(native_size.ws_col, columns_max),
      .rows = std::min(native_size.ws_row, rows_max),
  };
}

[[nodiscard]] auto RawTerminal::enter(const int descriptor) noexcept -> bool {
  if (active_ || ::tcgetattr(descriptor, &original_) != 0) {
    return false;
  }

  auto raw = original_;
  raw.c_iflag &= static_cast<tcflag_t>(~(BRKINT | ICRNL | INPCK | ISTRIP | IXON));
  raw.c_oflag &= static_cast<tcflag_t>(~OPOST);
  raw.c_cflag |= CS8;
  raw.c_lflag &= static_cast<tcflag_t>(~(ECHO | ICANON | IEXTEN | ISIG));
  raw.c_cc[VMIN] = 1;
  raw.c_cc[VTIME] = 0;
  if (::tcsetattr(descriptor, TCSAFLUSH, &raw) != 0) {
    return false;
  }
  descriptor_ = descriptor;
  active_ = true;
  return true;
}

RawTerminal::~RawTerminal() {
  if (active_) {
    static_cast<void>(::tcsetattr(descriptor_, TCSAFLUSH, &original_));
  }
}

} // namespace lemma::platform
