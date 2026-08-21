#include "daemon/server.hpp"

#include "api/action.hpp"
#include "api/json.hpp"
#include "core/engine.hpp"
#include "extension/host.hpp"
#include "lemma/id.hpp"
#include "platform/io.hpp"
#include "platform/pty.hpp"
#include "protocol/attachment.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <expected>
#include <iterator>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <thread>
#include <utility>
#include <vector>

#include <fcntl.h>
#include <poll.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <syslog.h>
#include <unistd.h>

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

[[nodiscard]] auto capture_home_directory(const std::span<char> output) noexcept -> std::size_t {
  return platform::account_home_directory(output);
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

  const auto environment_size = platform::capture_process_environment(context.environment);
  if (!environment_size.has_value()) {
    static_cast<void>(write_text(STDERR_FILENO, "launch environment exceeds lemma limits\n"));
    return false;
  }
  context.environment_size = *environment_size;

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

[[nodiscard]] constexpr auto decode_control_u32(const std::span<const std::byte, 4> input) noexcept
    -> std::uint32_t {
  return (std::to_integer<std::uint32_t>(input.subspan(0, 1).front()) << 24U) |
         (std::to_integer<std::uint32_t>(input.subspan(1, 1).front()) << 16U) |
         (std::to_integer<std::uint32_t>(input.subspan(2, 1).front()) << 8U) |
         std::to_integer<std::uint32_t>(input.subspan(3, 1).front());
}

template <typename Id>
[[nodiscard]] auto parse_public_id(std::string_view value) noexcept -> std::optional<Id>;

[[nodiscard]] auto event_request(const std::optional<std::string_view> session,
                                 const std::optional<PaneId> pane, const bool screen)
    -> std::optional<std::string> {
  const auto session_id = session.has_value() ? parse_public_id<SessionId>(*session) : std::nullopt;
  if ((session.has_value() && !session_id.has_value() && !valid_session_name(*session)) ||
      (pane.has_value() && (!pane->is_valid() || !session.has_value())) ||
      (screen && !pane.has_value())) {
    return std::nullopt;
  }
  try {
    std::string request = R"({"schema":"lemma.events/v1")";
    if (session_id.has_value()) {
      request += R"(,"session":{"id":")";
      request += std::to_string(session_id->slot());
      request += ":";
      request += std::to_string(session_id->generation());
      request += "\"}";
    } else if (session.has_value()) {
      request += R"(,"session":{"name":")";
      request += *session;
      request += "\"}";
    }
    if (pane.has_value()) {
      request += R"(,"pane":{"id":")";
      request += std::to_string(pane->slot());
      request += ":";
      request += std::to_string(pane->generation());
      request += "\"}";
    }
    if (screen) {
      request += R"(,"screen":true)";
    }
    request += "}\n";
    return request;
  } catch (...) {
    return std::nullopt;
  }
}

// Multi-Pane request encoding keeps one closed public grammar and one legacy single-Pane spelling.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto event_request(const std::optional<std::string_view> session,
                                 const std::span<const PaneId> panes, const bool screen)
    -> std::optional<std::string> {
  if (panes.size() > api::event_panes_max || (screen && panes.empty()) ||
      (!panes.empty() && !session.has_value())) {
    return std::nullopt;
  }
  if (panes.size() <= 1U) {
    return event_request(
        session, panes.empty() ? std::optional<PaneId>{} : std::optional{panes.front()}, screen);
  }
  const auto session_value = session.value_or(std::string_view{});
  const auto session_id = parse_public_id<SessionId>(session_value);
  if (!session_id.has_value() && !valid_session_name(session_value)) {
    return std::nullopt;
  }
  try {
    std::string request = R"({"schema":"lemma.events/v1")";
    if (session_id.has_value()) {
      request += R"(,"session":{"id":")" + std::to_string(session_id->slot()) + ":" +
                 std::to_string(session_id->generation()) + "\"}";
    } else {
      request += R"(,"session":{"name":")" + std::string(session_value) + "\"}";
    }
    request += R"(,"panes":[)";
    bool separator = false;
    for (const auto pane : panes) {
      if (!pane.is_valid()) {
        return std::nullopt;
      }
      if (separator) {
        request += ',';
      }
      separator = true;
      request += R"({"id":")" + std::to_string(pane.slot()) + ":" +
                 std::to_string(pane.generation()) + "\"}";
    }
    request += screen ? "],\"screen\":true}\n" : "]}\n";
    return request;
  } catch (...) {
    return std::nullopt;
  }
}

