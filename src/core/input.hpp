#ifndef LEMMA_CORE_INPUT_HPP
#define LEMMA_CORE_INPUT_HPP

#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>

namespace lemma::protocol {
struct KeyInput;
}

namespace lemma::core {

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
  [[nodiscard]] auto writable_span() noexcept -> std::span<std::byte>;
  [[nodiscard]] auto commit_write(std::size_t bytes) noexcept -> bool;
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

// Borrows the pane's single ordered PTY path as the synchronous destination for terminal-generated
// replies. The sink is valid only while the queue remains alive and is not moved.
[[nodiscard]] auto pane_pty_response_sink(PanePtyWriteQueue& queue) noexcept -> vt::PtyResponseSink;

// Normalizes attached-terminal legacy bytes against the pane's active keyboard modes, then appends
// the complete encoded packet transactionally. A full queue is unchanged so the caller can retain
// the client decoder message and apply read backpressure.
[[nodiscard]] auto queue_normalized_input(PanePtyWriteQueue& queue, vt::Terminal& terminal,
                                          std::span<const std::byte> input) noexcept
    -> InputQueueResult;
[[nodiscard]] auto queue_key_input(PanePtyWriteQueue& queue, vt::Terminal& terminal,
                                   const protocol::KeyInput& key,
                                   std::span<const std::byte> text) noexcept -> InputQueueResult;
// Encodes a bounded legacy prefix and one structured key before committing either packet. This
// keeps an unbound one-shot input context transactional under PTY backpressure.
[[nodiscard]] auto queue_prefixed_key_input(PanePtyWriteQueue& queue, vt::Terminal& terminal,
                                            std::span<const std::byte> prefix,
                                            const protocol::KeyInput& key,
                                            std::span<const std::byte> text) noexcept
    -> InputQueueResult;
[[nodiscard]] auto queue_paste_input(PanePtyWriteQueue& queue, vt::Terminal& terminal,
                                     std::span<std::byte> input) noexcept -> InputQueueResult;
[[nodiscard]] auto queue_focus_input(PanePtyWriteQueue& queue, const vt::Terminal& terminal,
                                     vt::FocusEvent event) noexcept -> InputQueueResult;
[[nodiscard]] auto queue_mouse_input(PanePtyWriteQueue& queue, vt::Terminal& terminal,
                                     const vt::MouseEvent& event) noexcept -> InputQueueResult;
// Ghostty-compatible alternate-screen wheel synthesis. One normalized host wheel report becomes
// one cursor key encoded against the pane's canonical keyboard modes.
[[nodiscard]] auto queue_alternate_scroll_input(PanePtyWriteQueue& queue, vt::Terminal& terminal,
                                                bool upward) noexcept -> InputQueueResult;

} // namespace lemma::core

#endif // LEMMA_CORE_INPUT_HPP
