#include "core/pane_snapshot_quota.hpp"

#include "lemma/assert.hpp"
#include "lemma/limits.hpp"

#include <cstddef>
#include <expected>
#include <span>
#include <utility>

namespace lemma::core {

PaneSnapshotQuota::Reservation::Reservation(PaneSnapshotQuota& owner,
                                            const std::size_t session_slot,
                                            const std::size_t bytes) noexcept
    : owner_(&owner), session_slot_(session_slot), bytes_(bytes) {}

PaneSnapshotQuota::Reservation::Reservation(Reservation&& other) noexcept
    : owner_(std::exchange(other.owner_, nullptr)), session_slot_(other.session_slot_),
      bytes_(std::exchange(other.bytes_, 0)) {}

auto PaneSnapshotQuota::Reservation::operator=(Reservation&& other) noexcept -> Reservation& {
  if (this != &other) {
    reset();
    owner_ = std::exchange(other.owner_, nullptr);
    session_slot_ = other.session_slot_;
    bytes_ = std::exchange(other.bytes_, 0);
  }
  return *this;
}

PaneSnapshotQuota::Reservation::~Reservation() { reset(); }

void PaneSnapshotQuota::Reservation::reset() noexcept {
  if (owner_ != nullptr) {
    owner_->release(session_slot_, bytes_);
    owner_ = nullptr;
  }
  bytes_ = 0;
}

auto PaneSnapshotQuota::Reservation::bytes() const noexcept -> std::size_t { return bytes_; }

auto PaneSnapshotQuota::Reservation::valid() const noexcept -> bool {
  return owner_ != nullptr && bytes_ > 0;
}

auto PaneSnapshotQuota::reserve(const std::size_t session_slot, const std::size_t bytes) noexcept
    -> std::expected<Reservation, PaneSnapshotQuotaError> {
  if (session_slot >= session_bytes_.size() || bytes == 0 || bytes > limits::snapshot_bytes_max) {
    return std::unexpected(PaneSnapshotQuotaError::invalid_request);
  }
  auto& session = std::span(session_bytes_).subspan(session_slot, 1).front();
  if (bytes > limits::snapshot_session_bytes_max - session ||
      bytes > limits::snapshot_daemon_bytes_max - daemon_bytes_) {
    return std::unexpected(PaneSnapshotQuotaError::capacity);
  }
  session += bytes;
  daemon_bytes_ += bytes;
  return Reservation(*this, session_slot, bytes);
}

void PaneSnapshotQuota::release(const std::size_t session_slot, const std::size_t bytes) noexcept {
  LEMMA_ASSERT(session_slot < session_bytes_.size());
  auto& session = std::span(session_bytes_).subspan(session_slot, 1).front();
  LEMMA_ASSERT(bytes > 0 && session >= bytes && daemon_bytes_ >= bytes);
  session -= bytes;
  daemon_bytes_ -= bytes;
}

auto PaneSnapshotQuota::daemon_bytes() const noexcept -> std::size_t { return daemon_bytes_; }

auto PaneSnapshotQuota::session_bytes(const std::size_t session_slot) const noexcept
    -> std::size_t {
  return session_slot < session_bytes_.size()
             ? std::span(session_bytes_).subspan(session_slot, 1).front()
             : 0;
}

} // namespace lemma::core
