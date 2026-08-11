#include "protocol/single_pane.hpp"

#include "lemma/assert.hpp"

#include <algorithm>
#include <cstring>
#include <limits>
#include <new>

// Fixed wire offsets are checked against compile-time-sized headers and validated payload bounds.
// NOLINTBEGIN(cppcoreguidelines-pro-bounds-avoid-unchecked-container-access)

namespace lemma::protocol {
namespace {

void encode_u16(const std::uint16_t value, const std::span<std::byte, 2> output) noexcept {
  output.front() = static_cast<std::byte>(value >> 8U);
  output.back() = static_cast<std::byte>(value & 0xFFU);
}

void encode_u32(const std::uint32_t value, const std::span<std::byte, 4> output) noexcept {
  output[0] = static_cast<std::byte>(value >> 24U);
  output[1] = static_cast<std::byte>((value >> 16U) & 0xFFU);
  output[2] = static_cast<std::byte>((value >> 8U) & 0xFFU);
  output[3] = static_cast<std::byte>(value & 0xFFU);
}

[[nodiscard]] constexpr auto decode_u16(const std::byte high, const std::byte low) noexcept
    -> std::uint16_t {
  const auto high_value = std::to_integer<std::uint16_t>(high);
  const auto low_value = std::to_integer<std::uint16_t>(low);
  return static_cast<std::uint16_t>((high_value << 8U) | low_value);
}

[[nodiscard]] constexpr auto decode_u32(const std::span<const std::byte, 4> bytes) noexcept
    -> std::uint32_t {
  return (std::to_integer<std::uint32_t>(bytes[0]) << 24U) |
         (std::to_integer<std::uint32_t>(bytes[1]) << 16U) |
         (std::to_integer<std::uint32_t>(bytes[2]) << 8U) |
         std::to_integer<std::uint32_t>(bytes[3]);
}

[[nodiscard]] auto valid_dimensions(const Dimensions dimensions) noexcept -> bool {
  return dimensions.columns > 0 && dimensions.rows > 0 && dimensions.columns <= columns_max &&
         dimensions.rows <= rows_max;
}

[[nodiscard]] auto valid_session_name(const std::string_view session) noexcept -> bool {
  return !session.empty() && session.size() <= session_name_bytes_max &&
         std::ranges::all_of(session, [](const char character) {
           return (character >= 'a' && character <= 'z') ||
                  (character >= 'A' && character <= 'Z') ||
                  (character >= '0' && character <= '9') || character == '_' || character == '-';
         });
}

[[nodiscard]] auto pane_command(const std::byte encoded) noexcept -> std::optional<PaneCommand> {
  const auto command = static_cast<PaneCommand>(std::to_integer<std::uint8_t>(encoded));
  switch (command) {
  case PaneCommand::none:
    break;
  case PaneCommand::split_left_right:
  case PaneCommand::split_top_bottom:
  case PaneCommand::focus_left:
  case PaneCommand::focus_right:
  case PaneCommand::focus_up:
  case PaneCommand::focus_down:
  case PaneCommand::focus_next:
  case PaneCommand::focus_previous:
  case PaneCommand::close:
  case PaneCommand::zoom:
  case PaneCommand::create_tab:
  case PaneCommand::next_tab:
  case PaneCommand::previous_tab:
  case PaneCommand::kill_tab:
  case PaneCommand::select_tab_0:
  case PaneCommand::select_tab_1:
  case PaneCommand::select_tab_2:
  case PaneCommand::select_tab_3:
  case PaneCommand::select_tab_4:
  case PaneCommand::select_tab_5:
  case PaneCommand::select_tab_6:
  case PaneCommand::select_tab_7:
  case PaneCommand::select_tab_8:
  case PaneCommand::select_tab_9:
    return command;
  }
  return std::nullopt;
}

[[nodiscard]] auto disconnect_reason(const std::byte encoded) noexcept
    -> std::optional<DisconnectReason> {
  const auto reason = static_cast<DisconnectReason>(std::to_integer<std::uint8_t>(encoded));
  switch (reason) {
  case DisconnectReason::normal:
  case DisconnectReason::protocol_error:
  case DisconnectReason::version_mismatch:
  case DisconnectReason::session_busy:
  case DisconnectReason::session_missing:
  case DisconnectReason::capacity:
  case DisconnectReason::setup_failed:
  case DisconnectReason::frame_timeout:
  case DisconnectReason::daemon_shutdown:
  case DisconnectReason::internal_error:
    return reason;
  }
  return std::nullopt;
}

[[nodiscard]] auto message_kind(const std::byte encoded) noexcept -> std::optional<MessageKind> {
  const auto kind = static_cast<MessageKind>(std::to_integer<std::uint8_t>(encoded));
  switch (kind) {
  case MessageKind::hello:
  case MessageKind::input:
  case MessageKind::resize:
  case MessageKind::pane_command:
  case MessageKind::detach:
  case MessageKind::render_frame:
  case MessageKind::disconnect:
    return kind;
  }
  return std::nullopt;
}

[[nodiscard]] auto valid_diagnostic(const std::span<const std::byte> bytes) noexcept -> bool {
  return std::ranges::all_of(bytes, [](const std::byte byte) {
    const auto value = std::to_integer<std::uint8_t>(byte);
    return value >= 0x20U && value <= 0x7EU;
  });
}

struct Envelope final {
  MessageKind kind{MessageKind::disconnect};
  std::uint8_t flags{0};
  std::size_t payload_bytes{0};
  std::uint32_t sequence{0};
};

[[nodiscard]] auto decode_envelope(const std::span<const std::byte> buffered,
                                   const std::uint32_t expected_sequence) noexcept
    -> std::expected<std::optional<Envelope>, DecodeError> {
  if (buffered.size() < attach_header_bytes) {
    return std::optional<Envelope>{};
  }
  if (!std::ranges::equal(buffered.first(attach_magic.size()), attach_magic)) {
    return std::unexpected(DecodeError::invalid_magic);
  }
  if (std::to_integer<std::uint8_t>(buffered[4]) != current_version.major ||
      std::to_integer<std::uint8_t>(buffered[5]) != current_version.minor) {
    return std::unexpected(DecodeError::version_mismatch);
  }
  const auto kind = message_kind(buffered[6]);
  if (!kind.has_value()) {
    return std::unexpected(DecodeError::invalid_kind);
  }
  const auto payload = decode_u32(std::span(buffered).subspan<8, 4>());
  const auto sequence = decode_u32(std::span(buffered).subspan<12, 4>());
  if (sequence == 0 || sequence != expected_sequence) {
    return std::unexpected(DecodeError::invalid_sequence);
  }
  return Envelope{
      .kind = *kind,
      .flags = std::to_integer<std::uint8_t>(buffered[7]),
      .payload_bytes = payload,
      .sequence = sequence,
  };
}

void copy_header(const std::array<std::byte, attach_header_bytes>& header,
                 const std::span<std::byte> storage, std::size_t& size) noexcept {
  std::ranges::copy(header, storage.begin());
  size = header.size();
}

[[nodiscard]] auto next_sequence(const std::uint32_t sequence) noexcept -> std::uint32_t {
  return sequence == std::numeric_limits<std::uint32_t>::max() ? 0U : sequence + 1U;
}

} // namespace

[[nodiscard]] auto encode_session_header(const ControlCommand command,
                                         const std::string_view session) noexcept
    -> std::array<std::byte, 2> {
  LEMMA_ASSERT(!session.empty());
  LEMMA_ASSERT(session.size() <= session_name_bytes_max);
  return {wire_byte(command), static_cast<std::byte>(session.size())};
}

[[nodiscard]] auto encode_dimensions(const Dimensions dimensions) noexcept
    -> std::array<std::byte, 4> {
  std::array<std::byte, 4> packet{};
  encode_u16(dimensions.columns, std::span(packet).subspan<0, 2>());
  encode_u16(dimensions.rows, std::span(packet).subspan<2, 2>());
  return packet;
}

[[nodiscard]] auto encode_bounded_size(const std::size_t size) noexcept
    -> std::array<std::byte, 2> {
  LEMMA_ASSERT(size <= std::numeric_limits<std::uint16_t>::max());
  std::array<std::byte, 2> encoded{};
  encode_u16(static_cast<std::uint16_t>(size), encoded);
  return encoded;
}

[[nodiscard]] auto decode_bounded_size(const std::span<const std::byte, 2> bytes) noexcept
    -> std::size_t {
  return decode_u16(bytes.front(), bytes.back());
}

[[nodiscard]] auto decode_dimensions(const std::span<const std::byte, 4> bytes) noexcept
    -> Dimensions {
  return {
      .columns = decode_u16(bytes.front(), bytes.subspan<1>().front()),
      .rows = decode_u16(bytes.subspan<2>().front(), bytes.subspan<3>().front()),
  };
}

[[nodiscard]] auto encode_header(const MessageKind kind, const std::uint8_t flags,
                                 const std::uint32_t payload_bytes, const std::uint32_t sequence,
                                 const ProtocolVersion version) noexcept
    -> std::array<std::byte, attach_header_bytes> {
  LEMMA_ASSERT(sequence != 0);
  std::array<std::byte, attach_header_bytes> header{};
  std::ranges::copy(attach_magic, header.begin());
  header[4] = static_cast<std::byte>(version.major);
  header[5] = static_cast<std::byte>(version.minor);
  header[6] = static_cast<std::byte>(kind);
  header[7] = static_cast<std::byte>(flags);
  encode_u32(payload_bytes, std::span(header).subspan<8, 4>());
  encode_u32(sequence, std::span(header).subspan<12, 4>());
  return header;
}

[[nodiscard]] auto encode_client_hello(const std::string_view session, const Dimensions dimensions,
                                       const std::uint32_t sequence,
                                       const ProtocolVersion version) noexcept -> SmallMessage {
  LEMMA_ASSERT(!session.empty());
  LEMMA_ASSERT(session.size() <= session_name_bytes_max);
  SmallMessage message;
  const auto payload_bytes = static_cast<std::uint32_t>(5U + session.size());
  copy_header(encode_header(MessageKind::hello, 0, payload_bytes, sequence, version),
              message.storage_, message.size_);
  auto output = std::span(message.storage_).subspan(message.size_);
  output.front() = static_cast<std::byte>(session.size());
  const auto dimensions_bytes = encode_dimensions(dimensions);
  std::ranges::copy(dimensions_bytes, output.subspan<1, 4>().begin());
  std::ranges::copy(std::as_bytes(std::span(session.data(), session.size())),
                    output.subspan<5>().begin());
  message.size_ += payload_bytes;
  return message;
}

[[nodiscard]] auto encode_daemon_hello(const Dimensions dimensions,
                                       const std::uint32_t sequence) noexcept -> SmallMessage {
  LEMMA_ASSERT(valid_dimensions(dimensions));
  SmallMessage message;
  copy_header(encode_header(MessageKind::hello, 0, 4, sequence), message.storage_, message.size_);
  const auto encoded = encode_dimensions(dimensions);
  std::ranges::copy(encoded, std::span(message.storage_).subspan(message.size_).begin());
  message.size_ += encoded.size();
  return message;
}

[[nodiscard]] auto encode_input_header(const std::size_t bytes,
                                       const std::uint32_t sequence) noexcept
    -> std::array<std::byte, attach_header_bytes> {
  LEMMA_ASSERT(bytes > 0);
  LEMMA_ASSERT(bytes <= input_message_bytes_max);
  return encode_header(MessageKind::input, 0, static_cast<std::uint32_t>(bytes), sequence);
}

[[nodiscard]] auto encode_resize(const Dimensions dimensions, const std::uint32_t sequence) noexcept
    -> SmallMessage {
  LEMMA_ASSERT(valid_dimensions(dimensions));
  SmallMessage message;
  copy_header(encode_header(MessageKind::resize, 0, 4, sequence), message.storage_, message.size_);
  const auto encoded = encode_dimensions(dimensions);
  std::ranges::copy(encoded, std::span(message.storage_).subspan(message.size_).begin());
  message.size_ += encoded.size();
  return message;
}

[[nodiscard]] auto encode_detach(const std::uint32_t sequence) noexcept -> SmallMessage {
  SmallMessage message;
  copy_header(encode_header(MessageKind::detach, 0, 0, sequence), message.storage_, message.size_);
  return message;
}

[[nodiscard]] auto encode_pane_command(const PaneCommand command,
                                       const std::uint32_t sequence) noexcept -> SmallMessage {
  LEMMA_ASSERT(command != PaneCommand::none);
  SmallMessage message;
  copy_header(encode_header(MessageKind::pane_command, 0, 1, sequence), message.storage_,
              message.size_);
  std::span(message.storage_).subspan(message.size_, 1).front() = static_cast<std::byte>(command);
  ++message.size_;
  return message;
}

[[nodiscard]] auto encode_render_frame_header(const std::size_t ansi_bytes,
                                              const std::uint32_t sequence,
                                              const std::uint32_t full_redraw_generation,
                                              const bool full_redraw) noexcept
    -> std::array<std::byte, attach_header_bytes + render_generation_bytes> {
  LEMMA_ASSERT(ansi_bytes > 0);
  LEMMA_ASSERT(ansi_bytes <= render_ansi_bytes_max);
  LEMMA_ASSERT(full_redraw_generation > 0);
  std::array<std::byte, attach_header_bytes + render_generation_bytes> encoded{};
  const auto header =
      encode_header(MessageKind::render_frame, full_redraw ? render_full_redraw_flag : 0,
                    static_cast<std::uint32_t>(render_generation_bytes + ansi_bytes), sequence);
  std::ranges::copy(header, encoded.begin());
  encode_u32(full_redraw_generation,
             std::span(encoded).subspan<attach_header_bytes, render_generation_bytes>());
  return encoded;
}

[[nodiscard]] auto encode_disconnect(const DisconnectReason reason,
                                     const std::string_view diagnostic,
                                     const std::uint32_t sequence) noexcept -> SmallMessage {
  LEMMA_ASSERT(disconnect_reason(static_cast<std::byte>(reason)).has_value());
  LEMMA_ASSERT(diagnostic.size() <= diagnostic_bytes_max);
  SmallMessage message;
  const auto payload_bytes = static_cast<std::uint32_t>(1U + diagnostic.size());
  copy_header(encode_header(MessageKind::disconnect, 0, payload_bytes, sequence), message.storage_,
              message.size_);
  auto output = std::span(message.storage_).subspan(message.size_);
  output.front() = static_cast<std::byte>(reason);
  std::ranges::copy(std::as_bytes(std::span(diagnostic.data(), diagnostic.size())),
                    output.subspan<1>().begin());
  message.size_ += payload_bytes;
  return message;
}

[[nodiscard]] auto decode_error_diagnostic(const DecodeError error) noexcept -> std::string_view {
  switch (error) {
  case DecodeError::invalid_magic:
    return "invalid attach protocol magic";
  case DecodeError::version_mismatch:
    return "attach protocol version mismatch; daemon requires 1.0";
  case DecodeError::invalid_kind:
    return "invalid attach message kind";
  case DecodeError::invalid_flags:
    return "invalid attach message flags";
  case DecodeError::invalid_length:
    return "invalid attach message length";
  case DecodeError::oversized:
    return "attach message exceeds its bounded size";
  case DecodeError::invalid_sequence:
    return "invalid attach message sequence";
  case DecodeError::invalid_enum:
    return "invalid attach message enum";
  case DecodeError::invalid_dimensions:
    return "invalid attach terminal dimensions";
  case DecodeError::invalid_session:
    return "invalid attach session name";
  case DecodeError::invalid_generation:
    return "invalid full-redraw generation";
  case DecodeError::buffer_full:
    return "attach decoder buffer exhausted";
  case DecodeError::allocation_failed:
    return "attach decoder allocation failed";
  }
  return "invalid attach protocol message";
}

// Prefix parsing is a bounded state machine because terminal escape keys may be fragmented across
// reads. Actions retain their position among ordinary input bytes so the client preserves ordering.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto PrefixParser::parse(const std::span<const std::byte> input,
                                       const std::span<std::byte> output) noexcept -> PrefixResult {
  PrefixResult result{};
  const auto append = [&](const std::byte byte) {
    LEMMA_ASSERT(result.bytes < output.size());
    output.subspan(result.bytes, 1).front() = byte;
    ++result.bytes;
  };
  const auto command = [&](const PaneCommand pane_command_value) {
    if (result.action_count >= result.actions.size()) {
      return false;
    }
    std::span(result.actions).subspan(result.action_count, 1).front() = {
        .input_bytes = result.bytes,
        .command = pane_command_value,
    };
    ++result.action_count;
    return true;
  };

  for (const auto byte : input) {
    if (state_ == State::normal) {
      if (byte == std::byte{0x02}) {
        state_ = State::prefix;
      } else {
        append(byte);
      }
      continue;
    }
    if (state_ == State::escape) {
      if (byte == std::byte{'['} || byte == std::byte{'O'}) {
        escape_introducer_ = byte;
        state_ = State::csi;
      } else {
        append(std::byte{0x02});
        append(std::byte{0x1B});
        append(byte);
        state_ = State::normal;
      }
      continue;
    }
    if (state_ == State::csi) {
      std::optional<PaneCommand> pane_command_value;
      switch (byte) {
      case std::byte{'A'}:
        pane_command_value = PaneCommand::focus_up;
        break;
      case std::byte{'B'}:
        pane_command_value = PaneCommand::focus_down;
        break;
      case std::byte{'C'}:
        pane_command_value = PaneCommand::focus_right;
        break;
      case std::byte{'D'}:
        pane_command_value = PaneCommand::focus_left;
        break;
      default:
        break;
      }
      if (!pane_command_value.has_value() || !command(*pane_command_value)) {
        append(std::byte{0x02});
        append(std::byte{0x1B});
        append(escape_introducer_);
        append(byte);
      }
      state_ = State::normal;
      continue;
    }

    LEMMA_ASSERT(state_ == State::prefix);
    state_ = State::normal;
    if (byte == std::byte{'d'}) {
      result.detach = true;
      break;
    }
    if (byte == std::byte{0x02}) {
      append(byte);
      continue;
    }
    if (byte == std::byte{0x1B}) {
      state_ = State::escape;
      continue;
    }

    std::optional<PaneCommand> pane_command_value;
    switch (byte) {
    case std::byte{'%'}:
      pane_command_value = PaneCommand::split_left_right;
      break;
    case std::byte{'"'}:
      pane_command_value = PaneCommand::split_top_bottom;
      break;
    case std::byte{'o'}:
      pane_command_value = PaneCommand::focus_next;
      break;
    case std::byte{';'}:
      pane_command_value = PaneCommand::focus_previous;
      break;
    case std::byte{'x'}:
      pane_command_value = PaneCommand::close;
      break;
    case std::byte{'z'}:
      pane_command_value = PaneCommand::zoom;
      break;
    case std::byte{'c'}:
      pane_command_value = PaneCommand::create_tab;
      break;
    case std::byte{'n'}:
      pane_command_value = PaneCommand::next_tab;
      break;
    case std::byte{'p'}:
      pane_command_value = PaneCommand::previous_tab;
      break;
    case std::byte{'&'}:
      pane_command_value = PaneCommand::kill_tab;
      break;
    case std::byte{'0'}:
    case std::byte{'1'}:
    case std::byte{'2'}:
    case std::byte{'3'}:
    case std::byte{'4'}:
    case std::byte{'5'}:
    case std::byte{'6'}:
    case std::byte{'7'}:
    case std::byte{'8'}:
    case std::byte{'9'}:
      pane_command_value = static_cast<PaneCommand>(std::to_integer<std::uint8_t>(byte));
      break;
    default:
      break;
    }
    if (!pane_command_value.has_value() || !command(*pane_command_value)) {
      append(std::byte{0x02});
      append(byte);
    }
  }
  return result;
}

