#include "daemon/server.hpp"

#include "core/engine.hpp"
#include "extension/host.hpp"
#include "lemma/id.hpp"
#include "lemma/version.hpp"
#include "platform/io.hpp"
#include "protocol/attachment.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <expected>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

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
#endif

namespace lemma::daemon {
namespace {

constexpr auto response_ready = protocol::wire_byte(protocol::ControlResponse::ready);
constexpr auto response_no_effect = protocol::wire_byte(protocol::ControlResponse::no_effect);
constexpr auto response_unavailable = protocol::wire_byte(protocol::ControlResponse::unavailable);
constexpr auto response_capacity = protocol::wire_byte(protocol::ControlResponse::capacity);
constexpr auto response_conflict = protocol::wire_byte(protocol::ControlResponse::conflict);
constexpr auto response_missing = protocol::wire_byte(protocol::ControlResponse::missing);
using platform::close_descriptor;
using platform::read_exact;
using platform::send_all;
using platform::write_all;
using platform::write_text;

volatile sig_atomic_t child_exit_pending = 0;

void record_child_exit([[maybe_unused]] const int signal_number) noexcept {
  child_exit_pending = 1;
}

[[nodiscard]] auto reap_child([[maybe_unused]] void* const context) noexcept
    -> std::optional<core::ChildExit> {
  if (child_exit_pending == 0) {
    return std::nullopt;
  }
  // Clear before probing so a concurrent SIGCHLD publishes another pending pass rather than being
  // lost between waitpid and the flag update.
  child_exit_pending = 0;
  int status = 0;
  const auto process = ::waitpid(-1, &status, WNOHANG);
  if (process > 0) {
    child_exit_pending = 1;
    return core::ChildExit{.process = static_cast<int>(process), .status = status};
  }
  if (process < 0 && errno == EINTR) {
    child_exit_pending = 1;
  }
  return std::nullopt;
}

[[nodiscard]] constexpr auto valid_session_name(const std::string_view session) noexcept -> bool {
  if (session.empty() || session.front() == '-' ||
      session.size() > protocol::session_name_bytes_max) {
    return false;
  }
  return std::ranges::all_of(session, [](const char character) {
    return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
           (character >= '0' && character <= '9') || character == '_' || character == '-';
  });
}

[[nodiscard]] constexpr auto valid_tab_title(const std::string_view title) noexcept -> bool {
  return title.size() <= protocol::tab_title_bytes_max &&
         std::ranges::all_of(title, [](const char character) {
           const auto byte = static_cast<unsigned char>(character);
           return byte >= 0x20U && byte <= 0x7eU;
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
  struct sigaction child_action{};
  child_action.sa_handler = &record_child_exit;
  if (sigemptyset(&child_action.sa_mask) != 0 ||
      ::sigaction(SIGCHLD, &child_action, nullptr) != 0) {
    return 1;
  }
  child_exit_pending = 0;
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
                          options.stop_requested, &reap_child, nullptr);
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

[[nodiscard]] auto
capture_working_directory(const std::string_view requested,
                          std::array<char, protocol::working_directory_bytes_max + 1U>& output,
                          bool& used_home_directory) noexcept -> std::optional<std::string_view> {
  used_home_directory = false;
  if (requested.empty()) {
    if (::getcwd(output.data(), output.size()) != nullptr) {
      return std::string_view(output.data());
    }
    const auto home_size = capture_home_directory(output);
    if (home_size == 0) {
      return std::nullopt;
    }
    used_home_directory = true;
    return std::string_view(output.data(), home_size);
  }
  if (requested.contains('\0') || requested.size() > protocol::working_directory_bytes_max) {
    return std::nullopt;
  }
  std::array<char, protocol::working_directory_bytes_max + 1U> candidate{};
  std::ranges::copy(requested, candidate.begin());
  if (::realpath(candidate.data(), output.data()) == nullptr) {
    return std::nullopt;
  }
  struct stat info{};
  const std::string_view resolved(output.data());
  if (resolved.size() > protocol::working_directory_bytes_max ||
      ::stat(output.data(), &info) != 0 || !S_ISDIR(info.st_mode)) {
    return std::nullopt;
  }
  return resolved;
}

[[nodiscard]] auto
encode_launch_command(const std::span<const std::string_view> arguments,
                      std::array<std::byte, protocol::command_bytes_max>& output) noexcept
    -> std::optional<std::size_t> {
  if (arguments.size() > protocol::command_arguments_max ||
      (!arguments.empty() && arguments.front().empty())) {
    return std::nullopt;
  }
  std::size_t size = 0;
  for (const auto argument : arguments) {
    if (argument.contains('\0') || argument.size() + 1U > output.size() - size) {
      return std::nullopt;
    }
    std::ranges::copy(std::as_bytes(std::span(argument.data(), argument.size())),
                      std::span(output).subspan(size).begin());
    size += argument.size();
    std::span(output).subspan(size, 1).front() = std::byte{0};
    ++size;
  }
  return size;
}

struct CapturedLaunchContext final {
  std::array<char, protocol::working_directory_bytes_max + 1U> working_directory{};
  std::array<std::byte, protocol::environment_bytes_max> environment{};
  std::array<std::byte, protocol::command_bytes_max> command{};
  std::size_t working_directory_size{0};
  std::size_t environment_size{0};
  std::size_t command_size{0};
  bool hold{false};
};

[[nodiscard]] auto capture_launch_context(const LaunchOptions options,
                                          CapturedLaunchContext& context) noexcept -> bool {
  bool used_home_directory = false;
  const auto working_directory = capture_working_directory(
      options.working_directory, context.working_directory, used_home_directory);
  if (!working_directory.has_value()) {
    static_cast<void>(write_text(STDERR_FILENO, "invalid or unavailable working directory\n"));
    return false;
  }
  context.working_directory_size = working_directory->size();

  std::size_t environment_entries = 0;
  // POSIX exposes the process environment as a null-terminated pointer vector.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  for (char** entry = process_environment(); entry != nullptr && *entry != nullptr; ++entry) {
    const std::string_view value(*entry);
    const auto encoded_size = value.size() + 1U;
    if (encoded_size > context.environment.size() - context.environment_size ||
        environment_entries == protocol::environment_entries_max) {
      static_cast<void>(write_text(STDERR_FILENO, "launch environment exceeds lemma limits\n"));
      return false;
    }
    std::ranges::copy(std::as_bytes(std::span(value.data(), value.size())),
                      std::span(context.environment).subspan(context.environment_size).begin());
    context.environment_size += value.size();
    std::span(context.environment).subspan(context.environment_size, 1).front() = std::byte{0};
    ++context.environment_size;
    ++environment_entries;
  }

  const auto command_size = encode_launch_command(options.command, context.command);
  if (!command_size.has_value()) {
    static_cast<void>(write_text(STDERR_FILENO, "launch command exceeds lemma limits\n"));
    return false;
  }
  context.command_size = *command_size;
  context.hold = options.hold;
  return !used_home_directory ||
         write_text(
             STDERR_FILENO,
             "warning: current directory unavailable; new session will use home directory\n");
}

[[nodiscard]] auto send_create_request(const int connection,
                                       const std::optional<std::string_view> session,
                                       const CapturedLaunchContext& context) noexcept -> bool {
  const auto directory_size = protocol::encode_bounded_size(context.working_directory_size);
  const auto environment_size = protocol::encode_bounded_size(context.environment_size);
  const auto command_size = protocol::encode_bounded_size(context.command_size);
  const bool sent_header =
      session.has_value()
          ? send_session_request(connection, protocol::ControlCommand::create_with_context,
                                 *session)
          : send_all(connection, std::array{protocol::wire_byte(
                                     protocol::ControlCommand::create_auto_with_context)});
  const std::array flags{static_cast<std::byte>(context.hold ? 1 : 0)};
  return sent_header && send_all(connection, flags) && send_all(connection, directory_size) &&
         send_all(connection, std::as_bytes(std::span(context.working_directory))
                                  .first(context.working_directory_size)) &&
         send_all(connection, environment_size) &&
         send_all(connection, std::span(context.environment).first(context.environment_size)) &&
         send_all(connection, command_size) &&
         send_all(connection, std::span(context.command).first(context.command_size));
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto capture_control_command(const RuntimeEndpoint& endpoint,
                                           const protocol::ControlCommand command,
                                           const std::string_view session) -> TextResult {
  int connection = open_connection(std::string(endpoint.socket_path()));
  if (connection < 0) {
    return {};
  }
  const bool named = !session.empty();
  const std::array encoded_command{protocol::wire_byte(command)};
  const bool sent = named ? send_session_request(connection, command, session)
                          : send_all(connection, encoded_command);
  if (!sent) {
    close_descriptor(connection);
    return {};
  }

  TextResult result{.status = OperationStatus::applied, .text = {}};
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
      return {};
    }
    const auto bytes = std::span(response).first(static_cast<std::size_t>(bytes_read));
    if (first && bytes.front() == response_missing) {
      close_descriptor(connection);
      return {.status = OperationStatus::missing, .text = {}};
    }
    first = false;
    // Control listing bytes are printable UTF-8/ASCII by construction.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    result.text.append(reinterpret_cast<const char*>(bytes.data()), bytes.size());
  }
  close_descriptor(connection);
  return first ? TextResult{} : result;
}

[[nodiscard]] auto run_control_command(const RuntimeEndpoint& endpoint,
                                       const protocol::ControlCommand command,
                                       const std::string_view session, const bool report_missing)
    -> int {
  const auto result = capture_control_command(endpoint, command, session);
  if (result.status != OperationStatus::applied) {
    if (report_missing) {
      static_cast<void>(write_text(STDERR_FILENO, result.status == OperationStatus::missing
                                                      ? "no lemma session\n"
                                                      : "no lemma daemon\n"));
    }
    return 1;
  }
  return write_text(STDOUT_FILENO, result.text) ? 0 : 1;
}

[[nodiscard]] auto
capture_rename_request(const RuntimeEndpoint& endpoint, const protocol::ControlCommand command,
                       const std::string_view session, const std::span<const std::byte> fields)
    -> OperationStatus {
  int connection = open_connection(std::string(endpoint.socket_path()));
  if (connection < 0 || !send_session_request(connection, command, session) ||
      !send_all(connection, fields)) {
    close_descriptor(connection);
    return OperationStatus::failed;
  }
  std::array<std::byte, 1> response{};
  const bool received = read_exact(connection, response);
  close_descriptor(connection);
  if (!received) {
    return OperationStatus::failed;
  }
  if (response.front() == response_ready) {
    return OperationStatus::applied;
  }
  if (response.front() == response_missing) {
    return OperationStatus::missing;
  }
  if (response.front() == response_conflict) {
    return OperationStatus::conflict;
  }
  if (response.front() == response_capacity) {
    return OperationStatus::capacity;
  }
  return OperationStatus::failed;
}

[[nodiscard]] auto report_rename_status(const OperationStatus status) -> int {
  if (status == OperationStatus::applied) {
    return 0;
  }
  if (status == OperationStatus::missing) {
    static_cast<void>(write_text(STDERR_FILENO, "no matching lemma session or tab\n"));
  } else if (status == OperationStatus::conflict) {
    static_cast<void>(write_text(STDERR_FILENO, "lemma session name already exists\n"));
  } else if (status == OperationStatus::capacity) {
    static_cast<void>(write_text(STDERR_FILENO, "lemma identity capacity reached\n"));
  } else {
    static_cast<void>(write_text(STDERR_FILENO, "failed to rename lemma session or tab\n"));
  }
  return 1;
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

[[nodiscard]] constexpr auto operation_status(const std::byte response) noexcept
    -> OperationStatus {
  if (response == response_ready) {
    return OperationStatus::applied;
  }
  if (response == response_no_effect) {
    return OperationStatus::no_effect;
  }
  if (response == response_missing) {
    return OperationStatus::missing;
  }
  if (response == response_conflict) {
    return OperationStatus::conflict;
  }
  if (response == response_capacity) {
    return OperationStatus::capacity;
  }
  if (response == response_unavailable) {
    return OperationStatus::unavailable;
  }
  return OperationStatus::failed;
}

[[nodiscard]] auto open_payload_request(const RuntimeEndpoint& endpoint,
                                        const protocol::ControlCommand command,
                                        const std::string_view session,
                                        const std::span<const std::byte> payload) -> int {
  if (!valid_session_name(session) || payload.empty() ||
      payload.size() > protocol::control_payload_bytes_max) {
    return -1;
  }
  int connection = open_connection(std::string(endpoint.socket_path()));
  const auto size = protocol::encode_bounded_size(payload.size());
  if (connection < 0 || !send_session_request(connection, command, session) ||
      !send_all(connection, size) || !send_all(connection, payload)) {
    close_descriptor(connection);
    return -1;
  }
  return connection;
}

[[nodiscard]] auto read_operation_response(int connection) noexcept -> OperationStatus {
  std::array<std::byte, 1> response{};
  const bool received = read_exact(connection, response);
  close_descriptor(connection);
  return received ? operation_status(response.front()) : OperationStatus::failed;
}

[[nodiscard]] constexpr auto protocol_surface_kind(const SurfaceCreateKind kind) noexcept
    -> protocol::SurfaceCreateKind {
  switch (kind) {
  case SurfaceCreateKind::tab:
    return protocol::SurfaceCreateKind::tab;
  case SurfaceCreateKind::split_right:
    return protocol::SurfaceCreateKind::split_right;
  case SurfaceCreateKind::split_down:
    return protocol::SurfaceCreateKind::split_down;
  }
  return protocol::SurfaceCreateKind::tab;
}

[[nodiscard]] constexpr auto protocol_action(const SemanticAction action) noexcept
    -> protocol::ControlAction {
  switch (action) {
  case SemanticAction::tab_select:
    return protocol::ControlAction::tab_select;
  case SemanticAction::tab_move:
    return protocol::ControlAction::tab_move;
  case SemanticAction::tab_kill:
    return protocol::ControlAction::tab_kill;
  case SemanticAction::pane_focus:
    return protocol::ControlAction::pane_focus;
  case SemanticAction::pane_swap:
    return protocol::ControlAction::pane_swap;
  case SemanticAction::pane_resize_left:
    return protocol::ControlAction::pane_resize_left;
  case SemanticAction::pane_resize_right:
    return protocol::ControlAction::pane_resize_right;
  case SemanticAction::pane_resize_up:
    return protocol::ControlAction::pane_resize_up;
  case SemanticAction::pane_resize_down:
    return protocol::ControlAction::pane_resize_down;
  case SemanticAction::pane_zoom_on:
    return protocol::ControlAction::pane_zoom_on;
  case SemanticAction::pane_zoom_off:
    return protocol::ControlAction::pane_zoom_off;
  case SemanticAction::pane_kill:
    return protocol::ControlAction::pane_kill;
  case SemanticAction::session_kill:
    return protocol::ControlAction::session_kill;
  }
  return protocol::ControlAction::pane_kill;
}

void encode_control_u16(const std::uint16_t value, const std::span<std::byte, 2> output) noexcept {
  output.front() = static_cast<std::byte>((value >> 8U) & 0xffU);
  output.back() = static_cast<std::byte>(value & 0xffU);
}

[[nodiscard]] constexpr auto decode_control_u32(const std::span<const std::byte, 4> input) noexcept
    -> std::uint32_t {
  return (std::to_integer<std::uint32_t>(input.subspan(0, 1).front()) << 24U) |
         (std::to_integer<std::uint32_t>(input.subspan(1, 1).front()) << 16U) |
         (std::to_integer<std::uint32_t>(input.subspan(2, 1).front()) << 8U) |
         std::to_integer<std::uint32_t>(input.subspan(3, 1).front());
}

} // namespace

[[nodiscard]] auto validate_session(const std::string_view session) noexcept -> bool {
  if (valid_session_name(session)) {
    return true;
  }
  static_cast<void>(write_text(STDERR_FILENO,
                               "invalid session name; use 1-32 ASCII letters, digits, "
                               "underscores, or hyphens, and do not start with a hyphen\n"));
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

// Creation reports each bounded setup and daemon outcome without publishing partial client state.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto create_detailed(const RuntimeEndpoint& endpoint, const std::optional<std::string_view> session,
                     const LaunchOptions options) -> SurfaceResult {
  if (session.has_value() && !validate_session(*session)) {
    return {};
  }
  CapturedLaunchContext launch_context;
  if (!capture_launch_context(options, launch_context)) {
    return {};
  }
  const std::string path(endpoint.socket_path());
  if (!ensure_server(path)) {
    static_cast<void>(write_text(STDERR_FILENO, "failed to start lemma daemon\n"));
    return {};
  }
  int connection = open_connection(path);
  if (connection < 0 || !send_create_request(connection, session, launch_context)) {
    close_descriptor(connection);
    return {};
  }
  std::array<std::byte, 1> response{};
  const bool received = read_exact(connection, response);
  if (!received || response.front() != response_ready) {
    close_descriptor(connection);
    if (received && response.front() == response_capacity) {
      static_cast<void>(write_text(STDERR_FILENO, "lemma session capacity reached\n"));
    } else if (received && response.front() == response_conflict) {
      static_cast<void>(write_text(STDERR_FILENO, "lemma session already exists\n"));
    } else {
      static_cast<void>(write_text(STDERR_FILENO, "failed to create lemma session\n"));
    }
    auto status = OperationStatus::failed;
    if (received && response.front() == response_capacity) {
      status = OperationStatus::capacity;
    } else if (received && response.front() == response_conflict) {
      status = OperationStatus::conflict;
    }
    return {.status = status, .session = {}, .tab = {}, .pane = {}};
  }
  std::array<std::byte, 1> encoded_name_size{};
  if (!read_exact(connection, encoded_name_size)) {
    close_descriptor(connection);
    return {};
  }
  const auto name_size = std::to_integer<std::size_t>(encoded_name_size.front());
  if (name_size == 0 || name_size > protocol::session_name_bytes_max) {
    close_descriptor(connection);
    return {};
  }
  std::array<char, protocol::session_name_bytes_max> name{};
  std::array<std::byte, protocol::control_id_bytes> tab_bytes{};
  std::array<std::byte, protocol::control_id_bytes> pane_bytes{};
  const bool read_result =
      read_exact(connection, std::as_writable_bytes(std::span(name)).first(name_size)) &&
      read_exact(connection, tab_bytes) && read_exact(connection, pane_bytes);
  close_descriptor(connection);
  const auto tab = protocol::decode_control_id<TabId>(tab_bytes);
  const auto pane = protocol::decode_control_id<PaneId>(pane_bytes);
  if (!read_result || !tab.has_value() || !pane.has_value() || !tab->is_valid() ||
      !pane->is_valid()) {
    return {};
  }
  return {.status = OperationStatus::applied,
          .session = std::string(name.data(), name_size),
          .tab = *tab,
          .pane = *pane};
}

auto create(const RuntimeEndpoint& endpoint, const std::optional<std::string_view> session,
            const LaunchOptions options) -> std::optional<std::string> {
  auto result = create_detailed(endpoint, session, options);
  return result.succeeded() ? std::optional{std::move(result.session)} : std::nullopt;
}

auto start(const RuntimeEndpoint& endpoint, const std::optional<std::string_view> session,
           const LaunchOptions options) -> int {
  const auto created = create(endpoint, session, options);
  return created.has_value() ? list(endpoint, *created) : 1;
}

auto query(const RuntimeEndpoint& endpoint, const QueryKind kind, const std::string_view session)
    -> TextResult {
  if (kind != QueryKind::sessions && !valid_session_name(session)) {
    return {};
  }
  if (kind == QueryKind::sessions) {
    int connection = open_server_connection(endpoint);
    if (connection < 0) {
      return {.status = OperationStatus::applied, .text = "[]"};
    }
    close_descriptor(connection);
  }
  switch (kind) {
  case QueryKind::sessions:
    return capture_control_command(endpoint, protocol::ControlCommand::query_sessions, {});
  case QueryKind::session:
    return capture_control_command(endpoint, protocol::ControlCommand::query_session, session);
  case QueryKind::tabs:
    return capture_control_command(endpoint, protocol::ControlCommand::query_tabs, session);
  case QueryKind::panes:
    return capture_control_command(endpoint, protocol::ControlCommand::query_panes, session);
  }
  return {};
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

auto list_panes(const RuntimeEndpoint& endpoint, const std::string_view session) -> int {
  return validate_session(session)
             ? run_control_command(endpoint, protocol::ControlCommand::list_panes, session, true)
             : 1;
}

// Surface creation is cold control work. One bounded payload retains exact argv without exposing
// CLI or JSON grammar to the daemon reactor.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto create_surface(const RuntimeEndpoint& endpoint, const std::string_view session,
                    const SurfaceCreateKind kind, const PaneId target, const SurfaceOptions options)
    -> SurfaceResult {
  if (!validate_session(session) || !valid_tab_title(options.title) ||
      (kind == SurfaceCreateKind::tab && target.is_valid()) ||
      (kind != SurfaceCreateKind::tab && !target.is_valid())) {
    return {};
  }
  std::array<char, protocol::working_directory_bytes_max + 1U> directory{};
  std::size_t directory_size = 0;
  if (!options.working_directory.empty()) {
    bool used_home = false;
    const auto captured =
        capture_working_directory(options.working_directory, directory, used_home);
    if (!captured.has_value() || used_home) {
      static_cast<void>(write_text(STDERR_FILENO, "invalid or unavailable working directory\n"));
      return {};
    }
    directory_size = captured->size();
  }
  std::array<std::byte, protocol::command_bytes_max> command{};
  const auto command_size = encode_launch_command(options.command, command);
  if (!command_size.has_value()) {
    static_cast<void>(write_text(STDERR_FILENO, "launch command exceeds lemma limits\n"));
    return {};
  }
  constexpr std::size_t header_size = 15;
  const auto payload_size = header_size + options.title.size() + directory_size + *command_size;
  if (payload_size > protocol::control_payload_bytes_max) {
    return {.status = OperationStatus::capacity, .session = {}, .tab = {}, .pane = {}};
  }
  std::vector<std::byte> payload;
  try {
    payload.resize(payload_size);
  } catch (...) {
    return {};
  }
  payload.front() = static_cast<std::byte>(protocol_surface_kind(kind));
  const auto target_id = protocol::encode_control_id(target);
  std::ranges::copy(target_id, std::span(payload).subspan(1, protocol::control_id_bytes).begin());
  std::span(payload).subspan(9, 1).front() = static_cast<std::byte>(options.hold ? 1 : 0);
  std::span(payload).subspan(10, 1).front() = static_cast<std::byte>(options.title.size());
  encode_control_u16(static_cast<std::uint16_t>(directory_size),
                     std::span(payload).subspan<11, 2>());
  encode_control_u16(static_cast<std::uint16_t>(*command_size),
                     std::span(payload).subspan<13, 2>());
  std::size_t offset = header_size;
  std::ranges::copy(std::as_bytes(std::span(options.title.data(), options.title.size())),
                    std::span(payload).subspan(offset).begin());
  offset += options.title.size();
  std::ranges::copy(std::as_bytes(std::span(directory)).first(directory_size),
                    std::span(payload).subspan(offset).begin());
  offset += directory_size;
  std::ranges::copy(std::span(command).first(*command_size),
                    std::span(payload).subspan(offset).begin());

  int connection =
      open_payload_request(endpoint, protocol::ControlCommand::surface_create, session, payload);
  if (connection < 0) {
    return {};
  }
  std::array<std::byte, 1> response{};
  if (!read_exact(connection, response) || response.front() != response_ready) {
    close_descriptor(connection);
    return {.status = operation_status(response.front()), .session = {}, .tab = {}, .pane = {}};
  }
  std::array<std::byte, protocol::control_id_bytes> tab_bytes{};
  std::array<std::byte, protocol::control_id_bytes> pane_bytes{};
  const bool read_ids = read_exact(connection, tab_bytes) && read_exact(connection, pane_bytes);
  close_descriptor(connection);
  const auto tab = protocol::decode_control_id<TabId>(tab_bytes);
  const auto pane = protocol::decode_control_id<PaneId>(pane_bytes);
  if (!read_ids || !tab.has_value() || !pane.has_value() || !tab->is_valid() || !pane->is_valid()) {
    return {};
  }
  return {.status = OperationStatus::applied,
          .session = std::string(session),
          .tab = *tab,
          .pane = *pane};
}

auto perform_action(const RuntimeEndpoint& endpoint, const std::string_view session,
                    const SemanticAction action, const ActionTarget target) -> OperationStatus {
  if (!validate_session(session)) {
    return OperationStatus::failed;
  }
  std::array<std::byte, protocol::semantic_action_payload_bytes> payload{};
  payload.front() = static_cast<std::byte>(protocol_action(action));
  const auto tab = protocol::encode_control_id(target.tab);
  const auto pane = protocol::encode_control_id(target.pane);
  const auto peer = protocol::encode_control_id(target.peer_pane);
  std::ranges::copy(tab, std::span(payload).subspan(1, protocol::control_id_bytes).begin());
  std::ranges::copy(pane, std::span(payload)
                              .subspan(1U + protocol::control_id_bytes, protocol::control_id_bytes)
                              .begin());
  std::ranges::copy(peer,
                    std::span(payload)
                        .subspan(1U + (2U * protocol::control_id_bytes), protocol::control_id_bytes)
                        .begin());
  encode_control_u16(target.tab_position,
                     std::span(payload).subspan<1U + (3U * protocol::control_id_bytes), 2>());
  encode_control_u16(target.value,
                     std::span(payload).subspan<3U + (3U * protocol::control_id_bytes), 2>());
  const int connection =
      open_payload_request(endpoint, protocol::ControlCommand::semantic_action, session, payload);
  return connection < 0 ? OperationStatus::failed : read_operation_response(connection);
}

auto send_pane(const RuntimeEndpoint& endpoint, const std::string_view session, const PaneId pane,
               const std::string_view text) -> OperationStatus {
  if (!validate_session(session) || !pane.is_valid() || text.empty() ||
      text.size() > protocol::control_payload_bytes_max - protocol::control_id_bytes) {
    return OperationStatus::failed;
  }
  std::vector<std::byte> payload;
  try {
    payload.resize(protocol::control_id_bytes + text.size());
  } catch (...) {
    return OperationStatus::failed;
  }
  const auto encoded = protocol::encode_control_id(pane);
  std::ranges::copy(encoded, payload.begin());
  std::ranges::copy(std::as_bytes(std::span(text.data(), text.size())),
                    std::span(payload).subspan(protocol::control_id_bytes).begin());
  const int connection =
      open_payload_request(endpoint, protocol::ControlCommand::send_pane, session, payload);
  return connection < 0 ? OperationStatus::failed : read_operation_response(connection);
}

auto capture_pane(const RuntimeEndpoint& endpoint, const std::string_view session,
                  const PaneId pane) -> std::pair<OperationStatus, std::string> {
  if (!validate_session(session) || !pane.is_valid()) {
    return {OperationStatus::failed, {}};
  }
  const auto payload = protocol::encode_control_id(pane);
  int connection =
      open_payload_request(endpoint, protocol::ControlCommand::capture_pane, session, payload);
  if (connection < 0) {
    return {OperationStatus::failed, {}};
  }
  std::array<std::byte, 3> header{};
  if (!read_exact(connection, header) || header.front() != response_ready) {
    close_descriptor(connection);
    return {operation_status(header.front()), {}};
  }
  const auto size = static_cast<std::size_t>(
      (std::to_integer<std::uint16_t>(std::span(header).subspan(1, 1).front()) << 8U) |
      std::to_integer<std::uint16_t>(std::span(header).subspan(2, 1).front()));
  std::string output;
  try {
    output.resize(size);
  } catch (...) {
    close_descriptor(connection);
    return {OperationStatus::failed, {}};
  }
  const bool received = read_exact(connection, std::as_writable_bytes(std::span(output)));
  close_descriptor(connection);
  return received ? std::pair{OperationStatus::applied, std::move(output)}
                  : std::pair{OperationStatus::failed, std::string{}};
}

auto pane_status(const RuntimeEndpoint& endpoint, const std::string_view session, const PaneId pane)
    -> PaneStatus {
  if (!validate_session(session) || !pane.is_valid()) {
    return {};
  }
  const auto payload = protocol::encode_control_id(pane);
  int connection =
      open_payload_request(endpoint, protocol::ControlCommand::pane_status, session, payload);
  if (connection < 0) {
    return {};
  }
  std::array<std::byte, 7> response{};
  if (!read_exact(connection, response) || response.front() != response_ready) {
    close_descriptor(connection);
    return {
        .status = operation_status(response.front()), .process = ProcessState::running, .value = 0};
  }
  close_descriptor(connection);
  const bool exited = std::to_integer<std::uint8_t>(std::span(response).subspan(1, 1).front()) != 0;
  const auto kind = std::to_integer<std::uint8_t>(std::span(response).subspan(2, 1).front());
  const auto value = decode_control_u32(std::span(response).subspan<3, 4>());
  auto process = ProcessState::running;
  if (exited && kind == 1U) {
    process = ProcessState::exited;
  } else if (exited && kind == 2U) {
    process = ProcessState::signaled;
  } else if (exited) {
    process = ProcessState::exited_unknown;
  }
  return {.status = OperationStatus::applied, .process = process, .value = value};
}

[[nodiscard]] constexpr auto matches_expectation(const PaneStatus& actual,
                                                 const ProcessExpectation expected) noexcept
    -> bool {
  switch (expected.kind) {
  case ProcessExpectationKind::any:
    return actual.process != ProcessState::running;
  case ProcessExpectationKind::exit_code:
    return actual.process == ProcessState::exited && actual.value == expected.value;
  case ProcessExpectationKind::signal:
    return actual.process == ProcessState::signaled && actual.value == expected.value;
  }
  return false;
}

[[nodiscard]] auto poll_process_wait(const RuntimeEndpoint& endpoint,
                                     const std::string_view session, const PaneId pane,
                                     const ProcessExpectation expected)
    -> std::optional<PaneWaitResult> {
  const auto actual = pane_status(endpoint, session, pane);
  if (actual.status != OperationStatus::applied) {
    return PaneWaitResult{.status = actual.status, .process = std::nullopt};
  }
  if (actual.process == ProcessState::running) {
    return std::nullopt;
  }
  const auto status = matches_expectation(actual, expected) ? OperationStatus::applied
                                                            : OperationStatus::unexpected_exit;
  return PaneWaitResult{.status = status, .process = actual};
}

[[nodiscard]] auto poll_text_wait(const RuntimeEndpoint& endpoint, const std::string_view session,
                                  const PaneId pane, const std::string_view contains)
    -> std::optional<PaneWaitResult> {
  const auto [status, text] = capture_pane(endpoint, session, pane);
  if (status != OperationStatus::applied) {
    return PaneWaitResult{.status = status, .process = std::nullopt};
  }
  return text.contains(contains) ? std::optional{PaneWaitResult{.status = OperationStatus::applied,
                                                                .process = std::nullopt}}
                                 : std::nullopt;
}

auto wait_pane(const RuntimeEndpoint& endpoint, const std::string_view session, const PaneId pane,
               const PaneWaitOptions options) -> PaneWaitResult {
  constexpr auto timeout_max = std::chrono::minutes(10);
  const bool waits_for_process = options.process.has_value();
  if (!validate_session(session) || !pane.is_valid() ||
      (waits_for_process == !options.contains.empty()) || options.timeout.count() <= 0 ||
      options.timeout > timeout_max) {
    return {};
  }
  const auto deadline = std::chrono::steady_clock::now() + options.timeout;
  auto polling_delay = std::chrono::milliseconds(25);
  const auto expected = options.process.value_or(ProcessExpectation{});
  while (std::chrono::steady_clock::now() < deadline) {
    const auto completed = waits_for_process
                               ? poll_process_wait(endpoint, session, pane, expected)
                               : poll_text_wait(endpoint, session, pane, options.contains);
    if (completed.has_value()) {
      return *completed;
    }
    std::this_thread::sleep_for(polling_delay);
    polling_delay =
        std::min(polling_delay + std::chrono::milliseconds(25), std::chrono::milliseconds(250));
  }
  return {.status = OperationStatus::timeout, .process = std::nullopt};
}

auto rename_session_status(const RuntimeEndpoint& endpoint, const std::string_view session,
                           const std::string_view new_name) -> OperationStatus {
  if (!valid_session_name(session) || !valid_session_name(new_name)) {
    return OperationStatus::failed;
  }
  std::array<std::byte, 1U + protocol::session_name_bytes_max> fields{};
  fields.front() = std::byte{static_cast<std::uint8_t>(new_name.size())};
  std::ranges::copy(std::as_bytes(std::span(new_name.data(), new_name.size())),
                    std::span(fields).subspan(1).begin());
  return capture_rename_request(endpoint, protocol::ControlCommand::rename_session, session,
                                std::span(fields).first(1U + new_name.size()));
}

auto rename_session(const RuntimeEndpoint& endpoint, const std::string_view session,
                    const std::string_view new_name) -> int {
  if (!validate_session(session) || !validate_session(new_name)) {
    return 1;
  }
  return report_rename_status(rename_session_status(endpoint, session, new_name));
}

auto rename_tab_status(const RuntimeEndpoint& endpoint, const std::string_view session,
                       const std::size_t one_based_position, const std::string_view title)
    -> OperationStatus {
  if (!valid_session_name(session) || one_based_position == 0 ||
      one_based_position > protocol::tab_slots_max || !valid_tab_title(title)) {
    return OperationStatus::failed;
  }
  std::array<std::byte, 2U + protocol::tab_title_bytes_max> fields{};
  fields.front() = std::byte{static_cast<std::uint8_t>(one_based_position - 1U)};
  std::span(fields).subspan(1, 1).front() = std::byte{static_cast<std::uint8_t>(title.size())};
  std::ranges::copy(std::as_bytes(std::span(title.data(), title.size())),
                    std::span(fields).subspan(2).begin());
  return capture_rename_request(endpoint, protocol::ControlCommand::rename_tab, session,
                                std::span(fields).first(2U + title.size()));
}

auto rename_tab(const RuntimeEndpoint& endpoint, const std::string_view session,
                const std::size_t one_based_position, const std::string_view title) -> int {
  if (!validate_session(session) || one_based_position == 0 ||
      one_based_position > protocol::tab_slots_max || !valid_tab_title(title)) {
    static_cast<void>(write_text(STDERR_FILENO, "invalid tab rename; position must be 1-16 and "
                                                "title must be 0-64 printable ASCII bytes\n"));
    return 1;
  }
  return report_rename_status(rename_tab_status(endpoint, session, one_based_position, title));
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
