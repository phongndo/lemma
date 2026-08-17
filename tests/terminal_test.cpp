#include "lemma/terminal/terminal.hpp"

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include <algorithm>
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

TEST(TerminalTest, PinnedLibraryBuildInfoMatchesProductionContract) {
  const auto info = library_build_info();
  ASSERT_TRUE(info.has_value());
  // Ghostty exposes UTF-8 as uint8_t while string_view uses char.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view version(reinterpret_cast<const char*>(info->version.data()),
                                 info->version.size());

  EXPECT_EQ(version, "0.1.0-dev");
  EXPECT_EQ(library_version().size(), info->version.size());
  EXPECT_TRUE(info->simd);
  EXPECT_TRUE(info->kitty_graphics);
  EXPECT_FALSE(info->tmux_control_mode);
#ifdef NDEBUG
  EXPECT_EQ(info->optimization, BuildOptimization::release_fast);
#else
  EXPECT_EQ(info->optimization, BuildOptimization::debug);
#endif
}

TEST(TerminalTest, PreservesPositionalTerminalOptionMembers) {
  // Positional construction is intentional: this is an aggregate-compatibility regression.
  // NOLINTNEXTLINE(modernize-use-designated-initializers)
  const TerminalOptions options{{.columns = 40, .rows = 10}, 1'024U, 2'048U, {}, {}};
  EXPECT_EQ(options.scrollback_bytes_max, 1'024U);
  EXPECT_EQ(options.allocation_bytes_max, 2'048U);
  EXPECT_FALSE(options.theme.has_value());
  EXPECT_FALSE(options.scrollback_lines_max.has_value());
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

  TerminalOptions excessive_scrollback_lines;
  excessive_scrollback_lines.scrollback_lines_max = limits::terminal_scrollback_lines_hard_max + 1U;
  const auto excessive_scrollback_lines_result = Terminal::create(excessive_scrollback_lines);
  ASSERT_FALSE(excessive_scrollback_lines_result.has_value());
  EXPECT_EQ(excessive_scrollback_lines_result.error(), Error::invalid_options);

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

TEST(TerminalTest, ReportsNewDamageWithoutConsumingPreviouslyPendingRows) {
  auto terminal = make_terminal();
  ASSERT_TRUE(terminal.update_render_state().has_value());
  ASSERT_TRUE(terminal.mark_rendered().has_value());

  constexpr std::string_view query_text = "\x1B[5n";
  const auto query = terminal.write_and_report_damage(
      std::as_bytes(std::span(query_text.data(), query_text.size())));
  ASSERT_TRUE(query.has_value());
  EXPECT_EQ(*query, DirtyState::clean);
  EXPECT_GT(terminal.pending_pty_response_bytes(), 0U);

  constexpr std::string_view visible_text = "visible";
  const auto visible = terminal.write_and_report_damage(
      std::as_bytes(std::span(visible_text.data(), visible_text.size())));
  ASSERT_TRUE(visible.has_value());
  EXPECT_NE(*visible, DirtyState::clean);

  const auto query_after_damage = terminal.write_and_report_damage(
      std::as_bytes(std::span(query_text.data(), query_text.size())));
  ASSERT_TRUE(query_after_damage.has_value());
  EXPECT_EQ(*query_after_damage, DirtyState::clean);

  const auto retained = terminal.update_render_state();
  ASSERT_TRUE(retained.has_value());
  EXPECT_NE(retained->dirty, DirtyState::clean);
  EXPECT_GE(retained->dirty_rows, 1U);
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
  EXPECT_LT(changed->bytes, 128U);

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

TEST(TerminalTest, ScrollDetectionHashesCompleteGraphemes) {
  TerminalOptions options;
  options.size = {.columns = 2, .rows = 4};
  auto canonical = make_terminal(options);
  auto projected = make_terminal(options);
  write_text(canonical, "a\xCC\x81\r\na\xCC\x82\r\na\xCC\x83\r\na\xCC\x84");

  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  const auto initial = canonical.render_ansi(output, true);
  ASSERT_TRUE(initial.has_value());
  projected.write(std::span(output).first(initial->bytes));

  write_text(canonical, "\r\na\xCC\x85\r\na\xCC\x86");
  const auto changed = canonical.render_ansi(output);
  ASSERT_TRUE(changed.has_value());
  EXPECT_EQ(changed->scrolled_rows, 2);
  EXPECT_EQ(changed->rows, 2U);
  projected.write(std::span(output).first(changed->bytes));

  canonical.invalidate_ansi_render_state();
  projected.invalidate_ansi_render_state();
  std::array<std::byte, std::size_t{16} * 1'024U> canonical_output{};
  std::array<std::byte, std::size_t{16} * 1'024U> projected_output{};
  const auto canonical_full = canonical.render_ansi(canonical_output, true);
  const auto projected_full = projected.render_ansi(projected_output, true);
  ASSERT_TRUE(canonical_full.has_value());
  ASSERT_TRUE(projected_full.has_value());
  EXPECT_TRUE(std::ranges::equal(std::span(canonical_output).first(canonical_full->bytes),
                                 std::span(projected_output).first(projected_full->bytes)));
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

TEST(TerminalTest, EncodesFocusAndMouseFromCanonicalModes) {
  auto terminal = make_terminal();
  std::array<std::byte, 128> output{};

  auto tracking = terminal.mouse_tracking();
  ASSERT_TRUE(tracking.has_value());
  EXPECT_EQ(*tracking, MouseTrackingState{});
  EXPECT_EQ(terminal.encode_focus(FocusEvent::gained, output), 0U);
  write_text(terminal, "\x1B[?1004h");
  const auto focus = terminal.encode_focus(FocusEvent::gained, output);
  ASSERT_TRUE(focus.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(output.data()), *focus), "\x1B[I");

  write_text(terminal, "\x1B[?1000h\x1B[?1006h");
  tracking = terminal.mouse_tracking();
  ASSERT_TRUE(tracking.has_value());
  EXPECT_EQ(*tracking, (MouseTrackingState{.enabled = true}));
  const MouseEvent mouse{
      .action = MouseAction::press,
      .button = MouseButton::left,
      .x = 4,
      .y = 2,
      .geometry = {.screen_width = 80, .screen_height = 24},
      .any_button_pressed = true,
  };
  const auto encoded = terminal.encode_mouse(mouse, output);
  ASSERT_TRUE(encoded.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(output.data()), *encoded),
            "\x1B[<0;5;3M");

  write_text(terminal, "\x1B[?1003h");
  tracking = terminal.mouse_tracking();
  ASSERT_TRUE(tracking.has_value());
  EXPECT_EQ(*tracking, (MouseTrackingState{.enabled = true, .unbuttoned_motion = true}));
}

TEST(TerminalTest, RoutesAlternateScreenWheelFromCanonicalModes) {
  auto terminal = make_terminal();

  EXPECT_EQ(terminal.wheel_uses_alternate_scroll(), false);
  write_text(terminal, "\x1B[?1049h");
  EXPECT_EQ(terminal.wheel_uses_alternate_scroll(), true);
  write_text(terminal, "\x1B[?1007l");
  EXPECT_EQ(terminal.wheel_uses_alternate_scroll(), false);
  write_text(terminal, "\x1B[?1007h\x1B[?1000h");
  EXPECT_EQ(terminal.wheel_uses_alternate_scroll(), false);
  write_text(terminal, "\x1B[?1000l");
  EXPECT_EQ(terminal.wheel_uses_alternate_scroll(), true);
  write_text(terminal, "\x1B[?1049l");
  EXPECT_EQ(terminal.wheel_uses_alternate_scroll(), false);
}

TEST(TerminalTest, EncodesOpaquePasteThroughGhosttyPolicy) {
  auto terminal = make_terminal();
  std::array<std::byte, 64> output{};
  std::array input{std::byte{'a'}, std::byte{'\n'}, std::byte{0x1B}, std::byte{'b'}};
  EXPECT_FALSE(terminal.paste_is_safe(input));

  auto encoded = terminal.encode_paste(input, output);
  ASSERT_TRUE(encoded.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(output.data()), *encoded), "a\r b");

  write_text(terminal, "\x1B[?2004h");
  input = {std::byte{'a'}, std::byte{'\n'}, std::byte{0x1B}, std::byte{'b'}};
  encoded = terminal.encode_paste(input, output);
  ASSERT_TRUE(encoded.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(output.data()), *encoded),
            "\x1B[200~a\n b\x1B[201~");
}

TEST(TerminalTest, DisablesUnsupportedGraphicsUntilBoundedPresentationExists) {
  auto terminal = make_terminal();
  const auto allocations = terminal.allocation_stats().bytes_current;
  write_text(terminal, "\x1B_Gi=1,a=q,s=1,v=1,f=24;AAAA\x1B\\");
  write_text(terminal, "\x1B_25a1;s\x1B\\");
  write_text(terminal, "\x1B_25a1;r;cp=e0a0;AAAAAAAAAAAAAA==\x1B\\");

  EXPECT_EQ(terminal.pending_pty_response_bytes(), 0U);
  EXPECT_FALSE(terminal.integrity_failed());
  EXPECT_EQ(terminal.allocation_stats().bytes_current, allocations);
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, PtyResponseOverflowIsStickyTerminalIntegrityFailure) {
  auto terminal = make_terminal();
  std::string queries;
  constexpr std::string_view query = "\x1B[6n";
  queries.reserve(query.size() * 20'000U);
  for (std::size_t count = 0; count < 20'000U; ++count) {
    queries.append(query);
  }
  write_text(terminal, queries);

  EXPECT_TRUE(terminal.pty_response_overflowed());
  EXPECT_TRUE(terminal.integrity_failed());
  EXPECT_TRUE(terminal.take_effects().pty_response_overflowed);
  EXPECT_TRUE(terminal.pty_response_overflowed());
  EXPECT_TRUE(terminal.integrity_failed());
}

TEST(TerminalTest, ReportsTruthfulChildVisibleIdentityAndGeometry) {
  auto terminal = make_terminal();
  write_text(terminal, "\x1B[c\x1B[>q\x1B[18t\x1B[?996n\x1BP+q544e\x1B\\");

  std::array<std::byte, 512> response{};
  const auto response_size = terminal.read_pty_responses(response);
  ASSERT_GT(response_size, 0U);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded(reinterpret_cast<const char*>(response.data()), response_size);
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[?62;22c"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1BP>|lemma\x1B\\"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[8;24;80t"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[?997;1n"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1BP1+r544E=787465726D2D323536636F6C6F72\x1B\\"));
}

TEST(TerminalTest, CapturesEffectsWithoutCallingApplicationCode) {
  auto terminal = make_terminal();
  write_text(terminal, "\a\x1B]2;lemma title\x1B\\\x1B]7;file:///tmp\x1B\\"
                       "\x1B]777;notify;Codex;Needs attention\a\x1B]9;4;1;42\x1B\\"
                       "\x1B]52;c;YQ==\x1B\\\x1B_unsupported\x1B\\\x05\x1B[?7$p");

  const auto effects = terminal.take_effects();
  EXPECT_EQ(effects.bells, 1U);
  EXPECT_EQ(effects.title_changes, 1U);
  EXPECT_EQ(effects.pwd_changes, 1U);
  EXPECT_EQ(effects.desktop_notifications, 1U);
  EXPECT_EQ(effects.progress_reports, 1U);
  EXPECT_EQ(effects.clipboard_writes_denied, 1U);
  EXPECT_EQ(effects.unknown_sequences_dropped, 1U);
  EXPECT_FALSE(effects.unknown_sequence_truncated);
  EXPECT_FALSE(effects.pty_response_overflowed);

  const auto title = terminal.title();
  ASSERT_TRUE(title.has_value());
  EXPECT_THAT(*title, testing::StrEq("lemma title"));

  ASSERT_GT(terminal.pending_pty_response_bytes(), 0U);
  std::array<std::byte, 64> response{};
  const auto response_size = terminal.read_pty_responses(response);
  EXPECT_GT(response_size, 0U);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded(reinterpret_cast<const char*>(response.data()), response_size);
  EXPECT_THAT(encoded, testing::HasSubstr("lemma"));
  EXPECT_EQ(terminal.pending_pty_response_bytes(), 0U);
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, GrowsAndPrunesScrollbackUnderItsOwnerQuota) {
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
TEST(TerminalTest, DefaultScrollbackRetainsMultipleGhosttyPages) {
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

TEST(TerminalTest, UsesGhosttyGesturesAndTrackedSelectionEndpoints) {
  TerminalOptions options;
  options.size = {.columns = 12, .rows = 3};
  options.scrollback_bytes_max = limits::terminal_scrollback_bytes_hard_max;
  options.scrollback_lines_max = 100;
  auto terminal = make_terminal(options);
  write_text(terminal, "hello world\r\nsecond line");

  auto gesture = terminal.selection_gesture({
      .phase = SelectionGesturePhase::press,
      .point = {.space = PointSpace::viewport, .column = 0, .row = 0},
      .pointer_x = 2,
      .pointer_y = 4,
      .cell_width = 10,
      .screen_height = 30,
      .has_pointer_position = true,
  });
  ASSERT_TRUE(gesture.has_value());
  EXPECT_FALSE(gesture->selection_changed);
  gesture = terminal.selection_gesture({
      .phase = SelectionGesturePhase::drag,
      .point = {.space = PointSpace::viewport, .column = 5, .row = 0},
      .pointer_x = 55,
      .pointer_y = 4,
      .cell_width = 10,
      .screen_height = 30,
      .has_pointer_position = true,
  });
  ASSERT_TRUE(gesture.has_value());
  EXPECT_TRUE(gesture->selection_changed);
  EXPECT_TRUE(gesture->dragged);

  std::array<std::byte, 128> selected{};
  auto selected_size = terminal.format_selection(ScreenFormat::plain, selected);
  ASSERT_TRUE(selected_size.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(selected.data()), *selected_size),
            "hello");

  ASSERT_TRUE(
      terminal.select(SelectionUnit::word, {.space = PointSpace::viewport, .column = 6, .row = 0})
          .value_or(false));
  write_text(terminal, "\r\nthird\r\nfourth\r\nfifth");
  selected_size = terminal.format_selection(ScreenFormat::plain, selected);
  ASSERT_TRUE(selected_size.has_value());
  // The terminal-owned active selection uses tracked Ghostty refs and follows "world" into history.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(selected.data()), *selected_size),
            "world");
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, MovesCopyCursorByGhosttyWordSemantics) {
  TerminalOptions options;
  options.size = {.columns = 20, .rows = 2};
  auto terminal = make_terminal(options);
  write_text(terminal, "alpha bravo");
  ASSERT_TRUE(
      terminal.select(SelectionUnit::word, {.space = PointSpace::viewport, .column = 0, .row = 0})
          .value_or(false));
  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::word_right, false).value_or(false));

  std::array<std::byte, 32> selected{};
  const auto selected_size = terminal.format_selection(ScreenFormat::plain, selected);
  ASSERT_TRUE(selected_size.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(selected.data()), *selected_size), "b");

  ASSERT_TRUE(
      terminal.select(SelectionUnit::cell, {.space = PointSpace::viewport, .column = 2, .row = 0})
          .value_or(false));
  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::word_right, false).value_or(false));
  selected.fill(std::byte{0});
  const auto from_inside = terminal.format_selection(ScreenFormat::plain, selected);
  ASSERT_TRUE(from_inside.has_value());
  // `w` skips the remainder of the current Ghostty word and lands on the next word's start.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(selected.data()), *from_inside), "b");

  ASSERT_TRUE(
      terminal.select(SelectionUnit::cell, {.space = PointSpace::viewport, .column = 8, .row = 0})
          .value_or(false));
  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::word_left, false).value_or(false));
  selected.fill(std::byte{0});
  const auto backward = terminal.format_selection(ScreenFormat::plain, selected);
  ASSERT_TRUE(backward.has_value());
  // `b` from inside a word lands on that word's start rather than stepping one cell.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(selected.data()), *backward), "b");
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, WordNavigationRetainsProgressAcrossLongBlankRuns) {
  TerminalOptions options;
  options.size = {.columns = limits::terminal_columns_hard_max, .rows = 2};
  auto terminal = make_terminal(options);
  write_text(terminal, "alpha\r\nbravo");
  ASSERT_TRUE(
      terminal.select(SelectionUnit::word, {.space = PointSpace::viewport, .column = 0, .row = 0})
          .value_or(false));

  for (std::size_t step = 0; step < 4; ++step) {
    ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::word_right, false).value_or(false));
  }

  std::array<std::byte, 16> selected{};
  const auto selected_size = terminal.format_selection(ScreenFormat::plain, selected);
  ASSERT_TRUE(selected_size.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(selected.data()), *selected_size), "b");
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, NavigatesViewportAndFormatsAdjustedSelectionWithinCallerBound) {
  TerminalOptions options;
  options.size = {.columns = 10, .rows = 2};
  options.scrollback_bytes_max = limits::terminal_scrollback_bytes_hard_max;
  auto terminal = make_terminal(options);
  for (std::size_t row = 0; row < 20; ++row) {
    write_text(terminal, "history\r\n");
  }

  auto viewport = terminal.viewport_state();
  ASSERT_TRUE(viewport.has_value());
  EXPECT_TRUE(viewport->follows_output);
  EXPECT_GT(viewport->offset, 0U);
  terminal.scroll_viewport(ViewportScroll::top);
  viewport = terminal.viewport_state();
  ASSERT_TRUE(viewport.has_value());
  EXPECT_FALSE(viewport->follows_output);
  EXPECT_EQ(viewport->offset, 0U);

  ASSERT_TRUE(
      terminal.select(SelectionUnit::cell, {.space = PointSpace::viewport, .column = 0, .row = 0})
          .value_or(false));
  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::end_of_line, true).value_or(false));
  std::array<std::byte, 64> output{};
  const auto formatted = terminal.format_selection(ScreenFormat::plain, output);
  ASSERT_TRUE(formatted.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_THAT(std::string_view(reinterpret_cast<const char*>(output.data()), *formatted),
              testing::HasSubstr("history"));

  std::array<std::byte, 1> insufficient{};
  const auto bounded = terminal.format_selection(ScreenFormat::plain, insufficient);
  ASSERT_FALSE(bounded.has_value());
  EXPECT_EQ(bounded.error(), Error::out_of_space);
  const auto followed = terminal.scroll_viewport_to_bottom();
  ASSERT_TRUE(followed.has_value());
  EXPECT_TRUE(*followed);
  EXPECT_TRUE(terminal.viewport_state()->follows_output);
  EXPECT_EQ(terminal.scroll_viewport_to_bottom(), false);
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, SearchesIncrementallyWithoutRetainingDuplicateGrid) {
  TerminalOptions options;
  options.size = {.columns = 16, .rows = 3};
  options.scrollback_bytes_max = limits::terminal_scrollback_bytes_hard_max;
  auto terminal = make_terminal(options);
  write_text(terminal, "alpha\r\nbeta needle\r\ngamma");

  std::optional<SearchCursor> cursor;
  SearchStepResult step{};
  for (std::size_t slice = 0; slice < 1'000; ++slice) {
    const auto result = terminal.search_literal_step("needle", SearchDirection::forward, cursor, 2);
    ASSERT_TRUE(result.has_value());
    step = *result;
    if (step.status != SearchStepStatus::pending) {
      break;
    }
    cursor = step.next;
  }

  ASSERT_EQ(step.status, SearchStepStatus::found);
  ASSERT_TRUE(terminal.select_search_match(step.match).has_value());
  ASSERT_TRUE(terminal.scroll_selection_into_view().has_value());
  std::array<std::byte, 32> output{};
  const auto formatted = terminal.format_selection(ScreenFormat::plain, output);
  ASSERT_TRUE(formatted.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(output.data()), *formatted), "needle");

  ASSERT_TRUE(terminal.collapse_selection_to_endpoint().value_or(false));
  output.fill(std::byte{0});
  const auto collapsed = terminal.format_selection(ScreenFormat::plain, output);
  ASSERT_TRUE(collapsed.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(output.data()), *collapsed), "e");
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, RefreshesTrackedSelectionAfterReflowBeforeRendering) {
  TerminalOptions options;
  options.size = {.columns = 80, .rows = 23};
  options.scrollback_bytes_max = limits::terminal_scrollback_bytes_hard_max;
  auto terminal = make_terminal(options);
  for (std::size_t row = 0; row < 20; ++row) {
    write_text(terminal,
               "history abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\r\n");
  }
  write_text(terminal,
             "tracked abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\r\n");
  for (std::size_t row = 0; row < 25; ++row) {
    write_text(terminal,
               "history abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\r\n");
  }

  std::optional<SearchCursor> cursor;
  SearchStepResult step{};
  for (std::size_t slice = 0; slice < 1'000; ++slice) {
    const auto result =
        terminal.search_literal_step("tracked", SearchDirection::backward, cursor, 32);
    ASSERT_TRUE(result.has_value());
    step = *result;
    if (step.status != SearchStepStatus::pending) {
      break;
    }
    cursor = step.next;
  }
  ASSERT_EQ(step.status, SearchStepStatus::found);
  ASSERT_TRUE(terminal.select_search_match(step.match).has_value());
  ASSERT_TRUE(terminal.scroll_selection_into_view().has_value());

  ASSERT_TRUE(terminal.resize({.columns = 40, .rows = 23}).has_value());
  ASSERT_TRUE(terminal.refresh_selection().value_or(false));
  ASSERT_TRUE(terminal.scroll_selection_into_view().has_value());
  const auto endpoint = terminal.selection_endpoint(PointSpace::viewport);
  ASSERT_TRUE(endpoint.has_value());
  const auto endpoint_point = endpoint.value_or(std::optional<TerminalPoint>{});
  ASSERT_TRUE(endpoint_point.has_value());
  const auto point = endpoint_point.value_or(TerminalPoint{});

  std::array<std::byte, std::size_t{512} * 1'024U> output{};
  const PaneRenderOptions render_options{
      .cursor_override_column = point.column,
      .cursor_override_row = static_cast<std::uint16_t>(point.row),
      .force_full = true,
      .focused = true,
      .cursor_override = true,
  };
  const auto rendered = terminal.render_pane_ansi(output, render_options);
  if (!rendered.has_value()) {
    ADD_FAILURE() << "render error: " << static_cast<unsigned>(rendered.error());
  }
}

