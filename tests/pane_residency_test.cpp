#include "core/pane_residency.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <csignal>
#include <memory>
#include <optional>
#include <semaphore>
#include <span>
#include <string>
#include <utility>

#include <poll.h>
#include <pthread.h>

namespace lemma::core {
namespace {
using namespace std::chrono_literals;

[[nodiscard]] auto residency_options() -> vt::TerminalOptions {
  vt::TerminalOptions options;
  options.size = {.columns = 40, .rows = 6, .cell_width_px = 8, .cell_height_px = 16};
  options.scrollback_lines_max = 2'048;
  options.snapshot_continuation_bytes_max = 4'096;
  return options;
}

[[nodiscard]] auto populated_terminal(const vt::TerminalOptions& options) -> vt::Terminal {
  auto created = vt::Terminal::create(options);
  EXPECT_TRUE(created.has_value());
  auto terminal = std::move(*created);
  std::string history;
  for (std::size_t row = 0; row < 700; ++row) {
    history.append("snapshot history row ");
    history.append(std::to_string(row));
    history.append("\r\n");
  }
  terminal.write(std::as_bytes(std::span(history.data(), history.size())));
  return terminal;
}

struct WorkerGate final {
  std::atomic<PaneSnapshotWorker::Stage> stage{PaneSnapshotWorker::Stage::parking};
  std::atomic<bool> armed{false};
  std::counting_semaphore<64> entered{0};
  std::counting_semaphore<64> released{0};
  std::atomic<std::size_t> parkings{0};
  std::atomic<bool> signals_blocked{false};

