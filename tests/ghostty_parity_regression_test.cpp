#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"
#include "protocol/single_pane.hpp"
#include "render/single_pane.hpp"

#include <gtest/gtest.h>

#include <chrono>
#include <cstddef>

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
  EXPECT_EQ(render::frame_bytes_max, limits::frame_chunk_bytes_max);
}

TEST(GhosttyParityContractTest, SecurityAndProgressLimitsMatchM0Policy) {
  EXPECT_EQ(limits::frame_transaction_bytes_max, std::size_t{64} * 1'024U * 1'024U);
  EXPECT_EQ(limits::frame_output_queue_bytes_max, std::size_t{8} * 1'024U * 1'024U);
  EXPECT_EQ(limits::render_snapshot_hold_max, std::chrono::milliseconds{50});
  EXPECT_EQ(limits::frame_transaction_progress_deadline, std::chrono::seconds{5});
  EXPECT_EQ(limits::frame_transaction_total_deadline, std::chrono::seconds{30});
  EXPECT_EQ(limits::structured_input_payload_bytes_max, std::size_t{1} * 1'024U * 1'024U);
  EXPECT_EQ(limits::structured_event_batch_expanded_max, 4'096U);
  EXPECT_EQ(limits::pixel_mouse_report_bytes_max, 128U);
  EXPECT_EQ(limits::paste_payload_bytes_max, std::size_t{1} * 1'024U * 1'024U);
  EXPECT_EQ(limits::terminal_pty_response_bytes_max, std::size_t{64} * 1'024U);
}

// These disabled tests are executable M0 specifications for known parity gaps. Enabling any one is
// expected to fail until its named milestone implementation lands; replace FAIL() with the real
// characterization before removing the DISABLED_ prefix.
TEST(GhosttyParityRegressionTest, DISABLED_M2SessionThemeSurvivesReattach) {
  FAIL() << "M2 must retain one immutable session theme across ANSI client reattachment";
}

TEST(GhosttyParityRegressionTest, DISABLED_M2AnsiProjectionPreservesEffectiveColorsAndCursor) {
  FAIL() << "M2 must project effective default, palette, background-only, and cursor colors";
}

TEST(GhosttyParityRegressionTest, DISABLED_M2SynchronizedOutputIsGatedPerPane) {
  FAIL() << "M2 must hold only the pane whose canonical Ghostty mode 2026 is active";
}

TEST(GhosttyParityRegressionTest, DISABLED_M2SynchronizedOutputWatchdogPreservesCanonicalMode) {
  FAIL() << "M2 watchdog release must not clear Ghostty mode 2026";
}

TEST(GhosttyParityRegressionTest, DISABLED_M2FrameTransactionAbortRepairsPhysicalShadow) {
  FAIL() << "M2 must abort bounded transactions and schedule a complete later repair";
}

TEST(GhosttyParityRegressionTest, DISABLED_M2ResizeRollsBackAfterPtyFailure) {
  FAIL() << "M2 must keep PTY and Ghostty geometry equal after every resize outcome";
}

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
