#ifndef LEMMA_CORE_PANE_SNAPSHOT_WORKER_HPP
#define LEMMA_CORE_PANE_SNAPSHOT_WORKER_HPP

#include "core/pane_snapshot_quota.hpp"
#include "core/pane_snapshot_work.hpp"
#include "lemma/terminal/terminal.hpp"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include <pthread.h>

namespace lemma::core {

// The reactor owns admission, tickets and reservations. Only the worker touches an admitted work
// owner until completion's release/acquire handoff. Neither side waits for the other during
// service.
class PaneSnapshotWorker final {
public:
  static constexpr std::size_t jobs_max = 4;
  static constexpr std::size_t stack_bytes = 1U << 20U;
  struct Ticket final {
    std::uint64_t generation{0};
    std::size_t slot{jobs_max};
    friend auto operator==(const Ticket&, const Ticket&) noexcept -> bool = default;
  };
  struct Result final {
    std::unique_ptr<PaneSnapshotWork> work;
    std::optional<PaneSnapshotQuota::Reservation> reservation;
    std::optional<vt::Error> error;
  };
  enum class Stage : std::uint8_t { parking, hydrating, history, completing };
  // Tests may hold the worker at an operation boundary, without borrowing any terminal state.
  struct TestHook final {
    void* context{nullptr};
    void (*enter)(void*, Stage) noexcept {nullptr};
  };

  [[nodiscard]] static auto create(TestHook hook) noexcept
      -> std::expected<std::unique_ptr<PaneSnapshotWorker>, vt::Error>;
  ~PaneSnapshotWorker();
  PaneSnapshotWorker(const PaneSnapshotWorker&) = delete;
  auto operator=(const PaneSnapshotWorker&) -> PaneSnapshotWorker& = delete;
  PaneSnapshotWorker(PaneSnapshotWorker&&) = delete;
  auto operator=(PaneSnapshotWorker&&) -> PaneSnapshotWorker& = delete;

  [[nodiscard]] auto has_capacity() const noexcept -> bool;
  // On rejection Result is untouched. Directory is copied before ownership is transferred.
  [[nodiscard]] auto submit(Result& result, const vt::TerminalOptions& options,
                            std::string_view directory, SnapshotTestCorruption corruption,
                            bool hydrate) noexcept -> std::expected<Ticket, vt::Error>;
  void request_wake(Ticket ticket) noexcept;
  void abandon(Ticket ticket) noexcept;
  [[nodiscard]] auto take(Ticket ticket) noexcept -> std::optional<Result>;
  // Reclaims abandoned slots only after worker-side destruction. Quotas are never touched there.
  void collect() noexcept;
  [[nodiscard]] auto completion_descriptor() const noexcept -> int;
  void drain_notification() noexcept;

private:
  enum class State : std::uint8_t { free, parking, hydrating, destroying, running, complete };
  static_assert(std::atomic<State>::is_always_lock_free);
  static_assert(std::atomic<bool>::is_always_lock_free);
  struct Slot final {
    std::atomic<State> state{State::free};
    std::atomic<bool> cancel{false};
    std::atomic<bool> wake{false};
    // Reactor-only fields, including while the worker owns work/options/directory/error.
    std::uint64_t generation{0};
    bool abandoned{false};
    std::optional<PaneSnapshotQuota::Reservation> reservation;
    std::unique_ptr<PaneSnapshotWork> work;
    vt::TerminalOptions options;
    std::string directory;
    SnapshotTestCorruption corruption{SnapshotTestCorruption::none};
    std::optional<vt::Error> error;
  };

  explicit PaneSnapshotWorker(TestHook hook) noexcept;
  [[nodiscard]] auto matching(Ticket ticket) noexcept -> Slot*;
  [[nodiscard]] auto cancelled(const Slot& slot) const noexcept -> bool;
  void run() noexcept;
  [[nodiscard]] auto next_job() noexcept -> Slot*;
  void park(Slot& slot) noexcept;
  void hydrate(Slot& slot) noexcept;
  static auto thread_main(void* context) noexcept -> void*;
  void enter(Stage stage) const noexcept;

  std::array<Slot, jobs_max> slots_;
  std::array<int, 2> requests_{-1, -1};
  std::array<int, 2> completions_{-1, -1};
  std::atomic<bool> stopping_{false};
  pthread_t thread_{};
  bool started_{false};
  TestHook hook_;
};

} // namespace lemma::core
#endif