[[nodiscard]] auto PrefixParser::has_pending_input() const noexcept -> bool {
  return state_ != State::normal;
}

[[nodiscard]] auto PrefixParser::has_pending_escape_sequence() const noexcept -> bool {
  return state_ == State::escape || state_ == State::csi;
}

[[nodiscard]] auto PrefixParser::flush_pending(const std::span<std::byte> output) noexcept
    -> std::size_t {
  std::size_t bytes = 0;
  const auto append = [&](const std::byte byte) {
    LEMMA_ASSERT(bytes < output.size());
    output.subspan(bytes, 1).front() = byte;
    ++bytes;
  };

  switch (state_) {
  case State::normal:
    break;
  case State::prefix:
    append(std::byte{0x02});
    break;
  case State::escape:
    append(std::byte{0x02});
    append(std::byte{0x1B});
    break;
  case State::csi:
    append(std::byte{0x02});
    append(std::byte{0x1B});
    append(escape_introducer_);
    break;
  }
  state_ = State::normal;
  return bytes;
}

[[nodiscard]] auto ClientDecoder::writable_bytes() noexcept -> std::span<std::byte> {
  LEMMA_ASSERT(pending_size_ == 0);
  return std::span(storage_).subspan(used_);
}

[[nodiscard]] auto ClientDecoder::commit(const std::size_t bytes) noexcept
    -> std::expected<void, DecodeError> {
  if (pending_size_ != 0 || bytes > storage_.size() - used_) {
    return std::unexpected(DecodeError::buffer_full);
  }
  used_ += bytes;
  return {};
}

