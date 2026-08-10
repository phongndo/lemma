#ifndef LEMMA_CORE_CLIENT_FRAME_OUTPUT_HPP
#define LEMMA_CORE_CLIENT_FRAME_OUTPUT_HPP

#include "render/single_pane.hpp"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>

namespace lemma::core {

inline constexpr std::size_t attached_client_write_bytes_per_client_turn_max =
    std::size_t{64} * 1'024U;
inline constexpr std::size_t attached_client_write_bytes_per_turn_max = std::size_t{256} * 1'024U;
inline constexpr std::size_t attached_client_write_attempts_per_turn_max = 32;
inline constexpr auto attached_client_no_progress_timeout = std::chrono::seconds(5);
inline constexpr auto attached_client_frame_total_timeout = std::chrono::seconds(30);

class ClientFrameOutput final {
public:
  using Clock = std::chrono::steady_clock;
  using TimePoint = Clock::time_point;

  [[nodiscard]] auto queue(std::size_t bytes, TimePoint now,
                           std::uint64_t trace_correlation = 0) noexcept -> bool;
  [[nodiscard]] auto readable(const render::FrameBuffer& frame) const noexcept
      -> std::span<const std::byte>;
  [[nodiscard]] auto busy() const noexcept -> bool { return offset_ < size_; }
  [[nodiscard]] auto size() const noexcept -> std::size_t { return size_; }
  [[nodiscard]] auto offset() const noexcept -> std::size_t { return offset_; }
  [[nodiscard]] auto write_ready() const noexcept -> bool { return write_ready_; }
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  [[nodiscard]] auto trace_correlation() const noexcept -> std::uint64_t;
#endif
  [[nodiscard]] auto deadline() const noexcept -> std::optional<TimePoint>;
  [[nodiscard]] auto expired(TimePoint now) const noexcept -> bool;

  void mark_write_ready() noexcept;
  void clear_write_ready() noexcept { write_ready_ = false; }
  [[nodiscard]] auto consume(std::size_t bytes, TimePoint now) noexcept -> bool;
  void reset() noexcept;

private:
  std::size_t size_{0};
  std::size_t offset_{0};
  TimePoint queued_at_;
  TimePoint last_progress_at_;
  bool write_ready_{false};
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  std::uint64_t latency_trace_correlation_{0};
#endif
};

struct ClientFrameWriteAttempt final {
  std::ptrdiff_t bytes{0};
  int error{0};
};

using ClientFrameWriteOperation =
    ClientFrameWriteAttempt (*)(void* context, std::span<const std::byte> bytes) noexcept;

enum class ClientFrameFlushStatus : std::uint8_t {
  not_attempted,
  drained,
  pending,
  blocked,
  deadline_exceeded,
  hard_error,
};

struct ClientFrameFlushTarget final {
  int descriptor{-1};
  const render::FrameBuffer* frame{nullptr};
  ClientFrameOutput* output{nullptr};
  ClientFrameWriteOperation write{nullptr};
  void* context{nullptr};
  ClientFrameFlushStatus status{ClientFrameFlushStatus::not_attempted};
};

// Flushes one retained frame without consuming bytes until the injected writer reports progress.
// The daemon-wide budget is reduced only by bytes actually written.
[[nodiscard]] auto flush_client_frame(ClientFrameFlushTarget& target, std::size_t& global_budget,
                                      ClientFrameOutput::TimePoint now) noexcept
    -> ClientFrameFlushStatus;

// Visits attached clients from a persistent round-robin cursor. A target can consume at most its
// per-client budget; all targets together share global_budget for this reactor turn.
void flush_ready_client_frames(std::span<ClientFrameFlushTarget> targets, std::size_t& cursor,
                               std::size_t& global_budget,
                               ClientFrameOutput::TimePoint now) noexcept;

} // namespace lemma::core

#endif // LEMMA_CORE_CLIENT_FRAME_OUTPUT_HPP
