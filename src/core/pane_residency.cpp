#include "core/pane_residency.hpp"

#include "core/pane_snapshot_quota.hpp"
#include "core/pane_snapshot_work.hpp"
#include "core/pane_snapshot_worker.hpp"
#include "lemma/assert.hpp"
#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"

#include <cstddef>
#include <expected>
#include <memory>
#include <new>
#include <string_view>
#include <utility>
#include <variant>

namespace lemma::core {

PaneResidency::PaneResidency(vt::Terminal&& terminal) noexcept
    : state_(std::in_place_type<vt::Terminal>, std::move(terminal)) {}
PaneResidency::~PaneResidency() = default;

PaneResidency::ColdResidency::~ColdResidency() {
  if (const auto* const ticket = std::get_if<PaneSnapshotWorker::Ticket>(&state)) {
    worker.abandon(*ticket);
  }
}

auto PaneResidency::phase() const noexcept -> PaneResidencyPhase {
  const auto* const owner = std::get_if<std::unique_ptr<ColdResidency>>(&state_);
  if (owner == nullptr) {
    return PaneResidencyPhase::active;
  }
  const auto& cold = **owner;
  if (cold.waking) {
    return PaneResidencyPhase::unparking;
  }
  return std::holds_alternative<PaneSnapshotWorker::Ticket>(cold.state)
             ? PaneResidencyPhase::parking
             : PaneResidencyPhase::parked;
}

auto PaneResidency::active_terminal() noexcept -> vt::Terminal* {
  return std::get_if<vt::Terminal>(&state_);
}
auto PaneResidency::active_terminal() const noexcept -> const vt::Terminal* {
  return std::get_if<vt::Terminal>(&state_);
}
auto PaneResidency::snapshot_bytes() const noexcept -> std::size_t {
  const auto* const owner = std::get_if<std::unique_ptr<ColdResidency>>(&state_);
  return owner == nullptr ? 0 : (*owner)->bytes;
}

// All potentially allocating construction precedes the no-throw ownership transfer.
// NOLINTNEXTLINE(bugprone-exception-escape)
auto PaneResidency::begin_parking(PaneSnapshotWorker& worker,
                                  const vt::TerminalOptions& restore_options,
                                  PaneSnapshotQuota& quota, const std::size_t session_slot,
                                  const std::string_view directory,
                                  const SnapshotTestCorruption corruption) noexcept
    -> std::expected<void, vt::Error> {
  auto* const terminal = active_terminal();
  if (terminal == nullptr) {
    return std::unexpected(vt::Error::invalid_state);
  }
  if (restore_options.snapshot_continuation_bytes_max == 0) {
    return std::unexpected(vt::Error::invalid_options);
  }
  if (!worker.has_capacity()) {
    return std::unexpected(vt::Error::limit_exceeded);
  }
  auto reservation = quota.reserve(session_slot, limits::snapshot_bytes_max);
  if (!reservation.has_value()) {
    return std::unexpected(vt::Error::limit_exceeded);
  }
  std::unique_ptr<ColdResidency> cold;
  try {
    cold = std::make_unique<ColdResidency>(worker);
    auto& result = *std::get_if<PaneSnapshotWorker::Result>(&cold->state);
    result.work = std::make_unique<PaneSnapshotWork>(std::move(*terminal));
    result.reservation.emplace(std::move(*reservation));
  } catch (const std::bad_alloc&) {
    return std::unexpected(vt::Error::out_of_memory);
  }
  auto& result = *std::get_if<PaneSnapshotWorker::Result>(&cold->state);
  const auto ticket = worker.submit(result, restore_options, directory, corruption, false);
  if (!ticket.has_value()) {
    *terminal = std::move(*result.work->active_terminal());
    return std::unexpected(ticket.error());
  }
  cold->state.emplace<PaneSnapshotWorker::Ticket>(*ticket);
  cold->bytes = limits::snapshot_bytes_max;
  state_.emplace<std::unique_ptr<ColdResidency>>(std::move(cold));
  return {};
}

// NOLINTNEXTLINE(bugprone-exception-escape)
void PaneResidency::request_wake(const PaneWakeReason reason,
                                 const bool hydration_enabled) noexcept {
  wake_reasons_.add(reason);
  auto* const owner = std::get_if<std::unique_ptr<ColdResidency>>(&state_);
  if (owner == nullptr) {
    return;
  }
  auto& cold = **owner;
  cold.waking = true;
  if (const auto* const ticket = std::get_if<PaneSnapshotWorker::Ticket>(&cold.state)) {
    cold.worker.request_wake(*ticket);
  } else if (hydration_enabled) {
    auto& result = *std::get_if<PaneSnapshotWorker::Result>(&cold.state);
    if (!result.error.has_value()) {
      const auto admitted = cold.worker.submit(result, {}, {}, SnapshotTestCorruption::none, true);
      if (admitted.has_value()) {
        cold.state.emplace<PaneSnapshotWorker::Ticket>(*admitted);
      }
    }
  }
}

auto PaneResidency::take_wake_reasons() noexcept -> PaneWakeReasons {
  return std::exchange(wake_reasons_, {});
}

// Variant emplacement is tag-checked and all moved owners are no-throw.
// NOLINTNEXTLINE(bugprone-exception-escape)
auto PaneResidency::advance(const bool hydration_enabled) noexcept
    -> std::expected<bool, vt::Error> {
  auto* const owner = std::get_if<std::unique_ptr<ColdResidency>>(&state_);
  if (owner == nullptr) {
    return false;
  }
  auto& cold = **owner;
  if (const auto* const ticket = std::get_if<PaneSnapshotWorker::Ticket>(&cold.state)) {
    auto completed = cold.worker.take(*ticket);
    if (!completed.has_value()) {
      return false;
    }
    cold.state.emplace<PaneSnapshotWorker::Result>(std::move(*completed));
  }
  auto& result = *std::get_if<PaneSnapshotWorker::Result>(&cold.state);
  if (auto* const terminal = result.work->active_terminal()) {
    // On parking failure the untouched live terminal comes back. Every large temporary has
    // already been destroyed on the worker; only the moved-from work and reservation remain.
    auto restored = std::move(*terminal);
    state_.emplace<vt::Terminal>(std::move(restored));
    return true;
  }
  cold.bytes = result.work->snapshot_bytes();
  LEMMA_ASSERT(result.reservation.has_value());
  result.reservation->shrink(cold.bytes);
  if (result.error.has_value()) {
    return std::unexpected(*result.error);
  }
  if (cold.waking && hydration_enabled) {
    const auto ticket = cold.worker.submit(result, {}, {}, SnapshotTestCorruption::none, true);
    if (ticket.has_value()) {
      cold.state.emplace<PaneSnapshotWorker::Ticket>(*ticket);
    } else if (ticket.error() != vt::Error::limit_exceeded) {
      return std::unexpected(ticket.error());
    }
  }
  return false;
}

} // namespace lemma::core
