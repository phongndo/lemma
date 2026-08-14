#include "client/attached_client.hpp"

#include "daemon/server.hpp"
#include "diagnostic/latency_trace.hpp"
#include "lemma/assert.hpp"
#include "platform/io.hpp"
#include "platform/terminal_mode.hpp"
#include "protocol/single_pane.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <span>
#include <string_view>
#include <thread>

#include <fcntl.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <termios.h>
#include <unistd.h>

namespace lemma::client {
namespace {

constexpr auto prefix_flush_delay = std::chrono::milliseconds(50);
constexpr std::string_view outer_terminal_enter = "\x1B[?1049h\x1B[2J\x1B[H";
constexpr std::string_view outer_terminal_restore =
    "\x1B[0m\x1B[?2026l\x1B[?1l\x1B[?9l\x1B[?1000l\x1B[?1002l\x1B[?1003l"
    "\x1B[?1004l\x1B[?1005l\x1B[?1006l\x1B[?1007l\x1B[?1015l\x1B[?1016l"
    "\x1B[?2004l\x1B]112\x1B\\\x1B[0 q\x1B[?25h\x1B[?7h\x1B[?1049l";
constexpr std::string_view interruption_diagnostic = "lemma attach interrupted by signal\n";
constexpr auto signal_cleanup_storage = [] {
  std::array<char, outer_terminal_restore.size() + interruption_diagnostic.size()> payload{};
  std::size_t offset = 0;
  for (const char character : outer_terminal_restore) {
    payload.at(offset) = character;
    ++offset;
  }
  for (const char character : interruption_diagnostic) {
    payload.at(offset) = character;
    ++offset;
  }
  return payload;
}();
constexpr std::string_view signal_cleanup_payload{signal_cleanup_storage.data(),
                                                  signal_cleanup_storage.size()};
constexpr std::array handled_termination_signals{SIGINT, SIGTERM, SIGHUP, SIGQUIT};
using platform::close_descriptor;

volatile sig_atomic_t resize_pending = 0;
volatile sig_atomic_t termination_signal = 0;
volatile sig_atomic_t termination_wakeup_descriptor = -1;
volatile sig_atomic_t termination_wakeup_read_descriptor = -1;
volatile sig_atomic_t terminal_restore_wakeup_descriptor = -1;
volatile sig_atomic_t termination_render_descriptor = -1;
volatile sig_atomic_t termination_render_closed = 0;

[[nodiscard]] auto open_terminal_output(const char* const path) noexcept -> int {
  // open is variadic because its third argument is present only with O_CREAT.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  return ::open(path, O_WRONLY | O_NONBLOCK | O_CLOEXEC | O_NOCTTY);
}

[[nodiscard]] auto write_interruptibly(const int descriptor,
                                       const std::span<const std::byte> bytes) noexcept -> bool {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    if (termination_signal != 0) {
      return false;
    }
    const auto written = ::write(descriptor, bytes.subspan(offset).data(), bytes.size() - offset);
    if (written > 0) {
      offset += static_cast<std::size_t>(written);
      continue;
    }
    if (written < 0 && errno == EINTR) {
      continue;
    }
    return false;
  }
  return true;
}

[[nodiscard]] auto write_text_interruptibly(const int descriptor,
                                            const std::string_view text) noexcept -> bool {
  return write_interruptibly(descriptor, std::as_bytes(std::span(text.data(), text.size())));
}

// Terminal progress, signal wakeup, and bounded retry outcomes are deliberately handled together.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto write_terminal_interruptibly(const int descriptor,
                                                const std::span<const std::byte> bytes) noexcept
    -> bool {
  std::size_t offset = 0;
  constexpr auto progress_timeout = std::chrono::seconds(2);
  auto progress_deadline = std::chrono::steady_clock::now() + progress_timeout;
  while (offset < bytes.size()) {
    if (termination_signal != 0) {
      return false;
    }
    // Keep the tty below its non-writable high-water mark. On Darwin, filling a PTY all the way to
    // EAGAIN can also make an immediate termios ioctl fail until the master consumes output. Small
    // writes followed by a readiness check preserve kernel headroom for terminal control cleanup.
    constexpr std::size_t terminal_write_chunk = 1'024;
    const auto remaining = bytes.subspan(offset);
    const auto chunk = remaining.first(std::min(remaining.size(), terminal_write_chunk));
    const auto written = ::write(descriptor, chunk.data(), chunk.size());
    if (written > 0) {
      offset += static_cast<std::size_t>(written);
      progress_deadline = std::chrono::steady_clock::now() + progress_timeout;
      // Observe signal wakeup without adding a presentation latency floor. A later saturated write
      // is nonblocking and enters the bounded readiness path below.
      pollfd wakeup{.fd = termination_wakeup_read_descriptor, .events = POLLIN, .revents = 0};
      if (::poll(&wakeup, 1, 0) > 0 && (wakeup.revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
        return false;
      }
      pollfd writable{.fd = descriptor, .events = POLLOUT, .revents = 0};
      if (::poll(&writable, 1, 0) > 0 && (writable.revents & POLLOUT) != 0) {
        continue;
      }
    }
    if (written < 0 && errno == EINTR) {
      continue;
    }
    if (written < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EIO) {
      return false;
    }

    const auto now = std::chrono::steady_clock::now();
    if (now >= progress_deadline) {
      return false;
    }
    std::array<pollfd, 2> readiness{{
        {.fd = descriptor, .events = POLLOUT, .revents = 0},
        {.fd = termination_wakeup_read_descriptor, .events = POLLIN, .revents = 0},
    }};
    constexpr auto terminal_retry = std::chrono::milliseconds(10);
    const auto remaining_time =
        std::chrono::duration_cast<std::chrono::milliseconds>(progress_deadline - now);
    const auto retry =
        std::max(std::min(remaining_time, terminal_retry), std::chrono::milliseconds(1));
    const auto ready = ::poll(readiness.data(), readiness.size(), static_cast<int>(retry.count()));
    if (ready < 0) {
      if (errno == EINTR) {
        continue;
      }
      return false;
    }
    if ((readiness.back().revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
      return false;
    }
    if ((readiness.front().revents & (POLLHUP | POLLERR | POLLNVAL)) != 0 &&
        (readiness.front().revents & POLLOUT) == 0) {
      return false;
    }
  }
  return true;
}

[[nodiscard]] auto write_terminal_text_interruptibly(const int descriptor,
                                                     const std::string_view text) noexcept -> bool {
  return write_terminal_interruptibly(descriptor,
                                      std::as_bytes(std::span(text.data(), text.size())));
}

[[nodiscard]] auto send_interruptibly(const int socket,
                                      const std::span<const std::byte> bytes) noexcept -> bool {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    if (termination_signal != 0) {
      return false;
    }
    const auto sent =
        ::send(socket, bytes.subspan(offset).data(), bytes.size() - offset, MSG_NOSIGNAL);
    if (sent > 0) {
      offset += static_cast<std::size_t>(sent);
      continue;
    }
    if (sent < 0 && errno == EINTR) {
      continue;
    }
    return false;
  }
  return true;
}

[[nodiscard]] auto write_text_until(const int descriptor, const std::string_view text,
                                    const std::chrono::steady_clock::time_point deadline) noexcept
    -> bool {
  const auto bytes = std::as_bytes(std::span(text.data(), text.size()));
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    if (std::chrono::steady_clock::now() >= deadline) {
      return false;
    }
    const auto written = ::write(descriptor, bytes.subspan(offset).data(), bytes.size() - offset);
    if (written > 0) {
      offset += static_cast<std::size_t>(written);
      continue;
    }
    if (written < 0 && errno == EINTR) {
      continue;
    }
    // A flow-controlled Darwin PTY can transiently report zero or EIO as well as EAGAIN while
    // its master is still open. Retain the suffix for every no-progress result until the bounded
    // deadline; an actually unusable descriptor therefore remains bounded too.
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) {
      return false;
    }
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
    constexpr auto retry_delay = std::chrono::milliseconds(10);
    std::this_thread::sleep_for(
        std::max(std::min(remaining, retry_delay), std::chrono::milliseconds(1)));
  }
  return true;
}

