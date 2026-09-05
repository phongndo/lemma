#include "platform/pty.hpp"

#include "lemma/limits.hpp"
#include "platform/io.hpp"
#include "platform/pty_launch.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <expected>
#include <optional>
#include <span>
#include <string_view>
#include <utility>

#include <fcntl.h>
// POSIX signal-set operations are not the C++ standard-library signal facility.
// NOLINTNEXTLINE(modernize-deprecated-headers)
#include <signal.h>
#include <spawn.h>
#include <sys/socket.h>
#include <unistd.h>

#ifdef __APPLE__
#include <mach-o/dyld.h>
#include <sys/syslimits.h>
#include <util.h>
#elifdef __linux__
#include <linux/limits.h>
#include <pty.h>
#endif

namespace lemma::platform {
namespace {

struct SpawnedPty final {
  pid_t child;
  int master;
};

// Both build and install keep the private helper beside their executables. Resolve the actual
// executable, not argv[0], cwd, PATH, or a build-tree fallback. A missing installed helper is
// fatal.
[[nodiscard]] auto launcher_path(const std::span<char> output) noexcept -> int {
#ifdef __APPLE__
  std::array<char, PATH_MAX> executable{};
  auto size = static_cast<std::uint32_t>(executable.size());
  if (::_NSGetExecutablePath(executable.data(), &size) != 0) {
    return ENAMETOOLONG;
  }
  if (::realpath(executable.data(), output.data()) == nullptr) {
    return errno;
  }
  const std::string_view path(output.data());
#elifdef __linux__
  const auto size = ::readlink("/proc/self/exe", output.data(), output.size());
  if (size < 0) {
    return errno;
  }
  if (static_cast<std::size_t>(size) == output.size()) {
    return ENAMETOOLONG;
  }
  const std::string_view path(output.data(), static_cast<std::size_t>(size));
#endif
  const auto separator = path.rfind('/');
  if (separator == std::string_view::npos) {
    return EINVAL;
  }
  const auto start = separator + 1U;
  if (pty_launch::executable.size() >= output.size() - start) {
    return ENAMETOOLONG;
  }
  std::ranges::copy(pty_launch::executable, output.subspan(start).begin());
  output.subspan(start + pty_launch::executable.size(), 1).front() = '\0';
  return 0;
}

[[nodiscard]] auto valid_command(const std::span<const std::byte> command) noexcept -> bool {
  std::size_t count = 0;
  std::size_t offset = 0;
  while (offset < command.size()) {
    const auto remaining = command.subspan(offset);
    const auto end = std::ranges::find(remaining, std::byte{0});
    if (end == remaining.end() || (count == 0 && end == remaining.begin()) ||
        count == limits::command_arguments_hard_max) {
      return false;
    }
    ++count;
    offset += static_cast<std::size_t>(end - remaining.begin()) + 1U;
  }
  return true;
}

[[nodiscard]] auto copy_overlay(const std::span<const EnvironmentVariable> source,
                                const std::span<char> output) noexcept
    -> std::optional<std::size_t> {
  if (source.size() > limits::environment_entries_max) {
    return std::nullopt;
  }
  std::size_t used = 0;
  for (const auto& entry : source) {
    const auto remaining = output.subspan(used);
    if (remaining.size() < 2U || entry.name.size() > remaining.size() - 2U ||
        entry.value.size() > remaining.size() - 2U - entry.name.size() || entry.name.empty() ||
        entry.name.contains('=') || entry.name.contains('\0') || entry.value.contains('\0')) {
      return std::nullopt;
    }
    std::ranges::copy(entry.name, remaining.begin());
    remaining.subspan(entry.name.size(), 1).front() = '=';
    std::ranges::copy(entry.value, remaining.subspan(entry.name.size() + 1U).begin());
    used += entry.name.size() + entry.value.size() + 2U;
    output.subspan(used - 1U, 1).front() = '\0';
  }
  return used;
}

[[nodiscard]] auto prepare_source_descriptor(int& descriptor) noexcept -> bool {
  // Sources must not alias any destination (stdin/out/err or the setup socket).
  if (descriptor <= pty_launch::setup_descriptor) {
    // fcntl's final argument depends on its operation.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    const auto moved = ::fcntl(descriptor, F_DUPFD_CLOEXEC, pty_launch::setup_descriptor + 1);
    if (moved < 0) {
      return false;
    }
    static_cast<void>(::close(std::exchange(descriptor, moved)));
    return true;
  }
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  return ::fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0;
}

[[nodiscard]] auto send_part(const int descriptor, const std::span<const std::byte> bytes) noexcept
    -> int {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const auto remaining = bytes.subspan(offset);
    const auto sent = ::send(descriptor, remaining.data(), remaining.size(), MSG_NOSIGNAL);
    if (sent > 0) {
      offset += static_cast<std::size_t>(sent);
    } else if (sent < 0 && errno == EINTR) {
      continue;
    } else {
      return sent < 0 ? errno : EIO;
    }
  }
  return 0;
}

// One scope owns all partially prepared C resources; only a successful spawn releases the master.
class SpawnTransaction final {
public:
  SpawnTransaction() = default;
  SpawnTransaction(const SpawnTransaction&) = delete;
  auto operator=(const SpawnTransaction&) -> SpawnTransaction& = delete;
  SpawnTransaction(SpawnTransaction&&) = delete;
  auto operator=(SpawnTransaction&&) -> SpawnTransaction& = delete;
  ~SpawnTransaction() {
    close_descriptor(master_);
    close_descriptor(slave_);
    close_descriptor(sender_);
    close_descriptor(receiver_);
    if (actions_initialized_) {
      static_cast<void>(::posix_spawn_file_actions_destroy(&actions_));
    }
    if (attributes_initialized_) {
      static_cast<void>(::posix_spawnattr_destroy(&attributes_));
    }
  }

