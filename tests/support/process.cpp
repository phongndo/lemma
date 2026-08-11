#include "process.hpp"

#include "platform/io.hpp"

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
#include <limits>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <thread>
#include <utility>
#include <vector>

#include <fcntl.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#ifdef __APPLE__
#include <util.h>
#elifdef __linux__
#include <pty.h>
#else
#error "lemma process tests require forkpty"
#endif

namespace lemma::test {
namespace {

constexpr std::size_t output_tail_bytes_max = std::size_t{64} * 1'024U;

void retain_tail(std::string& destination, const std::span<const char> bytes) noexcept {
  try {
    if (bytes.size() >= output_tail_bytes_max) {
      destination.assign(bytes.end() - static_cast<std::ptrdiff_t>(output_tail_bytes_max),
                         bytes.end());
      return;
    }
    if (destination.size() + bytes.size() > output_tail_bytes_max) {
      destination.erase(0, destination.size() + bytes.size() - output_tail_bytes_max);
    }
    destination.append(bytes.data(), bytes.size());
  } catch (...) {
    destination.clear();
  }
}

[[nodiscard]] auto pointer_vector(std::vector<std::string>& values) -> std::vector<char*> {
  std::vector<char*> pointers;
  pointers.reserve(values.size() + 1U);
  for (auto& value : values) {
    pointers.push_back(value.data());
  }
  pointers.push_back(nullptr);
  return pointers;
}

class PreparedExec final {
public:
  PreparedExec(const std::vector<std::string>& arguments,
               const std::vector<std::string>& environment)
      : arguments_(arguments), environment_(environment),
        argument_pointers_(pointer_vector(arguments_)),
        environment_pointers_(pointer_vector(environment_)) {}

