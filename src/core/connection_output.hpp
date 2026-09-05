#ifndef LEMMA_CORE_CONNECTION_OUTPUT_HPP
#define LEMMA_CORE_CONNECTION_OUTPUT_HPP

#include "lemma/limits.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iterator>
#include <memory>
#include <new>
#include <span>
#include <string_view>
#include <system_error>
#include <utility>

namespace lemma::core {

class ConnectionOutput final {
public:
  [[nodiscard]] auto append(const std::span<const std::byte> bytes) noexcept -> bool {
    if (bytes.size() > limits::pending_connection_output_bytes_max - size_ ||
        !ensure_capacity(size_ + bytes.size())) {
      return false;
    }
    if (!bytes.empty()) {
      auto storage = std::span(storage_.get(), capacity_);
      std::memcpy(storage.subspan(size_, bytes.size()).data(), bytes.data(), bytes.size());
      size_ += bytes.size();
    }
    return true;
  }

  [[nodiscard]] auto append_text(const std::string_view text) noexcept -> bool {
    return append(std::as_bytes(std::span(text.data(), text.size())));
  }

  [[nodiscard]] auto append_safe(const std::string_view text, const std::size_t maximum) noexcept
      -> bool {
    const auto size = std::min(text.size(), maximum);
    if (size > limits::pending_connection_output_bytes_max - size_ ||
        !ensure_capacity(size_ + size)) {
      return false;
    }
    const auto source = std::span(text).first(size);
    auto destination = std::span(storage_.get(), capacity_).subspan(size_, size);
    std::ranges::transform(source, destination.begin(), [](const char character) noexcept {
      const auto value = static_cast<unsigned char>(character);
      return static_cast<std::byte>(value < 0x20U || value == 0x7FU ? '?' : character);
    });
    size_ += size;
    return true;
  }

  [[nodiscard]] auto append_title(const std::string_view title) noexcept -> bool {
    constexpr std::size_t title_bytes_max = 256;
    return append_safe(title, title_bytes_max);
  }

  [[nodiscard]] auto append_number(const std::uint64_t value) noexcept -> bool {
    std::array<char, 32> buffer{};
    const auto result = std::to_chars(buffer.begin(), buffer.end(), value);
    if (result.ec != std::errc{}) {
      return false;
    }
    const auto size = static_cast<std::size_t>(std::distance(buffer.begin(), result.ptr));
    return append_text(std::string_view(buffer.data(), size));
  }

  [[nodiscard]] auto readable() const noexcept -> std::span<const std::byte> {
    return size_ == 0 ? std::span<const std::byte>{}
                      : std::span<const std::byte>(storage_.get(), size_).subspan(offset_);
  }
  [[nodiscard]] auto busy() const noexcept -> bool { return offset_ < size_; }
  [[nodiscard]] auto consume(const std::size_t bytes) noexcept -> bool {
    if (bytes > size_ - offset_) {
      return false;
    }
    offset_ += bytes;
    return true;
  }
  void reset() noexcept {
    size_ = 0;
    offset_ = 0;
  }

private:
  [[nodiscard]] auto ensure_capacity(const std::size_t required) noexcept -> bool {
    if (required <= capacity_) {
      return true;
    }
    constexpr std::size_t initial_capacity = std::size_t{4} * 1'024U;
    const auto preferred = std::min(limits::pending_connection_output_bytes_max,
                                    std::max({required, initial_capacity, capacity_ * 2U}));
    try {
      // Runtime-sized output storage cannot use std::array.
      // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
      auto replacement = std::make_unique_for_overwrite<std::byte[]>(preferred);
      if (size_ > 0) {
        std::memcpy(replacement.get(), storage_.get(), size_);
      }
      storage_ = std::move(replacement);
      capacity_ = preferred;
      return true;
    } catch (const std::bad_alloc&) {
      return false;
    }
  }

  // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
  std::unique_ptr<std::byte[]> storage_;
  std::size_t capacity_{0};
  std::size_t size_{0};
  std::size_t offset_{0};
};

struct ConnectionWriteAttempt final {
  std::ptrdiff_t bytes{0};
  int error{0};
};

using ConnectionWriteOperation =
    ConnectionWriteAttempt (*)(void* context, std::span<const std::byte> bytes) noexcept;

enum class ConnectionFlushStatus : unsigned char {
  drained,
  pending,
  blocked,
  hard_error,
};

inline constexpr std::size_t connection_write_bytes_per_turn_max = std::size_t{16} * 1'024U;
inline constexpr std::size_t connection_write_attempts_per_turn_max = 16;

// Flushes retained control output without consuming bytes until the writer reports progress.
// global_budget is reduced only by bytes actually written.
template <typename Output>
[[nodiscard]] inline auto
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
flush_connection_output(Output& output, std::size_t& global_budget,
                        const ConnectionWriteOperation write, void* const context) noexcept
    -> ConnectionFlushStatus {
  if (!output.busy()) {
    return ConnectionFlushStatus::drained;
  }
  if (write == nullptr || global_budget == 0) {
    return ConnectionFlushStatus::pending;
  }

  std::size_t budget = std::min(connection_write_bytes_per_turn_max, global_budget);
  std::size_t attempts = 0;
  while (output.busy() && budget > 0 && attempts < connection_write_attempts_per_turn_max) {
    ++attempts;
    const auto readable = output.readable();
    const auto bytes = readable.first(std::min(readable.size(), budget));
    const auto result = write(context, bytes);
    if (result.bytes > 0) {
      const auto size = static_cast<std::size_t>(result.bytes);
      if (size > bytes.size() || !output.consume(size)) {
        return ConnectionFlushStatus::hard_error;
      }
      budget -= size;
      global_budget -= size;
      continue;
    }
    if (result.bytes == 0) {
      return ConnectionFlushStatus::hard_error;
    }
    if (result.error == EINTR) {
      continue;
    }
    if (result.error == EAGAIN || result.error == EWOULDBLOCK) {
      return ConnectionFlushStatus::blocked;
    }
    return ConnectionFlushStatus::hard_error;
  }
  return output.busy() ? ConnectionFlushStatus::pending : ConnectionFlushStatus::drained;
}

} // namespace lemma::core

#endif // LEMMA_CORE_CONNECTION_OUTPUT_HPP
