#include "client/host_input_parser.hpp"
#include "core/input.hpp"
#include "core/presentation_gate.hpp"
#include "core/terminal_resize.hpp"
#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"
#include "protocol/single_pane.hpp"
#include "render/pane_composition.hpp"
#include "render/single_pane.hpp"

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <span>
#include <string_view>
#include <utility>

namespace lemma {
namespace {

TEST(GhosttyParityContractTest, DeclaredGeometryFitsBoundedFrameTransaction) {
  constexpr auto declared_frame_bound =
      (std::size_t{protocol::columns_max} * protocol::rows_max * vt::pane_ansi_bytes_per_cell_max) +
      render::frame_fixed_overhead_bytes;
  constexpr auto abuse_limit_frame_bound =
      (std::size_t{limits::terminal_columns_hard_max} * limits::terminal_rows_hard_max *
       vt::pane_ansi_bytes_per_cell_max) +
      render::frame_fixed_overhead_bytes;

  EXPECT_EQ(declared_frame_bound, 35'204'096U);
  EXPECT_LE(declared_frame_bound, limits::frame_transaction_bytes_max);
  EXPECT_GT(abuse_limit_frame_bound, limits::frame_transaction_bytes_max);
  EXPECT_EQ(render::frame_bytes_max, limits::frame_transaction_bytes_max);
  EXPECT_EQ(protocol::render_ansi_bytes_max, limits::frame_chunk_bytes_max);
}

TEST(GhosttyParityContractTest, SecurityAndProgressLimitsMatchM0Policy) {
  EXPECT_EQ(limits::frame_transaction_bytes_max, std::size_t{64} * 1'024U * 1'024U);
  EXPECT_EQ(limits::frame_output_queue_bytes_max, std::size_t{8} * 1'024U * 1'024U);
  EXPECT_EQ(limits::frame_retained_bytes_aggregate_max, std::size_t{256} * 1'024U * 1'024U);
  EXPECT_EQ(limits::render_snapshot_hold_max, std::chrono::milliseconds{50});
  EXPECT_EQ(limits::frame_transaction_progress_deadline, std::chrono::seconds{5});
  EXPECT_EQ(limits::frame_transaction_total_deadline, std::chrono::seconds{30});
  EXPECT_EQ(limits::synchronized_output_presentation_timeout, std::chrono::seconds{1});
  EXPECT_EQ(limits::structured_input_payload_bytes_max, std::size_t{1} * 1'024U * 1'024U);
  EXPECT_EQ(limits::structured_event_batch_expanded_max, 4'096U);
  EXPECT_EQ(limits::pixel_mouse_report_bytes_max, 128U);
  EXPECT_EQ(limits::paste_payload_bytes_max, std::size_t{1} * 1'024U * 1'024U);
  EXPECT_EQ(limits::terminal_pty_response_bytes_max, std::size_t{64} * 1'024U);
  EXPECT_EQ(limits::selection_format_bytes_max, std::size_t{1} * 1'024U * 1'024U);
  EXPECT_EQ(limits::search_query_bytes_max, 256U);
  EXPECT_EQ(limits::search_candidates_per_step, 256U);
  EXPECT_EQ(limits::scrollback_compression_idle_delay, std::chrono::seconds{1});
}

[[nodiscard]] auto make_terminal(const vt::TerminalOptions& options = {}) -> vt::Terminal {
  auto terminal = vt::Terminal::create(options);
  EXPECT_TRUE(terminal.has_value());
  return std::move(*terminal);
}

void write_terminal(vt::Terminal& terminal, const std::string_view text) {
  terminal.write(std::as_bytes(std::span(text.data(), text.size())));
}

[[nodiscard]] auto output_text(const std::span<const std::byte> bytes) -> std::string_view {
  // Rendered bytes are borrowed as text only for matcher assertions.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  return {reinterpret_cast<const char*>(bytes.data()), bytes.size()};
}

TEST(GhosttyParityRegressionTest, M2SessionThemeSurvivesReattach) {
  auto theme = vt::default_theme();
  theme.foreground = {.red = 17, .green = 34, .blue = 51};
  theme.background = {.red = 1, .green = 2, .blue = 3};
  theme.cursor = {.red = 68, .green = 85, .blue = 102};
  vt::TerminalOptions options;
  options.theme = theme;
  auto terminal = make_terminal(options);

  EXPECT_EQ(terminal.theme(), theme);
  terminal.invalidate_ansi_render_state();
  EXPECT_EQ(terminal.theme(), theme);
}

TEST(GhosttyParityRegressionTest, M2AnsiProjectionPreservesSemanticColorsAndCursor) {
  auto theme = vt::default_theme();
  theme.foreground = {.red = 10, .green = 20, .blue = 30};
  theme.background = {.red = 40, .green = 50, .blue = 60};
  theme.cursor = {.red = 70, .green = 80, .blue = 90};
  theme.palette.at(1) = {.red = 101, .green = 102, .blue = 103};
  vt::TerminalOptions options;
  options.size = {.columns = 8, .rows = 2};
  options.theme = theme;
  auto terminal = make_terminal(options);
  write_terminal(terminal, "\x1B[31mR\x1B[0;48;2;7;8;9m \x1B[0mD");

  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  const auto rendered = terminal.render_ansi(output, true);
  ASSERT_TRUE(rendered.has_value());
  const auto ansi = output_text(std::span(output).first(rendered->bytes));
  EXPECT_THAT(ansi, testing::HasSubstr("38;5;1"));
  EXPECT_THAT(ansi, testing::HasSubstr("48;2;7;8;9"));
  EXPECT_THAT(ansi, testing::Not(testing::HasSubstr("38;2;10;20;30")));
  EXPECT_THAT(ansi, testing::Not(testing::HasSubstr("48;2;40;50;60")));
  EXPECT_THAT(ansi, testing::HasSubstr("\x1B]112\x1B\\"));
}

TEST(GhosttyParityRegressionTest, M2EraseLineTailPreservesSessionBackground) {
  auto theme = vt::default_theme();
  theme.foreground = {.red = 10, .green = 20, .blue = 30};
  theme.background = {.red = 40, .green = 50, .blue = 60};
  vt::TerminalOptions options;
  options.size = {.columns = 8, .rows = 2};
  options.theme = theme;
  auto terminal = make_terminal(options);
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto blank = terminal.render_ansi(output, true);
  ASSERT_TRUE(blank.has_value());
  EXPECT_THAT(output_text(std::span(output).first(blank->bytes)),
              testing::HasSubstr("\x1B[0m\x1B[K"));

  write_terminal(terminal, "text");
  const auto tail = terminal.render_ansi(output, true);
  ASSERT_TRUE(tail.has_value());
  EXPECT_THAT(output_text(std::span(output).first(tail->bytes)),
              testing::HasSubstr("\x1B[0m\x1B[K"));
}

TEST(GhosttyParityRegressionTest, M2PaletteRedrawDoesNotImitateTerminalScroll) {
  auto theme = vt::default_theme();
  theme.palette.at(1) = {.red = 1, .green = 2, .blue = 3};
  vt::TerminalOptions options;
  options.size = {.columns = 6, .rows = 4};
  options.theme = theme;
  auto terminal = make_terminal(options);
  write_terminal(terminal, "\x1B[31mAAAA\x1B[2;1HAAAA\x1B[3;1HAAAA\x1B[4;1HAAAA");
  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  ASSERT_TRUE(terminal.render_ansi(output, true).has_value());

  write_terminal(terminal, "\x1B]4;1;rgb:0a/14/1e\x1B\\");
  const auto recolored = terminal.render_ansi(output);
  ASSERT_TRUE(recolored.has_value());
  EXPECT_EQ(recolored->scrolled_rows, 0);
  EXPECT_EQ(recolored->rows, options.size.rows);
  const auto ansi = output_text(std::span(output).first(recolored->bytes));
  EXPECT_THAT(ansi, testing::HasSubstr("38;2;10;20;30"));
  EXPECT_THAT(ansi, testing::Not(testing::HasSubstr("\x1B[1S")));
  EXPECT_THAT(ansi, testing::Not(testing::HasSubstr("\x1B[1T")));
}

TEST(GhosttyParityRegressionTest, M2AnsiProjectionIsolatesPaneColorOverrides) {
  auto theme = vt::default_theme();
  theme.foreground = {.red = 10, .green = 20, .blue = 30};
  theme.background = {.red = 40, .green = 50, .blue = 60};
  theme.palette.at(1) = {.red = 70, .green = 80, .blue = 90};
  vt::TerminalOptions options;
  options.size = {.columns = 8, .rows = 2};
  options.theme = theme;
  auto terminal = make_terminal(options);
  write_terminal(terminal, "\x1B[31mP\x1B[38;2;70;80;90mT\x1B[0mD"
                           "\x1B]4;1;rgb:01/02/03\x1B\\\x1B[31mO"
                           "\x1B]10;rgb:04/05/06\x1B\\\x1B]11;rgb:07/08/09\x1B\\"
                           "\x1B]12;rgb:0a/0b/0c\x1B\\\x1B[0mX");

  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  const auto overridden = terminal.render_ansi(output, true);
  ASSERT_TRUE(overridden.has_value());
  const auto ansi = output_text(std::span(output).first(overridden->bytes));
  EXPECT_THAT(ansi, testing::HasSubstr("38;2;70;80;90"));
  EXPECT_THAT(ansi, testing::HasSubstr("38;2;1;2;3"));
  EXPECT_THAT(ansi, testing::HasSubstr("38;2;4;5;6"));
  EXPECT_THAT(ansi, testing::HasSubstr("48;2;7;8;9"));
  EXPECT_THAT(ansi, testing::HasSubstr("\x1B]12;#0a0b0c\x1B\\"));

  write_terminal(terminal, "\x1B]104;1\x1B\\\x1B]110\x1B\\\x1B]111\x1B\\\x1B]112\x1B\\\x1B[31mR");
  const auto reset = terminal.render_ansi(output, true);
  ASSERT_TRUE(reset.has_value());
  const auto reset_ansi = output_text(std::span(output).first(reset->bytes));
  EXPECT_THAT(reset_ansi, testing::HasSubstr("38;5;1"));
  EXPECT_THAT(reset_ansi, testing::Not(testing::HasSubstr("38;2;4;5;6")));
  EXPECT_THAT(reset_ansi, testing::Not(testing::HasSubstr("48;2;7;8;9")));
  EXPECT_THAT(reset_ansi, testing::HasSubstr("\x1B]112\x1B\\"));
}

TEST(GhosttyParityRegressionTest, M2ThemeReplacementPreservesApplicationOverrides) {
  auto theme = vt::default_theme();
  vt::TerminalOptions options;
  options.size = {.columns = 4, .rows = 2};
  options.theme = theme;
  auto terminal = make_terminal(options);
  write_terminal(terminal, "\x1B]4;1;rgb:01/02/03\x1B\\\x1B[31mX");
  theme.foreground = {.red = 10, .green = 20, .blue = 30};
  theme.palette.at(1) = {.red = 40, .green = 50, .blue = 60};

  ASSERT_TRUE(terminal.set_theme(theme).has_value());

  EXPECT_EQ(terminal.theme(), theme);
  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  const auto rendered = terminal.render_ansi(output, true);
  ASSERT_TRUE(rendered.has_value());
  EXPECT_THAT(output_text(std::span(output).first(rendered->bytes)),
              testing::HasSubstr("38;2;1;2;3"));
}

TEST(GhosttyParityRegressionTest, M2SynchronizedOutputIsGatedPerPane) {
  vt::TerminalOptions options;
  options.size = {.columns = 6, .rows = 2};
  auto held = make_terminal(options);
  auto live = make_terminal(options);
  std::array<std::byte, std::size_t{32} * 1'024U> output{};
  std::array panes{
      render::PaneSurface{
          .terminal = &held, .rectangle = {.columns = 6, .rows = 2}, .focused = true},
      render::PaneSurface{.terminal = &live, .rectangle = {.column = 6, .columns = 6, .rows = 2}},
  };
  ASSERT_TRUE(render::compose_frame(panes, {.columns = 12, .rows = 2}, output, true).has_value());

  write_terminal(held, "\x1B[?2026hhidden");
  write_terminal(live, "visible");
  core::PresentationGate gate;
  ASSERT_TRUE(held.synchronized_output().value_or(false));
  static_cast<void>(gate.observe(true, true, core::PresentationGate::TimePoint{}));
  panes.front().presentation_suppressed = gate.presentation_suppressed();

  const auto rendered = render::compose_frame(panes, {.columns = 12, .rows = 2}, output, false);
  ASSERT_TRUE(rendered.has_value());
  const auto ansi = output_text(std::span(output).first(rendered->bytes));
  EXPECT_THAT(ansi, testing::HasSubstr("visibl"));
  EXPECT_THAT(ansi, testing::Not(testing::HasSubstr("hidden")));
  const auto retained = held.update_render_state();
  ASSERT_TRUE(retained.has_value());
  EXPECT_NE(retained->dirty, vt::DirtyState::clean);

  const auto forced = render::compose_frame(panes, {.columns = 12, .rows = 2}, output, true);
  ASSERT_TRUE(forced.has_value());
  EXPECT_FALSE(forced->full);
  EXPECT_THAT(output_text(std::span(output).first(forced->bytes)),
              testing::Not(testing::HasSubstr("\x1B[2J")));
}

TEST(GhosttyParityRegressionTest, M2SynchronizedOutputWatchdogPreservesCanonicalMode) {
  auto terminal = make_terminal();
  write_terminal(terminal, "\x1B[?2026hheld");
  ASSERT_TRUE(terminal.synchronized_output().value_or(false));

  core::PresentationGate gate;
  constexpr auto origin = core::PresentationGate::TimePoint{};
  const auto held = gate.observe(true, true, origin);
  EXPECT_TRUE(held.presentation_deferred);
  const auto released =
      gate.release_if_expired(origin + limits::synchronized_output_presentation_timeout);

  EXPECT_TRUE(released.urgent_render);
  EXPECT_TRUE(released.force_full);
  EXPECT_EQ(gate.suppression(), core::PresentationSuppression::watchdog_released);
  EXPECT_EQ(gate.watchdog_releases(), 1U);
  EXPECT_TRUE(terminal.synchronized_output().value_or(false));
}

TEST(GhosttyParityRegressionTest, M2FrameTransactionAbortRepairsPhysicalShadow) {
  vt::TerminalOptions options;
  options.size = {.columns = 12, .rows = 2};
  auto terminal = make_terminal(options);
  const render::PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 12, .rows = 2},
      .focused = true,
  };
  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  ASSERT_TRUE(render::compose_frame(std::span(&pane, 1), {.columns = 12, .rows = 2}, output, true)
                  .has_value());
  write_terminal(terminal, "repair");

  std::array<std::byte, 48> exhausted{};
  const auto aborted =
      render::compose_frame(std::span(&pane, 1), {.columns = 12, .rows = 2}, exhausted, false);
  ASSERT_FALSE(aborted.has_value());
  EXPECT_EQ(aborted.error(), render::CompositionError::output_exhausted);

  const auto repaired =
      render::compose_frame(std::span(&pane, 1), {.columns = 12, .rows = 2}, output, false);
  ASSERT_TRUE(repaired.has_value());
  EXPECT_TRUE(repaired->full);
  EXPECT_THAT(output_text(std::span(output).first(repaired->bytes)), testing::HasSubstr("repair"));
}

struct ResizeFailure final {
  vt::Terminal* terminal{nullptr};
  vt::TerminalSize observed{};
};

[[nodiscard]] auto fail_pty_resize(void* const context, const vt::TerminalSize& size) noexcept
    -> bool {
  auto& failure = *static_cast<ResizeFailure*>(context);
  failure.observed = failure.terminal->size();
  return size != failure.observed;
}

TEST(GhosttyParityRegressionTest, M2ResizeRollsBackAfterPtyFailure) {
  auto terminal = make_terminal();
  const auto original = terminal.size();
  const vt::TerminalSize requested{.columns = 120, .rows = 40};
  ResizeFailure failure{.terminal = &terminal};

  const auto status =
      core::resize_terminal_transaction(terminal, requested, &fail_pty_resize, &failure);

  EXPECT_EQ(status, core::TerminalResizeStatus::rolled_back);
  EXPECT_EQ(failure.observed, requested) << "Ghostty must resize before the PTY is attempted";
  EXPECT_EQ(terminal.size(), original);
}

// Remaining disabled tests are executable M0 specifications for later milestones. Enabling any one
// requires replacing FAIL() with the real characterization.

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(GhosttyParityRegressionTest, M3HostInputDecoderAcceptsEveryFragmentationBoundary) {
  constexpr std::string_view encoded = "x\x1B[200~p\x02q\x1B[201~\x1B[I\x1B[<0;2;2M";
  const auto input = std::as_bytes(std::span(encoded));
  for (std::size_t split = 0; split <= input.size(); ++split) {
    client::HostInputParser parser;
    ASSERT_TRUE(parser.prepare().has_value());
    std::array<std::byte, 128> storage{};
    std::size_t events = 0;
    for (const auto fragment : {input.first(split), input.subspan(split)}) {
      const auto parsed = parser.parse(fragment, storage, {.columns = 80, .rows = 24});
      ASSERT_TRUE(parsed.has_value()) << split;
      events += parsed->event_count;
    }
    EXPECT_EQ(events, 4U) << split;
    EXPECT_FALSE(parser.has_pending_sequence()) << split;
  }
}

TEST(GhosttyParityRegressionTest, M3PasteIsOpaqueAndUsesGhosttyEncoder) {
  auto terminal = make_terminal();
  write_terminal(terminal, "\x1B[?2004h");
  core::PanePtyWriteQueue queue;
  std::array paste{std::byte{'p'}, std::byte{0x02}, std::byte{'q'}};

  ASSERT_EQ(core::queue_paste_input(queue, terminal, paste), core::InputQueueResult::queued);
  std::array<std::byte, 32> output{};
  const auto size = queue.read(output);
  EXPECT_EQ(output_text(std::span(output).first(size)), std::string_view("\x1B[200~p\x02"
                                                                         "q\x1B[201~",
                                                                         15));
}

TEST(GhosttyParityRegressionTest, M3KittyMetadataIsPreservedWithoutFabrication) {
  client::HostInputParser parser;
  ASSERT_TRUE(parser.prepare().has_value());
  constexpr std::string_view encoded = "\x1B[98;5:2;98u";
  const auto input = std::as_bytes(std::span(encoded));
  std::array<std::byte, 16> storage{};

  const auto parsed = parser.parse(input, storage, {.columns = 80, .rows = 24});

  ASSERT_TRUE(parsed.has_value());
  ASSERT_EQ(parsed->event_count, 1U);
  const auto& event = parsed->events.front();
  EXPECT_EQ(event.kind, client::HostInputKind::key);
  EXPECT_EQ(event.key.key, protocol::KeyInputKey::b);
  EXPECT_EQ(event.key.action, protocol::KeyInputAction::repeat);
  EXPECT_EQ(event.key.modifiers, protocol::key_input_modifier_control);
  EXPECT_EQ(event.key.unshifted_codepoint, static_cast<std::uint32_t>('b'));
}

TEST(GhosttyParityRegressionTest, M3MouseUsesReadTimeGeometryAndPaneLocalCoordinates) {
  client::HostInputParser parser;
  ASSERT_TRUE(parser.prepare().has_value());
  constexpr std::string_view encoded = "\x1B[<4;5;3M";
  const auto input = std::as_bytes(std::span(encoded));
  std::array<std::byte, 32> storage{};
  const auto parsed = parser.parse(input, storage, {.columns = 80, .rows = 24});
  ASSERT_TRUE(parsed.has_value());
  ASSERT_EQ(parsed->event_count, 1U);
  const auto& outer = parsed->events.front().mouse;
  EXPECT_EQ(outer.geometry, (protocol::Dimensions{.columns = 80, .rows = 24}));
  EXPECT_EQ(outer.column, 4U);
  EXPECT_EQ(outer.row, 2U);

  auto terminal = make_terminal();
  write_terminal(terminal, "\x1B[?1000h\x1B[?1006h");
  core::PanePtyWriteQueue queue;
  const vt::MouseEvent local{
      .action = vt::MouseAction::press,
      .button = vt::MouseButton::left,
      .modifiers = vt::key_modifier_shift,
      .x = 1,
      .y = 2,
      .geometry = {.screen_width = 40, .screen_height = 23},
      .any_button_pressed = true,
  };
  ASSERT_EQ(core::queue_mouse_input(queue, terminal, local), core::InputQueueResult::queued);
  std::array<std::byte, 64> output{};
  const auto size = queue.read(output);
  EXPECT_THAT(output_text(std::span(output).first(size)), testing::HasSubstr("\x1B[<4;2;3M"));
}

TEST(GhosttyParityRegressionTest, M3EffectsAreBoundedAndPolicyRouted) {
  auto terminal = make_terminal();
  write_terminal(terminal, "\a\x1B]2;title\x1B\\\x1B]7;file:///tmp\x1B\\"
                           "\x1B]777;notify;Title;Body\a\x1B]9;4;1;50\x1B\\"
                           "\x1B]52;c;YQ==\x1B\\\x1B_dropped\x1B\\");

  const auto effects = terminal.take_effects();

  EXPECT_EQ(effects.bells, 1U);
  EXPECT_EQ(effects.title_changes, 1U);
  EXPECT_EQ(effects.pwd_changes, 1U);
  EXPECT_EQ(effects.desktop_notifications, 1U);
  EXPECT_EQ(effects.progress_reports, 1U);
  EXPECT_EQ(effects.clipboard_writes_denied, 1U);
  EXPECT_EQ(effects.unknown_sequences_dropped, 1U);
  EXPECT_FALSE(effects.unknown_sequence_truncated);
}

TEST(GhosttyParityRegressionTest, M4SelectionAnchorsTrackTerminalMutation) {
  vt::TerminalOptions options;
  options.size = {.columns = 12, .rows = 3};
  options.scrollback_bytes_max = limits::terminal_scrollback_bytes_hard_max;
  options.scrollback_lines_max = 100;
  auto terminal = make_terminal(options);
  write_terminal(terminal, "alpha bravo\r\ncharlie");

  ASSERT_TRUE(terminal
                  .select(vt::SelectionUnit::word,
                          {.space = vt::PointSpace::viewport, .column = 0, .row = 0})
                  .value_or(false));
  write_terminal(terminal, "\r\ndelta\r\necho\r\nfoxtrot");
  ASSERT_TRUE(terminal.selection_adjust(vt::SelectionAdjustment::right, true).value_or(false));

  std::array<std::byte, 128> output{};
  const auto formatted = terminal.format_selection(vt::ScreenFormat::plain, output);
  ASSERT_TRUE(formatted.has_value());
  EXPECT_THAT(output_text(std::span(output).first(*formatted)), testing::HasSubstr("alpha"));
}

TEST(GhosttyParityRegressionTest, M5AnsiProjectionConvergesForCombiningCharacterScroll) {
  vt::TerminalOptions options;
  options.size = {.columns = 2, .rows = 4};
  auto canonical = make_terminal(options);
  auto projected = make_terminal(options);
  write_terminal(canonical, "a\xCC\x81\r\na\xCC\x82\r\na\xCC\x83\r\na\xCC\x84");

  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  const auto initial = canonical.render_ansi(output, true);
  ASSERT_TRUE(initial.has_value());
  projected.write(std::span(output).first(initial->bytes));
  write_terminal(canonical, "\r\na\xCC\x85\r\na\xCC\x86");
  const auto changed = canonical.render_ansi(output);
  ASSERT_TRUE(changed.has_value());
  EXPECT_EQ(changed->scrolled_rows, 2);
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

TEST(GhosttyParityRegressionTest, DISABLED_M7KittyGraphicsLifecycleIsBoundedAndClipped) {
  FAIL() << "M7 must preserve image data, placement updates, clipping, deletion, and animation";
}

} // namespace
} // namespace lemma