  [[nodiscard]] auto executable() const noexcept -> char* { return argument_pointers_.front(); }
  [[nodiscard]] auto arguments() const noexcept -> char* const* {
    return argument_pointers_.data();
  }
  [[nodiscard]] auto environment() const noexcept -> char* const* {
    return environment_pointers_.data();
  }

private:
  std::vector<std::string> arguments_;
  std::vector<std::string> environment_;
  std::vector<char*> argument_pointers_;
  std::vector<char*> environment_pointers_;
};

[[nodiscard]] auto byte_characters(const std::span<const std::byte> bytes) noexcept
    -> std::span<const char> {
  // Byte and character storage have the same object representation.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  return {reinterpret_cast<const char*>(bytes.data()), bytes.size()};
}

void exec_child(const PreparedExec& prepared) noexcept {
  sigset_t unblocked{};
  if (sigemptyset(&unblocked) != 0 || ::sigprocmask(SIG_SETMASK, &unblocked, nullptr) != 0) {
    ::_exit(127);
  }
  ::execve(prepared.executable(), prepared.arguments(), prepared.environment());
  ::_exit(127);
}

[[nodiscard]] auto milliseconds_until(const Deadline deadline) noexcept -> int {
  const auto now = std::chrono::steady_clock::now();
  if (now >= deadline) {
    return 0;
  }
  const auto remaining =
      std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
  return static_cast<int>(std::clamp(remaining, std::int64_t{1}, std::int64_t{20}));
}

} // namespace

TemporaryRuntime::TemporaryRuntime() {
  std::array<char, 64> pattern{};
  constexpr std::string_view value = "/tmp/lemma-e2e-XXXXXX";
  std::ranges::copy(value, pattern.begin());
  char* const created = ::mkdtemp(pattern.data());
  if (created == nullptr) {
    return;
  }
  struct stat information{};
  if (::stat(created, &information) != 0 || information.st_uid != ::getuid() ||
      (information.st_mode & 0777) != 0700) {
    static_cast<void>(::rmdir(created));
    return;
  }
  directory_ = created;
  socket_path_ = directory_ + "/daemon.sock";
  lock_path_ = socket_path_ + ".lock";
  home_path_ = directory_ + "/home";
  config_path_ = directory_ + "/config";
  zdot_path_ = directory_ + "/zdot";
  static_cast<void>(::mkdir(home_path_.c_str(), 0700));
  static_cast<void>(::mkdir(config_path_.c_str(), 0700));
  static_cast<void>(::mkdir(zdot_path_.c_str(), 0700));
}

TemporaryRuntime::~TemporaryRuntime() {
  if (directory_.empty()) {
    return;
  }
  for (const auto& path : owned_paths_) {
    static_cast<void>(::unlink(path.c_str()));
  }
  static_cast<void>(::unlink(socket_path_.c_str()));
  static_cast<void>(::unlink(lock_path_.c_str()));
  static_cast<void>(::rmdir(home_path_.c_str()));
  static_cast<void>(::rmdir(config_path_.c_str()));
  static_cast<void>(::rmdir(zdot_path_.c_str()));
  static_cast<void>(::rmdir(directory_.c_str()));
}

[[nodiscard]] auto TemporaryRuntime::environment() const -> std::vector<std::string> {
  std::vector<std::string> environment{
      "HOME=" + home_path_,
      "XDG_CONFIG_HOME=" + config_path_,
      "ZDOTDIR=" + zdot_path_,
      "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
      "TERM=xterm-256color",
      "LANG=C",
      "LC_ALL=C",
      "TMPDIR=" + directory_,
  };
  if (const char* const options = std::getenv("ASAN_OPTIONS"); options != nullptr) {
    environment.emplace_back("ASAN_OPTIONS=" + std::string(options));
  }
  if (const char* const options = std::getenv("UBSAN_OPTIONS"); options != nullptr) {
    environment.emplace_back("UBSAN_OPTIONS=" + std::string(options));
  }
  return environment;
}

[[nodiscard]] auto TemporaryRuntime::owned_path(const std::string_view name) -> std::string {
  if (name.empty() || name.contains('/')) {
    return {};
  }
  auto path = directory_ + "/" + std::string(name);
  owned_paths_.push_back(path);
  return path;
}

ChildProcess::~ChildProcess() { terminate(); }

[[nodiscard]] auto ChildProcess::spawn(const std::vector<std::string>& arguments,
                                       const std::vector<std::string>& environment) -> bool {
  if (running() || arguments.empty()) {
    return false;
  }
  const PreparedExec prepared(arguments, environment);
  std::array<int, 2> output{};
  if (::pipe(output.data()) != 0) {
    return false;
  }
  const auto child = ::fork();
  if (child < 0) {
    static_cast<void>(::close(output.front()));
    static_cast<void>(::close(output.back()));
    return false;
  }
  if (child == 0) {
    static_cast<void>(::setpgid(0, 0));
    static_cast<void>(::close(output.front()));
    static_cast<void>(::dup2(output.back(), STDOUT_FILENO));
    static_cast<void>(::dup2(output.back(), STDERR_FILENO));
    if (output.back() > STDERR_FILENO) {
      static_cast<void>(::close(output.back()));
    }
    exec_child(prepared);
  }
  static_cast<void>(::close(output.back()));
  static_cast<void>(::setpgid(child, child));
  process_ = child;
  output_descriptor_ = output.front();
  status_ = -1;
  if (!platform::set_nonblocking(output_descriptor_)) {
    terminate();
    return false;
  }
  return true;
}

void ChildProcess::drain_output() noexcept {
  if (output_descriptor_ < 0) {
    return;
  }
  std::array<char, 4'096> buffer{};
  while (true) {
    const auto received = ::read(output_descriptor_, buffer.data(), buffer.size());
    if (received > 0) {
      retain_tail(output_tail_, std::span(buffer).first(static_cast<std::size_t>(received)));
      continue;
    }
    if (received < 0 && errno == EINTR) {
      continue;
    }
    if (received == 0) {
      platform::close_descriptor(output_descriptor_);
    }
    return;
  }
}

[[nodiscard]] auto ChildProcess::wait(const Deadline deadline) -> bool {
  while (running()) {
    drain_output();
    int status = 0;
    const auto result = ::waitpid(process_, &status, WNOHANG);
    if (result == process_) {
      status_ = status;
      process_ = -1;
      drain_output();
      return true;
    }
    if (result < 0 && errno != EINTR) {
      process_ = -1;
      return false;
    }
    if (std::chrono::steady_clock::now() >= deadline) {
      return false;
    }
    pollfd descriptor{.fd = output_descriptor_, .events = POLLIN, .revents = 0};
    static_cast<void>(
        ::poll(&descriptor, output_descriptor_ >= 0 ? 1U : 0U, milliseconds_until(deadline)));
  }
  return true;
}

void ChildProcess::signal_group(const int signal_number) const noexcept {
  if (process_ > 0) {
    static_cast<void>(::kill(-process_, signal_number));
    static_cast<void>(::kill(process_, signal_number));
  }
}

void ChildProcess::terminate() noexcept {
  if (running()) {
    signal_group(SIGTERM);
    if (!wait(deadline_after(std::chrono::seconds(5)))) {
      signal_group(SIGKILL);
      static_cast<void>(wait(deadline_after(std::chrono::milliseconds(250))));
    }
  }
  platform::close_descriptor(output_descriptor_);
}

[[nodiscard]] auto ChildProcess::output() -> std::string {
  drain_output();
  return output_tail_;
}

RawPeer::~RawPeer() { close(); }

// Connection setup keeps retry and asynchronous completion failures explicit.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto RawPeer::connect(const std::string_view socket_path,
                                    const Deadline deadline) noexcept -> bool {
  if (connected() || socket_path.empty()) {
    last_error_ = EINVAL;
    return false;
  }
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  if (socket_path.size() >= sizeof(address.sun_path)) {
    last_error_ = ENAMETOOLONG;
    return false;
  }
  std::memcpy(std::span(address.sun_path).data(), socket_path.data(), socket_path.size());
  while (std::chrono::steady_clock::now() < deadline) {
    descriptor_ = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (descriptor_ < 0) {
      last_error_ = errno;
      return false;
    }
    if (!platform::set_nonblocking(descriptor_)) {
      last_error_ = errno;
      close();
      return false;
    }
    // The socket ABI intentionally erases the concrete address type.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    const auto* generic = reinterpret_cast<const sockaddr*>(&address);
    if (::connect(descriptor_, generic, sizeof(address)) == 0) {
      return true;
    }

    auto connection_error = errno;
    if (connection_error == EAGAIN || connection_error == EWOULDBLOCK) {
      // Linux AF_UNIX reports a full listen backlog as EAGAIN without starting an asynchronous
      // connection. SO_ERROR can still read as zero, so polling this descriptor would produce a
      // false success followed by ENOTCONN on the first send. Retry with a fresh socket instead.
      last_error_ = connection_error;
      close();
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      continue;
    }
    if (connection_error == EINPROGRESS || connection_error == EALREADY ||
        connection_error == EINTR) {
      while (std::chrono::steady_clock::now() < deadline) {
        pollfd event{.fd = descriptor_, .events = POLLOUT, .revents = 0};
        const auto polled = ::poll(&event, 1, milliseconds_until(deadline));
        if (polled < 0 && errno == EINTR) {
          continue;
        }
        if (polled < 0) {
          last_error_ = errno;
          close();
          return false;
        }
        if (polled == 0) {
          continue;
        }
        int socket_error = 0;
        auto socket_error_size = static_cast<socklen_t>(sizeof(socket_error));
        const auto option_status =
            ::getsockopt(descriptor_, SOL_SOCKET, SO_ERROR, &socket_error, &socket_error_size);
        if (option_status != 0) {
          last_error_ = errno;
          close();
          return false;
        }
        if (socket_error == 0) {
          return true;
        }
        connection_error = socket_error;
        break;
      }
      if (std::chrono::steady_clock::now() >= deadline) {
        close();
        last_error_ = ETIMEDOUT;
        return false;
      }
    }

    last_error_ = connection_error;
    close();
    if (last_error_ != ENOENT && last_error_ != ECONNREFUSED) {
      return false;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  last_error_ = ETIMEDOUT;
  return false;
}

[[nodiscard]] auto RawPeer::set_receive_buffer(const int bytes) noexcept -> bool {
  if (!connected() || bytes <= 0) {
    last_error_ = EINVAL;
    return false;
  }
  if (::setsockopt(descriptor_, SOL_SOCKET, SO_RCVBUF, &bytes,
                   static_cast<socklen_t>(sizeof(bytes))) != 0) {
    last_error_ = errno;
    return false;
  }
  return true;
}

[[nodiscard]] auto RawPeer::send_available(const std::span<const std::byte> bytes,
                                           std::size_t& consumed) noexcept -> bool {
  consumed = 0;
  while (consumed < bytes.size()) {
    const auto sent =
        ::send(descriptor_, bytes.subspan(consumed).data(), bytes.size() - consumed, MSG_NOSIGNAL);
    if (sent > 0) {
      consumed += static_cast<std::size_t>(sent);
      continue;
    }
    if (sent < 0 && errno == EINTR) {
      continue;
    }
    if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      last_error_ = errno;
      return true;
    }
    last_error_ = sent == 0 ? EPIPE : errno;
    return false;
  }
  return true;
}

[[nodiscard]] auto RawPeer::send(const std::span<const std::byte> bytes,
                                 const Deadline deadline) noexcept -> bool {
  std::size_t offset = 0;
  while (offset < bytes.size() && std::chrono::steady_clock::now() < deadline) {
    std::size_t sent = 0;
    if (!send_available(bytes.subspan(offset), sent)) {
      return false;
    }
    offset += sent;
    if (offset == bytes.size()) {
      return true;
    }
    pollfd event{.fd = descriptor_, .events = POLLOUT, .revents = 0};
    const auto polled = ::poll(&event, 1, milliseconds_until(deadline));
    if (polled < 0 && errno != EINTR) {
      last_error_ = errno;
      return false;
    }
  }
  last_error_ = ETIMEDOUT;
  return false;
}

[[nodiscard]] auto RawPeer::send(const std::string_view text, const Deadline deadline) noexcept
    -> bool {
  return send(std::as_bytes(std::span(text.data(), text.size())), deadline);
}

[[nodiscard]] auto RawPeer::send_fragments(const std::span<const std::byte> bytes,
                                           const std::size_t fragment_bytes,
                                           const Deadline deadline) noexcept -> bool {
  if (fragment_bytes == 0) {
    last_error_ = EINVAL;
    return false;
  }
  for (std::size_t offset = 0; offset < bytes.size(); offset += fragment_bytes) {
    const auto size = std::min(fragment_bytes, bytes.size() - offset);
    if (!send(bytes.subspan(offset, size), deadline)) {
      return false;
    }
  }
  return true;
}

void RawPeer::retain_received(const std::span<const std::byte> bytes) noexcept {
  retain_tail(received_tail_, byte_characters(bytes));
}

[[nodiscard]] auto RawPeer::read_some(const std::span<std::byte> output,
                                      const Deadline deadline) noexcept -> std::ptrdiff_t {
  if (!connected() || output.empty()) {
    last_error_ = EINVAL;
    return -1;
  }
  while (std::chrono::steady_clock::now() < deadline) {
    const auto received = ::recv(descriptor_, output.data(), output.size(), 0);
    if (received > 0) {
      const auto size = static_cast<std::size_t>(received);
      retain_received(output.first(size));
      return received;
    }
    if (received == 0) {
      return 0;
    }
    if (errno == EINTR) {
      continue;
    }
    if (errno != EAGAIN && errno != EWOULDBLOCK) {
      last_error_ = errno;
      return -1;
    }
    pollfd event{.fd = descriptor_, .events = POLLIN, .revents = 0};
    const auto polled = ::poll(&event, 1, milliseconds_until(deadline));
    if (polled < 0 && errno != EINTR) {
      last_error_ = errno;
      return -1;
    }
  }
  last_error_ = ETIMEDOUT;
  return -1;
}

[[nodiscard]] auto RawPeer::read_until_close(const std::size_t maximum, const Deadline deadline)
    -> std::optional<std::string> {
  std::string output;
  while (std::chrono::steady_clock::now() < deadline) {
    std::array<std::byte, 4'096> bytes{};
    const auto received = read_some(bytes, deadline);
    if (received == 0) {
      return output;
    }
    if (received < 0) {
      return std::nullopt;
    }
    const auto size = static_cast<std::size_t>(received);
    if (size > maximum - std::min(maximum, output.size())) {
      last_error_ = EMSGSIZE;
      return std::nullopt;
    }
    const auto characters = byte_characters(std::span(bytes).first(size));
    output.append(characters.data(), characters.size());
  }
  last_error_ = ETIMEDOUT;
  return std::nullopt;
}

[[nodiscard]] auto RawPeer::wait_for_byte(const std::byte expected,
                                          const Deadline deadline) noexcept -> bool {
  std::array<std::byte, 1> value{};
  return read_some(value, deadline) == 1 && value.front() == expected;
}

[[nodiscard]] auto RawPeer::wait_for_close(const Deadline deadline) noexcept -> bool {
  std::array<std::byte, 4'096> bytes{};
  while (std::chrono::steady_clock::now() < deadline) {
    const auto received = read_some(bytes, deadline);
    if (received == 0) {
      return true;
    }
    if (received < 0) {
      return false;
    }
  }
  last_error_ = ETIMEDOUT;
  return false;
}

void RawPeer::close() noexcept { platform::close_descriptor(descriptor_); }

namespace {

[[nodiscard]] auto parse_unsigned(const std::string_view text, std::size_t& offset)
    -> std::optional<std::uint64_t> {
  if (offset >= text.size()) {
    return std::nullopt;
  }
  std::uint64_t value = 0;
  const auto remaining = std::span(text).subspan(offset);
  const auto result = std::from_chars(remaining.data(), std::to_address(remaining.end()), value);
  if (result.ec != std::errc{}) {
    return std::nullopt;
  }
  offset = static_cast<std::size_t>(result.ptr - text.data());
  return value;
}

[[nodiscard]] auto consume_text(std::string_view text, std::size_t& offset,
                                const std::string_view expected) noexcept -> bool {
  if (offset > text.size()) {
    return false;
  }
  text.remove_prefix(offset);
  if (!text.starts_with(expected)) {
    return false;
  }
  offset += expected.size();
  return true;
}

[[nodiscard]] auto parse_tab_listing(const std::string_view line) -> std::optional<TabListing> {
  constexpr std::string_view prefix = "lemma tab ";
  if (!line.starts_with(prefix)) {
    return std::nullopt;
  }
  std::size_t offset = prefix.size();
  const auto number = parse_unsigned(line, offset);
  if (!number.has_value() || !consume_text(line, offset, ": ")) {
    return std::nullopt;
  }
  const auto panes = parse_unsigned(line, offset);
  if (!panes.has_value() || !consume_text(line, offset, " pane(s), ")) {
    return std::nullopt;
  }
  const auto status = line.substr(offset);
  const bool active = status.starts_with("active, title \"");
  if ((!active && !status.starts_with("inactive, title \"")) ||
      *number > std::numeric_limits<std::size_t>::max() ||
      *panes > std::numeric_limits<std::size_t>::max()) {
    return std::nullopt;
  }
  return TabListing{
      .number = static_cast<std::size_t>(*number),
      .panes = static_cast<std::size_t>(*panes),
      .active = active,
  };
}

} // namespace

[[nodiscard]] auto parse_session_listing(const std::string_view output)
    -> std::optional<SessionListing> {
  const auto prefix = output.find(": ");
  if (prefix == std::string_view::npos) {
    return std::nullopt;
  }
  std::size_t offset = prefix + 2U;
  const auto tabs = parse_unsigned(output, offset);
  if (!tabs.has_value() || !consume_text(output, offset, " tab(s), ")) {
    return std::nullopt;
  }
  const auto panes = parse_unsigned(output, offset);
  if (!panes.has_value() || !consume_text(output, offset, " pane(s), focused pid ")) {
    return std::nullopt;
  }
  const auto focused_pid = parse_unsigned(output, offset);
  if (!focused_pid.has_value()) {
    return std::nullopt;
  }
  bool attached = false;
  if (consume_text(output, offset, ", attached, ")) {
    attached = true;
  } else if (!consume_text(output, offset, ", detached, ")) {
    return std::nullopt;
  }
  const auto columns = parse_unsigned(output, offset);
  if (!columns.has_value() || !consume_text(output, offset, "x")) {
    return std::nullopt;
  }
  const auto rows = parse_unsigned(output, offset);
  if (!rows.has_value() || *tabs > std::numeric_limits<std::size_t>::max() ||
      *panes > std::numeric_limits<std::size_t>::max() ||
      *focused_pid > static_cast<std::uint64_t>(std::numeric_limits<pid_t>::max()) ||
      *columns > std::numeric_limits<std::uint16_t>::max() ||
      *rows > std::numeric_limits<std::uint16_t>::max()) {
    return std::nullopt;
  }
  return SessionListing{
      .tabs = static_cast<std::size_t>(*tabs),
      .panes = static_cast<std::size_t>(*panes),
      .focused_pid = static_cast<pid_t>(*focused_pid),
      .columns = static_cast<std::uint16_t>(*columns),
      .rows = static_cast<std::uint16_t>(*rows),
      .attached = attached,
  };
}

[[nodiscard]] auto parse_tab_listings(const std::string_view output) -> std::vector<TabListing> {
  std::vector<TabListing> listings;
  std::size_t line_start = 0;
  while (line_start < output.size()) {
    const auto line_end = output.find('\n', line_start);
    const auto line =
        output.substr(line_start, line_end == std::string_view::npos ? output.size() - line_start
                                                                     : line_end - line_start);
    const auto parsed = parse_tab_listing(line);
    if (parsed.has_value()) {
      listings.push_back(parsed.value_or(TabListing{}));
    }
    if (line_end == std::string_view::npos) {
      break;
    }
    line_start = line_end + 1U;
  }
  return listings;
}

PtyClient::PtyClient() {
  auto created = vt::Terminal::create({});
  if (created.has_value()) {
    terminal_.emplace(std::move(*created));
  }
}

PtyClient::~PtyClient() { terminate(); }

[[nodiscard]] auto PtyClient::spawn(const std::vector<std::string>& arguments,
                                    const std::vector<std::string>& environment,
                                    const std::uint16_t columns, const std::uint16_t rows) -> bool {
  if (process_ > 0 || arguments.empty() || !terminal_.has_value()) {
    return false;
  }
  const PreparedExec prepared(arguments, environment);
  winsize size{.ws_row = rows, .ws_col = columns, .ws_xpixel = 0, .ws_ypixel = 0};
  std::array<int, 2> descriptors{};
  if (::openpty(&descriptors.front(), &descriptors.back(), nullptr, nullptr, &size) != 0) {
    return false;
  }
  initial_terminal_state_valid_ = ::tcgetattr(descriptors.back(), &initial_terminal_state_) == 0;
  const auto child = ::fork();
  if (child < 0) {
    static_cast<void>(::close(descriptors.front()));
    static_cast<void>(::close(descriptors.back()));
    return false;
  }
  if (child == 0) {
    static_cast<void>(::close(descriptors.front()));
    // ioctl is variadic because its third argument depends on the request.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    if (::setsid() < 0 || ::ioctl(descriptors.back(), TIOCSCTTY, nullptr) < 0 ||
        ::tcsetpgrp(descriptors.back(), ::getpid()) < 0) {
      ::_exit(127);
    }
    static_cast<void>(::dup2(descriptors.back(), STDIN_FILENO));
    static_cast<void>(::dup2(descriptors.back(), STDOUT_FILENO));
    static_cast<void>(::dup2(descriptors.back(), STDERR_FILENO));
    if (descriptors.back() > STDERR_FILENO) {
      static_cast<void>(::close(descriptors.back()));
    }
    exec_child(prepared);
  }
  static_cast<void>(::close(descriptors.back()));
  master_ = descriptors.front();
  process_ = child;
  status_ = -1;
  if (!platform::set_nonblocking(master_)) {
    terminate();
    return false;
  }
  return terminal_->resize({.columns = columns, .rows = rows}).has_value();
}

