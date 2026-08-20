#include "app/application.hpp"

#include "app/procedure.hpp"
#include "client/attached_client.hpp"
#include "daemon/server.hpp"
#include "lemma/id.hpp"
#include "lemma/terminal/terminal.hpp"
#include "lemma/version.hpp"

#include <array>
#include <charconv>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <iterator>
#include <limits>
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
      "  new [NAME] [--hold] [-c DIR] [-- COMMAND...]\n"
      "  start [NAME] [--hold] [-c DIR] [-- COMMAND...]\n"
      "  attach [NAME]\n"
      "  list | ls | inspect NAME | rename OLD NEW | kill NAME\n"
      "  tab list SESSION\n"
      "  tab new SESSION [--title TITLE] [--hold] [-c DIR] [-- COMMAND...]\n"
      "  tab select SESSION TAB | move SESSION TAB POSITION\n"
      "  tab rename SESSION TAB [TITLE] | kill SESSION TAB\n"
      "  pane list SESSION\n"
      "  pane split SESSION PANE (--right|--down) [--hold] [-c DIR] [-- COMMAND...]\n"
      "  pane focus SESSION PANE | swap SESSION PANE OTHER\n"
      "  pane resize SESSION PANE (left|right|up|down) CELLS\n"
      "  pane zoom SESSION PANE (--on|--off) | kill SESSION PANE\n"
      "  pane send SESSION PANE --text TEXT\n"
      "  pane capture SESSION PANE [--lines N]\n"
      "  pane wait SESSION PANE (--contains TEXT|--exit|--exit-code CODE|--signal SIGNAL)\n"
      "                         [--timeout DURATION]\n"
      "  proc FILE|-            execute a bounded action procedure\n"
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
description: Operate and automate Lemma sessions, tabs, panes, processes, input, waits, and captures.
---

# Lemma

Use explicit Lemma CLI commands; do not emulate mux commands by sending prefix keys.

```sh
lemma new [NAME] [--hold] [-c DIR] [-- COMMAND...]
lemma start [NAME] [--hold] [-c DIR] [-- COMMAND...]
lemma attach [NAME]
lemma list  # alias: lemma ls
lemma rename OLD NEW
lemma kill NAME
lemma tab list SESSION
lemma tab new SESSION [--hold] [-- COMMAND...]
lemma pane list SESSION
lemma pane split SESSION PANE --right|--down [--hold] [-- COMMAND...]
lemma pane send SESSION PANE --text TEXT
lemma pane wait SESSION PANE --contains TEXT
lemma pane wait SESSION PANE --exit-code CODE
lemma pane capture SESSION PANE
lemma proc FILE|-
```

Session controls are top-level; tab and pane commands use explicit namespaces. Every command is a
one-shot action. `new` creates and attaches; `start` creates detached. Omit `NAME` to receive a
numeric session name. Arguments after `--` are
executed directly without a shell. `--hold` retains an exited pane for status and capture. Use
`proc` to execute a strictly prevalidated ordered JSON procedure containing the same actions. JSON
action names remain resource-qualified (`session.*`, `tab.*`, and `pane.*`) even though CLI session controls are
top-level. Procedure creation results can be referenced by a later typed selector:

```json
{"schema":"lemma.proc/v1","actions":[
  {"id":"qa","action":"session.start","name":"qa"},
  {"id":"tests","action":"tab.new","session":{"result":"qa"},"hold":true,
   "argv":["just","test"]},
  {"action":"pane.wait","pane":{"result":"tests"},"exit":{"code":0},
   "timeout_ms":120000},
  {"action":"pane.capture","pane":{"result":"tests"},"lines":100},
  {"action":"session.kill","session":{"result":"qa"}}
]}
```
)SKILL";
  return write_fragment(stdout, skill) ? 0 : 1;
}

struct CreationArguments final {
  std::optional<std::string_view> name;
  std::string_view working_directory;
  std::vector<std::string_view> command;
  bool hold{false};
};

struct SurfaceArguments final {
  std::string_view working_directory;
  std::string_view title;
  std::vector<std::string_view> command;
  bool hold{false};
};

[[nodiscard]] auto invalid_arguments(const std::string_view command) noexcept -> int {
  static_cast<void>(write_fragment(stderr, "invalid lemma "));
  static_cast<void>(write_fragment(stderr, command));
  static_cast<void>(write_fragment(stderr, " arguments\n"));
  static_cast<void>(print_usage(stderr));
  return 2;
}

