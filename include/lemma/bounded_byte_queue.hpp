#ifndef LEMMA_BOUNDED_BYTE_QUEUE_HPP
#define LEMMA_BOUNDED_BYTE_QUEUE_HPP

#include "lemma/assert.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstring>
#include <span>

namespace lemma {

template <std::size_t Capacity> class BoundedByteQueue final {
  static_assert(Capacity > 0);

public:
  [[nodiscard]] constexpr std::size_t size() const noexcept { return size_; }
  [[nodiscard]] static constexpr std::size_t capacity() noexcept { return Capacity; }
  [[nodiscard]] constexpr std::size_t remaining() const noexcept { return Capacity - size_; }
  [[nodiscard]] constexpr bool empty() const noexcept { return size_ == 0; }

  // Returns the first directly readable ring segment. A wrapped queue is exposed as two segments
  // across a consume() boundary; callers never need to copy or remove/reinsert partial writes.
  [[nodiscard]] auto readable_span() const noexcept -> std::span<const std::byte> {
    LEMMA_ASSERT(size_ <= Capacity);
    LEMMA_ASSERT(read_offset_ < Capacity);
    return std::span<const std::byte, Capacity>(storage_).subspan(
        read_offset_, std::min(size_, Capacity - read_offset_));
  }

  // Consumes only bytes already present. Failure leaves queue state unchanged.
  [[nodiscard]] bool consume(const std::size_t bytes) noexcept {
    LEMMA_ASSERT(size_ <= Capacity);
    LEMMA_ASSERT(read_offset_ < Capacity);
    if (bytes > size_) {
      return false;
    }
    read_offset_ = advance(read_offset_, bytes);
    size_ -= bytes;
    LEMMA_ASSERT(size_ <= Capacity);
    LEMMA_ASSERT(read_offset_ < Capacity);
    return true;
  }

  [[nodiscard]] bool append(const std::span<const std::byte> input) noexcept {
    LEMMA_ASSERT(size_ <= Capacity);
    LEMMA_ASSERT(write_offset_ < Capacity);

    if (input.size() > remaining()) {
      return false;
    }
    if (input.empty()) {
      return true;
    }

    const std::size_t first_size = std::min(input.size(), Capacity - write_offset_);
    std::span<std::byte, Capacity> storage(storage_);
    copy_bytes(storage.subspan(write_offset_, first_size), input.first(first_size));
    copy_bytes(storage.first(input.size() - first_size), input.subspan(first_size));

    write_offset_ = advance(write_offset_, input.size());
    size_ += input.size();

    LEMMA_ASSERT(size_ <= Capacity);
    LEMMA_ASSERT(write_offset_ < Capacity);
    return true;
  }

  std::size_t read(const std::span<std::byte> output) noexcept {
    LEMMA_ASSERT(size_ <= Capacity);
    LEMMA_ASSERT(read_offset_ < Capacity);

    const std::size_t read_size = std::min(output.size(), size_);
    if (read_size == 0) {
      return 0;
    }

    const std::size_t first_size = std::min(read_size, Capacity - read_offset_);
    std::span<std::byte, Capacity> storage(storage_);
    copy_bytes(output.first(first_size), storage.subspan(read_offset_, first_size));
    copy_bytes(output.subspan(first_size, read_size - first_size),
               storage.first(read_size - first_size));

    const bool consumed = consume(read_size);
    LEMMA_ASSERT(consumed);
    return read_size;
  }

  void clear() noexcept {
    read_offset_ = 0;
    write_offset_ = 0;
    size_ = 0;
  }

private:
  static void copy_bytes(const std::span<std::byte> destination,
                         const std::span<const std::byte> source) noexcept {
    LEMMA_ASSERT(destination.size() == source.size());
    if (!source.empty()) {
      std::memcpy(destination.data(), source.data(), source.size());
    }
  }

  [[nodiscard]] static constexpr std::size_t advance(const std::size_t offset,
                                                     const std::size_t amount) noexcept {
    LEMMA_ASSERT(offset < Capacity);
    LEMMA_ASSERT(amount <= Capacity);
    const std::size_t available = Capacity - offset;
    return amount < available ? offset + amount : amount - available;
  }

  std::array<std::byte, Capacity> storage_{};
  std::size_t read_offset_{0};
  std::size_t write_offset_{0};
  std::size_t size_{0};
};

} // namespace lemma

#endif // LEMMA_BOUNDED_BYTE_QUEUE_HPP