[[nodiscard]] auto PtyClient::send_available(const std::span<const std::byte> bytes,
                                             std::size_t& consumed) const noexcept -> bool {
  consumed = 0;
  while (consumed < bytes.size()) {
    const auto written = ::write(master_, bytes.subspan(consumed).data(), bytes.size() - consumed);
    if (written > 0) {
      consumed += static_cast<std::size_t>(written);
      continue;
    }
    if (written < 0 && errno == EINTR) {
      continue;
    }
    return written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK);
  }
  return true;
}

[[nodiscard]] auto PtyClient::send(const std::span<const std::byte> bytes,
                                   const Deadline deadline) noexcept -> bool {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    std::size_t written = 0;
    if (!send_available(bytes.subspan(offset), written)) {
      return false;
    }
    offset += written;
    if (offset == bytes.size()) {
      return true;
    }
    pollfd descriptor{.fd = master_, .events = POLLOUT, .revents = 0};
    if (::poll(&descriptor, 1, milliseconds_until(deadline)) < 0 && errno != EINTR) {
      return false;
    }
    if (std::chrono::steady_clock::now() >= deadline) {
      return false;
    }
  }
  return true;
}

[[nodiscard]] auto PtyClient::send(const std::string_view text, const Deadline deadline) noexcept
    -> bool {
  return send(std::as_bytes(std::span(text.data(), text.size())), deadline);
}

