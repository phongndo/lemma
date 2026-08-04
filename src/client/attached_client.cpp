#include "client/attached_client.hpp"

#include "daemon/server.hpp"
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
#include <span>
#include <string_view>

#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

namespace lemma::client {
namespace {

constexpr auto response_ready = protocol::wire_byte(protocol::ControlResponse::ready);
constexpr auto response_busy = protocol::wire_byte(protocol::ControlResponse::busy);
constexpr auto response_missing = protocol::wire_byte(protocol::ControlResponse::missing);
constexpr auto prefix_flush_delay = std::chrono::milliseconds(50);
using platform::close_descriptor;
using platform::read_exact;
using platform::send_all;
using platform::write_all;
using platform::write_text;

volatile sig_atomic_t resize_pending = 0;

void on_window_changed([[maybe_unused]] const int signal_number) noexcept { resize_pending = 1; }

[[nodiscard]] auto terminal_size() noexcept -> platform::WindowSize {
  return platform::terminal_size(STDOUT_FILENO, protocol::columns_max, protocol::rows_max);
}

[[nodiscard]] auto send_resize(const int connection, const platform::WindowSize size) noexcept
    -> bool {
  return send_all(connection, protocol::encode_resize({
                                  .columns = size.columns,
                                  .rows = size.rows,
                              }));
}

[[nodiscard]] auto send_input(const int connection, const std::span<const std::byte> input) noexcept
    -> bool {
  const auto header = protocol::encode_input_header(input.size());
  return send_all(connection, header) && send_all(connection, input);
}

[[nodiscard]] auto send_prefixed_input(const int connection, const protocol::PrefixResult& parsed,
                                       const std::span<const std::byte> input) noexcept -> bool {
  std::size_t sent = 0;
  for (const auto& action : std::span(parsed.actions).first(parsed.action_count)) {
    LEMMA_ASSERT(action.input_bytes >= sent);
    LEMMA_ASSERT(action.input_bytes <= input.size());
    const auto ordinary_input = input.subspan(sent, action.input_bytes - sent);
    if ((!ordinary_input.empty() && !send_input(connection, ordinary_input)) ||
        !send_all(connection, protocol::encode_pane_command(action.command))) {
      return false;
    }
    sent = action.input_bytes;
  }
  const auto remaining = input.subspan(sent);
  return remaining.empty() || send_input(connection, remaining);
}

[[nodiscard]] auto send_attach_handshake(const int connection, const std::string_view session,
                                         const platform::WindowSize& size) noexcept -> bool {
  const auto header = protocol::encode_session_header(protocol::ControlCommand::attach, session);
  const auto dimensions = protocol::encode_dimensions({
      .columns = size.columns,
      .rows = size.rows,
  });
  return send_all(connection, header) &&
         send_all(connection, std::as_bytes(std::span(session.data(), session.size()))) &&
         send_all(connection, dimensions);
}

// This is the client reactor; branches correspond directly to terminal and socket readiness.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto attach_client(const daemon::RuntimeEndpoint& endpoint,
                                 const std::string_view session) -> int {
  if (::isatty(STDIN_FILENO) == 0 || ::isatty(STDOUT_FILENO) == 0) {
    static_cast<void>(write_text(STDERR_FILENO, "lemma attach requires a terminal\n"));
    return 1;
  }

  int connection = daemon::open_server_connection(endpoint);
  if (connection < 0) {
    static_cast<void>(write_text(STDERR_FILENO, "no lemma daemon; run `lemma new`\n"));
    return 1;
  }
  if (!send_attach_handshake(connection, session, terminal_size())) {
    close_descriptor(connection);
    return 1;
  }

  std::array<std::byte, 1> response{};
  if (!read_exact(connection, response) || response.front() != response_ready) {
    std::string_view message = "lemma attach failed\n";
    if (response.front() == response_busy) {
      message = "lemma session is already attached\n";
    } else if (response.front() == response_missing) {
      message = "no lemma session\n";
    }
    static_cast<void>(write_text(STDERR_FILENO, message));
    close_descriptor(connection);
    return 1;
  }

  platform::RawTerminal raw_terminal;
  if (!raw_terminal.enter(STDIN_FILENO)) {
    close_descriptor(connection);
    return 1;
  }

  struct sigaction action{};
  struct sigaction previous_action{};
  action.sa_handler = &on_window_changed;
  static_cast<void>(sigemptyset(&action.sa_mask));
  action.sa_flags = 0;
  static_cast<void>(::sigaction(SIGWINCH, &action, &previous_action));

  static_cast<void>(write_text(STDOUT_FILENO, "\x1B[?1049h\x1B[2J\x1B[H"));
  protocol::PrefixParser prefix_parser;
  std::array<std::byte, protocol::input_bytes_max> input{};
  std::array<std::byte, protocol::input_bytes_max * 2U> encoded_input{};
  std::array<std::byte, std::size_t{64} * 1'024U> output{};
  auto prefix_deadline = std::chrono::steady_clock::time_point{};
  bool attached = true;
  while (attached) {
    if (resize_pending != 0) {
      resize_pending = 0;
      if (!send_resize(connection, terminal_size())) {
        break;
      }
    }

    int poll_timeout = -1;
    if (prefix_parser.has_pending_escape_sequence()) {
      const auto now = std::chrono::steady_clock::now();
      if (now >= prefix_deadline) {
        const auto flushed = prefix_parser.flush_pending(encoded_input);
        if (flushed != 0 && !send_input(connection, std::span(encoded_input).first(flushed))) {
          break;
        }
      } else {
        const auto remaining =
            std::chrono::duration_cast<std::chrono::milliseconds>(prefix_deadline - now);
        poll_timeout = static_cast<int>(std::max(remaining.count(), std::int64_t{1}));
      }
    }

    std::array<pollfd, 2> descriptors{{
        {.fd = STDIN_FILENO, .events = POLLIN, .revents = 0},
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
    const auto& server_events = descriptors.back();
    if ((server_events.revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
      const auto bytes_read = ::recv(connection, output.data(), output.size(), 0);
      if (bytes_read <= 0 || !write_all(STDOUT_FILENO, std::span(output).first(
                                                           static_cast<std::size_t>(bytes_read)))) {
        break;
      }
    }

    if ((input_events.revents & POLLIN) != 0) {
      const auto bytes_read = ::read(STDIN_FILENO, input.data(), input.size());
      if (bytes_read <= 0) {
        break;
      }
      const auto parsed = prefix_parser.parse(
          std::span(input).first(static_cast<std::size_t>(bytes_read)), encoded_input);
      if (!send_prefixed_input(connection, parsed, std::span(encoded_input).first(parsed.bytes))) {
        break;
      }
      if (prefix_parser.has_pending_escape_sequence()) {
        prefix_deadline = std::chrono::steady_clock::now() + prefix_flush_delay;
      }
      if (parsed.detach) {
        static_cast<void>(send_all(connection, protocol::encode_detach()));
        attached = false;
      }
    }
  }

  static_cast<void>(::sigaction(SIGWINCH, &previous_action, nullptr));
  constexpr std::string_view restore_terminal =
      "\x1B[0m\x1B[?2026l\x1B[?1l\x1B[?9l\x1B[?1000l\x1B[?1002l\x1B[?1003l"
      "\x1B[?1004l\x1B[?1005l\x1B[?1006l\x1B[?1007l\x1B[?1015l\x1B[?1016l"
      "\x1B[?2004l\x1B[?25h\x1B[?7h\x1B[?1049l";
  static_cast<void>(write_text(STDOUT_FILENO, restore_terminal));
  close_descriptor(connection);
  return 0;
}

} // namespace

[[nodiscard]] auto attach(const daemon::RuntimeEndpoint& endpoint, const std::string_view session)
    -> int {
  return daemon::validate_session(session) ? attach_client(endpoint, session) : 1;
}

} // namespace lemma::client