enum class EventReadError : std::uint8_t {
  timeout,
  closed,
  failed,
};

class EventReader final {
public:
  explicit EventReader(const int descriptor) noexcept : descriptor_(descriptor) {}

  // NOLINTNEXTLINE(readability-function-cognitive-complexity)
  [[nodiscard]] auto next(const std::chrono::steady_clock::time_point deadline)
      -> std::expected<std::string, EventReadError> {
    while (true) {
      if (const auto newline = buffered_.find('\n'); newline != std::string::npos) {
        auto line = buffered_.substr(0, newline);
        buffered_.erase(0, newline + 1U);
        return line;
      }
      const auto now = std::chrono::steady_clock::now();
      if (now >= deadline) {
        return std::unexpected(EventReadError::timeout);
      }
      const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
      pollfd descriptor{.fd = descriptor_, .events = POLLIN, .revents = 0};
      const auto waited =
          ::poll(&descriptor, 1, static_cast<int>(std::max(remaining.count(), std::int64_t{1})));
      if (waited == 0) {
        return std::unexpected(EventReadError::timeout);
      }
      if (waited < 0) {
        if (errno == EINTR) {
          continue;
        }
        return std::unexpected(EventReadError::failed);
      }
      std::array<char, std::size_t{16} * 1'024U> input{};
      const auto received = ::recv(descriptor_, input.data(), input.size(), 0);
      if (received > 0) {
        const auto size = static_cast<std::size_t>(received);
        if (size > api::json_bytes_max - buffered_.size()) {
          return std::unexpected(EventReadError::failed);
        }
        try {
          buffered_.append(input.data(), size);
        } catch (...) {
          return std::unexpected(EventReadError::failed);
        }
        continue;
      }
      if (received < 0 && errno == EINTR) {
        continue;
      }
      return std::unexpected(received == 0 ? EventReadError::closed : EventReadError::failed);
    }
  }

private:
  int descriptor_{-1};
  std::string buffered_;
};

[[nodiscard]] auto public_operation_status(const api::JsonValue& result) noexcept
    -> OperationStatus {
  const auto status = api::json_string(result, "status");
  if (status == std::optional<std::string_view>{"applied"}) {
    return OperationStatus::applied;
  }
  if (status == std::optional<std::string_view>{"no_effect"}) {
    return OperationStatus::no_effect;
  }
  if (status == std::optional<std::string_view>{"missing"} ||
      status == std::optional<std::string_view>{"stale"} ||
      status == std::optional<std::string_view>{"wrong_owner"}) {
    return OperationStatus::missing;
  }
  if (status == std::optional<std::string_view>{"conflict"}) {
    return OperationStatus::conflict;
  }
  if (status == std::optional<std::string_view>{"capacity"}) {
    return OperationStatus::capacity;
  }
  if (status == std::optional<std::string_view>{"unavailable"}) {
    return OperationStatus::unavailable;
  }
  return OperationStatus::failed;
}

[[nodiscard]] auto
invoke_public_action(const RuntimeEndpoint& endpoint, std::string request,
                     const std::chrono::milliseconds response_timeout = std::chrono::seconds(10))
    -> std::optional<api::JsonValue> {
  try {
    if (!request.ends_with('\n')) {
      request.push_back('\n');
    }
  } catch (...) {
    return std::nullopt;
  }
  int connection = open_connection(std::string(endpoint.socket_path()));
  if (connection < 0 ||
      !send_all(connection, std::as_bytes(std::span(request.data(), request.size())))) {
    close_descriptor(connection);
    return std::nullopt;
  }
  EventReader reader(connection);
  const auto line = reader.next(std::chrono::steady_clock::now() + response_timeout);
  close_descriptor(connection);
  if (!line.has_value()) {
    return std::nullopt;
  }
  auto parsed = api::parse_json(*line);
  return parsed.value.has_value() ? std::move(parsed.value) : std::nullopt;
}

struct ProcedureRequestPolicy final {
  std::chrono::milliseconds response_timeout{std::chrono::seconds(10)};
  bool starts_session{false};
};

