#include "daemon/server.hpp"

#include "core/engine.hpp"
#include "extension/host.hpp"
#include "platform/io.hpp"
#include "protocol/single_pane.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <cstring>
#include <expected>
#include <span>
#include <string>
#include <string_view>
#include <thread>

#include <fcntl.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <syslog.h>
#include <unistd.h>

namespace fiber::daemon {
namespace {

constexpr auto response_ready = protocol::wire_byte(protocol::ControlResponse::ready);
constexpr auto response_capacity = protocol::wire_byte(protocol::ControlResponse::capacity);
constexpr auto response_missing = protocol::wire_byte(protocol::ControlResponse::missing);
using platform::close_descriptor;
using platform::read_exact;
using platform::send_all;
using platform::write_all;
using platform::write_text;

[[nodiscard]] constexpr auto valid_workspace_name(const std::string_view workspace) noexcept
    -> bool {
  if (workspace.empty() || workspace.size() > protocol::workspace_name_bytes_max) {
    return false;
  }
  return std::ranges::all_of(workspace, [](const char character) {
    return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
           (character >= '0' && character <= '9') || character == '_' || character == '-';
  });
}

[[nodiscard]] auto socket_path() -> std::string {
  return "/tmp/fiber-v8-" + std::to_string(::getuid()) + ".sock";
}

[[nodiscard]] auto socket_address(const std::string& path) noexcept
    -> std::expected<sockaddr_un, int> {
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  if (path.size() >= sizeof(address.sun_path)) {
    return std::unexpected(ENAMETOOLONG);
  }
  std::memcpy(std::span(address.sun_path).data(), path.c_str(), path.size() + 1U);
  return address;
}

[[nodiscard]] auto open_connection(const std::string& path) noexcept -> int {
  int connection = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (connection < 0) {
    return -1;
  }
  const auto address = socket_address(path);
  if (!address.has_value()) {
    close_descriptor(connection);
    return -1;
  }
  // The C socket ABI erases the concrete sockaddr type.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const auto* generic_address = reinterpret_cast<const sockaddr*>(&*address);
  if (::connect(connection, generic_address, sizeof(*address)) != 0) {
    close_descriptor(connection);
    return -1;
  }
  return connection;
}

[[nodiscard]] auto acquire_server_lock(const std::string& path, int& lock_descriptor) noexcept
    -> bool {
  std::array<char, 256> lock_path{};
  constexpr std::string_view extension = ".lock";
  if (path.size() + extension.size() + 1U > lock_path.size()) {
    return false;
  }
  std::memcpy(lock_path.data(), path.data(), path.size());
  std::memcpy(std::span(lock_path).subspan(path.size()).data(), extension.data(), extension.size());
  // open is variadic because O_CREAT requires a file mode.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  lock_descriptor = ::open(lock_path.data(), O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (lock_descriptor < 0 || ::flock(lock_descriptor, LOCK_EX | LOCK_NB) != 0) {
    close_descriptor(lock_descriptor);
    return false;
  }
  return true;
}

[[nodiscard]] auto remove_stale_socket(const std::string& path) noexcept -> bool {
  struct stat existing{};
  if (::lstat(path.c_str(), &existing) != 0) {
    return errno == ENOENT;
  }
  if (!S_ISSOCK(existing.st_mode) || existing.st_uid != ::getuid()) {
    return false;
  }
  int existing_server = open_connection(path);
  if (existing_server >= 0) {
    close_descriptor(existing_server);
    return false;
  }
  return ::unlink(path.c_str()) == 0;
}

[[nodiscard]] auto create_listener(const std::string& path, int& lock_descriptor) noexcept -> int {
  if (!acquire_server_lock(path, lock_descriptor) || !remove_stale_socket(path)) {
    return -1;
  }
  int listener = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (listener < 0) {
    return -1;
  }
  const auto address = socket_address(path);
  if (!address.has_value()) {
    close_descriptor(listener);
    return -1;
  }
  // The C socket ABI erases the concrete sockaddr type.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const auto* generic_address = reinterpret_cast<const sockaddr*>(&*address);
  if (::bind(listener, generic_address, sizeof(*address)) != 0) {
    close_descriptor(listener);
    return -1;
  }
  if (::chmod(path.c_str(), 0600) != 0 || ::listen(listener, 16) != 0) {
    close_descriptor(listener);
    static_cast<void>(::unlink(path.c_str()));
    return -1;
  }
  return listener;
}

struct OwnedEndpoint final {
  const char* path;
  int listener;
  int server_lock;
  std::string extension_config;
};

void release_owned_endpoint(void* const context) noexcept {
  auto& endpoint = *static_cast<OwnedEndpoint*>(context);
  close_descriptor(endpoint.listener);
  static_cast<void>(::unlink(endpoint.path));
  close_descriptor(endpoint.server_lock);
}

[[nodiscard]] auto acquire_extension_host(void* const context) noexcept
    -> core::ExtensionConnection {
  const auto& endpoint = *static_cast<const OwnedEndpoint*>(context);
  const std::array inherited{endpoint.listener, endpoint.server_lock};
  const auto connection = extension::spawn_host(endpoint.extension_config, inherited);
  return {.descriptor = connection.descriptor};
}

void report_extension_error(void* const /*context*/, const std::string_view error) noexcept {
  // The detached daemon has no stderr. Keep load failures observable through the host's system log;
  // control listings also expose the retained error directly to CLI users.
  // syslog is variadic because the message arguments are determined by its format string.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  ::syslog(LOG_ERR, "configuration error: %.*s", static_cast<int>(error.size()), error.data());
}

[[nodiscard]] auto run_owned_server(const std::string& path) noexcept -> int {
  static_cast<void>(::signal(SIGPIPE, SIG_IGN));
  static_cast<void>(::signal(SIGCHLD, SIG_IGN));
  ::openlog("fiber", LOG_PID | LOG_NDELAY, LOG_USER);
  const auto previous_mask = ::umask(0077);
  int server_lock = -1;
  int listener = create_listener(path, server_lock);
  static_cast<void>(::umask(previous_mask));
  if (listener < 0) {
    close_descriptor(server_lock);
    return 1;
  }
  OwnedEndpoint endpoint{
      .path = path.c_str(),
      .listener = listener,
      .server_lock = server_lock,
      .extension_config = extension::default_config_path(),
  };
  return core::run_server(listener, &release_owned_endpoint, &endpoint, &acquire_extension_host,
                          &endpoint, &report_extension_error, nullptr);
}

[[nodiscard]] auto server_available(const std::string& path) noexcept -> bool {
  int connection = open_connection(path);
  if (connection < 0) {
    return false;
  }
  const std::array command{protocol::wire_byte(protocol::ControlCommand::list)};
  const auto sent = send_all(connection, command);
  std::array<std::byte, 1> response{};
  const auto received = sent && read_exact(connection, response);
  close_descriptor(connection);
  return received;
}

void redirect_standard_descriptors() noexcept {
  // open is variadic when file creation mode is present.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  int null_descriptor = ::open("/dev/null", O_RDWR | O_NOCTTY);
  if (null_descriptor < 0) {
    return;
  }
  static_cast<void>(::dup2(null_descriptor, STDIN_FILENO));
  static_cast<void>(::dup2(null_descriptor, STDOUT_FILENO));
  static_cast<void>(::dup2(null_descriptor, STDERR_FILENO));
  if (null_descriptor > STDERR_FILENO) {
    close_descriptor(null_descriptor);
  }
}

[[nodiscard]] auto launch_server(const std::string& path) noexcept -> bool {
  const auto first_child = ::fork();
  if (first_child < 0) {
    return false;
  }
  if (first_child == 0) {
    if (::setsid() < 0) {
      ::_exit(1);
    }
    const auto daemon_child = ::fork();
    if (daemon_child < 0) {
      ::_exit(1);
    }
    if (daemon_child > 0) {
      ::_exit(0);
    }
    redirect_standard_descriptors();
    ::_exit(run_owned_server(path));
  }

  static_cast<void>(::waitpid(first_child, nullptr, 0));
  for (std::size_t attempt = 0; attempt < 200; ++attempt) {
    if (server_available(path)) {
      return true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return false;
}

[[nodiscard]] auto ensure_server(const std::string& path) noexcept -> bool {
  return server_available(path) || launch_server(path);
}

[[nodiscard]] auto send_workspace_request(const int connection,
                                          const protocol::ControlCommand command,
                                          const std::string_view workspace) noexcept -> bool {
  const auto header = protocol::encode_workspace_header(command, workspace);
  return send_all(connection, header) &&
         send_all(connection, std::as_bytes(std::span(workspace.data(), workspace.size())));
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto run_control_command(const protocol::ControlCommand command,
                                       const std::string_view workspace, const bool report_missing)
    -> int {
  int connection = open_connection(socket_path());
  if (connection < 0) {
    if (report_missing) {
      static_cast<void>(write_text(STDERR_FILENO, "no fiber daemon\n"));
    }
    return 1;
  }
  const bool named = !workspace.empty();
  const std::array encoded_command{protocol::wire_byte(command)};
  const bool sent = named ? send_workspace_request(connection, command, workspace)
                          : send_all(connection, encoded_command);
  if (!sent) {
    close_descriptor(connection);
    return 1;
  }

  std::array<std::byte, std::size_t{4} * 1'024U> response{};
  bool first = true;
  while (true) {
    const auto bytes_read = ::recv(connection, response.data(), response.size(), 0);
    if (bytes_read == 0) {
      break;
    }
    if (bytes_read < 0) {
      if (errno == EINTR) {
        continue;
      }
      close_descriptor(connection);
      return 1;
    }
    const auto bytes = std::span(response).first(static_cast<std::size_t>(bytes_read));
    if (first && bytes.front() == response_missing) {
      static_cast<void>(write_text(STDERR_FILENO, "no fiber workspace\n"));
      close_descriptor(connection);
      return 1;
    }
    first = false;
    if (!write_all(STDOUT_FILENO, bytes)) {
      close_descriptor(connection);
      return 1;
    }
  }
  close_descriptor(connection);
  return 0;
}

} // namespace

[[nodiscard]] auto validate_workspace(const std::string_view workspace) noexcept -> bool {
  if (valid_workspace_name(workspace)) {
    return true;
  }
  static_cast<void>(write_text(
      STDERR_FILENO,
      "invalid workspace name; use 1-32 ASCII letters, digits, underscores, or hyphens\n"));
  return false;
}

[[nodiscard]] auto open_server_connection() -> int { return open_connection(socket_path()); }

[[nodiscard]] auto ensure(const std::string_view workspace) -> int {
  if (!validate_workspace(workspace)) {
    return 1;
  }
  const auto path = socket_path();
  if (!ensure_server(path)) {
    static_cast<void>(write_text(STDERR_FILENO, "failed to start fiber daemon\n"));
    return 1;
  }
  int connection = open_connection(path);
  if (connection < 0 ||
      !send_workspace_request(connection, protocol::ControlCommand::create, workspace)) {
    close_descriptor(connection);
    return 1;
  }
  std::array<std::byte, 1> response{};
  const bool received = read_exact(connection, response);
  close_descriptor(connection);
  if (received && response.front() == response_ready) {
    return 0;
  }
  static_cast<void>(write_text(STDERR_FILENO, received && response.front() == response_capacity
                                                  ? "fiber workspace capacity reached\n"
                                                  : "failed to create fiber workspace\n"));
  return 1;
}

auto start(const std::string_view workspace) -> int {
  return ensure(workspace) == 0 ? list(workspace) : 1;
}

auto list() -> int {
  int connection = open_server_connection();
  if (connection < 0) {
    static_cast<void>(write_text(STDOUT_FILENO, "no fiber workspaces\n"));
    return 0;
  }
  close_descriptor(connection);
  return run_control_command(protocol::ControlCommand::list, {}, false);
}

auto list(const std::string_view workspace) -> int {
  return validate_workspace(workspace)
             ? run_control_command(protocol::ControlCommand::list_workspace, workspace, true)
             : 1;
}

auto list_windows(const std::string_view workspace) -> int {
  return validate_workspace(workspace)
             ? run_control_command(protocol::ControlCommand::list_windows, workspace, true)
             : 1;
}

auto kill(const std::string_view workspace) -> int {
  return validate_workspace(workspace)
             ? run_control_command(protocol::ControlCommand::kill, workspace, true)
             : 1;
}

auto kill_all() -> int {
  int connection = open_server_connection();
  if (connection < 0) {
    return 0;
  }
  close_descriptor(connection);
  return run_control_command(protocol::ControlCommand::kill_all, {}, false);
}

} // namespace fiber::daemon
