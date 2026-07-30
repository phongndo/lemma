#include "core/input.hpp"

#include "fiber/assert.hpp"
#include "protocol/single_pane.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <new>
#include <span>
#include <string_view>
#include <utility>

namespace fiber::core {

std::atomic_size_t PanePtyWriteQueue::allocated_bytes{0};

PanePtyWriteQueue::~PanePtyWriteQueue() { release_storage(); }

auto PanePtyWriteQueue::readable_span() const noexcept -> std::span<const std::byte> {
  FIBER_ASSERT(size_ <= capacity());
  if (size_ == 0) {
    return {};
  }
  FIBER_ASSERT(storage_ != nullptr);
  FIBER_ASSERT(read_offset_ <= storage_capacity_);
  FIBER_ASSERT(size_ <= storage_capacity_ - read_offset_);
  return std::span(storage_.get(), storage_capacity_).subspan(read_offset_, size_);
}

auto PanePtyWriteQueue::consume(const std::size_t bytes) noexcept -> bool {
  FIBER_ASSERT(size_ <= capacity());
  if (bytes > size_) {
    return false;
  }
  read_offset_ += bytes;
  size_ -= bytes;
  if (size_ == 0) {
    release_storage();
  }
  return true;
}

auto PanePtyWriteQueue::reserve(const std::size_t bytes) noexcept -> bool {
  if (bytes > remaining()) {
    return false;
  }
  return ensure_capacity(size_ + bytes);
}

auto PanePtyWriteQueue::append(const std::span<const std::byte> input) noexcept -> bool {
  if (!reserve(input.size())) {
    return false;
  }
  if (input.empty()) {
    return true;
  }
  const auto write_offset = read_offset_ + size_;
  FIBER_ASSERT(write_offset <= storage_capacity_);
  FIBER_ASSERT(input.size() <= storage_capacity_ - write_offset);
  auto storage = std::span(storage_.get(), storage_capacity_);
  std::memcpy(storage.subspan(write_offset, input.size()).data(), input.data(), input.size());
  size_ += input.size();
  return true;
}

auto PanePtyWriteQueue::read(const std::span<std::byte> output) noexcept -> std::size_t {
  const auto readable = readable_span();
  const auto bytes = std::min(output.size(), readable.size());
  if (bytes == 0) {
    return 0;
  }
  std::memcpy(output.data(), readable.data(), bytes);
  const bool consumed = consume(bytes);
  FIBER_ASSERT(consumed);
  return bytes;
}

void PanePtyWriteQueue::clear() noexcept { release_storage(); }

auto PanePtyWriteQueue::ensure_capacity(const std::size_t required) noexcept -> bool {
  if (required > capacity()) {
    return false;
  }
  if (required <= storage_capacity_) {
    if (read_offset_ > storage_capacity_ - required) {
      FIBER_ASSERT(storage_ != nullptr);
      const auto storage = std::span(storage_.get(), storage_capacity_);
      std::memmove(storage_.get(), storage.subspan(read_offset_, size_).data(), size_);
      read_offset_ = 0;
    }
    return true;
  }

  constexpr std::size_t allocation_granularity = std::size_t{4} * 1'024U;
  const auto doubled = std::min(capacity(), storage_capacity_ * 2U);
  const auto preferred =
      std::min(capacity(), std::max({required, allocation_granularity, doubled}));
  if (replace_storage(preferred)) {
    return true;
  }
  return preferred != required && replace_storage(required);
}

auto PanePtyWriteQueue::replace_storage(const std::size_t new_capacity) noexcept -> bool {
  FIBER_ASSERT(new_capacity > storage_capacity_);
  FIBER_ASSERT(new_capacity >= size_);
  FIBER_ASSERT(new_capacity <= capacity());
  if (!acquire_allocation(new_capacity)) {
    return false;
  }
  // Runtime-sized non-throwing storage cannot use std::array.
  // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
  auto replacement = std::unique_ptr<std::byte[]>(
      // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
      new (std::nothrow) std::byte[new_capacity]);
  if (replacement == nullptr) {
    release_allocation(new_capacity);
    return false;
  }
  if (size_ > 0) {
    FIBER_ASSERT(storage_ != nullptr);
    const auto storage = std::span(storage_.get(), storage_capacity_);
    std::memcpy(replacement.get(), storage.subspan(read_offset_, size_).data(), size_);
  }

  const auto previous_capacity = storage_capacity_;
  storage_ = std::move(replacement);
  storage_capacity_ = new_capacity;
  read_offset_ = 0;
  release_allocation(previous_capacity);
  return true;
}

auto PanePtyWriteQueue::acquire_allocation(const std::size_t bytes) noexcept -> bool {
  auto allocated = allocated_bytes.load(std::memory_order_relaxed);
  const auto maximum = limits::pane_pty_write_queue_bytes_aggregate_max;
  while (allocated <= maximum && bytes <= maximum - allocated) {
    if (allocated_bytes.compare_exchange_weak(allocated, allocated + bytes,
                                              std::memory_order_relaxed)) {
      return true;
    }
  }
  return false;
}

void PanePtyWriteQueue::release_allocation(const std::size_t bytes) noexcept {
  if (bytes == 0) {
    return;
  }
  const auto previous = allocated_bytes.fetch_sub(bytes, std::memory_order_relaxed);
  FIBER_ASSERT(previous >= bytes);
}

void PanePtyWriteQueue::release_storage() noexcept {
  const auto released = storage_capacity_;
  storage_.reset();
  storage_capacity_ = 0;
  read_offset_ = 0;
  size_ = 0;
  release_allocation(released);
}

namespace {

constexpr std::size_t key_encoding_bytes_max = 128;
static_assert(limits::normalized_client_input_bytes_max ==
              protocol::input_bytes_max * 2U * key_encoding_bytes_max);
static_assert(limits::pane_pty_write_queue_bytes_max >=
              limits::terminal_pty_response_bytes_max + limits::normalized_client_input_bytes_max);

[[nodiscard]] constexpr auto control_key(const std::byte byte) noexcept -> vt::Key {
  const auto value = std::to_integer<std::uint8_t>(byte);
  FIBER_ASSERT(value >= 1 && value <= 26);
  return static_cast<vt::Key>(static_cast<std::uint8_t>(vt::Key::a) + value - 1U);
}

[[nodiscard]] constexpr auto arrow_key(const std::byte final) noexcept -> vt::Key {
  switch (std::to_integer<char>(final)) {
  case 'A':
    return vt::Key::arrow_up;
  case 'B':
    return vt::Key::arrow_down;
  case 'C':
    return vt::Key::arrow_right;
  case 'D':
    return vt::Key::arrow_left;
  case 'F':
    return vt::Key::end;
  case 'H':
    return vt::Key::home;
  default:
    return vt::Key::unidentified;
  }
}

template <typename Visitor>
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto visit_normalized_input(vt::Terminal& terminal,
                                          const std::span<const std::byte> input,
                                          Visitor visitor) noexcept -> bool {
  std::size_t input_offset = 0;
  while (input_offset < input.size()) {
    vt::KeyEvent event{};
    std::array<char, 1> event_text{};
    std::size_t consumed = 0;
    const auto byte = input.subspan(input_offset, 1).front();
    const auto value = std::to_integer<std::uint8_t>(byte);
    if (byte == std::byte{0x0D}) {
      // Enter and Ctrl-M share the legacy byte. Applications using Kitty modes receive Enter.
      event.key = vt::Key::enter;
      consumed = 1;
    } else if (byte == std::byte{0x09}) {
      event.key = vt::Key::tab;
      consumed = 1;
    } else if (byte == std::byte{0x7F}) {
      event.key = vt::Key::backspace;
      consumed = 1;
    } else if (value >= 1 && value <= 26) {
      event.key = control_key(byte);
      event.modifiers = vt::key_modifier_control;
      event.unshifted_codepoint = static_cast<std::uint32_t>('a' + value - 1U);
      event_text.front() = static_cast<char>('a' + value - 1U);
      event.text = std::string_view(event_text.data(), event_text.size());
      consumed = 1;
    } else if (input.size() - input_offset >= 3 && byte == std::byte{0x1B} &&
               (input.subspan(input_offset + 1, 1).front() == std::byte{'['} ||
                input.subspan(input_offset + 1, 1).front() == std::byte{'O'})) {
      event.key = arrow_key(input.subspan(input_offset + 2, 1).front());
      consumed = event.key == vt::Key::unidentified ? 0 : 3;
    }

    if (consumed == 0) {
      if (!visitor(input.subspan(input_offset, 1))) {
        return false;
      }
      ++input_offset;
      continue;
    }

    std::array<std::byte, key_encoding_bytes_max> encoded{};
    const auto key_bytes = terminal.encode_key(event, encoded);
    if (!key_bytes.has_value() || *key_bytes > encoded.size() ||
        !visitor(std::span(encoded).first(*key_bytes))) {
      return false;
    }
    input_offset += consumed;
  }
  return true;
}

} // namespace

[[nodiscard]] auto queue_normalized_input(PanePtyWriteQueue& queue, vt::Terminal& terminal,
                                          const std::span<const std::byte> input) noexcept
    -> InputQueueResult {
  if (input.size() > protocol::input_bytes_max * 2U) {
    return InputQueueResult::encoding_failed;
  }

  std::size_t encoded_size = 0;
  const bool measured =
      visit_normalized_input(terminal, input, [&](const std::span<const std::byte> bytes) noexcept {
        if (bytes.size() > std::numeric_limits<std::size_t>::max() - encoded_size) {
          return false;
        }
        encoded_size += bytes.size();
        return encoded_size <= limits::normalized_client_input_bytes_max;
      });
  if (!measured) {
    return InputQueueResult::encoding_failed;
  }
  if (encoded_size > queue.remaining() || !queue.reserve(encoded_size)) {
    return InputQueueResult::full;
  }

  const bool appended =
      visit_normalized_input(terminal, input, [&](const std::span<const std::byte> bytes) noexcept {
        return queue.append(bytes);
      });
  FIBER_ASSERT(appended);
  return appended ? InputQueueResult::queued : InputQueueResult::encoding_failed;
}

} // namespace fiber::core
