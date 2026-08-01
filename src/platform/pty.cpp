#include "platform/pty.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <csignal>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <span>
#include <string_view>
#include <system_error>

#include <pwd.h>
#include <sys/ioctl.h>
#include <unistd.h>

#ifdef __APPLE__
#include <libproc.h>
#include <util.h>
#elifdef __linux__
#include <fcntl.h>
#include <pty.h>
#else
#error "lemma requires forkpty"
#endif

namespace lemma::platform {
namespace {

[[nodiscard]] auto copy_process_name(const std::span<const char> source,
                                     const std::span<char> output) noexcept -> std::size_t {
  const auto terminator = std::ranges::find_if(source, [](const char character) {
    return character == '\0' || character == '\n' || character == '\r';
  });
  const auto available = static_cast<std::size_t>(std::distance(source.begin(), terminator));
  const auto size = std::min(available, output.size());
  std::ranges::copy(source.first(size), output.begin());
  return size;
}

} // namespace

[[nodiscard]] auto spawn_login_shell(int& pty_descriptor) noexcept -> pid_t {
  winsize initial_size{.ws_row = 24, .ws_col = 80, .ws_xpixel = 0, .ws_ypixel = 0};
  const auto child = ::forkpty(&pty_descriptor, nullptr, nullptr, &initial_size);
  if (child != 0) {
    return child;
  }

  // The daemon ignores these signals for its own I/O and child-reaping behavior. Ignored
  // dispositions survive exec, so restore normal shell semantics before launching the login shell.
  if (::signal(SIGCHLD, SIG_DFL) == SIG_ERR || ::signal(SIGPIPE, SIG_DFL) == SIG_ERR) {
    ::_exit(127);
  }

  std::array fallback_shell{'/', 'b', 'i', 'n', '/', 's', 'h', '\0'};
  std::array<char, std::size_t{16} * 1'024U> account_buffer{};
  struct passwd account{};
  struct passwd* account_result = nullptr;
  char* shell = fallback_shell.data();
  if (::getpwuid_r(::getuid(), &account, account_buffer.data(), account_buffer.size(),
                   &account_result) == 0 &&
      account_result != nullptr && account.pw_shell != nullptr) {
    const std::string_view configured_shell(account.pw_shell);
    if (!configured_shell.empty() && configured_shell.front() == '/' &&
        ::access(account.pw_shell, X_OK) == 0) {
      shell = account.pw_shell;
    }
  }

  if (::setenv("TERM", "xterm-256color", 1) != 0 || ::setenv("COLORTERM", "truecolor", 1) != 0 ||
      ::setenv("TERM_PROGRAM", "lemma", 1) != 0) {
    ::_exit(127);
  }

  std::array login_argument{'-', 'l', '\0'};
  const std::array arguments{shell, login_argument.data(), static_cast<char*>(nullptr)};
  ::execv(shell, arguments.data());
  ::_exit(127);
}

[[nodiscard]] auto foreground_process_name(const int pty_descriptor,
                                           const std::span<char> output) noexcept -> std::size_t {
  if (output.empty()) {
    return 0;
  }
  const auto foreground_group = ::tcgetpgrp(pty_descriptor);
  if (foreground_group <= 0) {
    return 0;
  }

#ifdef __APPLE__
  proc_bsdshortinfo information{};
  const auto bytes = ::proc_pidinfo(foreground_group, PROC_PIDT_SHORTBSDINFO, 0, &information,
                                    static_cast<int>(sizeof(information)));
  if (bytes < 0 || static_cast<std::size_t>(bytes) != sizeof(information)) {
    return 0;
  }
  return copy_process_name(information.pbsi_comm, output);
#elifdef __linux__
  std::array<char, 64> path{};
  constexpr std::string_view prefix = "/proc/";
  constexpr std::string_view suffix = "/comm";
  std::ranges::copy(prefix, path.begin());
  auto remaining = std::span(path).subspan(prefix.size());
  const auto encoded = std::to_chars(remaining.data(), path.end(), foreground_group);
  const auto digits = static_cast<std::size_t>(std::distance(remaining.data(), encoded.ptr));
  if (encoded.ec != std::errc{} || remaining.size() - digits <= suffix.size()) {
    return 0;
  }
  std::ranges::copy(suffix, remaining.subspan(digits).begin());
  // open is variadic only to accept a mode when creation flags require one.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const auto descriptor = ::open(path.data(), O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) {
    return 0;
  }
  std::array<char, 64> name{};
  const auto bytes = ::read(descriptor, name.data(), name.size());
  static_cast<void>(::close(descriptor));
  return bytes > 0
             ? copy_process_name(std::span(name).first(static_cast<std::size_t>(bytes)), output)
             : 0;
#endif
}

[[nodiscard]] auto resize_pty(const int pty_descriptor, const std::uint16_t columns,
                              const std::uint16_t rows) noexcept -> bool {
  winsize native_size{
      .ws_row = rows,
      .ws_col = columns,
      .ws_xpixel = 0,
      .ws_ypixel = 0,
  };
  // ioctl is variadic because its third argument depends on the request.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  return ::ioctl(pty_descriptor, TIOCSWINSZ, &native_size) == 0;
}

} // namespace lemma::platform