[[nodiscard]] auto PtyClient::resize(const std::uint16_t columns, const std::uint16_t rows) noexcept
    -> bool {
  winsize size{.ws_row = rows, .ws_col = columns, .ws_xpixel = 0, .ws_ypixel = 0};
  // ioctl is variadic because its third argument depends on the request.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  if (::ioctl(master_, TIOCSWINSZ, &size) != 0) {
    return false;
  }
  winsize actual{};
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  if (::ioctl(master_, TIOCGWINSZ, &actual) != 0 || actual.ws_col != columns ||
      actual.ws_row != rows) {
    return false;
  }
  // forkpty makes the child the foreground process-group leader. Signal the whole group so the
  // attached client observes the resize on platforms that do not notify for a master-side ioctl.
  const bool group_signaled = ::kill(-process_, SIGWINCH) == 0;
  const bool process_signaled = ::kill(process_, SIGWINCH) == 0;
  return (group_signaled || process_signaled) && terminal_.has_value() &&
         terminal_->resize({.columns = columns, .rows = rows}).has_value();
}

void PtyClient::pump(const Deadline deadline) noexcept {
  if (master_ < 0 || !terminal_.has_value()) {
    return;
  }
  pollfd descriptor{.fd = master_, .events = POLLIN, .revents = 0};
  if (::poll(&descriptor, 1, milliseconds_until(deadline)) <= 0) {
    return;
  }
  std::array<std::byte, std::size_t{64} * 1'024U> buffer{};
  while (true) {
    const auto received = ::read(master_, buffer.data(), buffer.size());
    if (received > 0) {
      const auto bytes = std::span(buffer).first(static_cast<std::size_t>(received));
      terminal_->write(bytes);
      retain_tail(raw_tail_, byte_characters(bytes));
      continue;
    }
    if (received < 0 && errno == EINTR) {
      continue;
    }
    return;
  }
}

