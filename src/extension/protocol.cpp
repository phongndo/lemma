#include "extension/protocol.hpp"

#include "lemma/limits.hpp"
#include "platform/io.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <optional>
#include <span>
#include <string_view>
#include <utility>

#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

namespace lemma::extension {
namespace {

void encode_u32(const std::span<std::byte, 4> output, const std::uint32_t value) noexcept {
  output.subspan<0, 1>().front() = static_cast<std::byte>((value >> 24U) & 0xffU);
  output.subspan<1, 1>().front() = static_cast<std::byte>((value >> 16U) & 0xffU);
  output.subspan<2, 1>().front() = static_cast<std::byte>((value >> 8U) & 0xffU);
  output.subspan<3, 1>().front() = static_cast<std::byte>(value & 0xffU);
}

[[nodiscard]] auto decode_u32(const std::span<const std::byte, 4> input) noexcept -> std::uint32_t {
  return (std::to_integer<std::uint32_t>(input.subspan<0, 1>().front()) << 24U) |
         (std::to_integer<std::uint32_t>(input.subspan<1, 1>().front()) << 16U) |
         (std::to_integer<std::uint32_t>(input.subspan<2, 1>().front()) << 8U) |
         std::to_integer<std::uint32_t>(input.subspan<3, 1>().front());
}

[[nodiscard]] constexpr auto valid_kind(const std::uint8_t value) noexcept -> bool {
  return value >= static_cast<std::uint8_t>(RecordKind::hello) &&
         value <= static_cast<std::uint8_t>(RecordKind::error);
}

} // namespace

auto encode_header(const RecordKind kind, const std::size_t payload_bytes,
                   const std::uint32_t sequence) noexcept
    -> std::array<std::byte, protocol_header_bytes> {
  std::array<std::byte, protocol_header_bytes> output{};
  if (payload_bytes > limits::extension_record_bytes_max ||
      payload_bytes > std::numeric_limits<std::uint32_t>::max() || sequence == 0) {
    return output;
  }
  std::ranges::copy(protocol_magic, output.begin());
  auto encoded = std::span(output);
  encoded.subspan<4, 1>().front() = static_cast<std::byte>(protocol_major);
  encoded.subspan<5, 1>().front() = static_cast<std::byte>(protocol_minor);
  encoded.subspan<6, 1>().front() = static_cast<std::byte>(kind);
  encoded.subspan<7, 1>().front() = std::byte{0};
  encode_u32(std::span(output).subspan<8, 4>(), static_cast<std::uint32_t>(payload_bytes));
  encode_u32(std::span(output).subspan<12, 4>(), sequence);
  return output;
}

FramedPeer::FramedPeer(const int descriptor) noexcept : descriptor_(descriptor) {
  if (descriptor_ < 0) {
    return;
  }
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const auto flags = ::fcntl(descriptor_, F_GETFL, 0);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  if (flags < 0 || ::fcntl(descriptor_, F_SETFL, flags | O_NONBLOCK) != 0) {
    disconnect();
  }
}

FramedPeer::FramedPeer(FramedPeer&& other) noexcept
    : descriptor_(std::exchange(other.descriptor_, -1)), input_(std::move(other.input_)),
      input_offset_(std::exchange(other.input_offset_, 0)),
      record_bytes_(std::exchange(other.record_bytes_, 0)), output_(std::move(other.output_)),
      output_offset_(std::exchange(other.output_offset_, 0)) {}

auto FramedPeer::operator=(FramedPeer&& other) noexcept -> FramedPeer& {
  if (this == &other) {
    return *this;
  }
  disconnect();
  descriptor_ = std::exchange(other.descriptor_, -1);
  input_ = std::move(other.input_);
  input_offset_ = std::exchange(other.input_offset_, 0);
  record_bytes_ = std::exchange(other.record_bytes_, 0);
  output_ = std::move(other.output_);
  output_offset_ = std::exchange(other.output_offset_, 0);
  return *this;
}

FramedPeer::~FramedPeer() { disconnect(); }

auto FramedPeer::events() const noexcept -> short {
  return static_cast<short>(POLLIN | (output_offset_ < output_.size() ? POLLOUT : 0));
}

auto FramedPeer::prime(const std::byte first) noexcept -> bool {
  if (descriptor_ < 0 || !input_.empty()) {
    return false;
  }
  try {
    input_.reserve(limits::extension_io_bytes_per_turn_max);
    input_.push_back(first);
    return true;
  } catch (...) {
    disconnect();
    return false;
  }
}

// Shrinking a vector does not allocate; retained elements are nothrow movable bytes.
// NOLINTNEXTLINE(bugprone-exception-escape)
auto FramedPeer::compact_input() noexcept -> bool {
  if (input_offset_ == 0) {
    return true;
  }
  if (input_offset_ == input_.size()) {
    input_.clear();
  } else {
    std::ranges::move(std::span(input_).subspan(input_offset_), input_.begin());
    input_.resize(input_.size() - input_offset_);
  }
  input_offset_ = 0;
  return true;
}

auto FramedPeer::read_ready() noexcept -> std::size_t {
  if (descriptor_ < 0 || complete_record().has_value()) {
    return 0;
  }
  static_cast<void>(compact_input());
  constexpr auto retained_max = protocol_header_bytes + limits::extension_record_bytes_max;
  if (input_.size() >= retained_max) {
    disconnect();
    return 0;
  }
  std::array<std::byte, limits::extension_io_bytes_per_turn_max> buffer{};
  const auto requested = std::min(buffer.size(), retained_max - input_.size());
  const auto received = ::recv(descriptor_, buffer.data(), requested, 0);
  if (received > 0) {
    try {
      const auto count = static_cast<std::size_t>(received);
      const auto received_bytes = std::span(buffer).first(count);
      input_.insert(input_.end(), received_bytes.begin(), received_bytes.end());
    } catch (...) {
      disconnect();
      return 0;
    }
    return static_cast<std::size_t>(received);
  }
  if (received == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) {
    disconnect();
  }
  return 0;
}

auto FramedPeer::buffered_record() const noexcept -> bool {
  const auto available = std::span<const std::byte>(input_).subspan(input_offset_);
  if (record_bytes_ != 0 || available.size() < protocol_header_bytes) {
    return record_bytes_ != 0;
  }
  const auto header = available.first<protocol_header_bytes>();
  const auto payload_bytes = decode_u32(header.subspan<8, 4>());
  const auto sequence = decode_u32(header.subspan<12, 4>());
  if (!std::ranges::equal(header.first<4>(), protocol_magic) ||
      std::to_integer<std::uint8_t>(header.subspan<4, 1>().front()) != protocol_major ||
      std::to_integer<std::uint8_t>(header.subspan<5, 1>().front()) != protocol_minor ||
      !valid_kind(std::to_integer<std::uint8_t>(header.subspan<6, 1>().front())) ||
      header.subspan<7, 1>().front() != std::byte{0} || sequence == 0 ||
      payload_bytes > limits::extension_record_bytes_max) {
    return true;
  }
  return available.size() >= protocol_header_bytes + payload_bytes;
}

void FramedPeer::write_ready(const std::size_t bytes_max) noexcept {
  if (descriptor_ < 0 || output_offset_ == output_.size() || bytes_max == 0) {
    return;
  }
  const auto remaining = std::span(output_).subspan(output_offset_);
  const auto sent =
      ::send(descriptor_, remaining.data(), std::min(remaining.size(), bytes_max), MSG_NOSIGNAL);
  if (sent > 0) {
    output_offset_ += static_cast<std::size_t>(sent);
    if (output_offset_ == output_.size()) {
      output_.clear();
      output_offset_ = 0;
    }
  } else if (sent == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) {
    disconnect();
  }
}

auto FramedPeer::complete_record() noexcept -> std::optional<Record> {
  const auto available = std::span<const std::byte>(input_).subspan(input_offset_);
  if (available.size() < protocol_header_bytes) {
    return std::nullopt;
  }
  const auto header = available.first<protocol_header_bytes>();
  if (!std::ranges::equal(header.first<4>(), protocol_magic) ||
      std::to_integer<std::uint8_t>(header.subspan<4, 1>().front()) != protocol_major ||
      std::to_integer<std::uint8_t>(header.subspan<5, 1>().front()) != protocol_minor ||
      !valid_kind(std::to_integer<std::uint8_t>(header.subspan<6, 1>().front())) ||
      header.subspan<7, 1>().front() != std::byte{0}) {
    disconnect();
    return std::nullopt;
  }
  const auto payload_bytes = decode_u32(header.subspan<8, 4>());
  const auto sequence = decode_u32(header.subspan<12, 4>());
  if (payload_bytes > limits::extension_record_bytes_max || sequence == 0) {
    disconnect();
    return std::nullopt;
  }
  const auto total = protocol_header_bytes + static_cast<std::size_t>(payload_bytes);
  if (available.size() < total) {
    return std::nullopt;
  }
  record_bytes_ = total;
  return Record{.payload = available.subspan(protocol_header_bytes, payload_bytes),
                .sequence = sequence,
                .kind = static_cast<RecordKind>(
                    std::to_integer<std::uint8_t>(header.subspan<6, 1>().front()))};
}

auto FramedPeer::receive() noexcept -> std::optional<Record> {
  return record_bytes_ == 0 ? complete_record() : std::optional<Record>{};
}

void FramedPeer::consume() noexcept {
  if (record_bytes_ == 0) {
    return;
  }
  input_offset_ += record_bytes_;
  record_bytes_ = 0;
  if (input_offset_ == input_.size()) {
    input_.clear();
    input_offset_ = 0;
  }
}

auto FramedPeer::send(const RecordKind kind, const std::uint32_t sequence,
                      const std::span<const std::byte> payload) noexcept -> bool {
  if (descriptor_ < 0 || payload.size() > limits::extension_record_bytes_max || sequence == 0) {
    return false;
  }
  const auto header = encode_header(kind, payload.size(), sequence);
  if (header == std::array<std::byte, protocol_header_bytes>{}) {
    return false;
  }
  const auto queued = output_.size() - output_offset_;
  const auto added = header.size() + payload.size();
  if (added > limits::extension_output_bytes_per_owner_max -
                  std::min(queued, limits::extension_output_bytes_per_owner_max)) {
    return false;
  }
  try {
    if (output_offset_ > 0) {
      std::ranges::move(std::span(output_).subspan(output_offset_), output_.begin());
      output_.resize(queued);
      output_offset_ = 0;
    }
    output_.insert(output_.end(), header.begin(), header.end());
    output_.insert(output_.end(), payload.begin(), payload.end());
    return true;
  } catch (...) {
    disconnect();
    return false;
  }
}

auto FramedPeer::send_json(const RecordKind kind, const std::uint32_t sequence,
                           const std::string_view payload) noexcept -> bool {
  return send(kind, sequence, std::as_bytes(std::span(payload.data(), payload.size())));
}

auto FramedPeer::release_descriptor() noexcept -> int { return std::exchange(descriptor_, -1); }

void FramedPeer::disconnect() noexcept {
  if (descriptor_ >= 0) {
    platform::close_descriptor(descriptor_);
  }
  input_.clear();
  input_offset_ = 0;
  record_bytes_ = 0;
  output_.clear();
  output_offset_ = 0;
}

} // namespace lemma::extension
