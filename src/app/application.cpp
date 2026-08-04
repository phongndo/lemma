#include "app/application.hpp"

#include "client/attached_client.hpp"
#include "daemon/server.hpp"
#include "lemma/terminal/terminal.hpp"
#include "lemma/version.hpp"

#include <array>
#include <charconv>
#include <cstddef>
#include <cstdio>
#include <iterator>
#include <span>
#include <string_view>
#include <system_error>
#include <utility>

namespace lemma::app {
namespace {

void write_text(lemma::vt::Terminal& terminal, const std::string_view text) noexcept {
  terminal.write(std::as_bytes(std::span(text.data(), text.size())));
}

[[nodiscard]] auto write_fragment(std::FILE* stream, const std::string_view text) noexcept -> bool {
  return std::fwrite(text.data(), 1, text.size(), stream) == text.size();
}

template <typename Integer>
[[nodiscard]] auto write_integer(std::FILE* stream, const Integer value) noexcept -> bool {
  std::array<char, 32> buffer{};
  const auto result = std::to_chars(buffer.begin(), buffer.end(), value);
  if (result.ec != std::errc{}) {
    return false;
  }
  const auto size = static_cast<std::size_t>(std::distance(buffer.begin(), result.ptr));
  return std::fwrite(buffer.data(), 1, size, stream) == size;
}

[[nodiscard]] auto write_summary(const lemma::vt::RenderUpdate& update,
                                 const lemma::vt::EffectBatch& effects,
                                 const lemma::vt::AllocationStats& stats) noexcept -> bool {
  return write_fragment(stdout, "\x1B[0m\n\nGhostty damage: ") &&
         write_integer(stdout, update.dirty_rows) && write_fragment(stdout, " rows; bells: ") &&
         write_integer(stdout, effects.bells) && write_fragment(stdout, "; terminal memory: ") &&
         write_integer(stdout, stats.bytes_current / 1'024U) && write_fragment(stdout, " KiB\n");
}

[[nodiscard]] auto run_demo() noexcept -> int {
  lemma::vt::TerminalOptions options;
  options.size = {
      .columns = 72,
      .rows = 12,
      .cell_width_px = 9,
      .cell_height_px = 18,
  };

  auto terminal_result = lemma::vt::Terminal::create(options);
  if (!terminal_result.has_value()) {
    static_cast<void>(write_fragment(stderr, "failed to create the demo terminal\n"));
    return 1;
  }
  auto terminal = std::move(*terminal_result);

  constexpr std::string_view screen =
      "\x1B]2;lemma demo\x1B\\"
      "\x1B[1;36mLemma\x1B[0m + \x1B[1;35mlibghostty-vt\x1B[0m\r\n"
      "\x1B[2mBounded, data-oriented terminal state\x1B[0m\r\n"
      "\r\n"
      "  \x1B[32m✓\x1B[0m ANSI colors and styles\r\n"
      "  \x1B[32m✓\x1B[0m Unicode: λ  你好  🚀\r\n"
      "  \x1B[32m✓\x1B[0m Dirty-row tracking and reflow\r\n"
      "  \x1B[32m✓\x1B[0m Bounded effect and PTY response queues\r\n"
      "\r\n"
      "progress: 10%\rprogress: \x1B[1;32m100%\x1B[0m\r\n"
      "\a\x1B[7m Next: PTY reactor and tmux-compatible key tables \x1B[0m";
  write_text(terminal, screen);

  const auto update = terminal.update_render_state();
  if (!update.has_value()) {
    static_cast<void>(write_fragment(stderr, "failed to update the demo render state\n"));
    return 1;
  }

  std::array<std::byte, std::size_t{64} * 1'024U> output{};
  const auto output_size = terminal.format_screen(lemma::vt::ScreenFormat::vt, output);
  if (!output_size.has_value()) {
    static_cast<void>(write_fragment(stderr, "failed to format the demo screen\n"));
    return 1;
  }

  const auto bytes_written = std::fwrite(output.data(), 1, *output_size, stdout);
  if (bytes_written != *output_size) {
    static_cast<void>(write_fragment(stderr, "failed to write the demo screen\n"));
    return 1;
  }

  const auto effects = terminal.take_effects();
  const auto stats = terminal.allocation_stats();
  return write_summary(*update, effects, stats) ? 0 : 1;
}

[[nodiscard]] auto print_usage(std::FILE* const stream) noexcept -> int {
  return write_fragment(
             stream,
             "Usage: lemma [command [session]]\n\nCommands:\n  new [name]      start and "
             "attach\n  start [name]    start detached\n  attach [name]   attach\n  list "
             "[name]     list all or one\n  tabs [name]     list tabs\n  kill [name]     stop "
             "one session\n  kill-all        stop every session\n  shutdown        show "
             "destructive "
             "shutdown warning\n  shutdown --confirm\n                  stop the daemon and every "
             "session\n"
             "  help            show this help\n  version         show build and "
             "protocol version\n  demo            VT demo\n\nWithout a command, Lemma creates or "
             "enters `default`. C-b % and C-b \" split panes; C-b c creates a tab; C-b n/p "
             "changes tabs; C-b d detaches.\n")
             ? 0
             : 1;
}

[[nodiscard]] auto print_version() noexcept -> int {
  return write_fragment(stdout, "lemma ") && write_fragment(stdout, lemma::version) &&
                 write_fragment(stdout, " (private protocol ") &&
                 write_fragment(stdout, lemma::private_protocol_version) &&
                 write_fragment(stdout, ")\n")
             ? 0
             : 1;
}

// CLI spellings deliberately converge on the small set of daemon/client operations.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto dispatch(const daemon::RuntimeEndpoint& endpoint, const std::string_view command,
                            const std::string_view session, const bool named) -> int {
  if ((command == "help" || command == "--help" || command == "-h") && !named) {
    return print_usage(stdout);
  }
  if ((command == "version" || command == "--version" || command == "-V") && !named) {
    return print_version();
  }
  if (command == "demo" && !named) {
    return run_demo();
  }
  if (command == "new") {
    return daemon::ensure(endpoint, session) == 0 ? client::attach(endpoint, session) : 1;
  }
  if (command == "start") {
    return daemon::start(endpoint, session);
  }
  if (command == "attach") {
    return client::attach(endpoint, session);
  }
  if (command == "list" || command == "ls" || command == "lookup") {
    return named ? daemon::list(endpoint, session) : daemon::list(endpoint);
  }
  if (command == "tabs") {
    return daemon::list_tabs(endpoint, session);
  }
  if (command == "kill") {
    return daemon::kill(endpoint, session);
  }
  if (command == "kill-all" && !named) {
    return daemon::kill_all(endpoint);
  }
  if (command == "shutdown") {
    constexpr std::string_view warning =
        "WARNING: daemon shutdown ends every session and its pane processes.\n";
    if (!named) {
      static_cast<void>(write_fragment(stderr, warning));
      static_cast<void>(write_fragment(stderr, "Re-run `lemma shutdown --confirm` to continue.\n"));
      return 1;
    }
    if (session == "--confirm") {
      if (!write_fragment(stderr, warning)) {
        return 1;
      }
      return daemon::shutdown(endpoint);
    }
  }
  static_cast<void>(write_fragment(stderr, "invalid lemma command or arguments: "));
  static_cast<void>(write_fragment(stderr, command));
  static_cast<void>(write_fragment(stderr, "\n"));
  static_cast<void>(print_usage(stderr));
  return 2;
}

} // namespace

[[nodiscard]] auto run(const daemon::RuntimeEndpoint& endpoint, const int argument_count,
                       char** argument_values) -> int {
  const std::span arguments(argument_values, static_cast<std::size_t>(argument_count));
  if (arguments.size() == 1) {
    return dispatch(endpoint, "new", daemon::default_session, false);
  }
  if (arguments.size() != 2 && arguments.size() != 3) {
    static_cast<void>(write_fragment(stderr, "invalid number of arguments\n"));
    static_cast<void>(print_usage(stderr));
    return 2;
  }

  const std::string_view command(arguments.subspan(1, 1).front());
  std::string_view session = daemon::default_session;
  const bool named = arguments.size() == 3;
  if (named) {
    session = arguments.subspan(2, 1).front();
  }
  return dispatch(endpoint, command, session, named);
}

} // namespace lemma::app