[[nodiscard]] auto PtyClient::screen() -> std::string {
  if (!terminal_.has_value()) {
    return {};
  }
  std::array<std::byte, std::size_t{64} * 1'024U> output{};
  const auto size = terminal_->format_screen(vt::ScreenFormat::plain, output);
  if (!size.has_value()) {
    return {};
  }
  const auto characters = byte_characters(std::span(output).first(*size));
  return {characters.data(), characters.size()};
}

[[nodiscard]] auto PtyClient::terminal_state_restored() const noexcept -> bool {
  termios current{};
  if (!initial_terminal_state_valid_ || master_ < 0 || ::tcgetattr(master_, &current) != 0) {
    return false;
  }
  return current.c_iflag == initial_terminal_state_.c_iflag &&
         current.c_oflag == initial_terminal_state_.c_oflag &&
         current.c_cflag == initial_terminal_state_.c_cflag &&
         current.c_lflag == initial_terminal_state_.c_lflag &&
         std::ranges::equal(current.c_cc, initial_terminal_state_.c_cc);
}

[[nodiscard]] auto PtyClient::wait_for_screen(const std::string_view text, const Deadline deadline)
    -> bool {
  while (std::chrono::steady_clock::now() < deadline) {
    pump(std::min(deadline, deadline_after(std::chrono::milliseconds(20))));
    if (screen().contains(text)) {
      return true;
    }
  }
  return false;
}

