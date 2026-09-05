#include <array>
#include <climits>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <span>
#include <string_view>

#include <fcntl.h>
#include <sys/ioctl.h>
#include <unistd.h>

#ifdef __APPLE__
#include <crt_externs.h>
#endif

namespace {

void print_hex(const std::string_view value) noexcept {
  for (const auto character : value) {
    const auto byte = static_cast<unsigned int>(static_cast<unsigned char>(character));
    // printf is the deliberately dependency-free fixture output boundary.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    static_cast<void>(std::printf("%02x", byte));
  }
  static_cast<void>(std::putchar('\n'));
}

} // namespace

// Inspect independent OS properties in one diagnostic record.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
int main(const int argc, char** argv) {
  const auto arguments = std::span(argv, static_cast<std::size_t>(argc));
  if (arguments.size() == 2 && std::string_view(arguments.back()) == "--ready") {
    return std::puts("__SPAWN_READY__") < 0 ? 1 : 0;
  }
  if (arguments.size() == 2 && std::string_view(arguments.back()) == "--inherited") {
    const auto* const marker = std::getenv("LEMMA_TEST_SPAWN_CHILD");
    const bool matches = marker != nullptr && std::string_view(marker) == arguments.front();
    // Never dump the ambient environment (which may contain CI/developer credentials).
    return std::puts(matches ? "__INHERITED_MARKER__" : "__MISSING_MARKER__") < 0 ? 1 : 0;
  }
  sigset_t mask{};
  struct sigaction child_action{};
  struct sigaction pipe_action{};
  winsize size{};
  std::array<char, PATH_MAX> directory{};
  // ioctl is the POSIX terminal inspection boundary.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  if (::ioctl(STDIN_FILENO, TIOCGWINSZ, &size) != 0 ||
      ::sigprocmask(SIG_SETMASK, nullptr, &mask) != 0 ||
      ::sigaction(SIGCHLD, nullptr, &child_action) != 0 ||
      ::sigaction(SIGPIPE, nullptr, &pipe_action) != 0 ||
      ::getcwd(directory.data(), directory.size()) == nullptr) {
    return 1;
  }
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  static_cast<void>(std::printf(
      "pid=%ld sid=%ld pgid=%ld foreground=%ld\nuid=%lu euid=%lu gid=%lu egid=%lu\n"
      "tty=%d,%d,%d size=%u,%u chld=%d pipe=%d usr1_blocked=%d\n",
      static_cast<long>(::getpid()), static_cast<long>(::getsid(0)), static_cast<long>(::getpgrp()),
      static_cast<long>(::tcgetpgrp(STDIN_FILENO)), static_cast<unsigned long>(::getuid()),
      static_cast<unsigned long>(::geteuid()), static_cast<unsigned long>(::getgid()),
      static_cast<unsigned long>(::getegid()), ::isatty(STDIN_FILENO), ::isatty(STDOUT_FILENO),
      ::isatty(STDERR_FILENO), static_cast<unsigned int>(size.ws_col),
      static_cast<unsigned int>(size.ws_row), static_cast<int>(child_action.sa_handler == SIG_DFL),
      static_cast<int>(pipe_action.sa_handler == SIG_DFL), sigismember(&mask, SIGUSR1)));
  static_cast<void>(std::fputs("cwd=", stdout));
  print_hex(directory.data());
  for (int descriptor = 3; descriptor < 512; ++descriptor) {
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    if (::fcntl(descriptor, F_GETFD) >= 0) {
      // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
      static_cast<void>(std::printf("unexpected_fd=%d\n", descriptor));
    }
  }
  for (const auto* const argument : arguments) {
    static_cast<void>(std::fputs("arg=", stdout));
    print_hex(argument);
  }
#ifdef __APPLE__
  char** environment = *_NSGetEnviron();
#else
  char** environment = ::environ;
#endif
  // POSIX exposes a null-terminated pointer vector.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  for (; environment != nullptr && *environment != nullptr; ++environment) {
    static_cast<void>(std::fputs("env=", stdout));
    print_hex(*environment);
  }
  return std::fflush(stdout) == 0 ? 0 : 1;
}
