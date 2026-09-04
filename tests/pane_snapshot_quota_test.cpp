#include "core/pane_snapshot_quota.hpp"

#include "lemma/limits.hpp"

#include <gtest/gtest.h>

#include <array>
#include <cstddef>
#include <optional>
#include <span>
#include <utility>

namespace lemma::core {
namespace {

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity,cppcoreguidelines-pro-bounds-constant-array-index,cppcoreguidelines-pro-bounds-avoid-unchecked-container-access)
TEST(PaneSnapshotQuotaTest, EnforcesPaneSessionAndDaemonBounds) {
  PaneSnapshotQuota quota;
  const auto zero = quota.reserve(0, 0);
  ASSERT_FALSE(zero.has_value());
  EXPECT_EQ(zero.error(), PaneSnapshotQuotaError::invalid_request);
  const auto invalid_session = quota.reserve(lemma::limits::sessions_hard_max, 1);
  ASSERT_FALSE(invalid_session.has_value());
  EXPECT_EQ(invalid_session.error(), PaneSnapshotQuotaError::invalid_request);
  const auto oversized = quota.reserve(0, lemma::limits::snapshot_bytes_max + 1U);
  ASSERT_FALSE(oversized.has_value());
  EXPECT_EQ(oversized.error(), PaneSnapshotQuotaError::invalid_request);

  std::array<std::optional<PaneSnapshotQuota::Reservation>, 16> reservations;
  for (std::size_t index = 0; index < reservations.size(); ++index) {
    const auto session = index / 4U;
    auto reservation = quota.reserve(session, lemma::limits::snapshot_bytes_max);
    ASSERT_TRUE(reservation.has_value());
    std::span(reservations).subspan(index, 1).front().emplace(std::move(*reservation));
  }
  EXPECT_EQ(quota.daemon_bytes(), lemma::limits::snapshot_daemon_bytes_max);
  EXPECT_EQ(quota.session_bytes(0), lemma::limits::snapshot_session_bytes_max);

  const auto session_full = quota.reserve(0, 1);
  ASSERT_FALSE(session_full.has_value());
  EXPECT_EQ(session_full.error(), PaneSnapshotQuotaError::capacity);
  const auto daemon_full = quota.reserve(5, 1);
  ASSERT_FALSE(daemon_full.has_value());
  EXPECT_EQ(daemon_full.error(), PaneSnapshotQuotaError::capacity);

  reservations.front().reset();
  EXPECT_EQ(quota.daemon_bytes(),
            lemma::limits::snapshot_daemon_bytes_max - lemma::limits::snapshot_bytes_max);
  EXPECT_EQ(quota.session_bytes(0),
            lemma::limits::snapshot_session_bytes_max - lemma::limits::snapshot_bytes_max);
  const auto replacement = quota.reserve(0, lemma::limits::snapshot_bytes_max);
  EXPECT_TRUE(replacement.has_value());
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PaneSnapshotQuotaTest, MoveAssignmentReleasesTheReplacedReservationExactlyOnce) {
  PaneSnapshotQuota quota;
  auto first = quota.reserve(1, 10);
  auto second = quota.reserve(2, 20);
  ASSERT_TRUE(first.has_value());
  ASSERT_TRUE(second.has_value());
  EXPECT_EQ(quota.daemon_bytes(), 30U);

  *first = std::move(*second);
  EXPECT_EQ(quota.daemon_bytes(), 20U);
  EXPECT_EQ(quota.session_bytes(1), 0U);
  EXPECT_EQ(quota.session_bytes(2), 20U);
  EXPECT_FALSE(second->valid());
  EXPECT_EQ(first->bytes(), 20U);
}

} // namespace
} // namespace lemma::core
