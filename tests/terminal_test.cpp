#include "lemma/terminal/terminal.hpp"

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include <array>
#include <cstddef>
#include <span>
#include <string>
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

TEST(TerminalTest, RejectsInvalidAndUnfundedConfigurations) {
  TerminalOptions invalid_dimensions;
  invalid_dimensions.size.columns = 0;
  const auto invalid_result = Terminal::create(invalid_dimensions);
  ASSERT_FALSE(invalid_result.has_value());
  EXPECT_EQ(invalid_result.error(), Error::invalid_options);

  TerminalOptions excessive_scrollback;
  excessive_scrollback.scrollback_bytes_max = limits::terminal_scrollback_bytes_hard_max + 1U;
  const auto excessive_scrollback_result = Terminal::create(excessive_scrollback);
  ASSERT_FALSE(excessive_scrollback_result.has_value());
  EXPECT_EQ(excessive_scrollback_result.error(), Error::invalid_options);

  TerminalOptions exhausted;
  exhausted.allocation_bytes_max = 1;
  const auto exhausted_result = Terminal::create(exhausted);
  ASSERT_FALSE(exhausted_result.has_value());
  EXPECT_EQ(exhausted_result.error(), Error::out_of_memory);
}

TEST(TerminalTest, ParsesUtf8AndReportsDamage) {
  auto terminal = make_terminal();

  const auto initial = terminal.update_render_state();
  ASSERT_TRUE(initial.has_value());
  EXPECT_EQ(initial->dirty, DirtyState::full);
  EXPECT_EQ(initial->columns, 80);
  EXPECT_EQ(initial->rows, 24);
  ASSERT_TRUE(terminal.mark_rendered().has_value());

  write_text(terminal, "h\xC3\xA9llo");
  const auto update = terminal.update_render_state();
  ASSERT_TRUE(update.has_value());
  EXPECT_NE(update->dirty, DirtyState::clean);
  EXPECT_GE(update->dirty_rows, 1U);
  EXPECT_EQ(update->cursor_column, 5);
  EXPECT_EQ(update->cursor_row, 0);

  ASSERT_TRUE(terminal.mark_rendered().has_value());
  const auto clean = terminal.update_render_state();
  ASSERT_TRUE(clean.has_value());
  EXPECT_EQ(clean->dirty, DirtyState::clean);
  EXPECT_EQ(clean->dirty_rows, 0U);
}

