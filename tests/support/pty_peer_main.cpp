#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <span>
#include <string_view>
#include <thread>

#include <fcntl.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <termios.h>
#include <unistd.h>

namespace {

using namespace std::chrono_literals;

[[nodiscard]] auto write_all(const std::string_view text) noexcept -> bool {
  std::size_t offset = 0;
  while (offset < text.size()) {
    const auto remaining = std::span(text).subspan(offset);
    const auto written = ::write(STDOUT_FILENO, remaining.data(), remaining.size());
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

[[nodiscard]] auto write_all_until(const std::string_view text,
                                   const std::chrono::steady_clock::time_point deadline) noexcept
    -> bool {
  std::size_t offset = 0;
  while (offset < text.size()) {
    const auto remaining = std::span(text).subspan(offset);
    const auto written = ::write(STDOUT_FILENO, remaining.data(), remaining.size());
    if (written > 0) {
      offset += static_cast<std::size_t>(written);
      continue;
    }
    if (written < 0 && errno == EINTR) {
      continue;
    }
    if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) &&
        std::chrono::steady_clock::now() < deadline) {
      pollfd event{.fd = STDOUT_FILENO, .events = POLLOUT, .revents = 0};
      const auto time_left = std::chrono::duration_cast<std::chrono::milliseconds>(
          deadline - std::chrono::steady_clock::now());
      const auto timeout = static_cast<int>(std::max(time_left.count(), std::int64_t{1}));
      const auto polled = ::poll(&event, 1, timeout);
      if (polled > 0 || (polled < 0 && errno == EINTR)) {
        continue;
      }
    }
    return false;
  }
  return true;
}

[[nodiscard]] auto enter_raw_input() noexcept -> bool {
  termios state{};
  if (::tcgetattr(STDIN_FILENO, &state) != 0) {
    return false;
  }
  ::cfmakeraw(&state);
  return ::tcsetattr(STDIN_FILENO, TCSANOW, &state) == 0;
}

[[nodiscard]] auto wait_for_gate(const char* const path) noexcept -> bool {
  const auto deadline = std::chrono::steady_clock::now() + 15s;
  while (std::chrono::steady_clock::now() < deadline) {
    if (::access(path, F_OK) == 0) {
      return true;
    }
    if (errno != ENOENT) {
      return false;
    }
    std::this_thread::sleep_for(1ms);
  }
  return false;
}

[[nodiscard]] auto parse_size(const std::string_view value) noexcept -> std::size_t {
  std::size_t size = 0;
  const auto input = std::span(value);
  const auto* const end = std::to_address(input.end());
  const auto result = std::from_chars(input.data(), end, size);
  return result.ec == std::errc{} && result.ptr == end ? size : 0;
}

[[nodiscard]] auto read_exact_digest(const std::size_t expected, std::uint64_t& digest,
                                     std::size_t& received) noexcept -> bool {
  constexpr std::uint64_t offset_basis = 14'695'981'039'346'656'037ULL;
  constexpr std::uint64_t prime = 1'099'511'628'211ULL;
  digest = offset_basis;
  received = 0;
  std::array<std::byte, std::size_t{16} * 1'024U> bytes{};
  const auto deadline = std::chrono::steady_clock::now() + 30s;
  while (received < expected && std::chrono::steady_clock::now() < deadline) {
    pollfd event{.fd = STDIN_FILENO, .events = POLLIN, .revents = 0};
    const auto remaining = expected - received;
    const auto polled = ::poll(&event, 1, 100);
    if (polled < 0 && errno == EINTR) {
      continue;
    }
    if (polled <= 0) {
      continue;
    }
    const auto count = ::read(STDIN_FILENO, bytes.data(), std::min(bytes.size(), remaining));
    if (count > 0) {
      const auto size = static_cast<std::size_t>(count);
      for (const auto byte : std::span(bytes).first(size)) {
        digest ^= std::to_integer<std::uint8_t>(byte);
        digest *= prime;
      }
      received += size;
      continue;
    }
    if (count < 0 && errno == EINTR) {
      continue;
    }
    return false;
  }
  return received == expected;
}

void linger_for_render() noexcept { std::this_thread::sleep_for(250ms); }

[[nodiscard]] auto run_block(const char* const gate, const std::size_t bytes) noexcept -> int {
  if (bytes == 0 || bytes > std::size_t{8} * 1'024U * 1'024U || !enter_raw_input() ||
      !write_all("\r\n__LEMMA_PTY_READY__\r\n") || !wait_for_gate(gate)) {
    return 1;
  }
  std::uint64_t digest = 0;
  std::size_t received = 0;
  if (!read_exact_digest(bytes, digest, received)) {
    std::array<char, 32> received_text{};
    const auto received_storage = std::span(received_text);
    const auto encoded =
        std::to_chars(received_storage.data(), std::to_address(received_storage.end()), received);
    static_cast<void>(write_all("\r\n__LEMMA_PTY_FAILED__ received="));
    if (encoded.ec == std::errc{}) {
      static_cast<void>(write_all(
          {received_text.data(), static_cast<std::size_t>(encoded.ptr - received_text.data())}));
    }
    static_cast<void>(write_all("\r\n"));
    linger_for_render();
    return 1;
  }
  std::array<char, 32> digest_text{};
  const auto digest_storage = std::span(digest_text);
  const auto encoded =
      std::to_chars(digest_storage.data(), std::to_address(digest_storage.end()), digest, 16);
  if (encoded.ec != std::errc{}) {
    return 1;
  }
  std::array<char, 32> count_text{};
  const auto count_storage = std::span(count_text);
  const auto count =
      std::to_chars(count_storage.data(), std::to_address(count_storage.end()), bytes);
  if (count.ec != std::errc{}) {
    return 1;
  }
  const bool written =
      write_all("\r\n__LEMMA_PTY_DONE__ bytes=") &&
      write_all({count_text.data(), static_cast<std::size_t>(count.ptr - count_text.data())}) &&
      write_all(" digest=") &&
      write_all({digest_text.data(), static_cast<std::size_t>(encoded.ptr - digest_text.data())}) &&
      write_all("\r\n");
  linger_for_render();
  return written ? 0 : 1;
}

// This test peer keeps every ordering failure explicit for bounded diagnostics.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto run_order(const char* const gate, const std::string_view user_input) noexcept
    -> int {
  if (user_input.empty() || user_input.size() > 1'024U || !enter_raw_input() ||
      !write_all("\x1B[5n") || !write_all("\r\n__LEMMA_ORDER_READY__\r\n") ||
      !wait_for_gate(gate)) {
    return 1;
  }
  constexpr std::string_view response = "\x1B[0n";
  std::array<char, 1'028> received{};
  const auto expected = response.size() + user_input.size();
  std::size_t offset = 0;
  const auto deadline = std::chrono::steady_clock::now() + 2s;
  while (offset < expected && std::chrono::steady_clock::now() < deadline) {
    pollfd event{.fd = STDIN_FILENO, .events = POLLIN, .revents = 0};
    if (::poll(&event, 1, 100) <= 0) {
      continue;
    }
    auto remaining = std::span(received).subspan(offset, expected - offset);
    const auto count = ::read(STDIN_FILENO, remaining.data(), remaining.size());
    if (count > 0) {
      offset += static_cast<std::size_t>(count);
      continue;
    }
    if (count < 0 && errno == EINTR) {
      continue;
    }
    return 1;
  }
  const std::string_view actual(received.data(), offset);
  const bool matches = offset == expected &&
                       std::ranges::equal(std::span(actual).first(response.size()), response) &&
                       std::ranges::equal(std::span(actual).subspan(response.size()), user_input);
  if (!matches) {
    static_cast<void>(write_all("\r\n__LEMMA_ORDER_FAILED__ bytes="));
    for (const char character : actual) {
      const auto byte = static_cast<unsigned char>(character);
      std::array<char, 2> encoded{};
      constexpr std::string_view digits = "0123456789abcdef";
      encoded.front() = std::span(digits).subspan(byte >> 4U, 1).front();
      encoded.back() = std::span(digits).subspan(byte & 0x0FU, 1).front();
      static_cast<void>(write_all({encoded.data(), encoded.size()}));
    }
    static_cast<void>(write_all("\r\n"));
    linger_for_render();
    return 1;
  }
  const bool written = write_all("\r\n__LEMMA_ORDER_OK__\r\n");
  linger_for_render();
  return written ? 0 : 1;
}

[[nodiscard]] auto write_background_line() noexcept -> bool {
  constexpr std::string_view line =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopq\r\n";
  static_assert(line.size() == 81);
  const auto written = ::write(STDOUT_FILENO, line.data(), line.size());
  return written >= 0 || errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK;
}

[[nodiscard]] auto make_output_nonblocking() noexcept -> bool {
  // fcntl is variadic even when F_GETFL has no third argument.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const auto flags = ::fcntl(STDOUT_FILENO, F_GETFL);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  return flags >= 0 && ::fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK) == 0;
}

// Keep resize stress independent of interactive-shell job-control and signal timing.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto run_resize_flood() noexcept -> int {
  termios original_terminal{};
  if (::tcgetattr(STDIN_FILENO, &original_terminal) != 0) {
    return 1;
  }
  auto raw_terminal = original_terminal;
  ::cfmakeraw(&raw_terminal);
  // fcntl is variadic even when F_GETFL has no third argument.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const auto output_flags = ::fcntl(STDOUT_FILENO, F_GETFL);
  bool output_nonblocking = false;
  if (output_flags >= 0) {
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    output_nonblocking = ::fcntl(STDOUT_FILENO, F_SETFL, output_flags | O_NONBLOCK) == 0;
  }
  if (output_flags < 0 || ::tcsetattr(STDIN_FILENO, TCSANOW, &raw_terminal) != 0 ||
      !write_all("\r\n__LEMMA_RESIZE_FLOOD__\r\n") || !output_nonblocking) {
    return 1;
  }