[[nodiscard]] auto procedure_request_policy(const api::JsonValue& document) noexcept
    -> ProcedureRequestPolicy {
  ProcedureRequestPolicy policy;
  const auto* const actions = api::json_member(document, "actions");
  if (actions == nullptr || actions->kind != api::JsonKind::array) {
    return policy;
  }
  for (const auto& action : actions->array) {
    const auto name = api::json_string(action, "action");
    policy.starts_session =
        policy.starts_session || name == std::optional<std::string_view>{"session.start"};
    if (name != std::optional<std::string_view>{"pane.wait"}) {
      continue;
    }
    const auto timeout = std::min(
        api::json_unsigned(action, "timeout_ms").value_or(api::wait_timeout_default_milliseconds),
        static_cast<std::uint64_t>(api::wait_timeout_max_milliseconds));
    policy.response_timeout += std::chrono::milliseconds(static_cast<std::int64_t>(timeout));
  }
  return policy;
}

[[nodiscard]] auto append_public_session_selector(std::string& request,
                                                  const std::string_view session) -> bool {
  try {
    request += R"(,"session":{"name":")";
    request += session;
    request += "\"}";
    return true;
  } catch (...) {
    return false;
  }
}

template <typename Id>
// NOLINTNEXTLINE(bugprone-exception-escape)
[[nodiscard]] auto parse_public_id(const std::string_view value) noexcept -> std::optional<Id> {
  const auto separator = value.find(':');
  if (separator == std::string_view::npos || separator == 0 || separator + 1U == value.size()) {
    return std::nullopt;
  }
  std::uint32_t slot = 0;
  std::uint32_t generation = 0;
  const auto slot_text = value.substr(0, separator);
  const auto generation_text = value.substr(separator + 1U);
  const auto slot_result = std::from_chars(slot_text.begin(), slot_text.end(), slot);
  const auto generation_result =
      std::from_chars(generation_text.begin(), generation_text.end(), generation);
  return slot_result.ec == std::errc{} && slot_result.ptr == slot_text.end() &&
                 generation_result.ec == std::errc{} &&
                 generation_result.ptr == generation_text.end()
             ? Id::try_from_parts(slot, generation)
             : std::nullopt;
}

[[nodiscard]] auto append_public_id_selector(std::string& request, const std::string_view field,
                                             const auto id) -> bool {
  try {
    request += ",\"";
    request += field;
    request += R"(":{"id":")";
    request += std::to_string(id.slot());
    request += ":";
    request += std::to_string(id.generation());
    request += "\"}";
    return true;
  } catch (...) {
    return false;
  }
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
  auto endpoint = RuntimeEndpoint::create("/tmp/lemma-" + std::to_string(::getuid()) + ".sock");
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

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto run_action(const RuntimeEndpoint& endpoint, const api::Action& action, const bool start_daemon)
    -> int {
  auto concrete = action;
  if (concrete.kind == api::ActionKind::session_start &&
      (concrete.working_directory.empty() || !concrete.environment_set)) {
    std::vector<std::string_view> arguments;
    try {
      arguments.reserve(concrete.arguments.size());
      for (const auto& argument : concrete.arguments) {
        arguments.emplace_back(argument);
      }
    } catch (...) {
      return 1;
    }
    CapturedLaunchContext context;
    if (!capture_launch_context({.working_directory = concrete.working_directory,
                                 .command = arguments,
                                 .hold = concrete.hold},
                                context)) {
      return 1;
    }
    if (concrete.working_directory.empty()) {
      concrete.working_directory.assign(context.working_directory.data(),
                                        context.working_directory_size);
    }
    if (!concrete.environment_set) {
      std::size_t offset = 0;
      while (offset < context.environment_size) {
        const auto remaining =
            std::span(context.environment).first(context.environment_size).subspan(offset);
        const auto terminator = std::ranges::find(remaining, std::byte{0});
        if (terminator == remaining.end()) {
          return 1;
        }
        const auto size = static_cast<std::size_t>(std::distance(remaining.begin(), terminator));
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
        concrete.environment.emplace_back(reinterpret_cast<const char*>(remaining.data()), size);
        offset += size + 1U;
      }
      concrete.environment_set = true;
    }
  }
  const auto document = api::encode_action(concrete);
  if (!document.has_value()) {
    return 2;
  }
  if (start_daemon && !ensure_server(std::string(endpoint.socket_path()))) {
    static_cast<void>(write_text(STDERR_FILENO, "failed to start lemma daemon\n"));
    return 1;
  }
  const auto response_timeout =
      concrete.kind == api::ActionKind::pane_wait
          ? std::chrono::milliseconds(concrete.wait_timeout_milliseconds) +
                std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::seconds(10))
          : std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::seconds(10));
  auto result = invoke_public_action(endpoint, *document, response_timeout);
  if (!result.has_value()) {
    std::string unavailable = R"({"schema":"lemma.action-result/v1","action":)";
    if (!api::append_json_string(unavailable, api::action_name(concrete.kind))) {
      return 1;
    }
    unavailable += R"(,"status":"unavailable"}
)";
    static_cast<void>(write_text(STDOUT_FILENO, unavailable));
    return 1;
  }
  std::string encoded;
  if (!api::append_json_value(encoded, *result) || !write_text(STDOUT_FILENO, encoded) ||
      !write_text(STDOUT_FILENO, "\n")) {
    return 1;
  }
  const auto status = public_operation_status(*result);
  return status == OperationStatus::applied || status == OperationStatus::no_effect ? 0 : 1;
}

