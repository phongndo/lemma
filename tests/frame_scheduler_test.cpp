#include "core/frame_scheduler.hpp"

#include <chrono>

#include <gtest/gtest.h>

namespace lemma::core {
namespace {

using namespace std::chrono_literals;

constexpr auto origin = FrameScheduler::TimePoint{};

TEST(FrameSchedulerTest, ClassifiesInputAndArmsOnlyAfterItsPtyWriteProgress) {
  EXPECT_FALSE(latency_sensitive_input(0));
  EXPECT_TRUE(latency_sensitive_input(interactive_input_bytes_max));
  EXPECT_FALSE(latency_sensitive_input(interactive_input_bytes_max + 1U));

  InteractiveDamageLatch latch;
  latch.await_write(3, 4);
  EXPECT_TRUE(latch.waiting_for_write());
  EXPECT_FALSE(latch.pending());
  EXPECT_FALSE(latch.consume());

  latch.record_write(3);
  EXPECT_TRUE(latch.waiting_for_write());
  EXPECT_FALSE(latch.pending());
  EXPECT_FALSE(latch.consume());

  latch.record_write(1);
  EXPECT_FALSE(latch.waiting_for_write());
  EXPECT_TRUE(latch.pending());
  EXPECT_TRUE(latch.consume());
  EXPECT_FALSE(latch.pending());
}

TEST(FrameSchedulerTest, HigherUrgencyAdvancesButLaterRequestsNeverPostponeDeadline) {
  FrameScheduler scheduler;
  scheduler.request(FrameUrgency::burst, false, origin, FrameSinkState::ready);
  ASSERT_EQ(scheduler.deadline(FrameSinkState::ready), origin + 3ms);

  scheduler.request(FrameUrgency::burst, false, origin + 1ms, FrameSinkState::ready);
  EXPECT_EQ(scheduler.deadline(FrameSinkState::ready), origin + 3ms);

  scheduler.request(FrameUrgency::interactive, false, origin + 1500us, FrameSinkState::ready);
  EXPECT_EQ(scheduler.deadline(FrameSinkState::ready), origin + 1500us);
  EXPECT_EQ(scheduler.urgency(), FrameUrgency::interactive);

  scheduler.request(FrameUrgency::state_change, false, origin + 1750us, FrameSinkState::ready);
  EXPECT_EQ(scheduler.deadline(FrameSinkState::ready), origin + 1500us);
  EXPECT_EQ(scheduler.urgency(), FrameUrgency::interactive);
}

TEST(FrameSchedulerTest, BurstContinuationGetsOneBoundedCoalescingDeadlinePerFrame) {
  FrameScheduler scheduler;
  scheduler.request(FrameUrgency::burst, false, origin, FrameSinkState::ready);
  EXPECT_FALSE(scheduler.due(origin + 2999us, FrameSinkState::ready));
  EXPECT_TRUE(scheduler.due(origin + 3ms, FrameSinkState::ready));

  scheduler.complete();
  EXPECT_FALSE(scheduler.pending());
  EXPECT_FALSE(scheduler.deadline(FrameSinkState::ready).has_value());

  scheduler.request(FrameUrgency::burst, false, origin + 4ms, FrameSinkState::ready);
  EXPECT_EQ(scheduler.deadline(FrameSinkState::ready), origin + 10ms);
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(FrameSchedulerTest, SustainedBurstUsesDisplayCadenceWithoutDelayingShortBursts) {
  FrameScheduler scheduler;
  bool first = true;
  for (auto elapsed : {0ms, 9ms, 18ms, 27ms, 36ms, 45ms}) {
    scheduler.request(FrameUrgency::burst, false, origin + elapsed, FrameSinkState::ready);
    EXPECT_EQ(scheduler.deadline(FrameSinkState::ready), origin + elapsed + (first ? 3ms : 6ms));
    scheduler.complete();
    first = false;
  }

  scheduler.request(FrameUrgency::burst, false, origin + 54ms, FrameSinkState::ready);
  EXPECT_EQ(scheduler.deadline(FrameSinkState::ready), origin + 70ms);
  scheduler.request(FrameUrgency::interactive, false, origin + 55ms, FrameSinkState::ready);
  EXPECT_EQ(scheduler.deadline(FrameSinkState::ready), origin + 55ms);
  scheduler.complete();

  // A gap outside the continuity window starts a fresh low-latency burst.
  scheduler.request(FrameUrgency::burst, false, origin + 65ms, FrameSinkState::ready);
  EXPECT_EQ(scheduler.deadline(FrameSinkState::ready), origin + 68ms);
}

TEST(FrameSchedulerTest, BlockedOutputRetainsOnePendingRequestWithoutADeadlineWakeup) {
  FrameScheduler scheduler;
  scheduler.request(FrameUrgency::interactive, false, origin, FrameSinkState::blocked);

  EXPECT_TRUE(scheduler.pending());
  EXPECT_TRUE(scheduler.force_full());
  EXPECT_FALSE(scheduler.deadline(FrameSinkState::blocked).has_value());
  EXPECT_FALSE(scheduler.due(origin + 1s, FrameSinkState::blocked));
  EXPECT_TRUE(scheduler.due(origin + 1s, FrameSinkState::ready));
}

TEST(FrameSchedulerTest, ResizePromotesBurstAndRetainsFullRedrawRequirement) {
  FrameScheduler scheduler;
  scheduler.request(FrameUrgency::burst, false, origin, FrameSinkState::ready);
  scheduler.request(FrameUrgency::state_change, true, origin + 500us, FrameSinkState::ready);

  EXPECT_EQ(scheduler.deadline(FrameSinkState::ready), origin + 500us);
  EXPECT_EQ(scheduler.urgency(), FrameUrgency::state_change);
  EXPECT_TRUE(scheduler.force_full());
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(FrameSchedulerTest, DetachCancelsPendingDeadlineFullRedrawAndBurstHistory) {
  FrameScheduler scheduler;
  scheduler.request(FrameUrgency::state_change, true, origin, FrameSinkState::ready);
  scheduler.cancel();

  EXPECT_FALSE(scheduler.pending());
  EXPECT_FALSE(scheduler.force_full());
  EXPECT_FALSE(scheduler.deadline(FrameSinkState::ready).has_value());

  for (auto elapsed : {0ms, 9ms, 18ms, 27ms, 36ms, 45ms}) {
    scheduler.request(FrameUrgency::burst, false, origin + elapsed, FrameSinkState::ready);
    scheduler.complete();
  }
  scheduler.request(FrameUrgency::burst, false, origin + 54ms, FrameSinkState::ready);
  ASSERT_EQ(scheduler.deadline(FrameSinkState::ready), origin + 70ms);

  scheduler.cancel();
  scheduler.request(FrameUrgency::burst, false, origin + 55ms, FrameSinkState::ready);
  EXPECT_EQ(scheduler.deadline(FrameSinkState::ready), origin + 58ms);
}

TEST(FrameSchedulerTest, NoClientDoesNotCreatePendingWorkOrAnIdleTimer) {
  FrameScheduler scheduler;
  scheduler.request(FrameUrgency::interactive, true, origin, FrameSinkState::unavailable);

  EXPECT_FALSE(scheduler.pending());
  EXPECT_FALSE(scheduler.deadline(FrameSinkState::ready).has_value());
}

} // namespace
} // namespace lemma::core