[[nodiscard]] constexpr auto help_flag(const std::string_view value) noexcept -> bool {
  return value == "-h" || value == "--help";
}

template <typename Integer>
[[nodiscard]] auto parse_integer(const std::string_view value) noexcept -> std::optional<Integer> {
  Integer parsed{};
  const auto result = std::from_chars(value.begin(), value.end(), parsed);
  return result.ec == std::errc{} && result.ptr == value.end() ? std::optional{parsed}
                                                               : std::nullopt;
}

template <typename Id>
[[nodiscard]] auto parse_id(const std::string_view value) -> std::optional<Id> {
  const auto separator = value.find(':');
  if (separator == std::string_view::npos || separator == 0 || separator + 1U == value.size()) {
    return std::nullopt;
  }
  const auto slot = parse_integer<std::uint32_t>(value.substr(0, separator));
  const auto generation = parse_integer<std::uint32_t>(value.substr(separator + 1U));
  return slot.has_value() && generation.has_value() ? Id::try_from_parts(*slot, *generation)
                                                    : std::nullopt;
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
    if (argument == "--hold") {
      if (parsed.hold) {
        return std::nullopt;
      }
      parsed.hold = true;
      continue;
    }
    if (argument == "-c" || argument == "--cwd") {
      if (!parsed.working_directory.empty() || index + 1U == arguments.size()) {
        return std::nullopt;
      }
      parsed.working_directory = arguments.subspan(++index, 1).front();
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

// Surface options share one bounded grammar for launch context and exit policy.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto parse_surface(const std::span<char*> arguments, const bool allow_title)
    -> std::optional<SurfaceArguments> {
  SurfaceArguments parsed;
  bool cwd_seen = false;
  bool title_seen = false;
  for (std::size_t index = 0; index < arguments.size(); ++index) {
    const std::string_view argument(arguments.subspan(index, 1).front());
    if (argument == "--") {
      if (index + 1U == arguments.size()) {
        return std::nullopt;
      }
      for (char* const value : arguments.subspan(index + 1U)) {
        parsed.command.emplace_back(value);
      }
      return parsed;
    }
    if (argument == "--hold") {
      if (parsed.hold) {
        return std::nullopt;
      }
      parsed.hold = true;
      continue;
    }
    if (argument == "-c" || argument == "--cwd") {
      if (cwd_seen || index + 1U == arguments.size()) {
        return std::nullopt;
      }
      parsed.working_directory = arguments.subspan(++index, 1).front();
      if (parsed.working_directory.empty()) {
        return std::nullopt;
      }
      cwd_seen = true;
      continue;
    }
    if (argument == "--title" && allow_title) {
      if (title_seen || index + 1U == arguments.size()) {
        return std::nullopt;
      }
      parsed.title = arguments.subspan(++index, 1).front();
      title_seen = true;
      continue;
    }
    return std::nullopt;
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
                                      .command = parsed->command,
                                      .hold = parsed->hold};
  if (!attach_after_create) {
    return daemon::start(endpoint, parsed->name, options);
  }
  const auto created = daemon::create(endpoint, parsed->name, options);
  return created.has_value() ? client::attach(endpoint, *created) : 1;
}

[[nodiscard]] auto report_operation(const daemon::OperationStatus status,
                                    const std::string_view success) noexcept -> int {
  if (status == daemon::OperationStatus::applied || status == daemon::OperationStatus::no_effect) {
    return success.empty() || (write_fragment(stdout, success) && write_fragment(stdout, "\n")) ? 0
                                                                                                : 1;
  }
  constexpr std::array messages{
      std::string_view{""},
      std::string_view{""},
      std::string_view{"no matching lemma object\n"},
      std::string_view{"lemma object conflicts with existing state\n"},
      std::string_view{"lemma capacity reached\n"},
      std::string_view{"lemma object is unavailable\n"},
      std::string_view{"lemma operation timed out\n"},
      std::string_view{"lemma pane exited unexpectedly\n"},
      std::string_view{"lemma operation failed\n"},
  };
  const auto index = static_cast<std::size_t>(status);
  const auto message =
      index < messages.size() ? std::span(messages).subspan(index, 1).front() : messages.back();
  static_cast<void>(write_fragment(stderr, message));
  return 1;
}

[[nodiscard]] auto print_id(std::FILE* const stream, const auto id) noexcept -> bool {
  return write_integer(stream, id.slot()) && write_fragment(stream, ":") &&
         write_integer(stream, id.generation());
}

[[nodiscard]] constexpr auto
action_target(const TabId tab = {}, const PaneId pane = {}, const PaneId peer = {},
              const std::uint16_t tab_position = 0, const std::uint16_t value = 0) noexcept
    -> daemon::ActionTarget {
  return {
      .tab = tab, .pane = pane, .peer_pane = peer, .tab_position = tab_position, .value = value};
}

[[nodiscard]] auto report_surface(const daemon::SurfaceResult& result,
                                  const std::string_view object) noexcept -> int {
  if (!result.succeeded()) {
    return report_operation(result.status, {});
  }
  return write_fragment(stdout, "created lemma ") && write_fragment(stdout, object) &&
                 write_fragment(stdout, " tab=") && print_id(stdout, result.tab) &&
                 write_fragment(stdout, " pane=") && print_id(stdout, result.pane) &&
                 write_fragment(stdout, "\n")
             ? 0
             : 1;
}

[[nodiscard]] auto tail_lines(const std::string_view text, const std::size_t lines)
    -> std::string_view {
  if (lines == 0 || text.empty()) {
    return {};
  }
  std::size_t offset = text.size();
  std::size_t found = 0;
  if (offset > 0 && text.back() == '\n') {
    --offset;
  }
  while (offset > 0) {
    --offset;
    if (text.substr(offset, 1).front() == '\n' && ++found == lines) {
      return text.substr(offset + 1U);
    }
  }
  return text;
}

[[nodiscard]] auto parse_duration(const std::string_view value)
    -> std::optional<std::chrono::milliseconds> {
  std::string_view number = value;
  std::uint64_t multiplier = 1;
  if (value.ends_with("ms")) {
    number.remove_suffix(2);
  } else if (value.ends_with('s')) {
    number.remove_suffix(1);
    multiplier = 1'000;
  } else if (value.ends_with('m')) {
    number.remove_suffix(1);
    multiplier = 60'000;
  }
  const auto amount = parse_integer<std::uint64_t>(number);
  constexpr std::uint64_t maximum = std::uint64_t{10} * 60U * 1'000U;
  if (!amount.has_value() || *amount == 0 || *amount > maximum / multiplier) {
    return std::nullopt;
  }
  return std::chrono::milliseconds(*amount * multiplier);
}

[[nodiscard]] constexpr auto canonical_session_operation(const std::string_view operation) noexcept
    -> std::string_view {
  return operation == "ls" ? std::string_view{"list"} : operation;
}

[[nodiscard]] auto run_session_control(const daemon::RuntimeEndpoint& endpoint,
                                       const std::span<char*> arguments) -> int {
  if (arguments.empty()) {
    return invalid_arguments("session control");
  }
  const std::string_view requested_operation(arguments.front());
  const auto operation = canonical_session_operation(requested_operation);
  if (operation == "new" || operation == "start") {
    return run_creation(endpoint, arguments.subspan(1), operation == "new");
  }
  if (operation == "attach" && arguments.size() <= 2) {
    const auto target =
        arguments.size() == 2 ? std::string_view(arguments.back()) : std::string_view{};
    return client::attach(endpoint, target);
  }
  if (operation == "list" && arguments.size() == 1) {
    return daemon::list(endpoint);
  }
  if (operation == "inspect" && arguments.size() == 2) {
    return daemon::list(endpoint, arguments.back());
  }
  if (operation == "rename" && arguments.size() == 3) {
    return daemon::rename_session(endpoint, arguments.subspan(1, 1).front(), arguments.back());
  }
  if (operation == "kill" && arguments.size() == 2) {
    return daemon::kill(endpoint, arguments.back());
  }
  return invalid_arguments(requested_operation);
}

// Tab branches are the complete one-shot tab action grammar.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto run_tab(const daemon::RuntimeEndpoint& endpoint,
                           const std::span<char*> arguments) -> int {
  if (arguments.empty()) {
    return invalid_arguments("tab");
  }
  const std::string_view operation(arguments.front());
  if (operation == "list" && arguments.size() == 2) {
    return daemon::list_tabs(endpoint, arguments.back());
  }
  if (operation == "new" && arguments.size() >= 2) {
    const auto parsed = parse_surface(arguments.subspan(2), true);
    if (!parsed.has_value()) {
      return invalid_arguments("tab new");
    }
    return report_surface(daemon::create_surface(endpoint, arguments.subspan(1, 1).front(),
                                                 daemon::SurfaceCreateKind::tab, {},
                                                 {.working_directory = parsed->working_directory,
                                                  .command = parsed->command,
                                                  .title = parsed->title,
                                                  .hold = parsed->hold}),
                          "tab");
  }
  if (operation == "rename" && (arguments.size() == 3 || arguments.size() == 4)) {
    const auto position = parse_integer<std::size_t>(arguments.subspan(2, 1).front());
    if (!position.has_value()) {
      return invalid_arguments("tab rename");
    }
    const auto title =
        arguments.size() == 4 ? std::string_view(arguments.back()) : std::string_view{};
    return daemon::rename_tab(endpoint, arguments.subspan(1, 1).front(), *position, title);
  }
  if ((operation == "select" || operation == "kill") && arguments.size() == 3) {
    const auto encoded = std::string_view(arguments.back());
    const auto id = parse_id<TabId>(encoded);
    const auto position =
        id.has_value() ? std::optional<std::uint16_t>{} : parse_integer<std::uint16_t>(encoded);
    if (!id.has_value() && (!position.has_value() || *position == 0)) {
      return invalid_arguments("tab");
    }
    const auto action = operation == "select" ? daemon::SemanticAction::tab_select
                                              : daemon::SemanticAction::tab_kill;
    return report_operation(
        daemon::perform_action(endpoint, arguments.subspan(1, 1).front(), action,
                               action_target(id.value_or(TabId{}), {}, {}, position.value_or(0))),
        operation == "select" ? "selected lemma tab" : "killed lemma tab");
  }
  if (operation == "move" && arguments.size() == 4) {
    const auto encoded = std::string_view(arguments.subspan(2, 1).front());
    const auto id = parse_id<TabId>(encoded);
    const auto source =
        id.has_value() ? std::optional<std::uint16_t>{} : parse_integer<std::uint16_t>(encoded);
    const auto destination = parse_integer<std::uint16_t>(arguments.back());
    if ((!id.has_value() && (!source.has_value() || *source == 0)) || !destination.has_value() ||
        *destination == 0) {
      return invalid_arguments("tab move");
    }
    return report_operation(daemon::perform_action(endpoint, arguments.subspan(1, 1).front(),
                                                   daemon::SemanticAction::tab_move,
                                                   action_target(id.value_or(TabId{}), {}, {},
                                                                 source.value_or(0), *destination)),
                            "moved lemma tab");
  }
  return invalid_arguments("tab");
}

[[nodiscard]] auto pane_action(const daemon::RuntimeEndpoint& endpoint,
                               const std::span<char*> arguments,
                               const daemon::SemanticAction action, const std::string_view success)
    -> int {
  const auto pane =
      arguments.size() >= 3 ? parse_id<PaneId>(arguments.subspan(2, 1).front()) : std::nullopt;
  if (arguments.size() != 3 || !pane.has_value()) {
    return invalid_arguments("pane");
  }
  return report_operation(daemon::perform_action(endpoint, arguments.subspan(1, 1).front(), action,
                                                 action_target({}, *pane)),
                          success);
}

// Pane operations intentionally remain explicit: no attached focus or caller context is used to
// guess a target for automation.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto run_pane(const daemon::RuntimeEndpoint& endpoint,
                            const std::span<char*> arguments) -> int {
  if (arguments.empty()) {
    return invalid_arguments("pane");
  }
  const std::string_view operation(arguments.front());
  if (operation == "list" && arguments.size() == 2) {
    return daemon::list_panes(endpoint, arguments.back());
  }
  if (operation == "split" && arguments.size() >= 4) {
    const auto pane = parse_id<PaneId>(arguments.subspan(2, 1).front());
    const std::string_view direction(arguments.subspan(3, 1).front());
    const auto parsed = parse_surface(arguments.subspan(4), false);
    if (!pane.has_value() || !parsed.has_value() ||
        (direction != "--right" && direction != "--down")) {
      return invalid_arguments("pane split");
    }
    const auto kind = direction == "--right" ? daemon::SurfaceCreateKind::split_right
                                             : daemon::SurfaceCreateKind::split_down;
    return report_surface(daemon::create_surface(endpoint, arguments.subspan(1, 1).front(), kind,
                                                 *pane,
                                                 {.working_directory = parsed->working_directory,
                                                  .command = parsed->command,
                                                  .title = {},
                                                  .hold = parsed->hold}),
                          "pane");
  }
  if (operation == "focus") {
    return pane_action(endpoint, arguments, daemon::SemanticAction::pane_focus,
                       "focused lemma pane");
  }
  if (operation == "kill") {
    return pane_action(endpoint, arguments, daemon::SemanticAction::pane_kill, "killed lemma pane");
  }
  if (operation == "swap" && arguments.size() == 4) {
    const auto pane = parse_id<PaneId>(arguments.subspan(2, 1).front());
    const auto peer = parse_id<PaneId>(arguments.back());
    if (!pane.has_value() || !peer.has_value()) {
      return invalid_arguments("pane swap");
    }
    return report_operation(daemon::perform_action(endpoint, arguments.subspan(1, 1).front(),
                                                   daemon::SemanticAction::pane_swap,
                                                   action_target({}, *pane, *peer)),
                            "swapped lemma panes");
  }
  if (operation == "resize" && arguments.size() == 5) {
    const auto pane = parse_id<PaneId>(arguments.subspan(2, 1).front());
    const std::string_view direction(arguments.subspan(3, 1).front());
    const auto amount = parse_integer<std::uint16_t>(arguments.back());
    if (!pane.has_value() || !amount.has_value() || *amount == 0 || *amount > 100) {
      return invalid_arguments("pane resize");
    }
    std::optional<daemon::SemanticAction> action;
    if (direction == "left") {
      action = daemon::SemanticAction::pane_resize_left;
    } else if (direction == "right") {
      action = daemon::SemanticAction::pane_resize_right;
    } else if (direction == "up") {
      action = daemon::SemanticAction::pane_resize_up;
    } else if (direction == "down") {
      action = daemon::SemanticAction::pane_resize_down;
    }
    if (!action.has_value()) {
      return invalid_arguments("pane resize");
    }
    return report_operation(daemon::perform_action(endpoint, arguments.subspan(1, 1).front(),
                                                   *action,
                                                   action_target({}, *pane, {}, 0, *amount)),
                            "resized lemma pane");
  }
  if (operation == "zoom" && arguments.size() == 4) {
    const auto pane = parse_id<PaneId>(arguments.subspan(2, 1).front());
    const std::string_view state(arguments.back());
    if (!pane.has_value() || (state != "--on" && state != "--off")) {
      return invalid_arguments("pane zoom");
    }
    const auto action = state == "--on" ? daemon::SemanticAction::pane_zoom_on
                                        : daemon::SemanticAction::pane_zoom_off;
    return report_operation(daemon::perform_action(endpoint, arguments.subspan(1, 1).front(),
                                                   action, action_target({}, *pane)),
                            "updated lemma pane zoom");
  }
  if (operation == "send" && arguments.size() == 5 &&
      std::string_view(arguments.subspan(3, 1).front()) == "--text") {
    const auto pane = parse_id<PaneId>(arguments.subspan(2, 1).front());
    return pane.has_value()
               ? report_operation(daemon::send_pane(endpoint, arguments.subspan(1, 1).front(),
                                                    *pane, arguments.back()),
                                  {})
               : invalid_arguments("pane send");
  }
  if (operation == "capture" && (arguments.size() == 3 || arguments.size() == 5)) {
    const auto pane = parse_id<PaneId>(arguments.subspan(2, 1).front());
    std::size_t lines = std::numeric_limits<std::size_t>::max();
    if (arguments.size() == 5) {
      const auto parsed = parse_integer<std::size_t>(arguments.back());
      if (std::string_view(arguments.subspan(3, 1).front()) != "--lines" || !parsed.has_value() ||
          *parsed == 0) {
        return invalid_arguments("pane capture");
      }
      lines = *parsed;
    }
    if (!pane.has_value()) {
      return invalid_arguments("pane capture");
    }
    const auto [status, text] =
        daemon::capture_pane(endpoint, arguments.subspan(1, 1).front(), *pane);
    if (status != daemon::OperationStatus::applied) {
      return report_operation(status, {});
    }
    return write_fragment(stdout, tail_lines(text, lines)) ? 0 : 1;
  }
  if (operation == "wait" && arguments.size() >= 4) {
    const auto pane = parse_id<PaneId>(arguments.subspan(2, 1).front());
    if (!pane.has_value()) {
      return invalid_arguments("pane wait");
    }
    std::optional<daemon::ProcessExpectation> process;
    std::string_view contains;
    auto timeout = std::chrono::milliseconds(30'000);
    bool timeout_seen = false;
    for (std::size_t index = 3; index < arguments.size(); ++index) {
      const std::string_view argument(arguments.subspan(index, 1).front());
      if (argument == "--exit" && contains.empty() && !process.has_value()) {
        process = daemon::ProcessExpectation{};
      } else if ((argument == "--exit-code" || argument == "--signal") && contains.empty() &&
                 !process.has_value() && index + 1U < arguments.size()) {
        const auto value = parse_integer<std::uint32_t>(arguments.subspan(++index, 1).front());
        const bool valid =
            value.has_value() && ((argument == "--exit-code" && *value <= 255U) ||
                                  (argument == "--signal" && *value > 0 && *value <= 127U));
        if (!valid) {
          return invalid_arguments("pane wait");
        }
        process = daemon::ProcessExpectation{.kind = argument == "--exit-code"
                                                         ? daemon::ProcessExpectationKind::exit_code
                                                         : daemon::ProcessExpectationKind::signal,
                                             .value = *value};
      } else if (argument == "--contains" && !process.has_value() && contains.empty() &&
                 index + 1U < arguments.size()) {
        contains = arguments.subspan(++index, 1).front();
        if (contains.empty()) {
          return invalid_arguments("pane wait");
        }
      } else if (argument == "--timeout" && !timeout_seen && index + 1U < arguments.size()) {
        const auto parsed = parse_duration(arguments.subspan(++index, 1).front());
        if (!parsed.has_value()) {
          return invalid_arguments("pane wait");
        }
        timeout = *parsed;
        timeout_seen = true;
      } else {
        return invalid_arguments("pane wait");
      }
    }
    if (process.has_value() == !contains.empty()) {
      return invalid_arguments("pane wait");
    }
    const auto waited =
        daemon::wait_pane(endpoint, arguments.subspan(1, 1).front(), *pane,
                          {.contains = contains, .process = process, .timeout = timeout});
    if (waited.status != daemon::OperationStatus::applied) {
      return report_operation(waited.status, {});
    }
    return write_fragment(stdout, process.has_value() ? "lemma pane process exit matched\n"
                                                      : "lemma pane condition matched\n")
               ? 0
               : 1;
  }
  return invalid_arguments("pane");
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
  const auto command_arguments = arguments.subspan(1);
  const std::string_view command(command_arguments.front());
  if (command == "help" || command == "--help" || command == "-h") {
    return command_arguments.size() == 1 ? print_usage(stdout) : invalid_arguments("help");
  }
  if (command == "version" || command == "--version" || command == "-V") {
    return command_arguments.size() == 1 ? print_version() : invalid_arguments("version");
  }
  if (help_flag(command_arguments.back())) {
    return print_usage(stdout);
  }
  if (command == "new" || command == "start" || command == "attach" || command == "list" ||
      command == "ls" || command == "inspect" || command == "rename" || command == "kill") {
    return run_session_control(endpoint, command_arguments);
  }
  if (command == "tab") {
    return run_tab(endpoint, command_arguments.subspan(1));
  }
  if (command == "pane") {
    return run_pane(endpoint, command_arguments.subspan(1));
  }
  if (command == "proc" && command_arguments.size() == 2) {
    return run_procedure(endpoint, command_arguments.back());
  }
  if (command == "show" && command_arguments.size() == 2 &&
      std::string_view(command_arguments.back()) == "skill") {
    return print_skill();
  }

  // Development-only diagnostics remain intentionally absent from the public command hierarchy.
  if (command == "shutdown" && command_arguments.size() == 2 &&
      std::string_view(command_arguments.back()) == "--confirm") {
    constexpr std::string_view warning =
        "WARNING: daemon shutdown ends every session and its pane processes.\n";
    return write_fragment(stderr, warning) ? daemon::shutdown(endpoint) : 1;
  }
  if (command == "demo" && command_arguments.size() == 1) {
    return run_demo();
  }

  static_cast<void>(write_fragment(stderr, "invalid lemma command or arguments: "));
  static_cast<void>(write_fragment(stderr, command));
  static_cast<void>(write_fragment(stderr, "\n"));
  static_cast<void>(print_usage(stderr));
  return 2;
}

} // namespace lemma::app
