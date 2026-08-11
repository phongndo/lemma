#include "core/frame_scheduler.hpp"

namespace lemma::core {

[[nodiscard]] auto latency_sensitive_input(const std::size_t bytes) noexcept -> bool {
  return bytes > 0 && bytes <= interactive_input_bytes_max;
}

void InteractiveDamageLatch::await_write(const std::size_t queued_bytes_before,
                                         const std::size_t queued_bytes_after) noexcept {
  if (bytes_until_armed_ == 0 && queued_bytes_after > queued_bytes_before) {
    bytes_until_armed_ = queued_bytes_before + 1U;
  }
}

void InteractiveDamageLatch::record_write(const std::size_t bytes) noexcept {
  if (bytes_until_armed_ == 0) {
    return;
  }
  if (bytes < bytes_until_armed_) {
    bytes_until_armed_ -= bytes;
    return;
  }
  bytes_until_armed_ = 0;
  pending_ = true;
}

[[nodiscard]] auto InteractiveDamageLatch::consume() noexcept -> bool {
  const bool consumed = pending_;
  pending_ = false;
  return consumed;
}

void InteractiveDamageLatch::reset() noexcept {
  bytes_until_armed_ = 0;
  pending_ = false;
}

void FrameScheduler::request(const FrameUrgency urgency, const bool force_full, const TimePoint now,
                             const FrameSinkState sink) noexcept {
  if (sink == FrameSinkState::unavailable) {
    return;
  }
  const auto candidate = urgency == FrameUrgency::burst ? burst_deadline(now) : now;
  if (!pending_ || candidate < deadline_) {
    deadline_ = candidate;
  }
  if (!pending_ || urgency > urgency_) {
    urgency_ = urgency;
  }
  pending_ = true;
  // Composition has already advanced retained physical state for the in-flight frame. Canonical
  // damage that arrives behind it collapses into one complete repair frame after it drains.
  force_full_ = force_full_ || force_full || sink == FrameSinkState::blocked;
}

[[nodiscard]] auto FrameScheduler::deadline(const FrameSinkState sink) const noexcept
    -> std::optional<TimePoint> {
  if (!pending_ || sink != FrameSinkState::ready) {
    return std::nullopt;
  }
  return deadline_;
}

[[nodiscard]] auto FrameScheduler::due(const TimePoint now,
                                       const FrameSinkState sink) const noexcept -> bool {
  const auto pending_deadline = deadline(sink);
  return pending_deadline.has_value() && now >= *pending_deadline;
}

[[nodiscard]] auto FrameScheduler::pending() const noexcept -> bool { return pending_; }

[[nodiscard]] auto FrameScheduler::force_full() const noexcept -> bool { return force_full_; }

[[nodiscard]] auto FrameScheduler::urgency() const noexcept -> FrameUrgency { return urgency_; }

void FrameScheduler::complete() noexcept { clear_pending(); }

void FrameScheduler::cancel() noexcept { reset(); }

[[nodiscard]] auto FrameScheduler::burst_deadline(const TimePoint now) noexcept -> TimePoint {
  if (!tracking_burst_ || now - last_burst_request_at_ > burst_continuity_window) {
    burst_started_at_ = now;
    tracking_burst_ = true;
  }
  last_burst_request_at_ = now;
  const bool sustained = now - burst_started_at_ >= sustained_burst_threshold;
  return now + (sustained ? sustained_burst_delay : burst_delay);
}

void FrameScheduler::clear_pending() noexcept {
  pending_ = false;
  force_full_ = false;
  urgency_ = FrameUrgency::burst;
  deadline_ = {};
}

void FrameScheduler::reset() noexcept {
  clear_pending();
  burst_started_at_ = {};
  last_burst_request_at_ = {};
  tracking_burst_ = false;
}

} // namespace lemma::core