auto run_proc(const RuntimeEndpoint& endpoint, const std::string_view document) -> int {
  auto parsed = api::parse_json(document);
  if (!parsed.value.has_value()) {
    constexpr std::string_view error =
        R"({"schema":"lemma.proc-result/v1","ok":false,"error":{"reason":"invalid_json"},"results":[]}
)";
    static_cast<void>(write_text(STDOUT_FILENO, error));
    return 2;
  }
  std::string compact;
  if (!api::append_json_value(compact, *parsed.value)) {
    return 2;
  }
  const auto policy = procedure_request_policy(*parsed.value);
  if (policy.starts_session && !ensure_server(std::string(endpoint.socket_path()))) {
    static_cast<void>(write_text(STDERR_FILENO, "failed to start lemma daemon\n"));
    return 1;
  }
  auto result = invoke_public_action(endpoint, std::move(compact), policy.response_timeout);
  if (!result.has_value()) {
    constexpr std::string_view unavailable =
        R"({"schema":"lemma.proc-result/v1","ok":false,"error":{"reason":"unavailable"},"results":[]}
)";
    static_cast<void>(write_text(STDOUT_FILENO, unavailable));
    return 1;
  }
  std::string encoded;
  if (!api::append_json_value(encoded, *result) || !write_text(STDOUT_FILENO, encoded) ||
      !write_text(STDOUT_FILENO, "\n")) {
    return 1;
  }
  const auto ok = api::json_boolean(*result, "ok");
  const auto partial = api::json_boolean(*result, "partial").value_or(false);
  if (api::json_member(*result, "error") != nullptr && !partial) {
    return 2;
  }
  return ok.has_value() && *ok ? 0 : 1;
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
  try {
    std::string request = R"({"schema":"lemma.action/v1","action":"session.start")";
    if (session.has_value()) {
      request += R"(,"name":)";
      if (!api::append_json_string(request, *session)) {
        return {};
      }
    }
    request += R"(,"cwd":)";
    if (!api::append_json_string(request, {launch_context.working_directory.data(),
                                           launch_context.working_directory_size})) {
      return {};
    }
    if (launch_context.hold) {
      request += R"(,"hold":true)";
    }
    if (!options.command.empty()) {
      request += R"(,"argv":[)";
      for (std::size_t index = 0; index < options.command.size(); ++index) {
        if (index > 0) {
          request += ",";
        }
        if (!api::append_json_string(request,
                                     std::span(options.command).subspan(index, 1).front())) {
          return {};
        }
      }
      request += "]";
    }
    request += R"(,"environment":[)";
    std::size_t environment_offset = 0;
    std::size_t environment_index = 0;
    while (environment_offset < launch_context.environment_size) {
      const auto remaining = std::span(launch_context.environment)
                                 .first(launch_context.environment_size)
                                 .subspan(environment_offset);
      const auto terminator = std::ranges::find(remaining, std::byte{0});
      if (terminator == remaining.end()) {
        return {};
      }
      const auto size = static_cast<std::size_t>(std::distance(remaining.begin(), terminator));
      if (environment_index++ > 0) {
        request += ",";
      }
      // Environment entries are validated byte strings captured from the local POSIX process.
      // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
      const std::string_view entry(reinterpret_cast<const char*>(remaining.data()), size);
      if (!api::append_json_string(request, entry)) {
        return {};
      }
      environment_offset += size + 1U;
    }
    request += "]}";
    auto public_result = invoke_public_action(endpoint, std::move(request));
    if (public_result.has_value()) {
      const auto status = public_operation_status(*public_result);
      if (status != OperationStatus::applied) {
        if (status == OperationStatus::conflict) {
          static_cast<void>(write_text(STDERR_FILENO, "lemma session already exists\n"));
        } else if (status == OperationStatus::capacity) {
          static_cast<void>(write_text(STDERR_FILENO, "lemma session capacity reached\n"));
        }
        return {.status = status, .session = {}, .tab = {}, .pane = {}};
      }
      const auto* const session_value = api::json_member(*public_result, "session");
      const auto name = session_value == nullptr ? std::optional<std::string_view>{}
                                                 : api::json_string(*session_value, "name");
      const auto tab_text = api::json_string(*public_result, "tab");
      const auto pane_text = api::json_string(*public_result, "pane");
      const auto tab = tab_text.has_value() ? parse_public_id<TabId>(*tab_text) : std::nullopt;
      const auto pane = pane_text.has_value() ? parse_public_id<PaneId>(*pane_text) : std::nullopt;
      if (!name.has_value() || !tab.has_value() || !pane.has_value()) {
        return {};
      }
      return {.status = status, .session = std::string(*name), .tab = *tab, .pane = *pane};
    }
    return {};
  } catch (...) {
    return {};
  }
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
  std::string_view action;
  std::string_view field;
  switch (kind) {
  case QueryKind::sessions:
    action = "session.list";
    field = "sessions";
    break;
  case QueryKind::session:
    action = "session.inspect";
    field = "sessions";
    break;
  case QueryKind::tabs:
    action = "tab.list";
    field = "tabs";
    break;
  case QueryKind::panes:
    action = "pane.list";
    field = "panes";
    break;
  }
  try {
    std::string request = R"({"schema":"lemma.action/v1","action":)";
    if (!api::append_json_string(request, action) ||
        (kind != QueryKind::sessions && !append_public_session_selector(request, session))) {
      return {};
    }
    request += "}";
    auto result = invoke_public_action(endpoint, std::move(request));
    if (!result.has_value()) {
      return {};
    }
    const auto status = public_operation_status(*result);
    const auto* const value = api::json_member(*result, field);
    std::string text;
    if (status != OperationStatus::applied || value == nullptr ||
        !api::append_json_value(text, *value)) {
      return {.status = status, .text = {}};
    }
    return {.status = status, .text = std::move(text)};
  } catch (...) {
    return {};
  }
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
  try {
    std::string request = R"({"schema":"lemma.action/v1","action":)";
    if (!api::append_json_string(request,
                                 kind == SurfaceCreateKind::tab ? "tab.new" : "pane.split") ||
        !append_public_session_selector(request, session)) {
      return {};
    }
    if (kind != SurfaceCreateKind::tab) {
      if (!append_public_id_selector(request, "pane", target)) {
        return {};
      }
      request += kind == SurfaceCreateKind::split_right ? R"(,"direction":"right")"
                                                        : R"(,"direction":"down")";
    }
    if (!options.title.empty()) {
      request += R"(,"title":)";
      if (!api::append_json_string(request, options.title)) {
        return {};
      }
    }
    if (directory_size > 0) {
      request += R"(,"cwd":)";
      if (!api::append_json_string(request, {directory.data(), directory_size})) {
        return {};
      }
    }
    if (options.hold) {
      request += R"(,"hold":true)";
    }
    if (!options.command.empty()) {
      request += R"(,"argv":[)";
      for (std::size_t index = 0; index < options.command.size(); ++index) {
        if (index > 0) {
          request += ",";
        }
        if (!api::append_json_string(request,
                                     std::span(options.command).subspan(index, 1).front())) {
          return {};
        }
      }
      request += "]";
    }
    request += "}";
    auto public_result = invoke_public_action(endpoint, std::move(request));
    if (public_result.has_value()) {
      const auto status = public_operation_status(*public_result);
      const auto tab_text = api::json_string(*public_result, "tab");
      const auto pane_text = api::json_string(*public_result, "pane");
      const auto tab = tab_text.has_value() ? parse_public_id<TabId>(*tab_text) : std::nullopt;
      const auto pane = pane_text.has_value() ? parse_public_id<PaneId>(*pane_text) : std::nullopt;
      if (status != OperationStatus::applied || !tab.has_value() || !pane.has_value()) {
        return {.status = status, .session = {}, .tab = {}, .pane = {}};
      }
      return {.status = status, .session = std::string(session), .tab = *tab, .pane = *pane};
    }
    return {};
  } catch (...) {
    return {};
  }
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity,bugprone-branch-clone)
auto perform_action(const RuntimeEndpoint& endpoint, const std::string_view session,
                    const SemanticAction action, const ActionTarget target) -> OperationStatus {
  if (!validate_session(session)) {
    return OperationStatus::failed;
  }
  try {
    std::string_view name;
    switch (action) {
    case SemanticAction::tab_select:
      name = "tab.select";
      break;
    case SemanticAction::tab_move:
      name = "tab.move";
      break;
    case SemanticAction::tab_kill:
      name = "tab.kill";
      break;
    case SemanticAction::pane_focus:
      name = "pane.focus";
      break;
    case SemanticAction::pane_swap:
      name = "pane.swap";
      break;
    case SemanticAction::pane_resize_left:
    case SemanticAction::pane_resize_right:
    case SemanticAction::pane_resize_up:
    case SemanticAction::pane_resize_down:
      name = "pane.resize";
      break;
    case SemanticAction::pane_zoom_on:
    case SemanticAction::pane_zoom_off:
      name = "pane.zoom";
      break;
    case SemanticAction::pane_kill:
      name = "pane.kill";
      break;
    case SemanticAction::session_kill:
      name = "session.kill";
      break;
    }
    std::string request = R"({"schema":"lemma.action/v1","action":)";
    if (!api::append_json_string(request, name) ||
        !append_public_session_selector(request, session)) {
      return OperationStatus::failed;
    }
    if (action == SemanticAction::tab_select || action == SemanticAction::tab_move ||
        action == SemanticAction::tab_kill) {
      request += R"(,"tab":{)";
      if (target.tab.is_valid()) {
        request += R"("id":")" + std::to_string(target.tab.slot()) + ":" +
                   std::to_string(target.tab.generation()) + "\"}";
      } else {
        request += R"("position":)" + std::to_string(target.tab_position) + "}";
      }
      if (action == SemanticAction::tab_move) {
        request += R"(,"to_position":)" + std::to_string(target.value);
      }
    } else if (action != SemanticAction::session_kill) {
      if (!append_public_id_selector(request, "pane", target.pane)) {
        return OperationStatus::failed;
      }
      if (action == SemanticAction::pane_swap &&
          !append_public_id_selector(request, "other", target.peer_pane)) {
        return OperationStatus::failed;
      }
      if (action == SemanticAction::pane_resize_left ||
          action == SemanticAction::pane_resize_right || action == SemanticAction::pane_resize_up ||
          action == SemanticAction::pane_resize_down) {
        std::string_view direction = "left";
        if (action == SemanticAction::pane_resize_right) {
          direction = "right";
        } else if (action == SemanticAction::pane_resize_up) {
          direction = "up";
        } else if (action == SemanticAction::pane_resize_down) {
          direction = "down";
        }
        request += R"(,"direction":")";
        request += direction;
        request += R"(","amount":)" + std::to_string(target.value);
      } else if (action == SemanticAction::pane_zoom_on ||
                 action == SemanticAction::pane_zoom_off) {
        request +=
            action == SemanticAction::pane_zoom_on ? R"(,"enabled":true)" : R"(,"enabled":false)";
      }
    }
    request += "}";
    const auto result = invoke_public_action(endpoint, std::move(request));
    return result.has_value() ? public_operation_status(*result) : OperationStatus::failed;
  } catch (...) {
    return OperationStatus::failed;
  }
}

