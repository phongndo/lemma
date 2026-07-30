#include "process.hpp"

#include "platform/io.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <cstring>
#include <span>
#include <string>
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
#error "fiber process tests require forkpty"
#endif

namespace fiber::test {
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
  constexpr std::string_view value = "/tmp/fiber-e2e-XXXXXX";
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
  static_cast<void>(::unlink(socket_path_.c_str()));
  static_cast<void>(::unlink(lock_path_.c_str()));
  static_cast<void>(::rmdir(home_path_.c_str()));
  static_cast<void>(::rmdir(config_path_.c_str()));
  static_cast<void>(::rmdir(zdot_path_.c_str()));
  static_cast<void>(::rmdir(directory_.c_str()));
}

[[nodiscard]] auto TemporaryRuntime::environment() const -> std::vector<std::string> {
  return {
      "HOME=" + home_path_,
      "XDG_CONFIG_HOME=" + config_path_,
      "ZDOTDIR=" + zdot_path_,
      "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
      "TERM=xterm-256color",
      "LANG=C",
      "LC_ALL=C",
      "TMPDIR=" + directory_,
  };
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
    if (!wait(deadline_after(std::chrono::milliseconds(250)))) {
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

[[nodiscard]] auto PtyClient::send(const std::span<const std::byte> bytes,
                                   const Deadline deadline) noexcept -> bool {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const auto written = ::write(master_, bytes.subspan(offset).data(), bytes.size() - offset);
    if (written > 0) {
      offset += static_cast<std::size_t>(written);
      continue;
    }
    if (written < 0 && errno == EINTR) {
      continue;
    }
    if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      pollfd descriptor{.fd = master_, .events = POLLOUT, .revents = 0};
      if (::poll(&descriptor, 1, milliseconds_until(deadline)) >= 0 &&
          std::chrono::steady_clock::now() < deadline) {
        continue;
      }
    }
    return false;
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

} // namespace fiber::test