TEST(TerminalTest, FormatsDiagnosticSnapshotsIntoCallerStorage) {
  auto terminal = make_terminal();
  write_text(terminal, "plain \x1B[1;32mgreen\x1B[0m");

  std::array<std::byte, 1'024> plain_output{};
  const auto plain_size = terminal.format_screen(ScreenFormat::plain, plain_output);
  ASSERT_TRUE(plain_size.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view plain_text(reinterpret_cast<const char*>(plain_output.data()),
                                    *plain_size);
  EXPECT_THAT(plain_text, testing::HasSubstr("plain green"));

  std::array<std::byte, std::size_t{8} * 1'024U> full_output{};
  const auto full_size = terminal.format_screen(ScreenFormat::vt_full, full_output);
  ASSERT_TRUE(full_size.has_value());
  EXPECT_GT(*full_size, *plain_size);

  std::array<std::byte, 1> insufficient_output{};
  const auto insufficient = terminal.format_screen(ScreenFormat::vt, insufficient_output);
  ASSERT_FALSE(insufficient.has_value());
  EXPECT_EQ(insufficient.error(), Error::out_of_space);
}

TEST(TerminalTest, RendersOnlyChangedAnsiRows) {
  TerminalOptions options;
  options.size = {.columns = 20, .rows = 4};
  auto terminal = make_terminal(options);
  write_text(terminal, "first row\r\nsecond row");

  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  const auto full = terminal.render_ansi(output, true);
  ASSERT_TRUE(full.has_value());
  EXPECT_TRUE(full->full);
  EXPECT_EQ(full->rows, options.size.rows);

  const auto clean = terminal.render_ansi(output);
  ASSERT_TRUE(clean.has_value());
  EXPECT_FALSE(clean->full);
  EXPECT_EQ(clean->rows, 0U);
  EXPECT_LT(clean->bytes, full->bytes);

  const auto allocations_before = terminal.allocation_stats().allocations_total;
  write_text(terminal, "\x1B[1;1Hchanged");
  const auto changed = terminal.render_ansi(output);
  ASSERT_TRUE(changed.has_value());
  EXPECT_FALSE(changed->full);
  EXPECT_EQ(changed->rows, 1U);
  EXPECT_LT(changed->bytes, full->bytes);
  EXPECT_EQ(terminal.allocation_stats().allocations_total, allocations_before);
}

TEST(TerminalTest, EncodesOnlyChangedCellSpan) {
  TerminalOptions options;
  options.size = {.columns = 40, .rows = 4};
  auto terminal = make_terminal(options);
  write_text(terminal, "\x1B[2;1Hunchanged-prefix-and-suffix");

  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  ASSERT_TRUE(terminal.render_ansi(output, true).has_value());
  write_text(terminal, "\x1B[2;13HX");
  const auto changed = terminal.render_ansi(output);
  ASSERT_TRUE(changed.has_value());
  EXPECT_EQ(changed->rows, 1U);
  EXPECT_LT(changed->bytes, 100U);

  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded(reinterpret_cast<const char*>(output.data()), changed->bytes);
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[2;13H"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("unchanged-prefix")));
}

TEST(TerminalTest, DetectsAndEncodesVerticalScroll) {
  TerminalOptions options;
  options.size = {.columns = 20, .rows = 4};
  auto terminal = make_terminal(options);
  write_text(terminal, "one\r\ntwo\r\nthree\r\nfour");

  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  ASSERT_TRUE(terminal.render_ansi(output, true).has_value());
  write_text(terminal, "\r\nfive");
  const auto changed = terminal.render_ansi(output);
  ASSERT_TRUE(changed.has_value());
  EXPECT_EQ(changed->scrolled_rows, 1);
  EXPECT_EQ(changed->rows, 1U);

  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded(reinterpret_cast<const char*>(output.data()), changed->bytes);
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1S"));
  EXPECT_THAT(encoded, testing::HasSubstr("five"));
}

TEST(TerminalTest, ResizesWithCheckedPixelDimensions) {
  auto terminal = make_terminal();
  const TerminalSize resized{
      .columns = 120,
      .rows = 40,
      .cell_width_px = 9,
      .cell_height_px = 18,
  };

  ASSERT_TRUE(terminal.resize(resized).has_value());
  EXPECT_EQ(terminal.size(), resized);

  const auto update = terminal.update_render_state();
  ASSERT_TRUE(update.has_value());
  EXPECT_EQ(update->columns, resized.columns);
  EXPECT_EQ(update->rows, resized.rows);
}

TEST(TerminalTest, EncodesNormalizedLegacyAndKittyKeys) {
  auto terminal = make_terminal();
  std::array<std::byte, 128> output{};
  const KeyEvent control_c{
      .key = Key::c,
      .modifiers = key_modifier_control,
      .unshifted_codepoint = 'c',
      .text = "c",
  };

  const auto legacy = terminal.encode_key(control_c, output);
  ASSERT_TRUE(legacy.has_value());
  ASSERT_EQ(*legacy, 1U);
  EXPECT_EQ(output.front(), std::byte{0x03});

  const KeyEvent enter_as_control_m{
      .key = Key::m,
      .modifiers = key_modifier_control,
      .unshifted_codepoint = 'm',
      .text = "m",
  };
  const auto enter = terminal.encode_key(enter_as_control_m, output);
  ASSERT_TRUE(enter.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded_control_m(reinterpret_cast<const char*>(output.data()), *enter);
  EXPECT_THAT(encoded_control_m, testing::StrEq("\x1B[109;5u"));

  write_text(terminal, "\x1B[>1u");
  const auto kitty = terminal.encode_key(control_c, output);
  ASSERT_TRUE(kitty.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded(reinterpret_cast<const char*>(output.data()), *kitty);
  EXPECT_THAT(encoded, testing::StrEq("\x1B[99;5u"));

  const KeyEvent enter_key{.key = Key::enter, .text = {}};
  const auto kitty_enter = terminal.encode_key(enter_key, output);
  ASSERT_TRUE(kitty_enter.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded_enter(reinterpret_cast<const char*>(output.data()), *kitty_enter);
  EXPECT_THAT(encoded_enter, testing::StrEq("\r"));
}

TEST(TerminalTest, KeyEncoderTracksCursorApplicationMode) {
  auto terminal = make_terminal();
  std::array<std::byte, 128> output{};
  const KeyEvent up{.key = Key::arrow_up, .text = {}};

  const auto normal = terminal.encode_key(up, output);
  ASSERT_TRUE(normal.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(output.data()), *normal), "\x1B[A");

  write_text(terminal, "\x1B[?1h");
  const auto application = terminal.encode_key(up, output);
  ASSERT_TRUE(application.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(output.data()), *application), "\x1BOA");
}

TEST(TerminalTest, CapturesEffectsWithoutCallingApplicationCode) {
  auto terminal = make_terminal();
  write_text(terminal, "\a\x1B]2;lemma title\x1B\\\x1B[?7$p");

  const auto effects = terminal.take_effects();
  EXPECT_EQ(effects.bells, 1U);
  EXPECT_EQ(effects.title_changes, 1U);
  EXPECT_FALSE(effects.pty_response_overflowed);

  const auto title = terminal.title();
  ASSERT_TRUE(title.has_value());
  EXPECT_THAT(*title, testing::StrEq("lemma title"));

  ASSERT_GT(terminal.pending_pty_response_bytes(), 0U);
  std::array<std::byte, 64> response{};
  const auto response_size = terminal.read_pty_responses(response);
  EXPECT_GT(response_size, 0U);
  EXPECT_EQ(terminal.pending_pty_response_bytes(), 0U);
}

TEST(TerminalTest, TracksQuotaAllocatorUsage) {
  auto terminal = make_terminal();
  const auto stats = terminal.allocation_stats();

  EXPECT_GT(stats.bytes_current, 0U);
  EXPECT_GE(stats.bytes_peak, stats.bytes_current);
  EXPECT_LE(stats.bytes_peak, limits::terminal_allocation_bytes_default);
  EXPECT_GT(stats.allocations_current, 0U);
  EXPECT_GE(stats.allocations_total, stats.allocations_current);
  EXPECT_EQ(stats.failures_total, 0U);
}

} // namespace
} // namespace lemma::vt