auto send_pane(const RuntimeEndpoint& endpoint, const std::string_view session, const PaneId pane,
               const std::string_view text) -> OperationStatus {
  if (!validate_session(session) || !pane.is_valid() || text.empty() ||
      text.size() > protocol::control_payload_bytes_max - protocol::control_id_bytes) {
    return OperationStatus::failed;
  }
  try {
    std::string request = R"({"schema":"lemma.action/v1","action":"pane.send")";
    if (!append_public_session_selector(request, session) ||
        !append_public_id_selector(request, "pane", pane)) {
      return OperationStatus::failed;
    }
    request += R"(,"text":)";
    if (!api::append_json_string(request, text)) {
      return OperationStatus::failed;
    }
    request += "}";
    const auto result = invoke_public_action(endpoint, std::move(request));
    return result.has_value() ? public_operation_status(*result) : OperationStatus::failed;
  } catch (...) {
    return OperationStatus::failed;
  }
}

auto capture_pane(const RuntimeEndpoint& endpoint, const std::string_view session,
                  const PaneId pane) -> std::pair<OperationStatus, std::string> {
  if (!validate_session(session) || !pane.is_valid()) {
    return {OperationStatus::failed, {}};
  }
  try {
    std::string request = R"({"schema":"lemma.action/v1","action":"pane.capture")";
    if (!append_public_session_selector(request, session) ||
        !append_public_id_selector(request, "pane", pane)) {
      return {OperationStatus::failed, {}};
    }
    request += "}";
    auto result = invoke_public_action(endpoint, std::move(request));
    if (!result.has_value()) {
      return {OperationStatus::failed, {}};
    }
    const auto status = public_operation_status(*result);
    const auto* const capture = api::json_member(*result, "capture");
    const auto text = capture != nullptr && capture->kind == api::JsonKind::object
                          ? api::json_string(*capture, "text")
                          : api::json_string(*result, "text");
    return status == OperationStatus::applied && text.has_value()
               ? std::pair{status, std::string(*text)}
               : std::pair{status, std::string{}};
  } catch (...) {
    return {OperationStatus::failed, {}};
  }
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

auto events(const RuntimeEndpoint& endpoint, const std::optional<std::string_view> session,
            const std::span<const PaneId> panes, const bool screen) -> int {
  const auto request = event_request(session, panes, screen);
  if (!request.has_value()) {
    return 2;
  }
  int connection = open_server_connection(endpoint);
  if (connection < 0 ||
      !send_all(connection, std::as_bytes(std::span(request->data(), request->size())))) {
    close_descriptor(connection);
    return 1;
  }
  std::array<std::byte, std::size_t{16} * 1'024U> buffer{};
  while (true) {
    const auto received = ::recv(connection, buffer.data(), buffer.size(), 0);
    if (received > 0) {
      if (!write_all(STDOUT_FILENO, std::span(buffer).first(static_cast<std::size_t>(received)))) {
        close_descriptor(connection);
        return 1;
      }
      continue;
    }
    if (received < 0 && errno == EINTR) {
      continue;
    }
    close_descriptor(connection);
    return received == 0 ? 0 : 1;
  }
}

auto rename_session_status(const RuntimeEndpoint& endpoint, const std::string_view session,
                           const std::string_view new_name) -> OperationStatus {
  if (!valid_session_name(session) || !valid_session_name(new_name)) {
    return OperationStatus::failed;
  }
  try {
    std::string request = R"({"schema":"lemma.action/v1","action":"session.rename")";
    if (!append_public_session_selector(request, session)) {
      return OperationStatus::failed;
    }
    request += R"(,"name":)";
    if (!api::append_json_string(request, new_name)) {
      return OperationStatus::failed;
    }
    request += "}";
    const auto result = invoke_public_action(endpoint, std::move(request));
    return result.has_value() ? public_operation_status(*result) : OperationStatus::failed;
  } catch (...) {
    return OperationStatus::failed;
  }
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
  try {
    std::string request = R"({"schema":"lemma.action/v1","action":"tab.rename")";
    if (!append_public_session_selector(request, session)) {
      return OperationStatus::failed;
    }
    request += R"(,"tab":{"position":)" + std::to_string(one_based_position) + R"(},"title":)";
    if (!api::append_json_string(request, title)) {
      return OperationStatus::failed;
    }
    request += "}";
    const auto result = invoke_public_action(endpoint, std::move(request));
    return result.has_value() ? public_operation_status(*result) : OperationStatus::failed;
  } catch (...) {
    return OperationStatus::failed;
  }
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
  if (!validate_session(session)) {
    return 1;
  }
  const auto status = perform_action(endpoint, session, SemanticAction::session_kill, {});
  if (status == OperationStatus::applied || status == OperationStatus::no_effect) {
    const auto message = "lemma session \"" + std::string(session) + "\" stopped\n";
    return write_text(STDOUT_FILENO, message) ? 0 : 1;
  }
  static_cast<void>(write_text(STDERR_FILENO, status == OperationStatus::missing
                                                  ? "no lemma session\n"
                                                  : "lemma operation failed\n"));
  return 1;
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
