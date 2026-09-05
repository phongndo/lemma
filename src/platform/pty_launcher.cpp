#include "platform/pty_launch.hpp"

#include "lemma/limits.hpp"
#include "lemma/version.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstddef>
#include <cstdlib>
#include <span>
#include <string_view>

#include <pwd.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

#ifdef __APPLE__
#include <crt_externs.h>
#endif

namespace {

namespace launch = lemma::platform::pty_launch;
namespace limits = lemma::limits;

[[nodiscard]] auto read_part(const std::span<std::byte> bytes) noexcept -> bool {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const auto remaining = bytes.subspan(offset);
    const auto count = ::read(launch::setup_descriptor, remaining.data(), remaining.size());
    if (count > 0) {
      offset += static_cast<std::size_t>(count);
    } else if (count < 0 && errno == EINTR) {
      continue;
    } else {
      return false;
    }
  }
  return true;
}

[[nodiscard]] auto install_assignments(const std::span<char> bytes) noexcept -> bool {
  std::size_t count = 0;
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const auto remaining = bytes.subspan(offset);
    const auto end = std::ranges::find(remaining, '\0');
    if (end == remaining.end() || count == limits::environment_entries_max) {
      return false;
    }
    const auto length = static_cast<std::size_t>(end - remaining.begin());
    const std::string_view text(remaining.data(), length);
    const auto separator = text.find('=');
    if (separator == 0 || separator == std::string_view::npos) {
      return false;
    }
    remaining.subspan(separator, 1).front() = '\0';
    if (::setenv(remaining.data(), remaining.subspan(separator + 1U).data(), 1) != 0) {
      return false;
    }
    offset += length + 1U;
    ++count;
  }
  return true;
}

// This runs after the first exec, in an otherwise empty helper. Inherited vectors preserve their
// order and duplicate entries; replacement still has libc setenv's last-assignment semantics.
[[nodiscard]] auto install_environment(const std::span<char> bytes, const bool inherited) noexcept
    -> bool {
  std::array<char*, limits::environment_entries_max + 1U> entries{};
  std::size_t count = 0;
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const auto entry = bytes.subspan(offset);
    const auto end = std::ranges::find(entry, '\0');
    if (end == entry.end() || count == limits::environment_entries_max) {
      return false;
    }
    std::span(entries).subspan(count, 1).front() = entry.data();
    ++count;
    offset += static_cast<std::size_t>(end - entry.begin()) + 1U;
  }
  // Darwin requires a writable allocated vector when replacing environ. It is intentionally owned
  // until exec/_exit, including if setenv subsequently replaces it.
  // NOLINTNEXTLINE(cppcoreguidelines-no-malloc)
  auto** const environment = static_cast<char**>(std::calloc(count + 1U, sizeof(char*)));
  if (environment == nullptr) {
    return false;
  }
  if (inherited) {
    std::ranges::copy(std::span(entries).first(count), std::span(environment, count).begin());
  }
#ifdef __APPLE__
  *_NSGetEnviron() = environment;
#elifdef __linux__
  ::environ = environment;
#endif
  return inherited || install_assignments(bytes);
}

[[nodiscard]] auto replace_process(const std::span<char> command) noexcept -> int {
  if (!command.empty()) {
    std::array<char*, limits::command_arguments_hard_max + 1U> arguments{};
    std::size_t count = 0;
    std::size_t offset = 0;
    while (offset < command.size()) {
      const auto entry = command.subspan(offset);
      const auto end = std::ranges::find(entry, '\0');
      if (end == entry.end() || (count == 0 && end == entry.begin()) ||
          count == limits::command_arguments_hard_max) {
        return 127;
      }
      std::span(arguments).subspan(count, 1).front() = entry.data();
      ++count;
      offset += static_cast<std::size_t>(end - entry.begin()) + 1U;
    }
    // Keep PATH search, EACCES precedence, and ENOEXEC script fallback owned by libc.
    ::execvp(arguments.front(), arguments.data());
    return 127;
  }
  std::array fallback_shell{'/', 'b', 'i', 'n', '/', 's', 'h', '\0'};
  std::array<char, std::size_t{16} * 1'024U> account_buffer{};
  struct passwd account{};
  struct passwd* result = nullptr;
  char* shell = fallback_shell.data();
  if (::getpwuid_r(::getuid(), &account, account_buffer.data(), account_buffer.size(), &result) ==
          0 &&
      result != nullptr && account.pw_shell != nullptr) {
    const std::string_view configured(account.pw_shell);
    if (!configured.empty() && configured.front() == '/' && ::access(account.pw_shell, X_OK) == 0) {
      shell = account.pw_shell;
    }
  }
  std::array login_argument{'-', 'l', '\0'};
  const std::array arguments{shell, login_argument.data(), static_cast<char*>(nullptr)};
  ::execv(shell, arguments.data());
  return 127;
}