[[nodiscard]] auto write_signal_cleanup(const int descriptor) noexcept -> bool {
  // RawTerminal has already restored termios before this function is called. Retain the client
  // until the queued payload reaches the terminal endpoint, so closing the final slave descriptor
  // cannot discard its restore suffix or diagnostic. The test/user may begin draining as soon as
  // termios is restored, and the single monotonic deadline keeps an abandoned endpoint bounded.
  constexpr auto output_timeout = std::chrono::seconds(10);
  const auto deadline = std::chrono::steady_clock::now() + output_timeout;
  if (!write_text_until(descriptor, signal_cleanup_payload, deadline)) {
    return false;
  }
  while (std::chrono::steady_clock::now() < deadline) {
    int queued = 0;
    // ioctl is variadic because its third argument depends on the request.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    if (::ioctl(descriptor, TIOCOUTQ, &queued) == 0 && queued == 0) {
      return true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return false;
}

void on_window_changed([[maybe_unused]] const int signal_number) noexcept { resize_pending = 1; }

void on_termination(const int signal_number) noexcept {
  const int saved_error = errno;
  if (termination_signal == 0) {
    termination_signal = signal_number;
  }
  constexpr std::byte notification{0};
  const int wakeup = termination_wakeup_descriptor;
  if (wakeup >= 0) {
    static_cast<void>(::write(wakeup, &notification, sizeof(notification)));
  }
  const int render = termination_render_descriptor;
  if (render >= 0) {
    // close is async-signal-safe. The independent cleanup descriptor keeps this from becoming the
    // tty's last close, while retiring the saturated writer lets the emergency restorer progress.
    static_cast<void>(::close(render));
    termination_render_descriptor = -1;
    termination_render_closed = 1;
  }
  const int terminal_restore = terminal_restore_wakeup_descriptor;
  if (terminal_restore >= 0) {
    static_cast<void>(::write(terminal_restore, &notification, sizeof(notification)));
  }
  errno = saved_error;
}

class SignalWakeup final {
public:
  SignalWakeup() = default;
  SignalWakeup(const SignalWakeup&) = delete;
  auto operator=(const SignalWakeup&) -> SignalWakeup& = delete;
  SignalWakeup(SignalWakeup&&) = delete;
  auto operator=(SignalWakeup&&) -> SignalWakeup& = delete;
  ~SignalWakeup() {
    termination_wakeup_descriptor = -1;
    termination_wakeup_read_descriptor = -1;
    close_descriptor(read_descriptor_);
    close_descriptor(write_descriptor_);
  }

  [[nodiscard]] auto install() noexcept -> bool {
    std::array<int, 2> descriptors{};
    if (::pipe(descriptors.data()) != 0) {
      return false;
    }
    read_descriptor_ = descriptors.front();
    write_descriptor_ = descriptors.back();
    if (!platform::set_nonblocking(read_descriptor_) ||
        !platform::set_nonblocking(write_descriptor_)) {
      close_descriptor(read_descriptor_);
      close_descriptor(write_descriptor_);
      return false;
    }
    termination_wakeup_read_descriptor = read_descriptor_;
    termination_wakeup_descriptor = write_descriptor_;
    return true;
  }

  [[nodiscard]] auto descriptor() const noexcept -> int { return read_descriptor_; }

  void drain() const noexcept {
    std::array<std::byte, 64> notifications{};
    while (true) {
      const auto received = ::read(read_descriptor_, notifications.data(), notifications.size());
      if (received > 0) {
        continue;
      }
      if (received < 0 && errno == EINTR) {
        continue;
      }
      return;
    }
  }

private:
  int read_descriptor_{-1};
  int write_descriptor_{-1};
};

class SignalActions final {
public:
  SignalActions() = default;
  SignalActions(const SignalActions&) = delete;
  auto operator=(const SignalActions&) -> SignalActions& = delete;
  SignalActions(SignalActions&&) = delete;
  auto operator=(SignalActions&&) -> SignalActions& = delete;
  ~SignalActions() { restore(); }

  [[nodiscard]] auto install() noexcept -> bool {
    if (installed_ != 0) {
      return false;
    }
    struct sigaction resize_action{};
    resize_action.sa_handler = &on_window_changed;
    if (sigemptyset(&resize_action.sa_mask) != 0 ||
        ::sigaction(SIGWINCH, &resize_action, &previous_resize_) != 0) {
      return false;
    }
    resize_installed_ = true;

    struct sigaction termination_action{};
    termination_action.sa_handler = &on_termination;
    static_cast<void>(sigemptyset(&termination_action.sa_mask));
    for (std::size_t index = 0; index < handled_termination_signals.size(); ++index) {
      const auto signal_number = std::span(handled_termination_signals).subspan(index, 1).front();
      auto& previous = std::span(previous_termination_).subspan(index, 1).front();
      if (::sigaction(signal_number, &termination_action, &previous) != 0) {
        restore();
        return false;
      }
      ++installed_;
    }
    return true;
  }

private:
  void restore() noexcept {
    while (installed_ > 0) {
      --installed_;
      const auto signal_number =
          std::span(handled_termination_signals).subspan(installed_, 1).front();
      auto& previous = std::span(previous_termination_).subspan(installed_, 1).front();
      static_cast<void>(::sigaction(signal_number, &previous, nullptr));
    }
    if (resize_installed_) {
      static_cast<void>(::sigaction(SIGWINCH, &previous_resize_, nullptr));
      resize_installed_ = false;
    }
  }

  struct sigaction previous_resize_{};
  std::array<struct sigaction, handled_termination_signals.size()> previous_termination_{};
  std::size_t installed_{0};
  bool resize_installed_{false};
};

class OuterTerminal final {
public:
  OuterTerminal() = default;
  OuterTerminal(const OuterTerminal&) = delete;
  auto operator=(const OuterTerminal&) -> OuterTerminal& = delete;
  OuterTerminal(OuterTerminal&&) = delete;
  auto operator=(OuterTerminal&&) -> OuterTerminal& = delete;
  ~OuterTerminal() {
    if (active_) {
      active_ = false;
      constexpr auto normal_cleanup_timeout = std::chrono::seconds(2);
      const bool normally_restored =
          termination_signal == 0 &&
          write_text_until(render_descriptor_, outer_terminal_restore,
                           std::chrono::steady_clock::now() + normal_cleanup_timeout);
      if (termination_signal != 0 && !signal_cleanup_suppressed_) {
        // Discard the interrupted render and close its description before queueing cleanup. Some
        // PTY implementations discard global output while tearing down an interrupted writer, so
        // closing it after the restore payload could erase the payload we just retained.
        retire_render_output();
        static_cast<void>(write_signal_cleanup(cleanup_descriptor_));
      } else if (termination_signal != 0) {
        abort_render_output();
      } else if (!normally_restored) {
        // A daemon-loss or EOF cleanup must not keep the process alive forever if the terminal has
        // stopped consuming output. Retire stale output and make one independent bounded attempt.
        retire_render_output();
        static_cast<void>(
            write_text_until(cleanup_descriptor_, outer_terminal_restore,
                             std::chrono::steady_clock::now() + normal_cleanup_timeout));
      }
    }
    close_descriptor(render_descriptor_);
    close_descriptor(cleanup_descriptor_);
  }

  [[nodiscard]] auto enter() noexcept -> bool {
    std::array<char, 1'024> terminal_path{};
    if (::ttyname_r(STDOUT_FILENO, terminal_path.data(), terminal_path.size()) != 0) {
      return false;
    }
    cleanup_descriptor_ = open_terminal_output(terminal_path.data());
    render_descriptor_ = open_terminal_output(terminal_path.data());
    if (cleanup_descriptor_ < 0 || render_descriptor_ < 0) {
      close_descriptor(render_descriptor_);
      close_descriptor(cleanup_descriptor_);
      return false;
    }
    active_ = true;
    return write_terminal_text_interruptibly(render_descriptor_, outer_terminal_enter);
  }

  [[nodiscard]] auto render_descriptor() const noexcept -> int { return render_descriptor_; }
  [[nodiscard]] auto cleanup_descriptor() const noexcept -> int { return cleanup_descriptor_; }

  void suppress_signal_cleanup() noexcept { signal_cleanup_suppressed_ = true; }

  void adopt_signal_render_retirement() noexcept {
    if (termination_render_closed != 0) {
      render_descriptor_ = -1;
      termination_render_closed = 0;
    }
  }

  void retire_render_writer() noexcept {
    // cleanup_descriptor_ keeps the tty open, so retiring the nonblocking render description does
    // not perform last-close terminal drainage.
    if (termination_render_descriptor == render_descriptor_) {
      termination_render_descriptor = -1;
    }
    close_descriptor(render_descriptor_);
  }

  void retire_render_output() noexcept {
    // Close before flushing: on Darwin, discarding a saturated per-writer queue may not take effect
    // until that writer has been retired.
    retire_render_writer();
    abort_render_output();
  }

  void abort_render_output() const noexcept {
    // Flush the shared queue while keeping every operation non-draining. Callers choose when it is
    // safe to retire the render description; signal teardown keeps an independent cleanup endpoint
    // open so that retirement is not a last-close drainage boundary.
    struct sigaction ignored{};
    ignored.sa_handler = SIG_IGN;
    static_cast<void>(sigemptyset(&ignored.sa_mask));
    struct sigaction previous{};
    const bool action_changed = ::sigaction(SIGTTOU, &ignored, &previous) == 0;
    // TCOON itself can wait for room to enqueue a flow-control event on a saturated Darwin PTY,
    // defeating this non-draining cleanup boundary. Discard queued output directly through the
    // dedicated nonblocking descriptions; never fall back to the possibly blocking stdout handle.
    constexpr std::size_t flush_attempts_max = 100;
    for (std::size_t attempt = 0; attempt < flush_attempts_max; ++attempt) {
      if (::tcflush(render_descriptor_, TCOFLUSH) == 0 ||
          ::tcflush(cleanup_descriptor_, TCOFLUSH) == 0) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (action_changed) {
      static_cast<void>(::sigaction(SIGTTOU, &previous, nullptr));
    }
  }

private:
  int cleanup_descriptor_{-1};
  int render_descriptor_{-1};
  bool active_{false};
  bool signal_cleanup_suppressed_{false};
};

[[nodiscard]] auto terminal_size() noexcept -> platform::WindowSize {
  return platform::terminal_size(STDOUT_FILENO, protocol::columns_max, protocol::rows_max);
}

[[nodiscard]] auto advance_sequence(std::uint32_t& sequence) noexcept -> bool {
  if (sequence == std::numeric_limits<std::uint32_t>::max()) {
    return false;
  }
  ++sequence;
  return true;
}

[[nodiscard]] auto send_small_message(const int connection, const protocol::SmallMessage& message,
                                      std::uint32_t& sequence) noexcept -> bool {
  return send_interruptibly(connection, message.bytes()) && advance_sequence(sequence);
}

[[nodiscard]] auto send_resize(const int connection, const platform::WindowSize size,
                               std::uint32_t& sequence) noexcept -> bool {
  return send_small_message(
      connection, protocol::encode_resize({.columns = size.columns, .rows = size.rows}, sequence),
      sequence);
}

[[nodiscard]] auto send_input(const int connection, const std::span<const std::byte> input,
                              std::uint32_t& sequence) noexcept -> bool {
  if (input.empty()) {
    return true;
  }
  const auto header = protocol::encode_input_header(input.size(), sequence);
  return send_interruptibly(connection, header) && send_interruptibly(connection, input) &&
         advance_sequence(sequence);
}

[[nodiscard]] auto send_prefixed_input(const int connection, const protocol::PrefixResult& parsed,
                                       const std::span<const std::byte> input,
                                       std::uint32_t& sequence) noexcept -> bool {
  std::size_t sent = 0;
  for (const auto& action : std::span(parsed.actions).first(parsed.action_count)) {
    LEMMA_ASSERT(action.input_bytes >= sent);
    LEMMA_ASSERT(action.input_bytes <= input.size());
    const auto ordinary_input = input.subspan(sent, action.input_bytes - sent);
    if (!send_input(connection, ordinary_input, sequence) ||
        !send_small_message(connection, protocol::encode_pane_command(action.command, sequence),
                            sequence)) {
      return false;
    }
    sent = action.input_bytes;
  }
  return send_input(connection, input.subspan(sent), sequence);
}

void report_disconnect(const protocol::ServerMessage& message) noexcept {
  static_cast<void>(write_text_interruptibly(STDERR_FILENO, "lemma attach failed: "));
  static_cast<void>(write_text_interruptibly(
      STDERR_FILENO,
      message.diagnostic.empty() ? std::string_view{"daemon disconnected"} : message.diagnostic));
  static_cast<void>(write_text_interruptibly(STDERR_FILENO, "\n"));
}

enum class HandshakeResult : std::uint8_t {
  accepted,
  rejected,
  error,
};

// The branches are bounded handshake transport and typed protocol outcomes.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto receive_handshake(const int connection, protocol::ServerDecoder& decoder,
                                     const protocol::Dimensions expected) noexcept
    -> HandshakeResult {
  while (true) {
    const auto decoded = decoder.next();
    if (!decoded.has_value()) {
      static_cast<void>(write_text_interruptibly(STDERR_FILENO, "lemma attach protocol error: "));
      static_cast<void>(write_text_interruptibly(
          STDERR_FILENO, protocol::decode_error_diagnostic(decoded.error())));
      static_cast<void>(write_text_interruptibly(STDERR_FILENO, "\n"));
      return HandshakeResult::error;
    }
    if (decoded->has_value()) {
      const auto& message = **decoded;
      if (message.kind == protocol::ServerMessageKind::disconnect) {
        report_disconnect(message);
        decoder.consume();
        return HandshakeResult::rejected;
      }
      if (message.kind != protocol::ServerMessageKind::hello || message.dimensions != expected) {
        static_cast<void>(write_text_interruptibly(
            STDERR_FILENO, "lemma attach protocol error: invalid daemon hello\n"));
        return HandshakeResult::error;
      }
      decoder.consume();
      return HandshakeResult::accepted;
    }

    auto available = decoder.writable_bytes();
    if (available.empty()) {
      return HandshakeResult::error;
    }
    const auto received = ::recv(connection, available.data(), available.size(), 0);
    if (received > 0) {
      if (!decoder.commit(static_cast<std::size_t>(received)).has_value()) {
        return HandshakeResult::error;
      }
      continue;
    }
    if (received < 0 && errno == EINTR) {
      continue;
    }
    return HandshakeResult::error;
  }
}

enum class ServerParseResult : std::uint8_t {
  keep,
  disconnect,
  peer_closed,
  error,
};

class LiveDiagnostic final {
public:
  void record_protocol_error(const protocol::DecodeError error) noexcept {
    if (!empty()) {
      return;
    }
    append("lemma attach protocol error: ");
    append(protocol::decode_error_diagnostic(error));
    append("\n");
  }

  void record_disconnect(const protocol::ServerMessage& message) noexcept {
    if (!empty()) {
      return;
    }
    append("lemma attach failed: ");
    append(message.diagnostic.empty() ? std::string_view{"daemon disconnected"}
                                      : message.diagnostic);
    append("\n");
  }

  void record_terminal_error() noexcept {
    if (empty()) {
      append("lemma attach error: outer terminal write failed\n");
    }
  }

  void record_connection_error() noexcept {
    if (empty()) {
      append("lemma attach error: daemon connection read failed\n");
    }
  }

  [[nodiscard]] auto empty() const noexcept -> bool { return size_ == 0; }
  [[nodiscard]] auto view() const noexcept -> std::string_view { return {storage_.data(), size_}; }

private:
  void append(const std::string_view text) noexcept {
    const auto count = std::min(text.size(), storage_.size() - size_);
    std::ranges::copy(std::span(text).first(count),
                      std::span(storage_).subspan(size_, count).begin());
    size_ += count;
  }

  std::array<char, protocol::diagnostic_bytes_max + 64U> storage_{};
  std::size_t size_{0};
};

// Live parsing validates a complete frame before presenting it to the outer terminal.
[[nodiscard]] auto
process_server_messages(protocol::ServerDecoder& decoder, const int terminal_descriptor,
                        diagnostic::LatencyTraceMarkerMatcher& output_trace_matcher,
                        std::uint64_t& pending_trace_correlation,
                        LiveDiagnostic& live_diagnostic) noexcept -> ServerParseResult {
  while (true) {
    const auto decoded = decoder.next();
    if (!decoded.has_value()) {
      live_diagnostic.record_protocol_error(decoded.error());
      return ServerParseResult::error;
    }
    if (!decoded->has_value()) {
      return ServerParseResult::keep;
    }
    const auto& message = **decoded;
    if (message.kind == protocol::ServerMessageKind::hello) {
      live_diagnostic.record_protocol_error(protocol::DecodeError::invalid_kind);
      return ServerParseResult::error;
    }
    if (message.kind == protocol::ServerMessageKind::disconnect) {
      live_diagnostic.record_disconnect(message);
      decoder.consume();
      return ServerParseResult::disconnect;
    }

    std::uint64_t trace_correlation = 0;
#ifdef LEMMA_ENABLE_LATENCY_TRACE
    trace_correlation =
        output_trace_matcher.observe_expected_visible(message.ansi, pending_trace_correlation);
    if (trace_correlation != 0) {
      pending_trace_correlation = 0;
    }
#else
    static_cast<void>(output_trace_matcher);
    static_cast<void>(pending_trace_correlation);
#endif
    diagnostic::record_latency_trace(
        diagnostic::LatencyTraceStage::client_outer_terminal_write_started,
        static_cast<std::uint32_t>(terminal_descriptor), message.ansi.size(), trace_correlation);
    if (!write_terminal_interruptibly(terminal_descriptor, message.ansi)) {
      live_diagnostic.record_terminal_error();
      return ServerParseResult::error;
    }
    diagnostic::record_latency_trace(
        diagnostic::LatencyTraceStage::client_outer_terminal_write_finished,
        static_cast<std::uint32_t>(terminal_descriptor), message.ansi.size(), trace_correlation);
    decoder.consume();
  }
}

[[nodiscard]] auto receive_server(const int connection, protocol::ServerDecoder& decoder,
                                  const int terminal_descriptor,
                                  diagnostic::LatencyTraceMarkerMatcher& output_trace_matcher,
                                  std::uint64_t& pending_trace_correlation,
                                  LiveDiagnostic& live_diagnostic) noexcept -> ServerParseResult {
  const auto buffered = process_server_messages(decoder, terminal_descriptor, output_trace_matcher,
                                                pending_trace_correlation, live_diagnostic);
  if (buffered != ServerParseResult::keep) {
    return buffered;
  }
  auto available = decoder.writable_bytes();
  if (available.empty()) {
    live_diagnostic.record_protocol_error(protocol::DecodeError::buffer_full);
    return ServerParseResult::error;
  }
  const auto received = ::recv(connection, available.data(), available.size(), 0);
  if (received == 0) {
    return ServerParseResult::peer_closed;
  }
  if (received < 0) {
    if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) {
      return ServerParseResult::keep;
    }
    live_diagnostic.record_connection_error();
    return ServerParseResult::error;
  }
  const auto size = static_cast<std::size_t>(received);
  diagnostic::record_latency_trace(diagnostic::LatencyTraceStage::client_socket_read,
                                   static_cast<std::uint32_t>(connection), size, 0);
  const auto committed = decoder.commit(size);
  if (!committed.has_value()) {
    live_diagnostic.record_protocol_error(committed.error());
    return ServerParseResult::error;
  }
  return process_server_messages(decoder, terminal_descriptor, output_trace_matcher,
                                 pending_trace_correlation, live_diagnostic);
}