// Header and payload validation is complete before a borrowed message is exposed to the core.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto ClientDecoder::next() noexcept
    -> std::expected<std::optional<ClientMessage>, DecodeError> {
  if (used_ == 0) {
    return std::optional<ClientMessage>{};
  }
  const auto buffered = std::span<const std::byte>(storage_).first(used_);
  const auto decoded = decode_envelope(buffered, expected_sequence_);
  if (!decoded.has_value()) {
    return std::unexpected(decoded.error());
  }
  if (!decoded->has_value()) {
    return std::optional<ClientMessage>{};
  }
  const auto envelope = **decoded;
  if (envelope.flags != 0) {
    return std::unexpected(DecodeError::invalid_flags);
  }

  if (expect_hello_) {
    if (envelope.kind != MessageKind::hello) {
      return std::unexpected(DecodeError::invalid_kind);
    }
    if (envelope.payload_bytes < 6U || envelope.payload_bytes > 5U + session_name_bytes_max) {
      return std::unexpected(envelope.payload_bytes > 5U + session_name_bytes_max
                                 ? DecodeError::oversized
                                 : DecodeError::invalid_length);
    }
  } else {
    switch (envelope.kind) {
    case MessageKind::input:
      if (envelope.payload_bytes == 0) {
        return std::unexpected(DecodeError::invalid_length);
      }
      if (envelope.payload_bytes > input_message_bytes_max) {
        return std::unexpected(DecodeError::oversized);
      }
      break;
    case MessageKind::resize:
      if (envelope.payload_bytes != 4) {
        return std::unexpected(DecodeError::invalid_length);
      }
      break;
    case MessageKind::pane_command:
      if (envelope.payload_bytes != 1) {
        return std::unexpected(DecodeError::invalid_length);
      }
      break;
    case MessageKind::detach:
      if (envelope.payload_bytes != 0) {
        return std::unexpected(DecodeError::invalid_length);
      }
      break;
    case MessageKind::hello:
    case MessageKind::render_frame:
    case MessageKind::disconnect:
      return std::unexpected(DecodeError::invalid_kind);
    }
  }

  const auto packet_size = attach_header_bytes + envelope.payload_bytes;
  if (packet_size > storage_.size()) {
    return std::unexpected(DecodeError::oversized);
  }
  if (buffered.size() < packet_size) {
    return std::optional<ClientMessage>{};
  }
  const auto payload = buffered.subspan(attach_header_bytes, envelope.payload_bytes);
  pending_size_ = packet_size;

  if (envelope.kind == MessageKind::hello) {
    const auto name_size = std::to_integer<std::size_t>(payload.front());
    if (name_size == 0 || name_size > session_name_bytes_max || payload.size() != 5U + name_size) {
      return std::unexpected(DecodeError::invalid_length);
    }
    const auto dimensions = decode_dimensions(std::span(payload).subspan<1, 4>());
    if (!valid_dimensions(dimensions)) {
      return std::unexpected(DecodeError::invalid_dimensions);
    }
    // Wire bytes are borrowed as a character view only for synchronous validation/dispatch.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    const std::string_view session(reinterpret_cast<const char*>(payload.subspan(5).data()),
                                   name_size);
    if (!valid_session_name(session)) {
      return std::unexpected(DecodeError::invalid_session);
    }
    return ClientMessage{
        .kind = ClientMessageKind::hello,
        .dimensions = dimensions,
        .pane_command = PaneCommand::none,
        .session = session,
        .input = {},
        .sequence = envelope.sequence,
    };
  }
  if (envelope.kind == MessageKind::input) {
    return ClientMessage{
        .kind = ClientMessageKind::input,
        .dimensions = {},
        .pane_command = PaneCommand::none,
        .session = {},
        .input = payload,
        .sequence = envelope.sequence,
    };
  }
  if (envelope.kind == MessageKind::resize) {
    const auto dimensions = decode_dimensions(std::span(payload).first<4>());
    if (!valid_dimensions(dimensions)) {
      return std::unexpected(DecodeError::invalid_dimensions);
    }
    return ClientMessage{
        .kind = ClientMessageKind::resize,
        .dimensions = dimensions,
        .pane_command = PaneCommand::none,
        .session = {},
        .input = {},
        .sequence = envelope.sequence,
    };
  }
  if (envelope.kind == MessageKind::pane_command) {
    const auto command = pane_command(payload.front());
    if (!command.has_value()) {
      return std::unexpected(DecodeError::invalid_enum);
    }
    return ClientMessage{
        .kind = ClientMessageKind::pane_command,
        .dimensions = {},
        .pane_command = *command,
        .session = {},
        .input = {},
        .sequence = envelope.sequence,
    };
  }
  LEMMA_ASSERT(envelope.kind == MessageKind::detach);
  return ClientMessage{
      .kind = ClientMessageKind::detach,
      .dimensions = {},
      .pane_command = PaneCommand::none,
      .session = {},
      .input = {},
      .sequence = envelope.sequence,
  };
}