  bool stopped = false;
  // This is only a leaked-peer lifetime guard; the test's existing assertion deadlines stay fixed.
  const auto deadline = std::chrono::steady_clock::now() + 60s;
  while (!stopped && std::chrono::steady_clock::now() < deadline) {
    pollfd event{.fd = STDIN_FILENO, .events = POLLIN, .revents = 0};
    const auto polled = ::poll(&event, 1, 1);
    if (polled < 0 && errno == EINTR) {
      continue;
    }
    if (polled < 0) {
      break;
    }
    if (polled > 0 && (event.revents & POLLIN) != 0) {
      std::array<char, 64> input{};
      const auto count = ::read(STDIN_FILENO, input.data(), input.size());
      if (count > 0) {
        const auto received = std::span(input).first(static_cast<std::size_t>(count));
        stopped = std::ranges::find(received, 'q') != received.end();
      } else if (count == 0 || errno != EINTR) {
        break;
      }
    }
    if (!stopped && !write_background_line()) {
      break;
    }
  }

  // fcntl and ioctl are variadic because their final argument depends on the request.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const bool output_restored = ::fcntl(STDOUT_FILENO, F_SETFL, output_flags) == 0;
  const bool terminal_restored = ::tcsetattr(STDIN_FILENO, TCSANOW, &original_terminal) == 0;
  winsize size{};
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const bool size_read = ::ioctl(STDIN_FILENO, TIOCGWINSZ, &size) == 0;
  if (!stopped || !output_restored || !terminal_restored || !size_read) {
    return 1;
  }

