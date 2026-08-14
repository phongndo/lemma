#include "core/presentation_gate.hpp"
#include "core/terminal_resize.hpp"
#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"
#include "protocol/single_pane.hpp"
#include "render/pane_composition.hpp"
#include "render/single_pane.hpp"

#include <gmock/gmock.h>
#include <gtest/gtest.h>

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

TEST(GhosttyParityRegressionTest, M2AnsiProjectionPreservesEffectiveColorsAndCursor) {
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
  EXPECT_THAT(ansi, testing::HasSubstr("38;2;101;102;103"));
  EXPECT_THAT(ansi, testing::HasSubstr("48;2;7;8;9"));
  EXPECT_THAT(ansi, testing::HasSubstr("38;2;10;20;30"));
  EXPECT_THAT(ansi, testing::HasSubstr("48;2;40;50;60"));
  EXPECT_THAT(ansi, testing::HasSubstr("\x1B]12;#46505a\x1B\\"));
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
              testing::HasSubstr("48;2;40;50;60m\x1B[K"));

  write_terminal(terminal, "text");
  const auto tail = terminal.render_ansi(output, true);
  ASSERT_TRUE(tail.has_value());
  EXPECT_THAT(output_text(std::span(output).first(tail->bytes)),
              testing::HasSubstr("48;2;40;50;60m\x1B[K"));
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

TEST(GhosttyParityRegressionTest, DISABLED_M3HostInputDecoderAcceptsEveryFragmentationBoundary) {
  FAIL() << "M3 must frame legacy, Kitty, mouse, focus, paste, and host-query input statefully";
}

TEST(GhosttyParityRegressionTest, DISABLED_M3PasteIsOpaqueAndUsesGhosttyEncoder) {
  FAIL() << "M3 must bypass prefix parsing and use Ghostty paste policy for opaque paste events";
}

TEST(GhosttyParityRegressionTest, DISABLED_M3KittyMetadataIsPreservedWithoutFabrication) {
  FAIL() << "M3 must preserve available action/text metadata without inventing legacy metadata";
}

TEST(GhosttyParityRegressionTest, DISABLED_M3HostCaptureEpochIsAckedAndRestored) {
  FAIL() << "M3 must atomically ACK capture epochs and restore every negotiated outer mode";
}

TEST(GhosttyParityRegressionTest, DISABLED_M3MouseUsesReadTimeGeometryAndPaneLocalCoordinates) {
  FAIL() << "M3 must validate geometry, hit-test chrome, and call Ghostty's mouse encoder";
}

TEST(GhosttyParityRegressionTest, DISABLED_M3EffectsAreSanitizedBoundedAndPolicyRouted) {
  FAIL() << "M3 must route title, PWD, progress, notification, clipboard, and unknown sequences";
}

TEST(GhosttyParityRegressionTest, DISABLED_M4SelectionAnchorsTrackTerminalMutation) {
  FAIL() << "M4 must use Ghostty gestures, tracked refs, endpoint adjustment, and formatting";
}

TEST(GhosttyParityRegressionTest, DISABLED_M5AnsiProjectionConvergesInSecondGhostty) {
  FAIL() << "M5 differential projection must compare cells, colors, cursor, modes, and links";
}

TEST(GhosttyParityRegressionTest, DISABLED_M7KittyGraphicsLifecycleIsBoundedAndClipped) {
  FAIL() << "M7 must preserve image data, placement updates, clipping, deletion, and animation";
}

} // namespace
} // namespace lemma
