#ifndef LEMMA_TESTS_SUPPORT_TERMINAL_RESPONSE_BUFFER_HPP
#define LEMMA_TESTS_SUPPORT_TERMINAL_RESPONSE_BUFFER_HPP

#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstring>
#include <span>

namespace lemma::test_support {

// Caller-owned bounded response path for terminal adapter tests. Production writes replies directly
// to PanePtyWriteQueue instead of retaining this additional buffer.
template <std::size_t Capacity = limits::terminal_pty_response_bytes_max>
class TerminalResponseBuffer final {
public:
  [[nodiscard]] auto sink() noexcept -> vt::PtyResponseSink {
    return {.context = this, .append = &append_callback};
  }

  [[nodiscard]] auto size() const noexcept -> std::size_t { return size_; }
  [[nodiscard]] auto empty() const noexcept -> bool { return size_ == 0; }
  [[nodiscard]] auto readable_span() const noexcept -> std::span<const std::byte> {
    return std::span(storage_).subspan(read_offset_, size_);
  }

  auto read(const std::span<std::byte> output) noexcept -> std::size_t {
    const auto bytes = std::min(output.size(), size_);
    if (bytes == 0) {
      return 0;
    }
    std::memcpy(output.data(), std::span(storage_).subspan(read_offset_, bytes).data(), bytes);
    read_offset_ += bytes;
    size_ -= bytes;
    if (size_ == 0) {
      read_offset_ = 0;
    }
    return bytes;
  }

  void clear() noexcept {
    read_offset_ = 0;
    size_ = 0;
  }

private:
  static auto append_callback(void* const context, const std::span<const std::byte> bytes) noexcept
      -> bool {
    return static_cast<TerminalResponseBuffer*>(context)->append(bytes);
  }

  auto append(const std::span<const std::byte> bytes) noexcept -> bool {
    if (bytes.size() > Capacity - size_) {
      return false;
    }
    if (read_offset_ > Capacity - size_ - bytes.size()) {
      std::memmove(storage_.data(), std::span(storage_).subspan(read_offset_, size_).data(), size_);
      read_offset_ = 0;
    }
    if (!bytes.empty()) {
      auto destination = std::span(storage_).subspan(read_offset_ + size_, bytes.size());
      std::memcpy(destination.data(), bytes.data(), bytes.size());
      size_ += bytes.size();
    }
    return true;
  }

  std::array<std::byte, Capacity> storage_{};
  std::size_t read_offset_{0};
  std::size_t size_{0};
};

} // namespace lemma::test_support

#endif // LEMMA_TESTS_SUPPORT_TERMINAL_RESPONSE_BUFFER_HPP
