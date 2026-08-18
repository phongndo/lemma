#include "lemma/terminal/terminal.hpp"

#include <gtest/gtest.h>

#include <cstddef>
#include <span>
#include <string_view>
#include <utility>

namespace lemma::vt {
namespace {

void write_text(Terminal& terminal, const std::string_view text) {
  terminal.write(std::as_bytes(std::span(text.data(), text.size())));
}

[[nodiscard]] auto make_terminal(const TerminalOptions& options = {}) -> Terminal {
  auto result = Terminal::create(options);
  EXPECT_TRUE(result.has_value());
  return std::move(result).value();
}

// Assertion macros and explicit bounded work loops dominate these extended resource checks.
// NOLINTBEGIN(readability-function-cognitive-complexity)
TEST(TerminalResourceTest, GrowsAndPrunesScrollbackUnderItsOwnerQuota) {
  TerminalOptions options;
  options.size = {.columns = 10, .rows = 2};
  options.scrollback_bytes_max = 1'000;
  auto terminal = make_terminal(options);
  constexpr std::string_view line = "history\r\n";
  constexpr std::size_t input_rows = 10'000;

  const auto initial = terminal.scrollback_rows();
  ASSERT_TRUE(initial.has_value());
  EXPECT_EQ(*initial, 0U);
  for (std::size_t row = 0; row < input_rows; ++row) {
    write_text(terminal, line);
  }

  const auto retained = terminal.scrollback_rows();
  ASSERT_TRUE(retained.has_value());
  EXPECT_GT(*retained, 0U);
  EXPECT_LT(*retained, input_rows);
  EXPECT_LE(options.scrollback_bytes_max, limits::terminal_scrollback_bytes_hard_max);
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalResourceTest, DefaultScrollbackRetainsMultipleGhosttyPages) {
  constexpr std::string_view line =
      "history-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789------\r\n";
  constexpr std::size_t input_rows = 20'000;

  TerminalOptions small_options;
  small_options.size = {.columns = 80, .rows = 23};
  small_options.scrollback_bytes_max = 1'000'000;
  auto small = make_terminal(small_options);
  for (std::size_t row = 0; row < input_rows; ++row) {
    write_text(small, line);
  }
  const auto small_rows = small.scrollback_rows();
  ASSERT_TRUE(small_rows.has_value());

  TerminalOptions default_options;
  default_options.size = small_options.size;
  auto terminal = make_terminal(default_options);
  for (std::size_t row = 0; row < input_rows; ++row) {
    write_text(terminal, line);
  }
  const auto retained = terminal.scrollback_rows();
  ASSERT_TRUE(retained.has_value());
  EXPECT_GT(*retained, 10'000U);
  EXPECT_GT(*retained, *small_rows * 10U);
}
TEST(TerminalResourceTest, CompressesScrollbackIncrementallyWithoutChangingLogicalContent) {
  TerminalOptions options;
  options.size = {.columns = 20, .rows = 3};
  options.scrollback_bytes_max = limits::terminal_scrollback_bytes_hard_max;
  auto terminal = make_terminal(options);
  const auto activity_before = terminal.compression_activity();
  ASSERT_TRUE(activity_before.has_value());
  for (std::size_t row = 0; row < 2'000; ++row) {
    write_text(terminal, "compressible history\r\n");
  }
  const auto activity_after = terminal.compression_activity();
  ASSERT_TRUE(activity_after.has_value());
  EXPECT_NE(*activity_before, *activity_after);
  const auto rows_before = terminal.scrollback_rows();
  ASSERT_TRUE(rows_before.has_value());

  CompressionResult compression = CompressionResult::pending;
  for (std::size_t step = 0; step < 10'000 && compression == CompressionResult::pending; ++step) {
    const auto result = terminal.compress_scrollback();
    ASSERT_TRUE(result.has_value());
    compression = *result;
  }
  EXPECT_NE(compression, CompressionResult::pending);
  EXPECT_EQ(terminal.scrollback_rows(), rows_before);
}
// NOLINTEND(readability-function-cognitive-complexity)

} // namespace
} // namespace lemma::vt
