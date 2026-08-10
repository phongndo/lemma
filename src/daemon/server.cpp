#include "daemon/server.hpp"

#include "core/engine.hpp"
#include "extension/host.hpp"
#include "lemma/version.hpp"
#include "platform/io.hpp"
#include "protocol/single_pane.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <expected>
#include <span>
#include <string>
#include <string_view>
#include <thread>

#include <fcntl.h>
#include <pwd.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <syslog.h>
#include <unistd.h>

#ifdef __APPLE__
#include <crt_externs.h>
#elifdef __linux__
extern char** environ;
#endif

namespace lemma::daemon {
namespace {

constexpr auto response_ready = protocol::wire_byte(protocol::ControlResponse::ready);
constexpr auto response_capacity = protocol::wire_byte(protocol::ControlResponse::capacity);
constexpr auto response_missing = protocol::wire_byte(protocol::ControlResponse::missing);
using platform::close_descriptor;
using platform::read_exact;
using platform::send_all;
using platform::write_all;
using platform::write_text;

[[nodiscard]] constexpr auto valid_session_name(const std::string_view session) noexcept -> bool {
  if (session.empty() || session.size() > protocol::session_name_bytes_max) {
    return false;
  }
  return std::ranges::all_of(session, [](const char character) {
    return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
           (character >= '0' && character <= '9') || character == '_' || character == '-';
  });
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

[[nodiscard]] auto extension_config_available(const std::string& path) noexcept -> bool {
  if (path.empty()) {
    return false;
  }
  struct stat info{};
  if (::stat(path.c_str(), &info) == 0) {
    return true;
  }
  // Missing configuration means the foundational path has no extension process. Other errors are
  // handed to the host so its existing bounded diagnostic remains observable.
  return errno != ENOENT;
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

[[nodiscard]] auto run_owned_server(const std::string& path, const ServeOptions options) noexcept
    -> int {
  static_cast<void>(::signal(SIGPIPE, SIG_IGN));
  static_cast<void>(::signal(SIGCHLD, SIG_IGN));
  ::openlog("lemma", LOG_PID | LOG_NDELAY, LOG_USER);
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
      .extension_config = {},
  };
  bool start_extension_host = false;
  if (options.extensions_enabled) {
    try {
      endpoint.extension_config = extension::default_config_path();
      start_extension_host = extension_config_available(endpoint.extension_config);
    } catch (...) {
      release_owned_endpoint(&endpoint);
      return 1;
    }
  }
  return core::run_server(listener, &release_owned_endpoint, &endpoint,
                          start_extension_host ? &acquire_extension_host : nullptr,
                          start_extension_host ? &endpoint : nullptr,
                          start_extension_host ? &report_extension_error : nullptr, nullptr,
                          options.stop_requested);
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
    ::_exit(run_owned_server(path, {}));
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

[[nodiscard]] auto send_session_request(const int connection,
                                        const protocol::ControlCommand command,
                                        const std::string_view session) noexcept -> bool {
  const auto header = protocol::encode_session_header(command, session);
  return send_all(connection, header) &&
         send_all(connection, std::as_bytes(std::span(session.data(), session.size())));
}

[[nodiscard]] auto process_environment() noexcept -> char** {
#ifdef __APPLE__
  return *_NSGetEnviron();
#elifdef __linux__
  return ::environ;
#endif
}

[[nodiscard]] auto capture_home_directory(const std::span<char> output) noexcept -> std::size_t {
  std::array<char, std::size_t{16} * 1'024U> account_buffer{};
  struct passwd account{};
  struct passwd* result = nullptr;
  if (::getpwuid_r(::getuid(), &account, account_buffer.data(), account_buffer.size(), &result) !=
          0 ||
      result == nullptr || account.pw_dir == nullptr) {
    return 0;
  }
  const std::string_view home(account.pw_dir);
  if (home.empty() || home.front() != '/' || home.size() >= output.size() || home.contains('\0')) {
    return 0;
  }
  std::ranges::copy(home, output.begin());
  return home.size();
}

[[nodiscard]] auto send_existing_session_request(const int connection,
                                                 const std::string_view session) noexcept -> bool {
  const auto unavailable_context =
      protocol::encode_bounded_size(protocol::unavailable_working_directory_size);
  return send_session_request(connection, protocol::ControlCommand::create_with_context, session) &&
         send_all(connection, unavailable_context);
}

[[nodiscard]] auto send_create_request(const int connection,
                                       const std::string_view session) noexcept -> bool {
  std::array<char, protocol::working_directory_bytes_max + 1U> directory{};
  bool used_home_directory = false;
  if (::getcwd(directory.data(), directory.size()) == nullptr) {
    if (capture_home_directory(directory) == 0) {
      return send_existing_session_request(connection, session);
    }
    used_home_directory = true;
  }
  const std::string_view working_directory(directory.data());
  std::array<std::byte, protocol::environment_bytes_max> environment{};
  std::size_t environment_size = 0;
  std::size_t environment_entries = 0;
  // POSIX exposes the process environment as a null-terminated pointer vector.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  for (char** entry = process_environment(); entry != nullptr && *entry != nullptr; ++entry) {
    const std::string_view value(*entry);
    const auto encoded_size = value.size() + 1U;
    if (encoded_size > environment.size() - environment_size ||
        environment_entries == protocol::environment_entries_max) {
      return send_existing_session_request(connection, session);
    }
    std::ranges::copy(std::as_bytes(std::span(value.data(), value.size())),
                      std::span(environment).subspan(environment_size).begin());
    environment_size += value.size();
    std::span(environment).subspan(environment_size, 1).front() = std::byte{0};
    ++environment_size;
    ++environment_entries;
  }
  if (used_home_directory &&
      !write_text(
          STDERR_FILENO,
          "warning: current directory unavailable; new session will use home directory\n")) {
    return false;
  }
  const auto directory_size = protocol::encode_bounded_size(working_directory.size());
  const auto encoded_environment_size = protocol::encode_bounded_size(environment_size);
  return send_session_request(connection, protocol::ControlCommand::create_with_context, session) &&
         send_all(connection, directory_size) &&
         send_all(connection,
                  std::as_bytes(std::span(working_directory.data(), working_directory.size()))) &&
         send_all(connection, encoded_environment_size) &&
         send_all(connection, std::span(environment).first(environment_size));
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto run_control_command(const RuntimeEndpoint& endpoint,
                                       const protocol::ControlCommand command,
                                       const std::string_view session, const bool report_missing)
    -> int {
  int connection = open_connection(std::string(endpoint.socket_path()));
  if (connection < 0) {
    if (report_missing) {
      static_cast<void>(write_text(STDERR_FILENO, "no lemma daemon\n"));
    }
    return 1;
  }
  const bool named = !session.empty();
  const std::array encoded_command{protocol::wire_byte(command)};
  const bool sent = named ? send_session_request(connection, command, session)
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
      static_cast<void>(write_text(STDERR_FILENO, "no lemma session\n"));
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

[[nodiscard]] auto run_shutdown_command(const RuntimeEndpoint& endpoint) -> int {
  int connection = open_connection(std::string(endpoint.socket_path()));
  if (connection < 0) {
    static_cast<void>(write_text(STDERR_FILENO, "no lemma daemon\n"));
    return 1;
  }
  const std::array command{protocol::wire_byte(protocol::ControlCommand::shutdown)};
  if (!send_all(connection, command)) {
    close_descriptor(connection);
    static_cast<void>(write_text(STDERR_FILENO, "failed to shut down lemma daemon\n"));
    return 1;
  }

  std::array<std::byte, protocol::shutdown_response.size()> response{};
  const bool received = read_exact(connection, response);
  close_descriptor(connection);
  const auto expected = std::as_bytes(
      std::span(protocol::shutdown_response.data(), protocol::shutdown_response.size()));
  if (received && std::ranges::equal(response, expected)) {
    return write_all(STDOUT_FILENO, expected) ? 0 : 1;
  }
  static_cast<void>(write_text(STDERR_FILENO, response.front() == response_capacity
                                                  ? "lemma daemon connection capacity reached\n"
                                                  : "failed to shut down lemma daemon\n"));
  return 1;
}

} // namespace

[[nodiscard]] auto validate_session(const std::string_view session) noexcept -> bool {
  if (valid_session_name(session)) {
    return true;
  }
  static_cast<void>(write_text(
      STDERR_FILENO,
      "invalid session name; use 1-32 ASCII letters, digits, underscores, or hyphens\n"));
  return false;
}

[[nodiscard]] auto RuntimeEndpoint::create(const std::string_view socket_path)
    -> std::optional<RuntimeEndpoint> {
  if (socket_path.empty() || socket_path.front() != '/' || socket_path.contains('\0') ||
      !socket_address(std::string(socket_path)).has_value()) {
    return std::nullopt;
  }
  return RuntimeEndpoint(std::string(socket_path));
}

[[nodiscard]] auto default_runtime_endpoint() -> RuntimeEndpoint {
  auto endpoint = RuntimeEndpoint::create("/tmp/" + std::string(private_protocol_version) + "-" +
                                          std::to_string(::getuid()) + ".sock");
  // The fixed production path is absolute and well below sockaddr_un::sun_path on supported hosts.
  if (!endpoint.has_value()) {
    std::abort();
  }
  return std::move(*endpoint);
}

[[nodiscard]] auto serve(const RuntimeEndpoint& endpoint, const ServeOptions options) noexcept
    -> int {
  return run_owned_server(endpoint.socket_path_storage(), options);
}

[[nodiscard]] auto open_server_connection(const RuntimeEndpoint& endpoint) -> int {
  return open_connection(std::string(endpoint.socket_path()));
}

[[nodiscard]] auto ensure(const RuntimeEndpoint& endpoint, const std::string_view session) -> int {
  if (!validate_session(session)) {
    return 1;
  }
  const std::string path(endpoint.socket_path());
  if (!ensure_server(path)) {
    static_cast<void>(write_text(STDERR_FILENO, "failed to start lemma daemon\n"));
    return 1;
  }
  int connection = open_connection(path);
  if (connection < 0 || !send_create_request(connection, session)) {
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
                                                  ? "lemma session capacity reached\n"
                                                  : "failed to create lemma session\n"));
  return 1;
}

auto start(const RuntimeEndpoint& endpoint, const std::string_view session) -> int {
  return ensure(endpoint, session) == 0 ? list(endpoint, session) : 1;
}

auto list(const RuntimeEndpoint& endpoint) -> int {
  int connection = open_server_connection(endpoint);
  if (connection < 0) {
    static_cast<void>(write_text(STDOUT_FILENO, "no lemma sessions\n"));
    return 0;
  }
  close_descriptor(connection);
  return run_control_command(endpoint, protocol::ControlCommand::list, {}, false);
}

auto list(const RuntimeEndpoint& endpoint, const std::string_view session) -> int {
  return validate_session(session)
             ? run_control_command(endpoint, protocol::ControlCommand::list_session, session, true)
             : 1;
}

auto list_tabs(const RuntimeEndpoint& endpoint, const std::string_view session) -> int {
  return validate_session(session)
             ? run_control_command(endpoint, protocol::ControlCommand::list_tabs, session, true)
             : 1;
}

auto kill(const RuntimeEndpoint& endpoint, const std::string_view session) -> int {
  return validate_session(session)
             ? run_control_command(endpoint, protocol::ControlCommand::kill, session, true)
             : 1;
}

auto kill_all(const RuntimeEndpoint& endpoint) -> int {
  int connection = open_server_connection(endpoint);
  if (connection < 0) {
    return 0;
  }
  close_descriptor(connection);
  return run_control_command(endpoint, protocol::ControlCommand::kill_all, {}, false);
}

auto shutdown(const RuntimeEndpoint& endpoint) -> int { return run_shutdown_command(endpoint); }

} // namespace lemma::daemon