  std::array<char, 16> rows{};
  std::array<char, 16> columns{};
  const auto encoded_rows = std::to_chars(rows.data(), std::to_address(rows.end()), size.ws_row);
  const auto encoded_columns =
      std::to_chars(columns.data(), std::to_address(columns.end()), size.ws_col);
  if (encoded_rows.ec != std::errc{} || encoded_columns.ec != std::errc{} ||
      !write_all("\r\n__LEMMA_RESIZE_FINAL__ ") ||
      !write_all({rows.data(), static_cast<std::size_t>(encoded_rows.ptr - rows.data())}) ||
      !write_all(" ") ||
      !write_all(
          {columns.data(), static_cast<std::size_t>(encoded_columns.ptr - columns.data())}) ||
      !write_all("\r\n")) {
    return 1;
  }
  linger_for_render();
  return 0;
}

// This benchmark peer keeps each framed receipt and echo bounded and explicit.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto run_latency(const std::string_view receipt_path,
                               const bool autonomous_output = false) noexcept -> int {
  if (receipt_path.empty()) {
    return 1;
  }
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  if (receipt_path.size() >= sizeof(address.sun_path)) {
    return 1;
  }
  std::memcpy(std::span(address.sun_path).data(), receipt_path.data(), receipt_path.size());
  const int receipt = ::socket(AF_UNIX, SOCK_DGRAM, 0);
  if (receipt < 0) {
    return 1;
  }
  // The socket ABI intentionally erases the concrete address type.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const auto* generic = reinterpret_cast<const sockaddr*>(&address);
  const std::string_view ready = autonomous_output ? "\r\n__LEMMA_LATENCY_OUTPUT_READY__\r\n"
                                                   : "\r\n__LEMMA_LATENCY_READY__\r\n";
  if (::connect(receipt, generic, sizeof(address)) != 0 || !enter_raw_input() ||
      !write_all(ready) || (autonomous_output && !make_output_nonblocking())) {
    static_cast<void>(::close(receipt));
    return 1;
  }

  std::array<char, 128> marker{};
  std::size_t marker_size = 0;
  auto deadline = std::chrono::steady_clock::now() + 120s;
  while (std::chrono::steady_clock::now() < deadline) {
    pollfd event{.fd = STDIN_FILENO, .events = POLLIN, .revents = 0};
    // Keep autonomous output near 1 kHz, but block on input until the next output deadline. A
    // zero-time poll followed by sleep made token acknowledgement wait for the sleep and measured
    // fixture scheduling rather than mux latency.
    const auto polled = ::poll(&event, 1, autonomous_output ? 1 : 100);
    if (polled < 0 && errno == EINTR) {
      continue;
    }
    if (polled < 0) {
      static_cast<void>(::close(receipt));
      return 1;
    }
    if (polled == 0) {
      if (autonomous_output && !write_background_line()) {
        static_cast<void>(::close(receipt));
        return 1;
      }
      continue;
    }
    std::array<char, 128> input{};
    const auto count = ::read(STDIN_FILENO, input.data(), input.size());
    if (count == 0) {
      static_cast<void>(::close(receipt));
      return 0;
    }
    if (count < 0 && errno == EINTR) {
      continue;
    }
    if (count < 0) {
      static_cast<void>(::close(receipt));
      return 1;
    }
    deadline = std::chrono::steady_clock::now() + 120s;
    bool marker_echo_written = false;
    for (const char byte : std::span(input).first(static_cast<std::size_t>(count))) {
      if (byte != '\n') {
        if (marker_size == marker.size()) {
          static_cast<void>(::close(receipt));
          return 1;
        }
        std::span(marker).subspan(marker_size, 1).front() = byte;
        ++marker_size;
        continue;
      }
      if (marker_size == 0) {
        static_cast<void>(::close(receipt));
        return 1;
      }
      const auto frame = std::string_view(marker.data(), marker_size);
      const auto sent = ::send(receipt, frame.data(), frame.size(), MSG_NOSIGNAL);
      if (sent < 0) {
        static_cast<void>(::close(receipt));
        return 1;
      }
      const auto sent_size = static_cast<std::size_t>(sent);
      bool output_written = false;
      if (autonomous_output) {
        const auto visibility_deadline = std::chrono::steady_clock::now() + 1s;
        output_written = write_all_until(frame, visibility_deadline) &&
                         write_all_until("\r\n", visibility_deadline);
      } else {
        output_written = write_all(frame) && write_all("\r\n");
      }
      if (sent_size != marker_size || !output_written) {
        static_cast<void>(::close(receipt));
        return 1;
      }
      marker_size = 0;
      marker_echo_written = true;
    }
    if (autonomous_output && marker_echo_written) {
      // A single 81-byte background row can scroll a token out of a small split pane before the
      // daemon's delayed frame is composed. Preserve the active load, but leave a bounded rendering
      // opportunity after each controlled visibility checkpoint. The receipt lets the harness keep
      // this pause outside the next measured interval.
      std::this_thread::sleep_for(20ms);
      constexpr std::string_view next = "__LEMMA_LATENCY_NEXT__";
      const auto sent = ::send(receipt, next.data(), next.size(), MSG_NOSIGNAL);
      if (sent < 0 || static_cast<std::size_t>(sent) != next.size()) {
        static_cast<void>(::close(receipt));
        return 1;
      }
    } else if (autonomous_output && !write_background_line()) {
      static_cast<void>(::close(receipt));
      return 1;
    }
  }
  static_cast<void>(::close(receipt));
  return 1;
}

