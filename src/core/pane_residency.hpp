#ifndef LEMMA_CORE_PANE_RESIDENCY_HPP
#define LEMMA_CORE_PANE_RESIDENCY_HPP

#include "core/pane_snapshot_quota.hpp"
#include "core/pane_snapshot_storage.hpp"
#include "lemma/terminal/terminal.hpp"

#include <cstddef>
#include <cstdint>
#include <expected>
#include <memory>
#include <string_view>
#include <utility>
#include <variant>

namespace lemma::core {

enum class PaneResidencyPhase : std::uint8_t {
  active,
  parking,
  parked,
  unparking,
};

enum class SnapshotTestCorruption : std::uint8_t {
  none,
  ghostty_payload,
};

enum class PaneWakeReason : std::uint8_t {
  attach = 1U << 0U,
  input = 1U << 1U,
  resize = 1U << 2U,
  capture = 1U << 3U,
  explicit_request = 1U << 4U,
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

// Active residency stays one inline Terminal owner. The larger transition states are allocated only
// while a Pane is parking or parked, so the all-active daemon does not multiply cold state.
class PaneResidency final {
public:
  explicit PaneResidency(vt::Terminal&& terminal) noexcept;

  PaneResidency(const PaneResidency&) = delete;
  auto operator=(const PaneResidency&) -> PaneResidency& = delete;
  PaneResidency(PaneResidency&&) = delete;
  auto operator=(PaneResidency&&) -> PaneResidency& = delete;

  ~PaneResidency();

  [[nodiscard]] auto phase() const noexcept -> PaneResidencyPhase;
  [[nodiscard]] auto active_terminal() noexcept -> vt::Terminal*;
  [[nodiscard]] auto active_terminal() const noexcept -> const vt::Terminal*;
  [[nodiscard]] auto snapshot_bytes() const noexcept -> std::size_t;

  // begin_parking() suppresses future PTY reads by leaving the active phase. finish_parking() then
  // encodes exactly that terminal state and releases the live terminal only after sealing succeeds.
  [[nodiscard]] auto begin_parking(const vt::TerminalOptions& restore_options,
                                   PaneSnapshotQuota& quota, std::size_t session_slot,
                                   std::string_view directory = "/tmp") noexcept
      -> std::expected<std::size_t, vt::Error>;
  [[nodiscard]] auto
  finish_parking(SnapshotTestCorruption corruption = SnapshotTestCorruption::none) noexcept
      -> std::expected<void, vt::Error>;
  void cancel_parking() noexcept;

  // READY construction borrows the sealed mapping. One call restores at most one Ghostty history
  // page. A true result means the complete terminal has atomically returned to active residency.
  [[nodiscard]] auto begin_unparking() noexcept -> std::expected<void, vt::Error>;
  [[nodiscard]] auto restore_one_history_page() noexcept -> std::expected<bool, vt::Error>;
  void cancel_unparking() noexcept;

  void request_wake(PaneWakeReason reason) noexcept;
  [[nodiscard]] auto take_wake_reasons() noexcept -> PaneWakeReasons;

private:
  struct Active final {
    explicit Active(vt::Terminal&& value) noexcept : terminal(std::move(value)) {}
    vt::Terminal terminal;
  };

  struct Parking final {
    Parking(vt::Terminal&& terminal_value, WritablePaneSnapshot&& storage_value,
            const vt::TerminalOptions& options_value,
            PaneSnapshotQuota::Reservation&& reservation_value) noexcept
        : terminal(std::move(terminal_value)), storage(std::move(storage_value)),
          options(options_value), reservation(std::move(reservation_value)) {}
    vt::Terminal terminal;
    WritablePaneSnapshot storage;
    vt::TerminalOptions options;
    PaneSnapshotQuota::Reservation reservation;
  };

  struct Parked final {
    Parked(PaneSnapshot&& storage_value, const vt::TerminalOptions& options_value,
           PaneSnapshotQuota::Reservation&& reservation_value) noexcept
        : storage(std::move(storage_value)), options(options_value),
          reservation(std::move(reservation_value)) {}
    PaneSnapshot storage;
    vt::TerminalOptions options;
    PaneSnapshotQuota::Reservation reservation;
  };

  struct Unparking final {
    Unparking(PaneSnapshot&& storage_value, const vt::TerminalOptions& options_value,
              PaneSnapshotQuota::Reservation&& reservation_value,
              vt::TerminalSnapshotRestore&& restore_value) noexcept
        : storage(std::move(storage_value)), options(options_value),
          reservation(std::move(reservation_value)), restore(std::move(restore_value)) {}
    PaneSnapshot storage;
    vt::TerminalOptions options;
    PaneSnapshotQuota::Reservation reservation;
    // Declared last so it is destroyed first and releases its borrowed decoder before storage.
    vt::TerminalSnapshotRestore restore;
  };

  struct ColdResidency final {
    template <typename State, typename... Arguments>
    explicit ColdResidency(std::in_place_type_t<State> state_type,
                           Arguments&&... arguments) noexcept
        : state(state_type, std::forward<Arguments>(arguments)...) {}
    std::variant<Parking, Parked, Unparking> state;
  };

  std::variant<Active, std::unique_ptr<ColdResidency>> state_;
  PaneWakeReasons wake_reasons_;
};

static_assert(sizeof(PaneResidency) <= 24);

} // namespace lemma::core

#endif // LEMMA_CORE_PANE_RESIDENCY_HPP