void ClientDecoder::consume() noexcept {
  LEMMA_ASSERT(pending_size_ > 0 && pending_size_ <= used_);
  std::memmove(storage_.data(), std::span(storage_).subspan(pending_size_).data(),
               used_ - pending_size_);
  used_ -= pending_size_;
  pending_size_ = 0;
  expected_sequence_ = next_sequence(expected_sequence_);
  if (expect_hello_) {
    expect_hello_ = false;
  }
}

void ClientDecoder::reset(const std::uint32_t expected_sequence, const bool expect_hello) noexcept {
  LEMMA_ASSERT(expected_sequence != 0);
  used_ = 0;
  pending_size_ = 0;
  expected_sequence_ = expected_sequence;
  expect_hello_ = expect_hello;
}

[[nodiscard]] auto ServerDecoder::prepare() noexcept -> std::expected<void, DecodeError> {
  if (storage_ != nullptr) {
    return {};
  }
  try {
    // One connection-lifetime owner; pages remain lazy until received frame bytes touch them.
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
    storage_ = std::make_unique_for_overwrite<std::byte[]>(server_decoder_bytes_max);
  } catch (const std::bad_alloc&) {
    return std::unexpected(DecodeError::allocation_failed);
  }
  return {};
}

[[nodiscard]] auto ServerDecoder::writable_bytes() noexcept -> std::span<std::byte> {
  LEMMA_ASSERT(pending_size_ == 0);
  return storage_ == nullptr
             ? std::span<std::byte>{}
             : std::span<std::byte>(storage_.get(), server_decoder_bytes_max).subspan(used_);
}

