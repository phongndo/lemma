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
#include <optional>
#include <span>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

#include <unistd.h>

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
  constexpr std::string_view usage =
      "Usage: lemma [command [arguments...]]\n\n"
      "Commands:\n"
      "  new [NAME] [-c DIR] [-- COMMAND...]\n"
      "                         create and attach\n"
      "  start [NAME] [-c DIR] [-- COMMAND...]\n"
      "                         create detached\n"
      "  attach [NAME]          attach to an existing session\n"
      "  list                   list sessions\n"
      "  session rename OLD NEW rename a session\n"
      "  session kill NAME      stop a session\n"
      "  tab list SESSION       list tabs\n"
      "  tab rename SESSION TAB [TITLE]\n"
      "                         set or clear a tab title override\n"
      "  show skill             print the Lemma agent skill\n"
      "  help                   show this help\n"
      "  version                show build and protocol version\n\n"
      "Without a command, Lemma creates a fresh numbered session and attaches.\n";
  return write_fragment(stream, usage) ? 0 : 1;
}

[[nodiscard]] auto print_version() noexcept -> int {
  return write_fragment(stdout, "lemma ") && write_fragment(stdout, lemma::version) &&
                 write_fragment(stdout, " (private protocol ") &&
                 write_fragment(stdout, lemma::private_protocol_version) &&
                 write_fragment(stdout, ")\n")
             ? 0
             : 1;
}

[[nodiscard]] auto print_skill() noexcept -> int {
  constexpr std::string_view skill = R"SKILL(---
name: lemma
description: Operate Lemma terminal-multiplexer sessions. Use when creating, attaching, listing, renaming, or stopping Lemma sessions and tabs.
---

# Lemma

Use explicit Lemma CLI commands; do not emulate mux commands by sending prefix keys.

```sh
lemma new [NAME] [-c DIR] [-- COMMAND...]
lemma start [NAME] [-c DIR] [-- COMMAND...]
lemma attach [NAME]
lemma list
lemma session rename OLD NEW
lemma session kill NAME
lemma tab list SESSION
lemma tab rename SESSION TAB [TITLE]
```

`new` creates and attaches. `start` creates detached. Omit `NAME` to receive a numeric session
name. Creation is strict and fails when an explicit name already exists. Arguments after `--` are
executed directly without a shell. Omitting `TITLE` clears a tab title override.
)SKILL";
  return write_fragment(stdout, skill) ? 0 : 1;
}

struct CreationArguments final {
  std::optional<std::string_view> name;
  std::string_view working_directory;
  std::vector<std::string_view> command;
};

[[nodiscard]] auto invalid_arguments(const std::string_view command) noexcept -> int {
  static_cast<void>(write_fragment(stderr, "invalid lemma "));
  static_cast<void>(write_fragment(stderr, command));
  static_cast<void>(write_fragment(stderr, " arguments\n"));
  static_cast<void>(print_usage(stderr));
  return 2;
}

// The branches are the complete bounded grammar for optional name, cwd, and argv.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto parse_creation(const std::span<char*> arguments)
    -> std::optional<CreationArguments> {
  CreationArguments parsed;
  for (std::size_t index = 0; index < arguments.size(); ++index) {
    const std::string_view argument(arguments.subspan(index, 1).front());
    if (argument == "--") {
      if (index + 1U == arguments.size()) {
        return std::nullopt;
      }
      parsed.command.reserve(arguments.size() - index - 1U);
      for (char* const value : arguments.subspan(index + 1U)) {
        parsed.command.emplace_back(value);
      }
      return parsed;
    }
    if (argument == "-c" || argument == "--cwd") {
      if (!parsed.working_directory.empty() || index + 1U == arguments.size()) {
        return std::nullopt;
      }
      ++index;
      parsed.working_directory = arguments.subspan(index, 1).front();
      if (parsed.working_directory.empty()) {
        return std::nullopt;
      }
      continue;
    }
    if (argument.starts_with('-') || parsed.name.has_value()) {
      return std::nullopt;
    }
    parsed.name = argument;
  }
  return parsed;
}

[[nodiscard]] auto run_creation(const daemon::RuntimeEndpoint& endpoint,
                                const std::span<char*> arguments, const bool attach_after_create)
    -> int {
  const auto parsed = parse_creation(arguments);
  if (!parsed.has_value()) {
    return invalid_arguments(attach_after_create ? "new" : "start");
  }
  if (attach_after_create && (::isatty(STDIN_FILENO) == 0 || ::isatty(STDOUT_FILENO) == 0)) {
    static_cast<void>(write_fragment(stderr, "lemma new requires a terminal\n"));
    return 1;
  }
  const daemon::LaunchOptions options{.working_directory = parsed->working_directory,
                                      .command = parsed->command};
  if (!attach_after_create) {
    return daemon::start(endpoint, parsed->name, options);
  }
  const auto created = daemon::create(endpoint, parsed->name, options);
  return created.has_value() ? client::attach(endpoint, *created) : 1;
}

[[nodiscard]] constexpr auto help_flag(const std::string_view value) noexcept -> bool {
  return value == "-h" || value == "--help";
}

} // namespace

