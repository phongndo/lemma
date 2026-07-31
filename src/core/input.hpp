#ifndef FIBER_CORE_INPUT_HPP
#define FIBER_CORE_INPUT_HPP

#include "fiber/limits.hpp"
#include "fiber/terminal/terminal.hpp"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>

namespace fiber::core {

// Per-pane PTY output is allocated on demand and shares a process-wide memory budget. Queue
// operations remain bounded and non-throwing so exhausted aggregate capacity applies backpressure.
class PanePtyWriteQueue final {
public:
  PanePtyWriteQueue() noexcept = default;
  ~PanePtyWriteQueue();

  PanePtyWriteQueue(const PanePtyWriteQueue&) = delete;
  auto operator=(const PanePtyWriteQueue&) -> PanePtyWriteQueue& = delete;
  PanePtyWriteQueue(PanePtyWriteQueue&&) = delete;
  auto operator=(PanePtyWriteQueue&&) -> PanePtyWriteQueue& = delete;

  [[nodiscard]] auto size() const noexcept -> std::size_t { return size_; }
  [[nodiscard]] static constexpr auto capacity() noexcept -> std::size_t {
    return limits::pane_pty_write_queue_bytes_max;
  }
  [[nodiscard]] static auto allocated_bytes_current() noexcept -> std::size_t;
  [[nodiscard]] auto remaining() const noexcept -> std::size_t { return capacity() - size_; }
  [[nodiscard]] auto empty() const noexcept -> bool { return size_ == 0; }
  [[nodiscard]] auto readable_span() const noexcept -> std::span<const std::byte>;
  [[nodiscard]] auto consume(std::size_t bytes) noexcept -> bool;
  [[nodiscard]] auto reserve(std::size_t bytes) noexcept -> bool;
  [[nodiscard]] auto append(std::span<const std::byte> input) noexcept -> bool;
  auto read(std::span<std::byte> output) noexcept -> std::size_t;
  void clear() noexcept;

private:
  [[nodiscard]] auto ensure_capacity(std::size_t required) noexcept -> bool;
  [[nodiscard]] auto replace_storage(std::size_t capacity) noexcept -> bool;
  [[nodiscard]] static auto acquire_allocation(std::size_t bytes) noexcept -> bool;
  static void release_allocation(std::size_t bytes) noexcept;
  void release_storage() noexcept;

  static std::atomic_size_t allocated_bytes;
  // Runtime-sized non-throwing storage cannot use std::array.
  // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
  std::unique_ptr<std::byte[]> storage_;
  std::size_t storage_capacity_{0};
  std::size_t read_offset_{0};
  std::size_t size_{0};
};

enum class InputQueueResult : std::uint8_t {
  queued,
  full,
  encoding_failed,
};

// Moves complete terminal-generated replies onto the pane's ordered write path before they can be
// overtaken by input accepted later in the same reactor turn.
[[nodiscard]] auto queue_terminal_responses(PanePtyWriteQueue& queue,
                                            vt::Terminal& terminal) noexcept -> bool;

// Normalizes attached-terminal legacy bytes against the pane's active keyboard modes, then appends
// the complete encoded packet transactionally. A full queue is unchanged so the caller can retain
// the client decoder message and apply read backpressure.
[[nodiscard]] auto queue_normalized_input(PanePtyWriteQueue& queue, vt::Terminal& terminal,
                                          std::span<const std::byte> input) noexcept
    -> InputQueueResult;

} // namespace fiber::core

#endif // FIBER_CORE_INPUT_HPP
