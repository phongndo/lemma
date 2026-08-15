#include "platform/terminal_mode.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <cstdint>
#include <thread>

#include <fcntl.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

namespace lemma::platform {
namespace {

#ifdef TCSASOFT
constexpr int terminal_restore_action = TCSANOW | TCSASOFT;
#else
constexpr int terminal_restore_action = TCSANOW;
#endif

[[nodiscard]] auto open_existing_terminal(const char* const path, const int flags) noexcept -> int {
  // open is variadic because its third argument is present only with O_CREAT.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  return ::open(path, flags);
}

[[nodiscard]] auto set_descriptor_flags(const int descriptor, const int flags) noexcept -> bool {
  // fcntl is variadic because its third argument depends on the command.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  return ::fcntl(descriptor, F_SETFL, flags) == 0;
}

// Restoration intentionally enumerates bounded child, tty, and deadline outcomes in one helper.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto restore_from_detached_process(
    const int descriptor, const int entry_descriptor, const termios& attributes,
    const std::chrono::steady_clock::time_point deadline, const bool attempt_inherited = true,
    const bool discard_output = false, const bool discard_input = true) noexcept -> bool {
  if (std::chrono::steady_clock::now() >= deadline) {
    return false;
  }
  std::array<int, 2> result_pipe{};
  if (::pipe(result_pipe.data()) != 0) {
    return false;
  }
  const auto child = ::fork();
  if (child < 0) {
    static_cast<void>(::close(result_pipe.front()));
    static_cast<void>(::close(result_pipe.back()));
    return false;
  }
  if (child == 0) {
    static_cast<void>(::close(result_pipe.front()));
    struct sigaction ignored{};
    ignored.sa_handler = SIG_IGN;
    static_cast<void>(sigemptyset(&ignored.sa_mask));
    static_cast<void>(::sigaction(SIGTTOU, &ignored, nullptr));
    const auto report_success = [&result_pipe]() noexcept {
      const std::byte success{1};
      static_cast<void>(::write(result_pipe.back(), &success, sizeof(success)));
      ::_exit(0);
    };
    // A saturated Darwin PTY can reject the attribute update until stale presentation output is
    // discarded. Do that on RawTerminal's dedicated control endpoint, rather than relying on the
    // output-only descriptions owned by the presentation layer. Both the flush and a blocking
    // attribute update remain confined to this child and are bounded by the parent's deadline.
    const int flush_action = discard_input ? TCIOFLUSH : TCOFLUSH;
    if (discard_output && ::tcflush(descriptor, flush_action) != 0 && entry_descriptor >= 0 &&
        entry_descriptor != descriptor) {
      static_cast<void>(::tcflush(entry_descriptor, flush_action));
    }
    // Try both endpoints retained by RawTerminal before reopening the device. Start with the
    // endpoint just flushed above; the entry endpoint remains an independent fallback with the
    // exact controlling-terminal semantics that established raw mode.
    if (attempt_inherited &&
        (::tcsetattr(descriptor, terminal_restore_action, &attributes) == 0 ||
         (entry_descriptor >= 0 &&
          ::tcsetattr(entry_descriptor, terminal_restore_action, &attributes) == 0))) {
      report_success();
    }
    // If the controlling endpoints reject the operation without blocking, detach job-control state
    // and retry through a fresh description of the same tty.
    static_cast<void>(::setsid());
    std::array<char, 1'024> terminal_path{};
    if (::ttyname_r(descriptor, terminal_path.data(), terminal_path.size()) != 0) {
      ::_exit(1);
    }
    // Keep terminal control independent from the saturated write side. tcsetattr only requires a
    // descriptor associated with the terminal, so a read-only description can apply attributes
    // without joining the blocked output path. This description is intentionally blocking: the
    // parent bounds the helper lifetime, while avoiding O_NONBLOCK/EAGAIN on the control ioctl.
    // open is variadic because its third argument is present only with O_CREAT.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    const int terminal = ::open(terminal_path.data(), O_RDONLY | O_CLOEXEC | O_NOCTTY);
    if (terminal < 0) {
      ::_exit(1);
    }
    if (discard_output) {
      static_cast<void>(::tcflush(terminal, flush_action));
    }
    if (::tcsetattr(terminal, terminal_restore_action, &attributes) == 0) {
      report_success();
    }
    ::_exit(1);
  }

  static_cast<void>(::close(result_pipe.back()));
  // fcntl is variadic because its third argument depends on the command.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  static_cast<void>(::fcntl(result_pipe.front(), F_SETFL, O_NONBLOCK));
  while (std::chrono::steady_clock::now() < deadline) {
    std::byte success{};
    if (::read(result_pipe.front(), &success, sizeof(success)) == sizeof(success)) {
      static_cast<void>(::close(result_pipe.front()));
      // Attribute application is complete, but retain ownership of the known child until it exits
      // so repeated restore cycles cannot accumulate zombies.
      while (std::chrono::steady_clock::now() < deadline) {
        int status = 0;
        const auto reaped = ::waitpid(child, &status, WNOHANG);
        if (reaped == child) {
          return true;
        }
        if (reaped < 0 && errno != EINTR) {
          return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      static_cast<void>(::kill(child, SIGKILL));
      int status = 0;
      // Never turn the helper deadline into an unbounded reap. If the terminal ioctl has left the
      // child temporarily unkillable, signal teardown will exit shortly and hand the killed child
      // to the system reaper; if it has exited already, collect it now.
      static_cast<void>(::waitpid(child, &status, WNOHANG));
      return true;
    }
    int status = 0;
    const auto result = ::waitpid(child, &status, WNOHANG);
    if (result == child) {
      static_cast<void>(::close(result_pipe.front()));
      return WIFEXITED(status) && WEXITSTATUS(status) == 0;
    }
    if (result < 0 && errno != EINTR) {
      static_cast<void>(::close(result_pipe.front()));
      return false;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  static_cast<void>(::close(result_pipe.front()));
  static_cast<void>(::kill(child, SIGKILL));
  int status = 0;
  // The caller must be able to try another independent endpoint after this deadline. A blocking
  // reap here would serialize every strategy behind the same stuck terminal ioctl.
  static_cast<void>(::waitpid(child, &status, WNOHANG));
  return false;
}

} // namespace

[[nodiscard]] auto terminal_size(const int descriptor, const std::uint16_t columns_max,
                                 const std::uint16_t rows_max) noexcept -> WindowSize {
  winsize native_size{};
  // ioctl is variadic because its third argument depends on the request.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  if (::ioctl(descriptor, TIOCGWINSZ, &native_size) != 0 || native_size.ws_col == 0 ||
      native_size.ws_row == 0) {
    return {};
  }
  return {
      .columns = std::min(native_size.ws_col, columns_max),
      .rows = std::min(native_size.ws_row, rows_max),
  };
}

// Entry prepares raw state and its independent emergency-restoration process transactionally.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto RawTerminal::enter(const int descriptor) noexcept -> bool {
  if (active_ || ::tcgetattr(descriptor, &original_) != 0) {
    return false;
  }

  std::array<char, 1'024> terminal_path{};
  if (::ttyname_r(descriptor, terminal_path.data(), terminal_path.size()) != 0) {
    return false;
  }
  // Prefer /dev/tty: it retains the process's controlling-terminal relationship on Darwin, unlike
  // a fresh O_NOCTTY open of the slave path. Validate that it is the same device as the input tty
  // so redirected stdin can never cause attributes to be restored on a different terminal. open is
  // variadic because its third argument is present only with O_CREAT.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  restore_descriptor_ = ::open("/dev/tty", O_RDONLY | O_NONBLOCK | O_CLOEXEC);
  struct stat input_status{};
  struct stat restore_status{};
  if (restore_descriptor_ < 0 || ::fstat(descriptor, &input_status) != 0 ||
      ::fstat(restore_descriptor_, &restore_status) != 0 ||
      input_status.st_rdev != restore_status.st_rdev) {
    if (restore_descriptor_ >= 0) {
      static_cast<void>(::close(restore_descriptor_));
    }
    restore_descriptor_ =
        open_existing_terminal(terminal_path.data(), O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOCTTY);
  }
  if (restore_descriptor_ < 0) {
    return false;
  }

  auto raw = original_;
  raw.c_iflag &= static_cast<tcflag_t>(~(BRKINT | ICRNL | INPCK | ISTRIP | IXON));
  raw.c_oflag &= static_cast<tcflag_t>(~OPOST);
  raw.c_cflag |= CS8;
  raw.c_lflag &= static_cast<tcflag_t>(~(ECHO | ICANON | IEXTEN | ISIG));
  raw.c_cc[VMIN] = 1;
  raw.c_cc[VTIME] = 0;
  if (::tcsetattr(descriptor, TCSAFLUSH, &raw) != 0) {
    static_cast<void>(::close(restore_descriptor_));
    restore_descriptor_ = -1;
    return false;
  }
  entry_descriptor_ = descriptor;
  active_ = true;
  if (!start_emergency_restorer(-1, -1)) {
    static_cast<void>(restore());
    return false;
  }
  return true;
}

// Restorer setup keeps child endpoint, signal, and pipe ownership visible in one transaction.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto RawTerminal::start_emergency_restorer(const int output_descriptor,
                                                         const int cleanup_descriptor) noexcept
    -> bool {
  if (!active_ || restore_process_ > 0) {
    return active_ && restore_process_ > 0;
  }
  // Start before the presentation layer opens render descriptions. The child therefore retains
  // only a fresh read-only control endpoint, so a saturated writer cannot gate restoration.
  std::array<int, 2> wakeup_pipe{};
  std::array<int, 2> result_pipe{};
  if (::pipe(wakeup_pipe.data()) != 0 || ::pipe(result_pipe.data()) != 0) {
    if (wakeup_pipe.front() > 0) {
      static_cast<void>(::close(wakeup_pipe.front()));
      static_cast<void>(::close(wakeup_pipe.back()));
    }
    return false;
  }
  const auto restorer = ::fork();
  if (restorer == 0) {
    static_cast<void>(::close(wakeup_pipe.back()));
    static_cast<void>(::close(result_pipe.front()));
    const std::array ignored_signals{SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGTTOU};
    struct sigaction ignored{};
    ignored.sa_handler = SIG_IGN;
    static_cast<void>(sigemptyset(&ignored.sa_mask));
    for (const int signal_number : ignored_signals) {
      static_cast<void>(::sigaction(signal_number, &ignored, nullptr));
    }
    std::array<char, 1'024> restore_path{};
    if (::ttyname_r(restore_descriptor_, restore_path.data(), restore_path.size()) != 0) {
      ::_exit(1);
    }
    const int emergency_descriptor =
        open_existing_terminal(restore_path.data(), O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOCTTY);
    if (emergency_descriptor < 0) {
      ::_exit(1);
    }
    // The guardian must not retain either inherited output endpoint while the parent saturates a
    // separately opened render writer.
    if (output_descriptor >= 0) {
      static_cast<void>(::close(output_descriptor));
    }
    if (cleanup_descriptor >= 0) {
      static_cast<void>(::close(cleanup_descriptor));
    }
    static_cast<void>(::close(STDIN_FILENO));
    static_cast<void>(::close(STDOUT_FILENO));
    static_cast<void>(::close(STDERR_FILENO));
    const std::byte ready{0};
    if (::write(result_pipe.back(), &ready, sizeof(ready)) != sizeof(ready)) {
      ::_exit(1);
    }
    std::byte notification{};
    ssize_t received = -1;
    while (received < 0) {
      received = ::read(wakeup_pipe.front(), &notification, sizeof(notification));
      if (received >= 0 || errno != EINTR) {
        break;
      }
    }
    if (received != sizeof(notification)) {
      ::_exit(1);
    }
    // Keep restoring until the parent completes teardown. This covers a signal racing any
    // in-flight terminal-control operation in the parent rather than relying on one restoration.
    // fcntl is variadic because its third argument depends on the command.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    static_cast<void>(::fcntl(wakeup_pipe.front(), F_SETFL, O_NONBLOCK));
    bool reported = false;
    while (true) {
      // Both operations use the guardian's nonblocking control endpoint. Discarding stale output
      // first gives Darwin's immediate termios update room without ever trapping the guardian in
      // the saturated presentation queue.
      static_cast<void>(::tcflush(restore_descriptor_, TCIOFLUSH));
      static_cast<void>(::tcflush(emergency_descriptor, TCIOFLUSH));
      const bool restored =
          ::tcsetattr(restore_descriptor_, terminal_restore_action, &original_) == 0 ||
          ::tcsetattr(emergency_descriptor, terminal_restore_action, &original_) == 0;
      if (restored && !reported) {
        const std::byte success{1};
        static_cast<void>(::write(result_pipe.back(), &success, sizeof(success)));
        reported = true;
      }
      const auto parent_state = ::read(wakeup_pipe.front(), &notification, sizeof(notification));
      if (parent_state == 0) {
        ::_exit(reported ? 0 : 1);
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
  }
  static_cast<void>(::close(wakeup_pipe.front()));
  static_cast<void>(::close(result_pipe.back()));
  if (restorer < 0) {
    static_cast<void>(::close(wakeup_pipe.back()));
    static_cast<void>(::close(result_pipe.front()));
    return false;
  }
  restore_wakeup_descriptor_ = wakeup_pipe.back();
  restore_result_descriptor_ = result_pipe.front();
  restore_process_ = restorer;
  // fcntl is variadic because its third argument depends on the command.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const bool wakeup_nonblocking = ::fcntl(restore_wakeup_descriptor_, F_SETFL, O_NONBLOCK) == 0;
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const bool result_nonblocking = ::fcntl(restore_result_descriptor_, F_SETFL, O_NONBLOCK) == 0;
  if (!wakeup_nonblocking || !result_nonblocking) {
    stop_emergency_restorer();
    return false;
  }
  const auto ready_deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(100);
  while (true) {
    const auto now = std::chrono::steady_clock::now();
    if (now >= ready_deadline) {
      break;
    }
    const auto remaining =
        std::chrono::duration_cast<std::chrono::milliseconds>(ready_deadline - now);
    pollfd ready_event{.fd = restore_result_descriptor_, .events = POLLIN, .revents = 0};
    const auto polled =
        ::poll(&ready_event, 1, static_cast<int>(std::max(remaining.count(), std::int64_t{1})));
    if (polled < 0) {
      if (errno == EINTR) {
        continue;
      }
      break;
    }
    if (polled == 0) {
      continue;
    }
    std::byte ready{1};
    const auto received = ::read(restore_result_descriptor_, &ready, sizeof(ready));
    if (received == sizeof(ready) && ready == std::byte{0}) {
      return true;
    }
    if (received < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) {
      continue;
    }
    break;
  }
  stop_emergency_restorer();
  return false;
}

[[nodiscard]] auto RawTerminal::consume_emergency_restore() noexcept -> bool {
  if (restore_result_descriptor_ < 0) {
    return false;
  }
  std::byte result{};
  const auto received = ::read(restore_result_descriptor_, &result, sizeof(result));
  if (received != sizeof(result) || result != std::byte{1}) {
    return false;
  }
  active_ = false;
  return true;
}

void RawTerminal::stop_emergency_restorer() noexcept {
  if (restore_wakeup_descriptor_ >= 0) {
    static_cast<void>(::close(restore_wakeup_descriptor_));
    restore_wakeup_descriptor_ = -1;
  }
  if (restore_process_ > 0) {
    static_cast<void>(::kill(restore_process_, SIGKILL));
    int status = 0;
    static_cast<void>(::waitpid(restore_process_, &status, WNOHANG));
    restore_process_ = -1;
  }
  if (restore_result_descriptor_ >= 0) {
    static_cast<void>(::close(restore_result_descriptor_));
    restore_result_descriptor_ = -1;
  }
}

// Restoration keeps each terminal endpoint and bounded fallback outcome explicit.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto RawTerminal::restore() noexcept -> bool {
  if (!active_ || consume_emergency_restore()) {
    return true;
  }

  // Terminal-control operations may otherwise fail with EIO or stop the process when its process
  // group loses foreground status during signal teardown. POSIX explicitly permits the operation
  // when SIGTTOU is ignored; restore the caller's disposition before returning.
  struct sigaction ignored{};
  ignored.sa_handler = SIG_IGN;
  static_cast<void>(sigemptyset(&ignored.sa_mask));
  struct sigaction previous{};
  const bool action_changed = ::sigaction(SIGTTOU, &ignored, &previous) == 0;

  // Restoration is a cleanup boundary and must wait for neither output drainage nor presentation
  // flushing. Apply TCSANOW directly through the owned input-terminal description. In particular,
  // do not queue tcflow/tcsetpgrp control events ahead of restoration: a saturated Darwin PTY may
  // reject those events and leave no room for the attribute update itself.
  bool restored = false;
  bool interrupted = false;
  constexpr std::size_t restoration_attempts_max = 100;
  for (std::size_t attempt = 0; attempt < restoration_attempts_max; ++attempt) {
    // The descriptor that entered raw mode retains the foreground/control relationship that a
    // separately opened endpoint can lose on Darwin. Make that exact file description nonblocking
    // for the attempt, then restore its shared flags before returning to the reactor.
    int restore_error = 0;
    // fcntl is variadic because its third argument depends on the command.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    const int entry_flags = ::fcntl(entry_descriptor_, F_GETFL, 0);
    if (entry_flags >= 0) {
      const bool made_nonblocking =
          set_descriptor_flags(entry_descriptor_, entry_flags | O_NONBLOCK);
      if (made_nonblocking &&
          ::tcsetattr(entry_descriptor_, terminal_restore_action, &original_) == 0) {
        restored = true;
      } else if (made_nonblocking) {
        restore_error = errno;
      }
      // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
      static_cast<void>(::fcntl(entry_descriptor_, F_SETFL, entry_flags));
      if (restored) {
        break;
      }
      if (restore_error == EINTR) {
        interrupted = true;
        break;
      }
    }
    if (::tcsetattr(restore_descriptor_, terminal_restore_action, &original_) == 0) {
      restored = true;
      break;
    }
    restore_error = errno;
    if (restore_error == EINTR) {
      // Do not begin another potentially blocking terminal operation after a handled termination
      // interrupts this one. The client reactor hands restoration to restore_bounded before exit.
      interrupted = true;
      break;
    }
    if (restore_error != EAGAIN && restore_error != EWOULDBLOCK && restore_error != EIO) {
      break;
    }
    // Darwin can transiently reject an immediate attribute change while PTY flow-control state is
    // being cleared. The client may explicitly clear stale output before another attempt.
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  if (action_changed) {
    static_cast<void>(::sigaction(SIGTTOU, &previous, nullptr));
  }
  if (!restored && !interrupted) {
    // If Darwin still rejects the foreground process during blocked-output teardown, use a short-
    // lived process detached from the controlling-terminal job-control relationship.
    const auto helper_deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(750);
    const auto first_deadline =
        std::chrono::steady_clock::now() + (helper_deadline - std::chrono::steady_clock::now()) / 3;
    restored =
        restore_from_detached_process(restore_descriptor_, -1, original_, first_deadline, false);
    const auto second_deadline =
        std::chrono::steady_clock::now() + (helper_deadline - std::chrono::steady_clock::now()) / 2;
    restored = restored ||
               restore_from_detached_process(restore_descriptor_, -1, original_, second_deadline);
    restored = restored ||
               restore_from_detached_process(entry_descriptor_, -1, original_, helper_deadline);
  }
  if (restored) {
    active_ = false;
    return true;
  }
  return consume_emergency_restore();
}

[[nodiscard]] auto RawTerminal::wait_for_emergency_restore(
    const std::chrono::steady_clock::time_point deadline) noexcept -> bool {
  while (std::chrono::steady_clock::now() < deadline) {
    if (!active_ || consume_emergency_restore()) {
      return true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return !active_ || consume_emergency_restore();
}

[[nodiscard]] auto RawTerminal::restore_bounded() noexcept -> bool {
  return restore_bounded(std::chrono::steady_clock::now() + std::chrono::milliseconds(750));
}

[[nodiscard]] auto
RawTerminal::restore_bounded(const std::chrono::steady_clock::time_point deadline) noexcept
    -> bool {
  if (!active_ || consume_emergency_restore()) {
    return true;
  }
  if (restore_descriptor_ < 0 || std::chrono::steady_clock::now() >= deadline) {
    return false;
  }
  // Reserve a bounded share for every independent strategy. A blocked candidate must never consume
  // the absolute deadline and prevent the retained entry descriptor from being attempted. Keep
  // direct updates on both owned endpoints independent from the output-discard strategy: a PTY
  // driver that blocks its flush operation must not prevent every helper from reaching tcsetattr.
  const auto first_deadline =
      std::chrono::steady_clock::now() + (deadline - std::chrono::steady_clock::now()) / 3;
  bool restored =
      restore_from_detached_process(restore_descriptor_, -1, original_, first_deadline, false);
  const auto second_deadline =
      std::chrono::steady_clock::now() + (deadline - std::chrono::steady_clock::now()) / 2;
  restored = restored || restore_from_detached_process(restore_descriptor_, entry_descriptor_,
                                                       original_, second_deadline, true, true);
  restored = restored || restore_from_detached_process(entry_descriptor_, restore_descriptor_,
                                                       original_, deadline);
  if (!restored) {
    return consume_emergency_restore();
  }
  active_ = false;
  return true;
}

[[nodiscard]] auto RawTerminal::restore_bounded_after_output_abort(
    const int output_descriptor, const std::chrono::steady_clock::time_point deadline) noexcept
    -> bool {
  if (!active_ || consume_emergency_restore()) {
    return true;
  }
  if (output_descriptor < 0 || std::chrono::steady_clock::now() >= deadline) {
    return false;
  }
  // The render description is the endpoint whose per-writer queue became saturated. Flush that
  // exact endpoint and apply the saved attributes in one bounded child before the parent retires
  // it; flushing separately opened control descriptions does not necessarily discard this queue on
  // Darwin. The caller retires this writer before trying other helpers, so a timed-out child cannot
  // make every later strategy inherit the blocked description.
  if (!restore_from_detached_process(output_descriptor, entry_descriptor_, original_, deadline,
                                     true, true, false)) {
    return consume_emergency_restore();
  }
  active_ = false;
  return true;
}

RawTerminal::~RawTerminal() {
  // Destruction retains one final bounded helper attempt, but never wraps it in an unbounded retry
  // policy or invokes a potentially blocking terminal ioctl in the exiting client itself.
  static_cast<void>(restore_bounded());
  stop_emergency_restorer();
  if (restore_descriptor_ >= 0) {
    static_cast<void>(::close(restore_descriptor_));
    restore_descriptor_ = -1;
  }
}

} // namespace lemma::platform
