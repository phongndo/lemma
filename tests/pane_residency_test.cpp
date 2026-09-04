#include "core/pane_residency.hpp"

#include "lemma/terminal/terminal.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <span>
#include <string>
#include <string_view>
#include <utility>

namespace lemma::core {
namespace {

[[nodiscard]] auto residency_options() -> vt::TerminalOptions {
  vt::TerminalOptions options;
  options.size = {.columns = 40, .rows = 6, .cell_width_px = 8, .cell_height_px = 16};
  options.scrollback_lines_max = 2'048;
  options.snapshot_continuation_bytes_max = 4'096;
  return options;
}

[[nodiscard]] auto populated_terminal(const vt::TerminalOptions& options) -> vt::Terminal {
  auto terminal_result = vt::Terminal::create(options);
  EXPECT_TRUE(terminal_result.has_value());
  auto terminal = std::move(*terminal_result);
  std::string history;
  for (std::size_t row = 0; row < 700; ++row) {
    history.append("snapshot history row ");
    history.append(std::to_string(row));
    history.append("\r\n");
  }
  terminal.write(std::as_bytes(std::span(history.data(), history.size())));
  return terminal;
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PaneResidencyTest, TransitionsThroughMappedSnapshotOneHistoryPagePerTurn) {
  const auto options = residency_options();
  PaneSnapshotQuota quota;
  PaneResidency residency(populated_terminal(options));
  ASSERT_EQ(residency.phase(), PaneResidencyPhase::active);
  ASSERT_NE(residency.active_terminal(), nullptr);
  std::array<std::byte, std::size_t{128} * 1'024U> before{};
  const auto before_size =
      residency.active_terminal()->format_recent(vt::ScreenFormat::vt_full, 700, before, false);
  ASSERT_TRUE(before_size.has_value());

  const auto required = residency.begin_parking(options, quota, 3);
  ASSERT_TRUE(required.has_value());
  EXPECT_GT(*required, 0U);
  EXPECT_EQ(residency.phase(), PaneResidencyPhase::parking);
  EXPECT_EQ(residency.active_terminal(), nullptr);
  EXPECT_EQ(residency.snapshot_bytes(), *required);
  EXPECT_EQ(quota.session_bytes(3), *required);
  ASSERT_TRUE(residency.finish_parking().has_value());
  EXPECT_EQ(residency.phase(), PaneResidencyPhase::parked);
  EXPECT_EQ(residency.snapshot_bytes(), *required);

  residency.request_wake(PaneWakeReason::attach);
  residency.request_wake(PaneWakeReason::input);
  residency.request_wake(PaneWakeReason::output);
  residency.request_wake(PaneWakeReason::attach);
  ASSERT_TRUE(residency.begin_unparking().has_value());
  EXPECT_EQ(residency.phase(), PaneResidencyPhase::unparking);
  EXPECT_EQ(residency.active_terminal(), nullptr);

  std::size_t turns = 0;
  while (residency.phase() == PaneResidencyPhase::unparking && turns < 1'024) {
    const auto restored = residency.restore_one_history_page();
    ASSERT_TRUE(restored.has_value());
    ++turns;
    if (*restored) {
      EXPECT_EQ(residency.phase(), PaneResidencyPhase::active);
    } else {
      EXPECT_EQ(residency.phase(), PaneResidencyPhase::unparking);
    }
  }
  EXPECT_GT(turns, 0U);
  ASSERT_EQ(residency.phase(), PaneResidencyPhase::active);
  ASSERT_NE(residency.active_terminal(), nullptr);
  EXPECT_EQ(residency.snapshot_bytes(), 0U);
  EXPECT_EQ(quota.daemon_bytes(), 0U);
  const auto reasons = residency.take_wake_reasons();
  EXPECT_TRUE(reasons.contains(PaneWakeReason::attach));
  EXPECT_TRUE(reasons.contains(PaneWakeReason::input));
  EXPECT_TRUE(reasons.contains(PaneWakeReason::output));
  EXPECT_FALSE(reasons.contains(PaneWakeReason::resize));
  EXPECT_TRUE(residency.take_wake_reasons().empty());

  std::array<std::byte, std::size_t{128} * 1'024U> after{};
  const auto after_size =
      residency.active_terminal()->format_recent(vt::ScreenFormat::vt_full, 700, after, false);
  ASSERT_TRUE(after_size.has_value());
  ASSERT_EQ(after_size, before_size);
  EXPECT_TRUE(std::ranges::equal(std::span(before).first(*before_size),
                                 std::span(after).first(*after_size)));
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PaneResidencyTest, CancellationRollsBackWithoutLosingTerminalOrSnapshot) {
  const auto options = residency_options();
  PaneSnapshotQuota quota;
  PaneResidency residency(populated_terminal(options));
  ASSERT_TRUE(residency.begin_parking(options, quota, 4).has_value());
  residency.cancel_parking();
  EXPECT_EQ(residency.phase(), PaneResidencyPhase::active);
  ASSERT_NE(residency.active_terminal(), nullptr);
  EXPECT_EQ(quota.daemon_bytes(), 0U);

  ASSERT_TRUE(residency.begin_parking(options, quota, 4).has_value());
  ASSERT_TRUE(residency.finish_parking().has_value());
  const auto stored_bytes = residency.snapshot_bytes();
  ASSERT_TRUE(residency.begin_unparking().has_value());
  residency.cancel_unparking();
  EXPECT_EQ(residency.phase(), PaneResidencyPhase::parked);
  EXPECT_EQ(residency.snapshot_bytes(), stored_bytes);

  ASSERT_TRUE(residency.begin_unparking().has_value());
  for (std::size_t turn = 0; residency.phase() == PaneResidencyPhase::unparking && turn < 1'024;
       ++turn) {
    ASSERT_TRUE(residency.restore_one_history_page().has_value());
  }
  EXPECT_EQ(residency.phase(), PaneResidencyPhase::active);
  EXPECT_EQ(quota.daemon_bytes(), 0U);
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PaneResidencyTest, FailedAdmissionLeavesTheActiveTerminalAuthoritative) {
  auto options = residency_options();
  PaneSnapshotQuota quota;
  PaneResidency residency(populated_terminal(options));
  {
    auto first = quota.reserve(5, lemma::limits::snapshot_bytes_max);
    auto second = quota.reserve(5, lemma::limits::snapshot_bytes_max);
    auto third = quota.reserve(5, lemma::limits::snapshot_bytes_max);
    auto fourth = quota.reserve(5, lemma::limits::snapshot_bytes_max);
    ASSERT_TRUE(first.has_value());
    ASSERT_TRUE(second.has_value());
    ASSERT_TRUE(third.has_value());
    ASSERT_TRUE(fourth.has_value());
    const auto quota_failure = residency.begin_parking(options, quota, 5);
    ASSERT_FALSE(quota_failure.has_value());
    EXPECT_EQ(quota_failure.error(), vt::Error::limit_exceeded);
    EXPECT_EQ(residency.phase(), PaneResidencyPhase::active);
    EXPECT_NE(residency.active_terminal(), nullptr);
  }
  EXPECT_EQ(quota.daemon_bytes(), 0U);

  const auto storage_failure =
      residency.begin_parking(options, quota, 5, "/missing/lemma-snapshot-directory");
  ASSERT_FALSE(storage_failure.has_value());
  EXPECT_EQ(storage_failure.error(), vt::Error::io_error);
  EXPECT_EQ(residency.phase(), PaneResidencyPhase::active);

  ASSERT_NE(residency.active_terminal(), nullptr);
  ASSERT_TRUE(residency.active_terminal()->select(vt::SelectionUnit::all).value_or(false));
  const auto selected = residency.begin_parking(options, quota, 5);
  ASSERT_FALSE(selected.has_value());
  EXPECT_EQ(selected.error(), vt::Error::invalid_state);
  EXPECT_EQ(residency.phase(), PaneResidencyPhase::active);
  ASSERT_NE(residency.active_terminal(), nullptr);
  residency.active_terminal()->clear_selection();

  options.snapshot_continuation_bytes_max = 0;
  const auto unsafe = residency.begin_parking(options, quota, 5);
  ASSERT_FALSE(unsafe.has_value());
  EXPECT_EQ(unsafe.error(), vt::Error::invalid_options);
  EXPECT_EQ(residency.phase(), PaneResidencyPhase::active);
  EXPECT_FALSE(residency.finish_parking().has_value());
  EXPECT_FALSE(residency.begin_unparking().has_value());
  EXPECT_FALSE(residency.restore_one_history_page().has_value());
}

} // namespace
} // namespace lemma::core