[[nodiscard]] auto PtyClient::wait_for_raw(const std::string_view text, const Deadline deadline)
    -> bool {
  while (std::chrono::steady_clock::now() < deadline) {
    pump(std::min(deadline, deadline_after(std::chrono::milliseconds(20))));
    if (raw_tail_.contains(text)) {
      return true;
    }
  }
  return false;
}

void PtyClient::drain(const Deadline deadline) noexcept { pump(deadline); }

[[nodiscard]] auto PtyClient::wait(const Deadline deadline) -> bool {
  while (process_ > 0) {
    pump(std::min(deadline, deadline_after(std::chrono::milliseconds(20))));
    int status = 0;
    const auto result = ::waitpid(process_, &status, WNOHANG);
    if (result == process_) {
      status_ = status;
      process_ = -1;
      return true;
    }
    if (result < 0 && errno != EINTR) {
      process_ = -1;
      return false;
    }
    if (std::chrono::steady_clock::now() >= deadline) {
      return false;
    }
  }
  return true;
}

void PtyClient::signal_group(const int signal_number) const noexcept {
  if (process_ > 0) {
    static_cast<void>(::kill(-process_, signal_number));
    static_cast<void>(::kill(process_, signal_number));
  }
}

[[nodiscard]] auto PtyClient::send_signal(const int signal_number) const noexcept -> bool {
  if (process_ <= 0 || signal_number <= 0) {
    return false;
  }
  const bool group_signaled = ::kill(-process_, signal_number) == 0;
  const bool process_signaled = ::kill(process_, signal_number) == 0;
  return group_signaled || process_signaled;
}