[[nodiscard]] auto run_attach_visible(const std::string_view ready_path = {}) noexcept -> int {
  if (!write_all("__LEMMA_ATTACH_VISIBLE__\r\n")) {
    return 1;
  }
  if (!ready_path.empty()) {
    std::array<char, 1'024> path{};
    if (ready_path.size() >= path.size()) {
      return 1;
    }
    std::ranges::copy(ready_path, path.begin());
    // open is variadic when O_CREAT supplies a mode.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    const auto ready = ::open(path.data(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (ready < 0) {
      return 1;
    }
    const bool announced = ::write(ready, "1", 1) == 1;
    const bool closed = ::close(ready) == 0;
    if (!announced || !closed) {
      return 1;
    }
  }
  // Keep the fixture in the foreground so a shell prompt cannot mutate the retained attach frame.
  std::this_thread::sleep_for(120s);
  return 0;
}

[[nodiscard]] auto run_warm_scroll() noexcept -> int {
  std::array<char, 81> line{};
  line.fill('x');
  std::span(line).subspan(79, 1).front() = '\r';
  std::span(line).subspan(80, 1).front() = '\n';
  for (std::size_t index = 0; index < 25'000; ++index) {
    if (!write_all({line.data(), line.size()})) {
      return 1;
    }
  }
  const bool written = write_all("__LEMMA_WARM_SCROLL_DONE__\r\n");
  return written ? 0 : 1;
}

} // namespace

