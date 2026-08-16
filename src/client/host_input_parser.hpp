#ifndef LEMMA_CLIENT_HOST_INPUT_PARSER_HPP
#define LEMMA_CLIENT_HOST_INPUT_PARSER_HPP

#include "lemma/limits.hpp"
#include "protocol/attachment.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <memory>
#include <span>

namespace lemma::client {

enum class HostInputKind : std::uint8_t {
  ordinary,
  paste,
  key,
  focus,
  mouse,
};

struct HostInputEvent final {
  HostInputKind kind{HostInputKind::ordinary};
  std::size_t offset{0};
  std::size_t size{0};
  protocol::KeyInput key{};
  protocol::FocusInput focus{protocol::FocusInput::lost};
  protocol::MouseInput mouse{};
};

inline constexpr std::size_t host_input_events_max = (protocol::input_bytes_max / 2U) + 1U;

struct HostInputBatch final {
  // Typed sequences consume at least three physical bytes; alternating one-byte ordinary runs give
  // the strictest event count, with one extra slot for a paste completed from an earlier read.
  std::array<HostInputEvent, host_input_events_max> events{};
  std::size_t event_count{0};
  std::size_t bytes{0};
};

static_assert(sizeof(HostInputBatch) < std::size_t{128} * 1'024U);

enum class HostInputError : std::uint8_t {
  output_exhausted,
  event_limit,
  allocation_failed,
  not_prepared,
};

inline constexpr std::size_t host_input_output_bytes_max =
    limits::structured_input_payload_bytes_max + (protocol::input_bytes_max * 2U);

// Preserves bracketed paste, focus, and SGR mouse boundaries across arbitrary read fragmentation.
// Unknown or malformed sequences remain ordinary bytes and retain their original ordering.
class HostInputParser final {
public:
  [[nodiscard]] auto prepare() noexcept -> std::expected<void, HostInputError>;
  [[nodiscard]] auto parse(std::span<const std::byte> input, std::span<std::byte> output,
                           protocol::Dimensions geometry) noexcept
      -> std::expected<HostInputBatch, HostInputError>;
  [[nodiscard]] auto flush_pending(std::span<std::byte> output) noexcept
      -> std::expected<HostInputBatch, HostInputError>;
  [[nodiscard]] auto has_pending_sequence() const noexcept -> bool { return pending_size_ > 0; }
  [[nodiscard]] auto paste_active() const noexcept -> bool { return paste_active_; }

private:
  // Decimal Kitty associated-text codepoints can be much larger than their decoded UTF-8.
  static constexpr std::size_t sequence_bytes_max = (protocol::key_input_text_bytes_max * 8U) + 64U;

  std::array<std::byte, sequence_bytes_max> pending_{};
  // One bounded opaque paste is retained until its end marker arrives, independent of reads.
  // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
  std::unique_ptr<std::byte[]> paste_storage_;
  std::size_t pending_size_{0};
  std::size_t paste_size_{0};
  bool paste_active_{false};
  bool any_button_pressed_{false};
};

} // namespace lemma::client

#endif // LEMMA_CLIENT_HOST_INPUT_PARSER_HPP