// Top-level branches are the complete CLI command grammar.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto run(const daemon::RuntimeEndpoint& endpoint, const int argument_count,
                       char** argument_values) -> int {
  const std::span arguments(argument_values, static_cast<std::size_t>(argument_count));
  if (arguments.size() == 1) {
    return run_creation(endpoint, {}, true);
  }
  const std::string_view command(arguments.subspan(1, 1).front());
  if (command == "help" || command == "--help" || command == "-h") {
    return arguments.size() == 2 ? print_usage(stdout) : invalid_arguments("help");
  }
  if (command == "version" || command == "--version" || command == "-V") {
    return arguments.size() == 2 ? print_version() : invalid_arguments("version");
  }
  if (command == "new" || command == "start") {
    if (arguments.size() == 3 && help_flag(arguments.subspan(2, 1).front())) {
      return print_usage(stdout);
    }
    return run_creation(endpoint, arguments.subspan(2), command == "new");
  }
  if (help_flag(arguments.back())) {
    return print_usage(stdout);
  }
  if (command == "attach") {
    if (arguments.size() == 3 && help_flag(arguments.subspan(2, 1).front())) {
      return print_usage(stdout);
    }
    if (arguments.size() > 3) {
      return invalid_arguments("attach");
    }
    const std::string_view session = arguments.size() == 3
                                         ? std::string_view(arguments.subspan(2, 1).front())
                                         : std::string_view{};
    return client::attach(endpoint, session);
  }
  if (command == "list" || command == "ls") {
    if (arguments.size() == 2) {
      return daemon::list(endpoint);
    }
    // Retained as a narrow compatibility spelling for focused diagnostics.
    return arguments.size() == 3 ? daemon::list(endpoint, arguments.subspan(2, 1).front())
                                 : invalid_arguments("list");
  }
  if (command == "session") {
    if (arguments.size() == 3 && help_flag(arguments.subspan(2, 1).front())) {
      return print_usage(stdout);
    }
    if (arguments.size() == 5 && std::string_view(arguments.subspan(2, 1).front()) == "rename") {
      return daemon::rename_session(endpoint, arguments.subspan(3, 1).front(),
                                    arguments.subspan(4, 1).front());
    }
    if (arguments.size() == 4 && std::string_view(arguments.subspan(2, 1).front()) == "kill") {
      return daemon::kill(endpoint, arguments.subspan(3, 1).front());
    }
    return invalid_arguments("session");
  }
  if (command == "tab") {
    if (arguments.size() == 3 && help_flag(arguments.subspan(2, 1).front())) {
      return print_usage(stdout);
    }
    const std::string_view operation = arguments.size() > 2
                                           ? std::string_view(arguments.subspan(2, 1).front())
                                           : std::string_view{};
    if (operation == "list" && arguments.size() == 4) {
      return daemon::list_tabs(endpoint, arguments.subspan(3, 1).front());
    }
    if (operation == "rename" && (arguments.size() == 5 || arguments.size() == 6)) {
      const std::string_view encoded_position(arguments.subspan(4, 1).front());
      std::size_t position = 0;
      const auto parsed =
          std::from_chars(encoded_position.begin(), encoded_position.end(), position);
      if (parsed.ec != std::errc{} || parsed.ptr != encoded_position.end()) {
        static_cast<void>(write_fragment(stderr, "invalid tab position\n"));
        return 2;
      }
      const std::string_view title = arguments.size() == 6
                                         ? std::string_view(arguments.subspan(5, 1).front())
                                         : std::string_view{};
      return daemon::rename_tab(endpoint, arguments.subspan(3, 1).front(), position, title);
    }
    return invalid_arguments("tab");
  }
  if (command == "show" && arguments.size() == 3 &&
      std::string_view(arguments.subspan(2, 1).front()) == "skill") {
    return print_skill();
  }

  // Transitional operational spellings remain accepted but are intentionally absent from help.
  if (command == "tabs" && arguments.size() == 3) {
    return daemon::list_tabs(endpoint, arguments.subspan(2, 1).front());
  }
  if (command == "kill" && arguments.size() == 3) {
    return daemon::kill(endpoint, arguments.subspan(2, 1).front());
  }
  if (command == "kill-all" && arguments.size() == 2) {
    return daemon::kill_all(endpoint);
  }
  if (command == "shutdown" && arguments.size() == 3 &&
      std::string_view(arguments.subspan(2, 1).front()) == "--confirm") {
    constexpr std::string_view warning =
        "WARNING: daemon shutdown ends every session and its pane processes.\n";
    return write_fragment(stderr, warning) ? daemon::shutdown(endpoint) : 1;
  }
  if (command == "demo" && arguments.size() == 2) {
    return run_demo();
  }

  static_cast<void>(write_fragment(stderr, "invalid lemma command or arguments: "));
  static_cast<void>(write_fragment(stderr, command));
  static_cast<void>(write_fragment(stderr, "\n"));
  static_cast<void>(print_usage(stderr));
  return 2;
}

} // namespace lemma::app