  [[nodiscard]] auto run(char* const path,
                         const std::span<const std::span<const std::byte>> parts) && noexcept
      -> std::expected<SpawnedPty, int> {
    if (const auto error = prepare_channel(parts); error != 0) {
      return std::unexpected(error);
    }
    if (const auto error = prepare_pty(); error != 0) {
      return std::unexpected(error);
    }
    if (const auto error = initialize(); error != 0) {
      return std::unexpected(error);
    }
    if (const auto error = setup_file_actions(); error != 0) {
      return std::unexpected(error);
    }
    if (const auto error = setup_attributes(); error != 0) {
      return std::unexpected(error);
    }
    const std::array arguments{path, static_cast<char*>(nullptr)};
    const std::array<char*, 1> bootstrap_environment{nullptr};
    pid_t child = -1;
    const auto error = ::posix_spawn(&child, path, &actions_, &attributes_, arguments.data(),
                                     bootstrap_environment.data());
    if (error != 0) {
      return std::unexpected(error);
    }
    return SpawnedPty{.child = child, .master = std::exchange(master_, -1)};
  }

private:
  [[nodiscard]] auto
  prepare_channel(const std::span<const std::span<const std::byte>> parts) noexcept -> int {
    std::array<int, 2> pair{-1, -1};
    if (::socketpair(AF_UNIX, SOCK_STREAM, 0, pair.data()) != 0) {
      return errno;
    }
    sender_ = pair.front();
    receiver_ = pair.back();
    if (!prepare_source_descriptor(sender_) || !prepare_source_descriptor(receiver_) ||
        !set_nonblocking(sender_)) {
      return errno;
    }
    std::size_t record_size = 0;
    for (const auto part : parts) {
      record_size += part.size();
    }
    const auto buffer_size = static_cast<int>(std::max(record_size * 2U, std::size_t{4096}));
    if (::setsockopt(sender_, SOL_SOCKET, SO_SNDBUF, &buffer_size, sizeof(buffer_size)) != 0 ||
        ::setsockopt(receiver_, SOL_SOCKET, SO_RCVBUF, &buffer_size, sizeof(buffer_size)) != 0) {
      return errno;
    }
    // Complete admission before creating a child. No secrets in argv, files, or the helper's loader
    // environment; a full socket fails admission instead of blocking the reactor.
    for (const auto part : parts) {
      if (const auto error = send_part(sender_, part); error != 0) {
        return error;
      }
    }
    return ::shutdown(sender_, SHUT_WR) == 0 ? 0 : errno;
  }

  [[nodiscard]] auto prepare_pty() noexcept -> int {
    winsize initial_size{.ws_row = 24, .ws_col = 80, .ws_xpixel = 0, .ws_ypixel = 0};
    std::array<int, 2> pair{-1, -1};
    // Adopt only after success; failure cleanup belongs to libc.
    if (::openpty(&pair.front(), &pair.back(), nullptr, nullptr, &initial_size) != 0) {
      return errno;
    }
    master_ = pair.front();
    slave_ = pair.back();
    return prepare_source_descriptor(master_) && prepare_source_descriptor(slave_) ? 0 : errno;
  }

  [[nodiscard]] auto initialize() noexcept -> int {
    const auto actions_error = ::posix_spawn_file_actions_init(&actions_);
    if (actions_error != 0) {
      return actions_error;
    }
    actions_initialized_ = true;
    const auto attributes_error = ::posix_spawnattr_init(&attributes_);
    attributes_initialized_ = attributes_error == 0;
    return attributes_error;
  }

