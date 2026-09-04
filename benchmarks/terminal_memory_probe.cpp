#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"

#include <charconv>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <limits>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace {

[[nodiscard]] auto parse_size(const std::string_view text, const std::size_t maximum) noexcept
    -> std::size_t {
  std::size_t value = 0;
  const auto input = std::span(text);
  const auto* const end = std::to_address(input.end());
  // from_chars consumes the explicit half-open range and does not require termination.
  // NOLINTNEXTLINE(bugprone-suspicious-stringview-data-usage)
  const auto parsed = std::from_chars(input.data(), end, value);
  return parsed.ec == std::errc{} && parsed.ptr == end && value <= maximum
             ? value
             : std::numeric_limits<std::size_t>::max();
}

void write_terminal(lemma::vt::Terminal& terminal, const std::string_view text) noexcept {
  terminal.write(std::as_bytes(std::span(text)));
}

void report(const std::string_view stage, const std::vector<lemma::vt::Terminal>& terminals) {
  lemma::vt::AllocationStats total{};
  for (const auto& terminal : terminals) {
    const auto stats = terminal.allocation_stats();
    total.bytes_current += stats.bytes_current;
    total.bytes_peak += stats.bytes_peak;
    total.allocations_current += stats.allocations_current;
    total.allocations_total += stats.allocations_total;
    total.failures_total += stats.failures_total;
  }
  std::cout << R"({"stage":")" << stage << R"(","terminals":)" << terminals.size()
            << R"(,"allocator_bytes_current":)" << total.bytes_current
            << R"(,"allocator_bytes_peak":)" << total.bytes_peak
            << R"(,"allocator_allocations_current":)" << total.allocations_current
            << R"(,"allocator_allocations_total":)" << total.allocations_total
            << R"(,"allocator_failures_total":)" << total.failures_total << "}\n"
            << std::flush;
}

} // namespace

// The branches are the explicit commands in this bounded probe protocol.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
int main(const int argc, char** const argv) {
  const auto arguments = std::span(argv, static_cast<std::size_t>(argc));
  if (arguments.size() != 3) {
    return 2;
  }
  const auto count = parse_size(arguments.subspan(1, 1).front(), 64);
  const auto scrollback_lines = parse_size(arguments.subspan(2, 1).front(), 25'000);
  if (count == std::numeric_limits<std::size_t>::max() ||
      scrollback_lines == std::numeric_limits<std::size_t>::max()) {
    return 2;
  }
  lemma::vt::TerminalOptions options;
  options.size = {.columns = 80, .rows = 24};
  options.scrollback_lines_max = scrollback_lines;
  std::vector<lemma::vt::Terminal> terminals;
  terminals.reserve(count);
  for (std::size_t index = 0; index < count; ++index) {
    auto terminal = lemma::vt::Terminal::create(options);
    if (!terminal.has_value()) {
      return 1;
    }
    terminals.push_back(std::move(*terminal));
  }
  report("empty", terminals);

  std::string history;
  history.reserve(std::size_t{5'100} * 82U);
  for (std::size_t row = 0; row < 5'100; ++row) {
    history.append("page-pool-row-");
    history.append(std::to_string(row));
    history.append(62, static_cast<char>('a' + (row % 26U)));
    history.append("\r\n");
  }

  std::string command;
  while (std::getline(std::cin, command)) {
    if (command == "history") {
      for (auto& terminal : terminals) {
        write_terminal(terminal, history);
      }
      report("history", terminals);
    } else if (command == "clear") {
      for (auto& terminal : terminals) {
        write_terminal(terminal, "\x1B[3J");
      }
      report("cleared", terminals);
    } else if (command == "exit") {
      return 0;
    } else {
      return 2;
    }
  }
  return 0;
}