// Command dispatch is deliberately explicit so invalid argument shapes remain rejected.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
int main(const int argc, char** const argv) {
  const auto arguments = std::span(argv, static_cast<std::size_t>(argc));
  if (arguments.size() == 2 &&
      std::string_view(arguments.subspan(1, 1).front()) == "attach-visible") {
    return run_attach_visible();
  }
  if (arguments.size() == 3 &&
      std::string_view(arguments.subspan(1, 1).front()) == "attach-visible") {
    return run_attach_visible(arguments.subspan(2, 1).front());
  }
  if (arguments.size() == 2 && std::string_view(arguments.subspan(1, 1).front()) == "warm-scroll") {
    return run_warm_scroll();
  }
  if (arguments.size() == 2 &&
      std::string_view(arguments.subspan(1, 1).front()) == "resize-flood") {
    return run_resize_flood();
  }
  if (arguments.size() == 3 && std::string_view(arguments.subspan(1, 1).front()) == "latency") {
    return run_latency(arguments.subspan(2, 1).front());
  }
  if (arguments.size() == 3 &&
      std::string_view(arguments.subspan(1, 1).front()) == "latency-output") {
    return run_latency(arguments.subspan(2, 1).front(), true);
  }
  if (arguments.size() == 4 && std::string_view(arguments.subspan(1, 1).front()) == "block") {
    return run_block(arguments.subspan(2, 1).front(), parse_size(arguments.subspan(3, 1).front()));
  }
  if (arguments.size() == 4 && std::string_view(arguments.subspan(1, 1).front()) == "order") {
    return run_order(arguments.subspan(2, 1).front(), arguments.subspan(3, 1).front());
  }
  return 2;
}