[[nodiscard]] auto ServerDecoder::commit(const std::size_t bytes) noexcept
    -> std::expected<void, DecodeError> {
  if (storage_ == nullptr || pending_size_ != 0 || bytes > server_decoder_bytes_max - used_) {
    return std::unexpected(DecodeError::buffer_full);
  }
  used_ += bytes;
  return {};
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto ServerDecoder::next() noexcept
    -> std::expected<std::optional<ServerMessage>, DecodeError> {
  if (used_ == 0) {
    return std::optional<ServerMessage>{};
  }
  LEMMA_ASSERT(storage_ != nullptr);
  const auto buffered = std::span<const std::byte>(storage_.get(), used_);
  const auto decoded = decode_envelope(buffered, expected_sequence_);
  if (!decoded.has_value()) {
    return std::unexpected(decoded.error());
  }
  if (!decoded->has_value()) {
    return std::optional<ServerMessage>{};
  }
  const auto envelope = **decoded;

  if (expect_hello_) {
    if (envelope.kind != MessageKind::hello && envelope.kind != MessageKind::disconnect) {
      return std::unexpected(DecodeError::invalid_kind);
    }
  } else if (envelope.kind != MessageKind::render_frame &&
             envelope.kind != MessageKind::disconnect) {
    return std::unexpected(DecodeError::invalid_kind);
  }
  if (envelope.kind == MessageKind::render_frame) {
    if ((envelope.flags & ~render_full_redraw_flag) != 0) {
      return std::unexpected(DecodeError::invalid_flags);
    }
    if (envelope.payload_bytes <= render_generation_bytes) {
      return std::unexpected(DecodeError::invalid_length);
    }
    if (envelope.payload_bytes > render_payload_bytes_max) {
      return std::unexpected(DecodeError::oversized);
    }
  } else {
    if (envelope.flags != 0) {
      return std::unexpected(DecodeError::invalid_flags);
    }
    if (envelope.kind == MessageKind::hello && envelope.payload_bytes != 4) {
      return std::unexpected(DecodeError::invalid_length);
    }
    if (envelope.kind == MessageKind::disconnect &&
        (envelope.payload_bytes == 0 || envelope.payload_bytes > 1U + diagnostic_bytes_max)) {
      return std::unexpected(envelope.payload_bytes > 1U + diagnostic_bytes_max
                                 ? DecodeError::oversized
                                 : DecodeError::invalid_length);
    }
  }

  const auto packet_size = attach_header_bytes + envelope.payload_bytes;
  if (packet_size > server_decoder_bytes_max) {
    return std::unexpected(DecodeError::oversized);
  }
  if (buffered.size() < packet_size) {
    return std::optional<ServerMessage>{};
  }
  const auto payload = buffered.subspan(attach_header_bytes, envelope.payload_bytes);
  pending_size_ = packet_size;
  pending_generation_ = 0;
  pending_full_redraw_ = false;

  if (envelope.kind == MessageKind::hello) {
    const auto dimensions = decode_dimensions(std::span(payload).first<4>());
    if (!valid_dimensions(dimensions)) {
      return std::unexpected(DecodeError::invalid_dimensions);
    }
    return ServerMessage{
        .kind = ServerMessageKind::hello,
        .dimensions = dimensions,
        .reason = DisconnectReason::internal_error,
        .diagnostic = {},
        .ansi = {},
        .sequence = envelope.sequence,
        .full_redraw_generation = 0,
        .full_redraw = false,
    };
  }
  if (envelope.kind == MessageKind::disconnect) {
    const auto reason = disconnect_reason(payload.front());
    if (!reason.has_value()) {
      return std::unexpected(DecodeError::invalid_enum);
    }
    const auto diagnostic_bytes = payload.subspan(1);
    if (!valid_diagnostic(diagnostic_bytes)) {
      return std::unexpected(DecodeError::invalid_enum);
    }
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    const std::string_view diagnostic(reinterpret_cast<const char*>(diagnostic_bytes.data()),
                                      diagnostic_bytes.size());
    return ServerMessage{
        .kind = ServerMessageKind::disconnect,
        .dimensions = {},
        .reason = *reason,
        .diagnostic = diagnostic,
        .ansi = {},
        .sequence = envelope.sequence,
        .full_redraw_generation = 0,
        .full_redraw = false,
    };
  }

  const auto generation = decode_u32(std::span(payload).first<render_generation_bytes>());
  const bool full_redraw = (envelope.flags & render_full_redraw_flag) != 0;
  if (generation == 0 || (full_redraw && generation != next_sequence(full_redraw_generation_)) ||
      (!full_redraw && (full_redraw_generation_ == 0 || generation != full_redraw_generation_))) {
    return std::unexpected(DecodeError::invalid_generation);
  }
  pending_generation_ = generation;
  pending_full_redraw_ = full_redraw;
  return ServerMessage{
      .kind = ServerMessageKind::render_frame,
      .dimensions = {},
      .reason = DisconnectReason::internal_error,
      .diagnostic = {},
      .ansi = payload.subspan(render_generation_bytes),
      .sequence = envelope.sequence,
      .full_redraw_generation = generation,
      .full_redraw = full_redraw,
  };
}

void ServerDecoder::consume() noexcept {
  LEMMA_ASSERT(storage_ != nullptr);
  LEMMA_ASSERT(pending_size_ > 0 && pending_size_ <= used_);
  std::memmove(storage_.get(), std::span(storage_.get(), used_).subspan(pending_size_).data(),
               used_ - pending_size_);
  used_ -= pending_size_;
  pending_size_ = 0;
  expected_sequence_ = next_sequence(expected_sequence_);
  if (expect_hello_) {
    expect_hello_ = false;
  }
  if (pending_full_redraw_) {
    full_redraw_generation_ = pending_generation_;
  }
  pending_generation_ = 0;
  pending_full_redraw_ = false;
}

void ServerDecoder::reset(const std::uint32_t expected_sequence, const bool expect_hello) noexcept {
  LEMMA_ASSERT(expected_sequence != 0);
  used_ = 0;
  pending_size_ = 0;
  expected_sequence_ = expected_sequence;
  full_redraw_generation_ = 0;
  pending_generation_ = 0;
  pending_full_redraw_ = false;
  expect_hello_ = expect_hello;
}

} // namespace lemma::protocol

// NOLINTEND(cppcoreguidelines-pro-bounds-avoid-unchecked-container-access)