TEST(TerminalTest, RetainsPartialSearchMatchWhenSliceWorkIsExhausted) {
  TerminalOptions options;
  options.size = {.columns = 16, .rows = 2};
  auto terminal = make_terminal(options);
  write_text(terminal, "a");

  const auto first = terminal.search_literal_step("aZ", SearchDirection::forward, std::nullopt, 1);
  ASSERT_TRUE(first.has_value());
  ASSERT_EQ(first->status, SearchStepStatus::pending);
  EXPECT_TRUE(first->next.matching);
  EXPECT_EQ(first->next.query_offset, 1);
  EXPECT_EQ(first->next.candidate, (TerminalPoint{.space = PointSpace::screen}));
  EXPECT_EQ(first->next.text, (TerminalPoint{.space = PointSpace::screen, .column = 1, .row = 0}));

  const auto second = terminal.search_literal_step("aZ", SearchDirection::forward, first->next, 1);
  ASSERT_TRUE(second.has_value());
  EXPECT_EQ(second->status, SearchStepStatus::pending);
  EXPECT_EQ(second->next.query_offset, 1);
  EXPECT_EQ(second->next.text, (TerminalPoint{.space = PointSpace::screen, .column = 2, .row = 0}));
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, CompressesScrollbackIncrementallyWithoutChangingLogicalContent) {
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

TEST(TerminalTest, ProjectsIncrementalSelectionAndCopyCursorHighlight) {
  TerminalOptions options;
  options.size = {.columns = 12, .rows = 2};
  auto terminal = make_terminal(options);
  write_text(terminal, "selected");

  std::array<std::byte, 8'192> output{};
  ASSERT_TRUE(terminal.render_ansi(output, true).has_value());
  ASSERT_TRUE(
      terminal.select(SelectionUnit::word, {.space = PointSpace::viewport, .column = 0, .row = 0})
          .value_or(false));
  const auto endpoint = terminal.selection_endpoint(PointSpace::viewport);
  ASSERT_TRUE(endpoint.has_value());
  const auto endpoint_point = endpoint.value_or(std::optional<TerminalPoint>{});
  ASSERT_TRUE(endpoint_point.has_value());
  const auto point = endpoint_point.value_or(TerminalPoint{});
  EXPECT_EQ(point.column, 7);
  EXPECT_EQ(point.row, 0U);

  output.fill(std::byte{0});
  const PaneRenderOptions render_options{
      .cursor_override_column = point.column,
      .cursor_override_row = static_cast<std::uint16_t>(point.row),
      .focused = true,
      .cursor_override = true,
  };
  const auto rendered = terminal.render_pane_ansi(output, render_options);
  ASSERT_TRUE(rendered.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view ansi(reinterpret_cast<const char*>(output.data()), rendered->bytes);
  EXPECT_THAT(ansi, testing::HasSubstr(";7"));
  EXPECT_THAT(ansi, testing::HasSubstr("mselected"));
  EXPECT_THAT(ansi, testing::HasSubstr("\x1B[1;8H\x1B[?25h"));
  EXPECT_THAT(ansi, testing::HasSubstr("\x1B[2 q"));
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
