#ifndef LEMMA_CORE_FRAME_SCHEDULER_HPP
#define LEMMA_CORE_FRAME_SCHEDULER_HPP

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <optional>

namespace lemma::core {

// Values are ordered from lowest to highest priority.
enum class FrameUrgency : std::uint8_t {
  burst,
  state_change,
  interactive,
};

enum class FrameSinkState : std::uint8_t {
  unavailable,
  ready,
  blocked,
};

// Larger physical reads are bounded paste/bulk input and retain frame coalescing.
inline constexpr std::size_t interactive_input_bytes_max = 64;

[[nodiscard]] auto latency_sensitive_input(std::size_t bytes) noexcept -> bool;

// Arms an interactive frame only after ordered PTY write progress reaches the accepted input.
class InteractiveDamageLatch final {
public:
  void await_write(std::size_t queued_bytes_before, std::size_t queued_bytes_after) noexcept;
  void record_write(std::size_t bytes) noexcept;
  [[nodiscard]] auto consume() noexcept -> bool;
  [[nodiscard]] auto pending() const noexcept -> bool { return pending_; }
  [[nodiscard]] auto waiting_for_write() const noexcept -> bool { return bytes_until_armed_ > 0; }
  void reset() noexcept;

private:
  std::size_t bytes_until_armed_{0};
  bool pending_{false};
};

class FrameScheduler final {
public:
  using Clock = std::chrono::steady_clock;
  using TimePoint = Clock::time_point;

  // Preserve short-command completion while presenting long autonomous streams at display cadence.
  // Interactive and state-change requests always bypass both delays.
  static constexpr auto burst_delay = std::chrono::milliseconds(3);
  static constexpr auto continued_burst_delay = std::chrono::milliseconds(6);
  static constexpr auto sustained_burst_delay = std::chrono::milliseconds(16);
  static constexpr auto sustained_burst_threshold = std::chrono::milliseconds(50);
  static constexpr auto burst_continuity_window = std::chrono::milliseconds(10);

  void request(FrameUrgency urgency, bool force_full, TimePoint now, FrameSinkState sink) noexcept;

  [[nodiscard]] auto deadline(FrameSinkState sink) const noexcept -> std::optional<TimePoint>;
  [[nodiscard]] auto due(TimePoint now, FrameSinkState sink) const noexcept -> bool;
  [[nodiscard]] auto pending() const noexcept -> bool;
  [[nodiscard]] auto force_full() const noexcept -> bool;
  [[nodiscard]] auto urgency() const noexcept -> FrameUrgency;

  void complete() noexcept;
  void cancel() noexcept;

private:
  void clear_pending() noexcept;
  void reset() noexcept;
  [[nodiscard]] auto burst_deadline(TimePoint now) noexcept -> TimePoint;

  TimePoint deadline_;
  TimePoint burst_started_at_;
  TimePoint last_burst_request_at_;
  FrameUrgency urgency_{FrameUrgency::burst};
  bool pending_{false};
  bool force_full_{false};
  bool tracking_burst_{false};
};

} // namespace lemma::core

#endif // LEMMA_CORE_FRAME_SCHEDULER_HPP
