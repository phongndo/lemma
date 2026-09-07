#ifndef LEMMA_CORE_PANE_RESIDENCY_HPP
#define LEMMA_CORE_PANE_RESIDENCY_HPP

#include "core/pane_snapshot_quota.hpp"
#include "core/pane_snapshot_work.hpp"
#include "core/pane_snapshot_worker.hpp"
#include "lemma/terminal/terminal.hpp"

#include <cstddef>
#include <cstdint>
#include <expected>
#include <memory>
#include <string_view>
#include <variant>

namespace lemma::core {

enum class PaneWakeReason : std::uint8_t {
  attach = 1U << 0U,
  input = 1U << 1U,
  resize = 1U << 2U,
  capture = 1U << 3U,
  explicit_request = 1U << 4U,
  output = 1U << 5U,
};

class PaneWakeReasons final {
public:
  constexpr void add(const PaneWakeReason reason) noexcept {
    bits_ |= static_cast<std::uint8_t>(reason);
  }
  [[nodiscard]] constexpr auto contains(const PaneWakeReason reason) const noexcept -> bool {
    return (bits_ & static_cast<std::uint8_t>(reason)) != 0;
  }
  [[nodiscard]] constexpr auto empty() const noexcept -> bool { return bits_ == 0; }

private:
  std::uint8_t bits_{0};
};

// Active residency stays one inline Terminal owner. A cold Pane has either its sealed snapshot or
// a generational worker ticket, never a terminal that the reactor and worker could both access.
class PaneResidency final {
public:
  explicit PaneResidency(vt::Terminal&& terminal) noexcept;
  ~PaneResidency();
  PaneResidency(const PaneResidency&) = delete;
  auto operator=(const PaneResidency&) -> PaneResidency& = delete;
  PaneResidency(PaneResidency&&) = delete;
  auto operator=(PaneResidency&&) -> PaneResidency& = delete;

  [[nodiscard]] auto phase() const noexcept -> PaneResidencyPhase;
  [[nodiscard]] auto active_terminal() noexcept -> vt::Terminal*;
  [[nodiscard]] auto active_terminal() const noexcept -> const vt::Terminal*;
  [[nodiscard]] auto snapshot_bytes() const noexcept -> std::size_t;

  // Admission reserves the maximum payload BEFORE transferring ownership. Sizing, storage,
  // cryptography, and terminal destruction run on the worker. Saturation retains the live owner.
  // Worker and quota must outlive this Pane; destruction cancels a ticket without waiting for it.
  [[nodiscard]] auto
  begin_parking(PaneSnapshotWorker& worker, const vt::TerminalOptions& restore_options,
                PaneSnapshotQuota& quota, std::size_t session_slot,
                std::string_view directory = "/tmp",
                SnapshotTestCorruption corruption = SnapshotTestCorruption::none) noexcept
      -> std::expected<void, vt::Error>;
  void request_wake(PaneWakeReason reason, bool hydration_enabled = true) noexcept;
  [[nodiscard]] auto take_wake_reasons() noexcept -> PaneWakeReasons;
  // Nonblocking completion handoff and admission of pending hydration. True means active again.
  // False keeps the cold owner; errors are hydration failures, never loss of a live parking owner.
  [[nodiscard]] auto advance(bool hydration_enabled = true) noexcept
      -> std::expected<bool, vt::Error>;

private:
  struct ColdResidency final {
    explicit ColdResidency(PaneSnapshotWorker& owner) noexcept : worker(owner) {}
    ~ColdResidency();
    ColdResidency(const ColdResidency&) = delete;
    auto operator=(const ColdResidency&) -> ColdResidency& = delete;
    ColdResidency(ColdResidency&&) = delete;
    auto operator=(ColdResidency&&) -> ColdResidency& = delete;
    PaneSnapshotWorker& worker;
    std::variant<PaneSnapshotWorker::Result, PaneSnapshotWorker::Ticket> state;
    std::size_t bytes{0};
    bool waking{false};
  };
  std::variant<vt::Terminal, std::unique_ptr<ColdResidency>> state_;
  PaneWakeReasons wake_reasons_;
};

static_assert(sizeof(PaneResidency) <= 24);

} // namespace lemma::core
#endif