  [[nodiscard]] auto setup_file_actions() noexcept -> int {
    for (const auto destination : {STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO}) {
      const auto error = ::posix_spawn_file_actions_adddup2(&actions_, slave_, destination);
      if (error != 0) {
        return error;
      }
    }
    const auto error =
        ::posix_spawn_file_actions_adddup2(&actions_, receiver_, pty_launch::setup_descriptor);
    if (error != 0) {
      return error;
    }
#ifdef __linux__
    // Also close descriptors another thread may have opened without CLOEXEC yet.
    return ::posix_spawn_file_actions_addclosefrom_np(&actions_, pty_launch::setup_descriptor + 1);
#else
    return 0; // Darwin preserves only explicit destinations with CLOEXEC_DEFAULT.
#endif
  }

  [[nodiscard]] auto setup_attributes() noexcept -> int {
    sigset_t defaults{};
    // Darwin exposes these POSIX operations as macros, not scope-qualifiable functions.
    if (sigemptyset(&defaults) != 0 || sigaddset(&defaults, SIGCHLD) != 0 ||
        sigaddset(&defaults, SIGPIPE) != 0) {
      return errno;
    }
    const auto error = ::posix_spawnattr_setsigdefault(&attributes_, &defaults);
    if (error != 0) {
      return error;
    }
    short flags = POSIX_SPAWN_SETSID | POSIX_SPAWN_SETSIGDEF;
#ifdef __APPLE__
    flags |= POSIX_SPAWN_CLOEXEC_DEFAULT;
#endif
    // Preserve mask/credentials as forkpty did. SID/PGID exist before spawn returns, allowing
    // immediate cancellation to address the child's process group even before helper setup ends.
    return ::posix_spawnattr_setflags(&attributes_, flags);
  }

  int master_{-1};
  int slave_{-1};
  int sender_{-1};
  int receiver_{-1};
  posix_spawn_file_actions_t actions_{};
  posix_spawnattr_t attributes_{};
  bool actions_initialized_{false};
  bool attributes_initialized_{false};
};

// Preparation is wholly in the parent. The only pre-first-exec child work belongs to posix_spawn.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto spawn_prepared(const std::string_view directory,
                                  const std::span<const std::byte> supplied_environment,
                                  const EnvironmentMode mode,
                                  const std::span<const std::byte> command,
                                  const std::span<const EnvironmentVariable> overlay) noexcept
    -> std::expected<SpawnedPty, int> {
  if (directory.size() > limits::working_directory_bytes_max || directory.contains('\0') ||
      (!directory.empty() && directory.front() != '/')) {
    return std::unexpected(EINVAL);
  }
  if (supplied_environment.size() > limits::environment_bytes_max ||
      command.size() > limits::command_bytes_hard_max) {
    return std::unexpected(E2BIG);
  }
  if (!valid_command(command)) {
    return std::unexpected(EINVAL);
  }
  pty_launch::Header header{};
  std::array<char, PATH_MAX> path{};
  if (const auto error = launcher_path(path); error != 0) {
    return std::unexpected(error);
  }
  std::array<std::byte, limits::environment_bytes_max> inherited{};
  auto environment = supplied_environment;
  if (mode == EnvironmentMode::inherit) {
    header.flags |= pty_launch::inherited_environment;
    if (!environment.empty()) {
      header.flags |= pty_launch::invalid_setup;
    } else {
      const auto captured = capture_process_environment(inherited);
      if (!captured.has_value()) {
        return std::unexpected(E2BIG);
      }
      environment = std::span(inherited).first(*captured);
    }
  }
  std::array<char, limits::environment_bytes_max> overlay_copy{};
  const auto copied = copy_overlay(overlay, overlay_copy);
  if (!copied.has_value()) {
    // These errors occurred after fork in the old implementation: preserve child exit 127.
    header.flags |= pty_launch::invalid_setup;
  } else {
    header.overlay_bytes = static_cast<std::uint32_t>(*copied);
  }
  header.directory_bytes = static_cast<std::uint32_t>(directory.size());
  header.environment_bytes = static_cast<std::uint32_t>(environment.size());
  header.command_bytes = static_cast<std::uint32_t>(command.size());
  const auto overlay_bytes = std::as_bytes(std::span(overlay_copy).first(header.overlay_bytes));
  const auto directory_bytes = std::as_bytes(std::span(directory.data(), directory.size()));
  const auto header_bytes = std::as_bytes(std::span(&header, 1));

  const std::array parts{header_bytes, directory_bytes, environment, command, overlay_bytes};
  return SpawnTransaction{}.run(path.data(), parts);
}

} // namespace

auto spawn_process(int& pty_descriptor, const std::string_view working_directory,
                   const std::span<const std::byte> environment,
                   const EnvironmentMode environment_mode,
                   const std::span<const std::byte> launch_command,
                   const std::span<const EnvironmentVariable> overlay) noexcept -> pid_t {
  const auto result =
      spawn_prepared(working_directory, environment, environment_mode, launch_command, overlay);
  if (!result.has_value()) {
    // Resource cleanup has finished: do not let close/destroy overwrite the actual spawn error.
    errno = result.error();
    return -1;
  }
  pty_descriptor = result->master;
  return result->child;
}

} // namespace lemma::platform