void PtyClient::terminate() noexcept {
  if (process_ > 0) {
    signal_group(SIGTERM);
    if (!wait(deadline_after(std::chrono::milliseconds(250)))) {
      signal_group(SIGKILL);
      static_cast<void>(wait(deadline_after(std::chrono::milliseconds(250))));
    }
  }
  platform::close_descriptor(master_);
}

[[nodiscard]] auto deadline_after(const std::chrono::milliseconds duration) noexcept -> Deadline {
  return std::chrono::steady_clock::now() + duration;
}

[[nodiscard]] auto wait_for_endpoint(const std::string_view socket_path,
                                     const Deadline deadline) noexcept -> bool {
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  if (socket_path.size() >= sizeof(address.sun_path)) {
    return false;
  }
  std::memcpy(std::span(address.sun_path).data(), socket_path.data(), socket_path.size());
  while (std::chrono::steady_clock::now() < deadline) {
    int descriptor = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (descriptor >= 0) {
      // The socket ABI intentionally erases the concrete address type.
      // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
      const auto* generic = reinterpret_cast<const sockaddr*>(&address);
      const bool connected = ::connect(descriptor, generic, sizeof(address)) == 0;
      static_cast<void>(::close(descriptor));
      if (connected) {
        return true;
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  return false;
}

} // namespace lemma::test