// The only input is one bounded record on the inherited setup socket. There is no command-line
// control surface and no Lemma runtime, extension, terminal library, or privilege initialization.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto launch_child() noexcept -> int {
  int socket_type = 0;
  socklen_t type_size = sizeof(socket_type);
  if (::getsockopt(launch::setup_descriptor, SOL_SOCKET, SO_TYPE, &socket_type, &type_size) != 0 ||
      socket_type != SOCK_STREAM || ::getsid(0) != ::getpid() || ::getpgrp() != ::getpid()) {
    return 127;
  }
  launch::Header header{};
  if (!read_part(std::as_writable_bytes(std::span(&header, 1))) ||
      header.magic != launch::signature || (header.flags & ~launch::inherited_environment) != 0 ||
      header.directory_bytes > limits::working_directory_bytes_max ||
      header.environment_bytes > limits::environment_bytes_max ||
      header.command_bytes > limits::command_bytes_hard_max ||
      header.overlay_bytes > limits::environment_bytes_max) {
    return 127;
  }
  std::array<char, limits::working_directory_bytes_max + 1U> directory{};
  std::array<char, limits::environment_bytes_max> environment{};
  std::array<char, limits::command_bytes_hard_max> command{};
  std::array<char, limits::environment_bytes_max> overlay{};
  const auto environment_bytes = std::span(environment).first(header.environment_bytes);
  const auto command_bytes = std::span(command).first(header.command_bytes);
  const auto overlay_bytes = std::span(overlay).first(header.overlay_bytes);
  if (!read_part(std::as_writable_bytes(std::span(directory).first(header.directory_bytes))) ||
      !read_part(std::as_writable_bytes(environment_bytes)) ||
      !read_part(std::as_writable_bytes(command_bytes)) ||
      !read_part(std::as_writable_bytes(overlay_bytes))) {
    return 127;
  }
  std::byte trailing{};
  auto received = ::read(launch::setup_descriptor, &trailing, 1);
  while (received < 0 && errno == EINTR) {
    received = ::read(launch::setup_descriptor, &trailing, 1);
  }
  static_cast<void>(::close(launch::setup_descriptor));
  if (received != 0 ||
      (header.directory_bytes > 0 &&
       (directory.front() != '/' ||
        std::ranges::find(std::span(directory).first(header.directory_bytes), '\0') !=
            std::span(directory).first(header.directory_bytes).end()))) {
    return 127;
  }
  // posix_spawn already established the session and process group, but opening/duplicating a
  // slave before setsid does not acquire a controlling terminal. Do that only after the first exec.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  if (::ioctl(STDIN_FILENO, TIOCSCTTY, nullptr) != 0 ||
      ::tcsetpgrp(STDIN_FILENO, ::getpid()) != 0 ||
      (header.directory_bytes > 0 && ::chdir(directory.data()) != 0) ||
      !install_environment(environment_bytes,
                           (header.flags & launch::inherited_environment) != 0) ||
      (header.directory_bytes > 0 && ::setenv("PWD", directory.data(), 1) != 0) ||
      !install_assignments(overlay_bytes) || ::setenv("TERM", "xterm-256color", 1) != 0 ||
      ::setenv("COLORTERM", "truecolor", 1) != 0 || ::setenv("TERM_PROGRAM", "lemma", 1) != 0 ||
      // version is backed by a null-terminated string literal.
      // NOLINTNEXTLINE(bugprone-suspicious-stringview-data-usage)
      ::setenv("TERM_PROGRAM_VERSION", lemma::version.data(), 1) != 0) {
    return 127;
  }
  return replace_process(command_bytes);
}

} // namespace

int main(const int argc, [[maybe_unused]] char** argv) {
  // No C++/stdio teardown after installing environment pointers into the setup record.
  ::_exit(argc == 1 ? launch_child() : 127);
}