  void arm(const PaneSnapshotWorker::Stage value) noexcept {
    stage.store(value);
    armed.store(true);
  }
  static void enter(void* const context, const PaneSnapshotWorker::Stage value) noexcept {
    auto& gate = *static_cast<WorkerGate*>(context);
    if (value == PaneSnapshotWorker::Stage::parking) {
      sigset_t mask{};
      gate.signals_blocked.store(::pthread_sigmask(SIG_SETMASK, nullptr, &mask) == 0 &&
                                 sigismember(&mask, SIGCHLD) == 1 &&
                                 sigismember(&mask, SIGTERM) == 1);
      gate.parkings.fetch_add(1);
    }
    if (gate.stage.load() == value && gate.armed.exchange(false)) {
      gate.entered.release();
      gate.released.acquire();
    }
  }
};

class PaneResidencyTest : public ::testing::Test {
public:
  // GoogleTest expands each signal-mask equality assertion into several branches.
  // NOLINTNEXTLINE(readability-function-cognitive-complexity)
  void SetUp() override {
    sigset_t before{};
    ASSERT_EQ(::pthread_sigmask(SIG_SETMASK, nullptr, &before), 0);
    auto created = PaneSnapshotWorker::create({.context = &gate, .enter = WorkerGate::enter});
    ASSERT_TRUE(created.has_value());
    worker = std::move(*created);
    sigset_t after{};
    ASSERT_EQ(::pthread_sigmask(SIG_SETMASK, nullptr, &after), 0);
    EXPECT_EQ(sigismember(&before, SIGCHLD), sigismember(&after, SIGCHLD));
    EXPECT_EQ(sigismember(&before, SIGTERM), sigismember(&after, SIGTERM));
  }
  void TearDown() override {
    gate.released.release();
    worker.reset();
    EXPECT_EQ(quota.daemon_bytes(), 0U);
  }
  [[nodiscard]] auto wait_for(PaneResidency& residency, const PaneResidencyPhase target) const
      -> bool {
    const auto deadline = std::chrono::steady_clock::now() + 5s;
    while (std::chrono::steady_clock::now() < deadline) {
      worker->drain_notification();
      worker->collect();
      const auto advanced = residency.advance();
      if (!advanced.has_value()) {
        ADD_FAILURE() << "residency failure " << static_cast<int>(advanced.error());
        return false;
      }
      if (residency.phase() == target) {
        return true;
      }
      pollfd descriptor{.fd = worker->completion_descriptor(), .events = POLLIN, .revents = 0};
      static_cast<void>(::poll(&descriptor, 1, 10));
    }
    return false;
  }
  void collect_until_empty() const {
    const auto deadline = std::chrono::steady_clock::now() + 5s;
    while (quota.daemon_bytes() != 0 && std::chrono::steady_clock::now() < deadline) {
      worker->drain_notification();
      worker->collect();
      pollfd descriptor{.fd = worker->completion_descriptor(), .events = POLLIN, .revents = 0};
      static_cast<void>(::poll(&descriptor, 1, 10));
    }
    EXPECT_EQ(quota.daemon_bytes(), 0U);
  }
  WorkerGate gate;
  PaneSnapshotQuota quota;
  std::unique_ptr<PaneSnapshotWorker> worker;
};

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(PaneResidencyTest, ExclusiveTransferRoundTripsHistoryAndRefinesReservation) {
  const auto options = residency_options();
  PaneResidency residency(populated_terminal(options));
  std::array<std::byte, std::size_t{128} * 1'024U> before{};
  const auto before_size =
      residency.active_terminal()->format_recent(vt::ScreenFormat::vt_full, 700, before, false);
  ASSERT_TRUE(before_size.has_value());

  gate.arm(PaneSnapshotWorker::Stage::parking);
  ASSERT_TRUE(residency.begin_parking(*worker, options, quota, 3).has_value());
  ASSERT_TRUE(gate.entered.try_acquire_for(5s));
  EXPECT_EQ(residency.phase(), PaneResidencyPhase::parking);
  EXPECT_EQ(residency.active_terminal(), nullptr);
  EXPECT_TRUE(gate.signals_blocked.load());
  EXPECT_EQ(quota.session_bytes(3), limits::snapshot_bytes_max);
  // No worker completion exists. The reactor-facing operation returns rather than waiting.
  EXPECT_FALSE(residency.advance().value());
  gate.released.release();
  ASSERT_TRUE(wait_for(residency, PaneResidencyPhase::parked));
  EXPECT_GT(residency.snapshot_bytes(), 0U);
  EXPECT_LT(residency.snapshot_bytes(), limits::snapshot_bytes_max);
  EXPECT_EQ(residency.snapshot_bytes(), quota.session_bytes(3));

  gate.arm(PaneSnapshotWorker::Stage::hydrating);
  residency.request_wake(PaneWakeReason::attach);
  residency.request_wake(PaneWakeReason::input);
  residency.request_wake(PaneWakeReason::output);
  ASSERT_TRUE(gate.entered.try_acquire_for(5s));
  EXPECT_EQ(residency.phase(), PaneResidencyPhase::unparking);
  EXPECT_EQ(residency.active_terminal(), nullptr);
  gate.released.release();
  ASSERT_TRUE(wait_for(residency, PaneResidencyPhase::active));
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
  ASSERT_EQ(after_size, before_size);
  EXPECT_TRUE(std::ranges::equal(std::span(before).first(*before_size),
                                 std::span(after).first(*after_size)));
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(PaneResidencyTest, SaturationKeepsLiveOwnerAndWakeCancelsQueuedParking) {
  const auto options = residency_options();
  std::array<std::unique_ptr<PaneResidency>, PaneSnapshotWorker::jobs_max> owners;
  gate.arm(PaneSnapshotWorker::Stage::parking);
  for (auto& owner : owners) {
    owner = std::make_unique<PaneResidency>(populated_terminal(options));
    ASSERT_TRUE(owner->begin_parking(*worker, options, quota, 4).has_value());
  }
  ASSERT_TRUE(gate.entered.try_acquire_for(5s));
  EXPECT_EQ(quota.daemon_bytes(), PaneSnapshotWorker::jobs_max * limits::snapshot_bytes_max);
  PaneResidency excess(populated_terminal(options));
  EXPECT_FALSE(excess.begin_parking(*worker, options, quota, 5).has_value());
  EXPECT_NE(excess.active_terminal(), nullptr);
  owners.back()->request_wake(PaneWakeReason::input);
  EXPECT_EQ(owners.back()->phase(), PaneResidencyPhase::unparking);
  gate.released.release();
  ASSERT_TRUE(wait_for(*owners.back(), PaneResidencyPhase::active));
  for (auto& owner : owners) {
    owner.reset();
  }
  collect_until_empty();
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(PaneResidencyTest, HydrationOutranksQueuedParking) {
  const auto options = residency_options();
  PaneResidency parked(populated_terminal(options));
  ASSERT_TRUE(parked.begin_parking(*worker, options, quota, 3).has_value());
  ASSERT_TRUE(wait_for(parked, PaneResidencyPhase::parked));
  const auto initial_parkings = gate.parkings.load();
  PaneResidency running(populated_terminal(options));
  PaneResidency queued(populated_terminal(options));
  gate.arm(PaneSnapshotWorker::Stage::parking);
  ASSERT_TRUE(running.begin_parking(*worker, options, quota, 4).has_value());
  ASSERT_TRUE(gate.entered.try_acquire_for(5s));
  ASSERT_TRUE(queued.begin_parking(*worker, options, quota, 4).has_value());
  parked.request_wake(PaneWakeReason::capture);
  gate.arm(PaneSnapshotWorker::Stage::hydrating);
  gate.released.release();
  ASSERT_TRUE(gate.entered.try_acquire_for(5s));
  EXPECT_EQ(gate.parkings.load(), initial_parkings + 1U);
  gate.released.release();
  ASSERT_TRUE(wait_for(parked, PaneResidencyPhase::active));
}

TEST_F(PaneResidencyTest, StorageAndSelectionFailuresReturnTheAuthoritativeLiveTerminal) {
  const auto options = residency_options();
  PaneResidency residency(populated_terminal(options));
  ASSERT_TRUE(
      residency.begin_parking(*worker, options, quota, 5, "/missing/lemma-snapshot-directory")
          .has_value());
  ASSERT_TRUE(wait_for(residency, PaneResidencyPhase::active));
  EXPECT_EQ(quota.daemon_bytes(), 0U);
  ASSERT_TRUE(residency.active_terminal()->select(vt::SelectionUnit::all).value_or(false));
  ASSERT_TRUE(residency.begin_parking(*worker, options, quota, 5).has_value());
  ASSERT_TRUE(wait_for(residency, PaneResidencyPhase::active));
  EXPECT_EQ(quota.daemon_bytes(), 0U);
}

TEST_F(PaneResidencyTest, RemovalDuringPartialRestoreRetainsQuotaUntilWorkerDestruction) {
  const auto options = residency_options();
  auto residency = std::make_unique<PaneResidency>(populated_terminal(options));
  ASSERT_TRUE(residency->begin_parking(*worker, options, quota, 5).has_value());
  ASSERT_TRUE(wait_for(*residency, PaneResidencyPhase::parked));
  gate.arm(PaneSnapshotWorker::Stage::history);
  residency->request_wake(PaneWakeReason::attach);
  ASSERT_TRUE(gate.entered.try_acquire_for(5s));
  const auto bytes = quota.daemon_bytes();
  residency.reset();
  EXPECT_EQ(quota.daemon_bytes(), bytes);
  gate.released.release();
  collect_until_empty();
}

TEST_F(PaneResidencyTest, RemovalRacingPublicationDestroysCompletedOwnerOnWorker) {
  const auto options = residency_options();
  auto residency = std::make_unique<PaneResidency>(populated_terminal(options));
  gate.arm(PaneSnapshotWorker::Stage::completing);
  ASSERT_TRUE(residency->begin_parking(*worker, options, quota, 5).has_value());
  ASSERT_TRUE(gate.entered.try_acquire_for(5s));
  residency.reset();
  EXPECT_GT(quota.daemon_bytes(), 0U);
  gate.released.release();
  collect_until_empty();
}

TEST_F(PaneResidencyTest, ShutdownReleasesRunningAndQueuedOwnersBeforeQuota) {
  const auto options = residency_options();
  auto first = std::make_unique<PaneResidency>(populated_terminal(options));
  auto second = std::make_unique<PaneResidency>(populated_terminal(options));
  gate.arm(PaneSnapshotWorker::Stage::parking);
  ASSERT_TRUE(first->begin_parking(*worker, options, quota, 5).has_value());
  ASSERT_TRUE(gate.entered.try_acquire_for(5s));
  ASSERT_TRUE(second->begin_parking(*worker, options, quota, 5).has_value());
  first.reset();
  second.reset();
  gate.released.release();
  worker.reset();
  EXPECT_EQ(quota.daemon_bytes(), 0U);
}

// Exercise the ticket boundary independently of Pane/Session addresses: even an identical reused
// sparse slot cannot accept a stale completion, wake or cancellation from its former generation.
// GoogleTest assertion expansion, not the ticket protocol, accounts for the branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(PaneResidencyTest, ReusedSlotRejectsStaleTickets) {
  const auto options = residency_options();
  const auto submit = [&]() {
    PaneSnapshotWorker::Result result{
        .work = std::make_unique<PaneSnapshotWork>(populated_terminal(options)),
        .reservation = std::move(quota.reserve(5, limits::snapshot_bytes_max)).value(),
        .error = {}};
    return worker
        ->submit(result, options, "/missing/lemma-snapshot-directory", SnapshotTestCorruption::none,
                 false)
        .value();
  };
  const auto previous = submit();
  std::optional<PaneSnapshotWorker::Result> completed;
  const auto deadline = std::chrono::steady_clock::now() + 5s;
  while (!completed.has_value() && std::chrono::steady_clock::now() < deadline) {
    completed = worker->take(previous);
    pollfd descriptor{.fd = worker->completion_descriptor(), .events = POLLIN, .revents = 0};
    static_cast<void>(::poll(&descriptor, 1, 10));
  }
  ASSERT_TRUE(completed.has_value());
  completed.reset();
  gate.arm(PaneSnapshotWorker::Stage::parking);
  const auto current = submit();
  ASSERT_TRUE(gate.entered.try_acquire_for(5s));
  EXPECT_EQ(previous.slot, current.slot);
  EXPECT_NE(previous.generation, current.generation);
  worker->abandon(previous);
  worker->request_wake(previous);
  EXPECT_FALSE(worker->take(previous).has_value());
  worker->abandon(current);
  gate.released.release();
  collect_until_empty();
}

} // namespace
} // namespace lemma::core