// This is the client reactor; branches correspond directly to terminal and socket readiness.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto attach_client(const daemon::RuntimeEndpoint& endpoint,
                                 const std::string_view session) -> int {
  diagnostic::set_latency_trace_role(diagnostic::LatencyTraceRole::attached_client);
  resize_pending = 0;
  termination_signal = 0;
  termination_wakeup_descriptor = -1;
  termination_wakeup_read_descriptor = -1;
  terminal_restore_wakeup_descriptor = -1;
  termination_render_descriptor = -1;
  termination_render_closed = 0;
  if (::isatty(STDIN_FILENO) == 0 || ::isatty(STDOUT_FILENO) == 0) {
    static_cast<void>(
        write_text_interruptibly(STDERR_FILENO, "lemma attach requires a terminal\n"));
    return 1;
  }

  protocol::ServerDecoder decoder;
  if (!decoder.prepare().has_value()) {
    static_cast<void>(
        write_text_interruptibly(STDERR_FILENO, "lemma attach decoder allocation failed\n"));
    return 1;
  }
  int connection = daemon::open_server_connection(endpoint);
  if (connection < 0) {
    static_cast<void>(
        write_text_interruptibly(STDERR_FILENO, "no lemma daemon; run `lemma new`\n"));
    return 1;
  }
  const auto size = terminal_size();
  const protocol::Dimensions dimensions{.columns = size.columns, .rows = size.rows};
  const auto hello = protocol::encode_client_hello(session, dimensions);
  if (!send_interruptibly(connection, hello.bytes()) ||
      receive_handshake(connection, decoder, dimensions) != HandshakeResult::accepted) {
    close_descriptor(connection);
    return 1;
  }

  SignalWakeup termination_wakeup;
  if (!termination_wakeup.install()) {
    close_descriptor(connection);
    return 1;
  }
  SignalActions signal_actions;
  if (!signal_actions.install()) {
    close_descriptor(connection);
    return 1;
  }

  bool clean_detach = false;
  bool typed_disconnect = false;
  bool protocol_failure = false;
  bool terminal_setup_succeeded = false;
  LiveDiagnostic live_diagnostic;
  std::uint32_t client_sequence = 2;
  {
    // Declare presentation state first so RawTerminal's final restoration runs before any bounded
    // presentation-output cleanup. The signal path restores explicitly, while reverse destruction
    // ordering preserves the same termios-before-presentation boundary on every other exit.
    OuterTerminal outer_terminal;
    platform::RawTerminal raw_terminal;
    const bool raw_terminal_entered = raw_terminal.enter(STDIN_FILENO);
    if (raw_terminal_entered) {
      terminal_restore_wakeup_descriptor = raw_terminal.restore_wakeup_descriptor();
    }
    terminal_setup_succeeded = raw_terminal_entered && outer_terminal.enter();
    if (terminal_setup_succeeded) {
      termination_render_descriptor = outer_terminal.render_descriptor();
    }

    protocol::PrefixParser prefix_parser;
    std::array<std::byte, protocol::input_bytes_max> input{};
    std::array<std::byte, protocol::input_bytes_max * 2U> encoded_input{};
#ifdef LEMMA_ENABLE_LATENCY_TRACE
    diagnostic::LatencyTraceMarkerMatcher input_trace_matcher;
#endif
    diagnostic::LatencyTraceMarkerMatcher output_trace_matcher;
    std::uint64_t pending_trace_correlation = 0;
    auto prefix_deadline = std::chrono::steady_clock::time_point{};
    bool attached = terminal_setup_succeeded;
    while (attached && termination_signal == 0) {
      const auto buffered =
          process_server_messages(decoder, outer_terminal.render_descriptor(), output_trace_matcher,
                                  pending_trace_correlation, live_diagnostic);
      if (buffered == ServerParseResult::disconnect) {
        typed_disconnect = true;
        break;
      }
      if (buffered == ServerParseResult::error) {
        protocol_failure = true;
        break;
      }

      if (resize_pending != 0) {
        resize_pending = 0;
        if (!send_resize(connection, terminal_size(), client_sequence)) {
          break;
        }
      }

      int poll_timeout = -1;
      if (prefix_parser.has_pending_escape_sequence()) {
        const auto now = std::chrono::steady_clock::now();
        if (now >= prefix_deadline) {
          const auto flushed = prefix_parser.flush_pending(encoded_input);
          if (flushed != 0 &&
              !send_input(connection, std::span(encoded_input).first(flushed), client_sequence)) {
            break;
          }
        } else {
          const auto remaining =
              std::chrono::duration_cast<std::chrono::milliseconds>(prefix_deadline - now);
          poll_timeout = static_cast<int>(std::max(remaining.count(), std::int64_t{1}));
        }
      }

      std::array<pollfd, 3> descriptors{{
          {.fd = STDIN_FILENO, .events = POLLIN, .revents = 0},
          {.fd = termination_wakeup.descriptor(), .events = POLLIN, .revents = 0},
          {.fd = connection, .events = POLLIN, .revents = 0},
      }};
      const auto poll_result = ::poll(descriptors.data(), descriptors.size(), poll_timeout);
      if (poll_result < 0) {
        if (errno == EINTR) {
          continue;
        }
        break;
      }

      const auto& input_events = descriptors.front();
      const auto& wakeup_events = std::span(descriptors).subspan(1, 1).front();
      const auto& server_events = descriptors.back();
      if ((wakeup_events.revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
        termination_wakeup.drain();
        if (termination_signal != 0) {
          break;
        }
      }
      if ((server_events.revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
        const auto received =
            receive_server(connection, decoder, outer_terminal.render_descriptor(),
                           output_trace_matcher, pending_trace_correlation, live_diagnostic);
        if (received == ServerParseResult::disconnect) {
          typed_disconnect = true;
          break;
        }
        if (received == ServerParseResult::peer_closed) {
          break;
        }
        if (received == ServerParseResult::error) {
          protocol_failure = true;
          break;
        }
      }

      if ((input_events.revents & POLLIN) != 0) {
        const auto bytes_read = ::read(STDIN_FILENO, input.data(), input.size());
        if (bytes_read <= 0) {
          break;
        }
        const auto input_size = static_cast<std::size_t>(bytes_read);
        std::uint64_t trace_correlation = 0;
#ifdef LEMMA_ENABLE_LATENCY_TRACE
        trace_correlation = input_trace_matcher.observe(std::span(input).first(input_size));
        if (trace_correlation != 0) {
          pending_trace_correlation = trace_correlation;
        }
#endif
        diagnostic::record_latency_trace(diagnostic::LatencyTraceStage::client_physical_input_read,
                                         static_cast<std::uint32_t>(STDIN_FILENO), input_size,
                                         trace_correlation);
        const auto parsed = prefix_parser.parse(std::span(input).first(input_size), encoded_input);
        if (!send_prefixed_input(connection, parsed, std::span(encoded_input).first(parsed.bytes),
                                 client_sequence)) {
          break;
        }
        if (prefix_parser.has_pending_escape_sequence()) {
          prefix_deadline = std::chrono::steady_clock::now() + prefix_flush_delay;
        }
        if (parsed.detach) {
          clean_detach = send_small_message(connection, protocol::encode_detach(client_sequence),
                                            client_sequence);
          attached = false;
        }
      }
    }
    if (termination_signal != 0) {
      // The signal handler has already retired the saturated writer using only async-signal-safe
      // operations. Synchronize the presentation guard before helper pipes can reuse that fd.
      outer_terminal.adopt_signal_render_retirement();
      const auto restoration_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
      // Discard the retired writer's blocked queue through the retained nonblocking cleanup
      // endpoint before asking any termios strategy to make progress.
      outer_terminal.abort_render_output();
      // The emergency restorer now runs nonblocking without the saturated writer held open. Give it
      // a bounded interval to report a confirmed restore before invoking foreground or detached
      // fallbacks that may consume the rest of the same end-to-end deadline.
      const auto emergency_deadline = std::min(
          restoration_deadline, std::chrono::steady_clock::now() + std::chrono::milliseconds(250));
      bool termios_restored = raw_terminal.wait_for_emergency_restore(emergency_deadline);
      if (!termios_restored && std::chrono::steady_clock::now() < restoration_deadline) {
        termios_restored = raw_terminal.restore();
      }
      outer_terminal.retire_render_writer();
      if (!termios_restored && std::chrono::steady_clock::now() < restoration_deadline) {
        termios_restored = raw_terminal.restore_bounded(restoration_deadline);
      }
      if (!termios_restored) {
        // RawTerminal's immediately following destructor retains one final bounded attempt. Avoid
        // placing it behind the emergency presentation write, then terminate on persistent failure.
        outer_terminal.suppress_signal_cleanup();
      }
    }
    terminal_restore_wakeup_descriptor = -1;
    termination_render_descriptor = -1;
  }

  close_descriptor(connection);
  if (termination_signal != 0) {
    return 128 + termination_signal;
  }
  if (!terminal_setup_succeeded) {
    return 1;
  }
  if ((typed_disconnect || protocol_failure) && !live_diagnostic.empty()) {
    static_cast<void>(write_text_interruptibly(STDERR_FILENO, live_diagnostic.view()));
  }
  if (!clean_detach && !typed_disconnect && !protocol_failure) {
    static_cast<void>(
        write_text_interruptibly(STDERR_FILENO, "lemma session ended or connection was lost\n"));
  }
  return clean_detach ? 0 : 1;
}

} // namespace

[[nodiscard]] auto attach(const daemon::RuntimeEndpoint& endpoint, const std::string_view session)
    -> int {
  return daemon::validate_session(session) ? attach_client(endpoint, session) : 1;
}

} // namespace lemma::client
