#include "core/pane_residency.hpp"

#include "core/pane_snapshot_quota.hpp"
#include "core/pane_snapshot_storage.hpp"
#include "lemma/assert.hpp"
#include "lemma/terminal/terminal.hpp"

#include <cstddef>
#include <expected>
#include <memory>
#include <new>
#include <string_view>
#include <utility>
#include <variant>

namespace lemma::core {
namespace {

[[nodiscard]] constexpr auto map_storage_error(const PaneSnapshotStorageError error) noexcept
    -> vt::Error {
  switch (error) {
  case PaneSnapshotStorageError::invalid_options:
    return vt::Error::invalid_options;
  case PaneSnapshotStorageError::limit_exceeded:
    return vt::Error::limit_exceeded;
  case PaneSnapshotStorageError::io_error:
    return vt::Error::io_error;
  case PaneSnapshotStorageError::invalid_state:
    return vt::Error::invalid_state;
  }
}

} // namespace

PaneResidency::PaneResidency(vt::Terminal&& terminal) noexcept
    : state_(std::in_place_type<Active>, std::move(terminal)) {}

PaneResidency::~PaneResidency() = default;

// std::variant reports potentially throwing access even though every branch is tag-checked.
// NOLINTNEXTLINE(bugprone-exception-escape)
auto PaneResidency::phase() const noexcept -> PaneResidencyPhase {
  if (std::holds_alternative<Active>(state_)) {
    return PaneResidencyPhase::active;
  }
  const auto* const cold_owner = std::get_if<std::unique_ptr<ColdResidency>>(&state_);
  LEMMA_ASSERT(cold_owner != nullptr && *cold_owner != nullptr);
  const auto& cold = **cold_owner;
  if (std::holds_alternative<Parking>(cold.state)) {
    return PaneResidencyPhase::parking;
  }
  return std::holds_alternative<Parked>(cold.state) ? PaneResidencyPhase::parked
                                                    : PaneResidencyPhase::unparking;
}

auto PaneResidency::active_terminal() noexcept -> vt::Terminal* {
  auto* const active = std::get_if<Active>(&state_);
  return active == nullptr ? nullptr : &active->terminal;
}

auto PaneResidency::active_terminal() const noexcept -> const vt::Terminal* {
  const auto* const active = std::get_if<Active>(&state_);
  return active == nullptr ? nullptr : &active->terminal;
}

// NOLINTNEXTLINE(bugprone-exception-escape)
auto PaneResidency::snapshot_bytes() const noexcept -> std::size_t {
  if (const auto* const cold_owner = std::get_if<std::unique_ptr<ColdResidency>>(&state_)) {
    const auto& cold = **cold_owner;
    if (const auto* const parking = std::get_if<Parking>(&cold.state)) {
      return parking->storage.payload_bytes();
    }
    if (const auto* const parked = std::get_if<Parked>(&cold.state)) {
      return parked->storage.payload_bytes();
    }
    const auto* const unparking = std::get_if<Unparking>(&cold.state);
    LEMMA_ASSERT(unparking != nullptr);
    return unparking->storage.payload_bytes();
  }
  return 0;
}

// NOLINTNEXTLINE(bugprone-exception-escape)
auto PaneResidency::begin_parking(const vt::TerminalOptions& restore_options,
                                  PaneSnapshotQuota& quota, const std::size_t session_slot,
                                  const std::string_view directory) noexcept
    -> std::expected<std::size_t, vt::Error> {
  auto* const active = std::get_if<Active>(&state_);
  if (active == nullptr) {
    return std::unexpected(vt::Error::invalid_state);
  }
  if (restore_options.snapshot_continuation_bytes_max == 0) {
    return std::unexpected(vt::Error::invalid_options);
  }
  auto options = restore_options;
  options.size = active->terminal.size();
  options.theme = active->terminal.theme();
  const auto required = active->terminal.snapshot_size();
  if (!required.has_value()) {
    return std::unexpected(required.error());
  }
  auto reservation = quota.reserve(session_slot, *required);
  if (!reservation.has_value()) {
    return std::unexpected(reservation.error() == PaneSnapshotQuotaError::capacity
                               ? vt::Error::limit_exceeded
                               : vt::Error::invalid_options);
  }
  const PaneSnapshotMetadata metadata{
      .compatibility = current_pane_snapshot_compatibility(),
      .geometry = options.size,
  };
  auto storage = WritablePaneSnapshot::create(metadata, *required, directory);
  if (!storage.has_value()) {
    return std::unexpected(map_storage_error(storage.error()));
  }

  std::unique_ptr<ColdResidency> cold;
  try {
    cold = std::make_unique<ColdResidency>(std::in_place_type<Parking>, std::move(active->terminal),
                                           std::move(*storage), options, std::move(*reservation));
  } catch (const std::bad_alloc&) {
    return std::unexpected(vt::Error::out_of_memory);
  }
  state_.emplace<std::unique_ptr<ColdResidency>>(std::move(cold));
  return *required;
}

// NOLINTNEXTLINE(bugprone-exception-escape)
auto PaneResidency::finish_parking(const SnapshotTestCorruption corruption) noexcept
    -> std::expected<void, vt::Error> {
  auto* const cold_owner = std::get_if<std::unique_ptr<ColdResidency>>(&state_);
  if (cold_owner == nullptr) {
    return std::unexpected(vt::Error::invalid_state);
  }
  auto& cold = **cold_owner;
  auto* const parking = std::get_if<Parking>(&cold.state);
  if (parking == nullptr) {
    return std::unexpected(vt::Error::invalid_state);
  }
  auto payload = parking->storage.payload();
  const auto encoded = parking->terminal.encode_snapshot(payload);
  if (!encoded.has_value()) {
    const auto error = encoded.error();
    cancel_parking();
    return std::unexpected(error);
  }
  if (corruption == SnapshotTestCorruption::ghostty_payload) {
    LEMMA_ASSERT(!payload.empty());
    payload.front() ^= std::byte{1};
  }
  auto sealed = std::move(parking->storage).finish();
  if (!sealed.has_value()) {
    const auto error = map_storage_error(sealed.error());
    cancel_parking();
    return std::unexpected(error);
  }
  auto snapshot = std::move(*sealed);
  const auto options = parking->options;
  auto reservation = std::move(parking->reservation);
  cold.state.emplace<Parked>(std::move(snapshot), options, std::move(reservation));
  return {};
}

// NOLINTNEXTLINE(bugprone-exception-escape)
void PaneResidency::cancel_parking() noexcept {
  auto* const cold_owner = std::get_if<std::unique_ptr<ColdResidency>>(&state_);
  if (cold_owner == nullptr) {
    return;
  }
  auto* const parking = std::get_if<Parking>(&(*cold_owner)->state);
  if (parking == nullptr) {
    return;
  }
  auto terminal = std::move(parking->terminal);
  state_.emplace<Active>(std::move(terminal));
}

// NOLINTNEXTLINE(bugprone-exception-escape)
auto PaneResidency::begin_unparking() noexcept -> std::expected<void, vt::Error> {
  auto* const cold_owner = std::get_if<std::unique_ptr<ColdResidency>>(&state_);
  if (cold_owner == nullptr) {
    return std::unexpected(vt::Error::invalid_state);
  }
  auto& cold = **cold_owner;
  auto* const parked = std::get_if<Parked>(&cold.state);
  if (parked == nullptr) {
    return std::unexpected(vt::Error::invalid_state);
  }
  const PaneSnapshotMetadata metadata{
      .compatibility = current_pane_snapshot_compatibility(),
      .geometry = parked->options.size,
  };
  auto payload = parked->storage.payload(metadata);
  if (!payload.has_value()) {
    return std::unexpected(map_storage_error(payload.error()));
  }
  auto restore = vt::TerminalSnapshotRestore::begin(parked->options, payload->bytes());
  if (!restore.has_value()) {
    return std::unexpected(restore.error());
  }

  auto snapshot = std::move(parked->storage);
  const auto options = parked->options;
  auto reservation = std::move(parked->reservation);
  auto decoder = std::move(*restore);
  cold.state.emplace<Unparking>(std::move(snapshot), options, std::move(reservation),
                                std::move(*payload), std::move(decoder));
  return {};
}

// NOLINTNEXTLINE(bugprone-exception-escape)
auto PaneResidency::restore_one_history_page() noexcept -> std::expected<bool, vt::Error> {
  auto* const cold_owner = std::get_if<std::unique_ptr<ColdResidency>>(&state_);
  if (cold_owner == nullptr) {
    return std::unexpected(vt::Error::invalid_state);
  }
  auto* const unparking = std::get_if<Unparking>(&(*cold_owner)->state);
  if (unparking == nullptr) {
    return std::unexpected(vt::Error::invalid_state);
  }
  const auto progress = unparking->restore.next_history();
  if (!progress.has_value()) {
    return std::unexpected(progress.error());
  }
  if (!unparking->restore.complete()) {
    return false;
  }
  auto terminal = std::move(unparking->restore).take_terminal();
  if (!terminal.has_value()) {
    return std::unexpected(terminal.error());
  }
  state_.emplace<Active>(std::move(*terminal));
  return true;
}

// NOLINTNEXTLINE(bugprone-exception-escape)
void PaneResidency::cancel_unparking() noexcept {
  auto* const cold_owner = std::get_if<std::unique_ptr<ColdResidency>>(&state_);
  if (cold_owner == nullptr) {
    return;
  }
  auto& cold = **cold_owner;
  auto* const unparking = std::get_if<Unparking>(&cold.state);
  if (unparking == nullptr) {
    return;
  }
  auto snapshot = std::move(unparking->storage);
  const auto options = unparking->options;
  auto reservation = std::move(unparking->reservation);
  cold.state.emplace<Parked>(std::move(snapshot), options, std::move(reservation));
}

void PaneResidency::request_wake(const PaneWakeReason reason) noexcept {
  wake_reasons_.add(reason);
}

auto PaneResidency::take_wake_reasons() noexcept -> PaneWakeReasons {
  return std::exchange(wake_reasons_, {});
}

} // namespace lemma::core
