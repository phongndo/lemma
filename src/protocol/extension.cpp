#include "protocol/extension.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <limits>
#include <optional>
#include <span>
#include <string_view>

namespace lemma::protocol::extension {
namespace {

class Writer final {
public:
  explicit Writer(const std::span<std::byte> output) noexcept : output_(output) {}

  [[nodiscard]] auto append_u8(const std::uint8_t value) noexcept -> bool {
    if (used_ < output_.size()) {
      output_.subspan(used_, 1).front() = static_cast<std::byte>(value);
    } else {
      output_too_small_ = true;
    }
    ++used_;
    return true;
  }

  [[nodiscard]] auto append_u16(const std::uint16_t value) noexcept -> bool {
    return append_u8(static_cast<std::uint8_t>(value >> 8U)) &&
           append_u8(static_cast<std::uint8_t>(value & 0xFFU));
  }

  [[nodiscard]] auto append_bytes(const std::span<const std::byte> bytes) noexcept -> bool {
    if (used_ <= output_.size() && bytes.size() <= output_.size() - used_) {
      std::ranges::copy(bytes, output_.subspan(used_, bytes.size()).begin());
    } else {
      output_too_small_ = true;
    }
    used_ += bytes.size();
    return true;
  }

  [[nodiscard]] auto append_string8(const std::string_view value,
                                    const std::size_t maximum) noexcept -> bool {
    return value.size() <= maximum && value.size() <= std::numeric_limits<std::uint8_t>::max() &&
           append_u8(static_cast<std::uint8_t>(value.size())) &&
           append_bytes(std::as_bytes(std::span(value.data(), value.size())));
  }

  [[nodiscard]] auto append_string16(const std::string_view value,
                                     const std::size_t maximum) noexcept -> bool {
    return value.size() <= maximum && value.size() <= std::numeric_limits<std::uint16_t>::max() &&
           append_u16(static_cast<std::uint16_t>(value.size())) &&
           append_bytes(std::as_bytes(std::span(value.data(), value.size())));
  }

  [[nodiscard]] auto size() const noexcept -> std::size_t { return used_; }
  [[nodiscard]] auto output_too_small() const noexcept -> bool { return output_too_small_; }

private:
  std::span<std::byte> output_;
  std::size_t used_{0};
  bool output_too_small_{false};
};

class Reader final {
public:
  explicit Reader(const std::span<const std::byte> input) noexcept : input_(input) {}

  [[nodiscard]] auto read_u8() noexcept -> std::optional<std::uint8_t> {
    if (offset_ == input_.size()) {
      return std::nullopt;
    }
    const auto value = std::to_integer<std::uint8_t>(input_.subspan(offset_, 1).front());
    ++offset_;
    return value;
  }

  [[nodiscard]] auto read_u16() noexcept -> std::optional<std::uint16_t> {
    const auto high = read_u8();
    const auto low = read_u8();
    if (!high.has_value() || !low.has_value()) {
      return std::nullopt;
    }
    return static_cast<std::uint16_t>((static_cast<std::uint16_t>(*high) << 8U) | *low);
  }

  [[nodiscard]] auto read_string8(const std::size_t maximum) noexcept
      -> std::optional<std::string_view> {
    const auto size = read_u8();
    return size.has_value() ? read_string(*size, maximum) : std::nullopt;
  }

  [[nodiscard]] auto read_string16(const std::size_t maximum) noexcept
      -> std::optional<std::string_view> {
    const auto size = read_u16();
    return size.has_value() ? read_string(*size, maximum) : std::nullopt;
  }

  [[nodiscard]] auto empty() const noexcept -> bool { return offset_ == input_.size(); }

private:
  [[nodiscard]] auto read_string(const std::size_t size, const std::size_t maximum) noexcept
      -> std::optional<std::string_view> {
    if (size > maximum || size > input_.size() - offset_) {
      return std::nullopt;
    }
    const auto bytes = input_.subspan(offset_, size);
    offset_ += size;
    // The explicit protocol length bounds this non-null-terminated text view.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    return std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size());
  }

  std::span<const std::byte> input_;
  std::size_t offset_{0};
};

void write_u16(const std::span<std::byte> output, const std::size_t offset,
               const std::uint16_t value) noexcept {
  auto target = output.subspan(offset, 2);
  target.front() = static_cast<std::byte>(value >> 8U);
  target.back() = static_cast<std::byte>(value & 0xFFU);
}

void write_u32(const std::span<std::byte> output, const std::size_t offset,
               const std::uint32_t value) noexcept {
  auto target = output.subspan(offset, 4);
  target.front() = static_cast<std::byte>(value >> 24U);
  target.subspan(1, 1).front() = static_cast<std::byte>((value >> 16U) & 0xFFU);
  target.subspan(2, 1).front() = static_cast<std::byte>((value >> 8U) & 0xFFU);
  target.back() = static_cast<std::byte>(value & 0xFFU);
}

void write_u64(const std::span<std::byte> output, const std::size_t offset,
               const std::uint64_t value) noexcept {
  for (std::size_t index = 0; index < 8; ++index) {
    const auto shift = static_cast<unsigned>((7U - index) * 8U);
    output.subspan(offset + index, 1).front() = static_cast<std::byte>((value >> shift) & 0xFFU);
  }
}

[[nodiscard]] auto read_u16(const std::span<const std::byte> input,
                            const std::size_t offset) noexcept -> std::uint16_t {
  const auto source = input.subspan(offset, 2);
  return static_cast<std::uint16_t>(
      (static_cast<std::uint16_t>(std::to_integer<std::uint8_t>(source.front())) << 8U) |
      std::to_integer<std::uint8_t>(source.back()));
}

[[nodiscard]] auto read_u32(const std::span<const std::byte> input,
                            const std::size_t offset) noexcept -> std::uint32_t {
  std::uint32_t value = 0;
  for (std::size_t index = 0; index < 4; ++index) {
    value = static_cast<std::uint32_t>(
        (value << 8U) | std::to_integer<std::uint8_t>(input.subspan(offset + index, 1).front()));
  }
  return value;
}

[[nodiscard]] auto read_u64(const std::span<const std::byte> input,
                            const std::size_t offset) noexcept -> std::uint64_t {
  std::uint64_t value = 0;
  for (std::size_t index = 0; index < 8; ++index) {
    value = (value << 8U) | std::to_integer<std::uint8_t>(input.subspan(offset + index, 1).front());
  }
  return value;
}

[[nodiscard]] constexpr auto valid_kind(const MessageKind kind) noexcept -> bool {
  switch (kind) {
  case MessageKind::begin_generation:
  case MessageKind::register_command:
  case MessageKind::register_keymap:
  case MessageKind::subscribe_event:
  case MessageKind::set_sidebar:
  case MessageKind::commit_generation:
  case MessageKind::config_error:
    return true;
  }
  return false;
}

[[nodiscard]] auto encode_frame(const MessageKind kind, const std::uint64_t request_id,
                                const std::size_t payload_size,
                                const std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, EncodeError> {
  if (!valid_kind(kind) || payload_size > payload_bytes_max) {
    return std::unexpected(EncodeError::invalid_value);
  }
  const auto frame_size = frame_header_bytes + payload_size;
  if (output.size() < frame_size) {
    return std::unexpected(EncodeError::output_too_small);
  }
  std::ranges::copy(magic, output.begin());
  write_u16(output, 4, version);
  output.subspan(6, 1).front() = static_cast<std::byte>(kind);
  output.subspan(7, 1).front() = std::byte{0};
  write_u32(output, 8, static_cast<std::uint32_t>(payload_size));
  write_u64(output, 12, request_id);
  return frame_size;
}

template <typename WritePayload>
[[nodiscard]] auto encode_with_payload(const MessageKind kind, const std::uint64_t request_id,
                                       const std::span<std::byte> output,
                                       const WritePayload& write_payload) noexcept
    -> std::expected<std::size_t, EncodeError> {
  if (output.size() < frame_header_bytes) {
    return std::unexpected(EncodeError::output_too_small);
  }
  Writer writer(output.subspan(frame_header_bytes));
  if (!write_payload(writer)) {
    return std::unexpected(EncodeError::invalid_value);
  }
  if (writer.output_too_small()) {
    return std::unexpected(EncodeError::output_too_small);
  }
  return encode_frame(kind, request_id, writer.size(), output);
}

} // namespace

auto encode_empty(const MessageKind kind, const std::uint64_t request_id,
                  const std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, EncodeError> {
  return encode_frame(kind, request_id, 0, output);
}

auto encode_command(const CommandRegistration& registration, const std::uint64_t request_id,
                    const std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, EncodeError> {
  return encode_with_payload(
      MessageKind::register_command, request_id, output, [&](Writer& writer) {
        return !registration.name.empty() &&
               writer.append_string8(registration.name, command_name_bytes_max) &&
               writer.append_string16(registration.description, command_description_bytes_max);
      });
}

auto encode_keymap(const KeymapRegistration& registration, const std::uint64_t request_id,
                   const std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, EncodeError> {
  return encode_with_payload(MessageKind::register_keymap, request_id, output, [&](Writer& writer) {
    return !registration.mode.empty() && !registration.key.empty() &&
           !registration.command.empty() &&
           writer.append_string8(registration.mode, key_mode_bytes_max) &&
           writer.append_string8(registration.key, key_bytes_max) &&
           writer.append_string8(registration.command, command_name_bytes_max);
  });
}

auto encode_subscription(const EventSubscription& subscription, const std::uint64_t request_id,
                         const std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, EncodeError> {
  return encode_with_payload(MessageKind::subscribe_event, request_id, output, [&](Writer& writer) {
    return !subscription.event.empty() &&
           writer.append_string8(subscription.event, event_name_bytes_max);
  });
}

auto encode_sidebar(const SidebarRegistration& registration, const std::uint64_t request_id,
                    const std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, EncodeError> {
  return encode_with_payload(MessageKind::set_sidebar, request_id, output, [&](Writer& writer) {
    if (registration.id.empty() || registration.width == 0 ||
        (registration.side != SidebarSide::left && registration.side != SidebarSide::right) ||
        registration.line_count > sidebar_lines_max ||
        !writer.append_string8(registration.id, sidebar_id_bytes_max) ||
        !writer.append_u8(static_cast<std::uint8_t>(registration.side)) ||
        !writer.append_u16(registration.width) ||
        !writer.append_u16(static_cast<std::uint16_t>(registration.line_count))) {
      return false;
    }
    for (const auto line : std::span(registration.lines).first(registration.line_count)) {
      if (!writer.append_string16(line, sidebar_line_bytes_max)) {
        return false;
      }
    }
    return true;
  });
}

auto encode_config_error(const std::string_view error, const std::uint64_t request_id,
                         const std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, EncodeError> {
  return encode_with_payload(MessageKind::config_error, request_id, output, [&](Writer& writer) {
    return !error.empty() && writer.append_string16(error, error_bytes_max);
  });
}

auto decode_command(const Message& message) noexcept
    -> std::expected<CommandRegistration, DecodeError> {
  if (message.kind != MessageKind::register_command) {
    return std::unexpected(DecodeError::invalid_payload);
  }
  Reader reader(message.payload);
  const auto name = reader.read_string8(command_name_bytes_max);
  const auto description = reader.read_string16(command_description_bytes_max);
  if (!name.has_value() || name->empty() || !description.has_value() || !reader.empty()) {
    return std::unexpected(DecodeError::invalid_payload);
  }
  return CommandRegistration{.name = *name, .description = *description};
}

auto decode_keymap(const Message& message) noexcept
    -> std::expected<KeymapRegistration, DecodeError> {
  if (message.kind != MessageKind::register_keymap) {
    return std::unexpected(DecodeError::invalid_payload);
  }
  Reader reader(message.payload);
  const auto mode = reader.read_string8(key_mode_bytes_max);
  const auto key = reader.read_string8(key_bytes_max);
  const auto command = reader.read_string8(command_name_bytes_max);
  if (!mode.has_value() || mode->empty() || !key.has_value() || key->empty() ||
      !command.has_value() || command->empty() || !reader.empty()) {
    return std::unexpected(DecodeError::invalid_payload);
  }
  return KeymapRegistration{.mode = *mode, .key = *key, .command = *command};
}

auto decode_subscription(const Message& message) noexcept
    -> std::expected<EventSubscription, DecodeError> {
  if (message.kind != MessageKind::subscribe_event) {
    return std::unexpected(DecodeError::invalid_payload);
  }
  Reader reader(message.payload);
  const auto event = reader.read_string8(event_name_bytes_max);
  if (!event.has_value() || event->empty() || !reader.empty()) {
    return std::unexpected(DecodeError::invalid_payload);
  }
  return EventSubscription{.event = *event};
}

auto decode_sidebar(const Message& message) noexcept
    -> std::expected<SidebarRegistration, DecodeError> {
  if (message.kind != MessageKind::set_sidebar) {
    return std::unexpected(DecodeError::invalid_payload);
  }
  Reader reader(message.payload);
  SidebarRegistration result;
  const auto id = reader.read_string8(sidebar_id_bytes_max);
  const auto side = reader.read_u8();
  const auto width = reader.read_u16();
  const auto line_count = reader.read_u16();
  if (!id.has_value() || id->empty() || !side.has_value() || !width.has_value() || *width == 0 ||
      !line_count.has_value() || *line_count > sidebar_lines_max ||
      (*side != static_cast<std::uint8_t>(SidebarSide::left) &&
       *side != static_cast<std::uint8_t>(SidebarSide::right))) {
    return std::unexpected(DecodeError::invalid_payload);
  }
  result.id = *id;
  result.side = static_cast<SidebarSide>(*side);
  result.width = *width;
  result.line_count = *line_count;
  for (std::size_t index = 0; index < result.line_count; ++index) {
    const auto line = reader.read_string16(sidebar_line_bytes_max);
    if (!line.has_value()) {
      return std::unexpected(DecodeError::invalid_payload);
    }
    std::span(result.lines).subspan(index, 1).front() = *line;
  }
  if (!reader.empty()) {
    return std::unexpected(DecodeError::invalid_payload);
  }
  return result;
}

auto decode_config_error(const Message& message) noexcept
    -> std::expected<std::string_view, DecodeError> {
  if (message.kind != MessageKind::config_error) {
    return std::unexpected(DecodeError::invalid_payload);
  }
  Reader reader(message.payload);
  const auto error = reader.read_string16(error_bytes_max);
  if (!error.has_value() || error->empty() || !reader.empty()) {
    return std::unexpected(DecodeError::invalid_payload);
  }
  return *error;
}

auto Decoder::writable_bytes() noexcept -> std::span<std::byte> {
  return std::span(storage_).subspan(used_);
}

auto Decoder::commit(const std::size_t bytes) noexcept -> std::expected<void, DecodeError> {
  if (bytes > storage_.size() - used_) {
    return std::unexpected(DecodeError::buffer_full);
  }
  used_ += bytes;
  return {};
}

auto Decoder::next() noexcept -> std::expected<std::optional<Message>, DecodeError> {
  if (pending_size_ != 0) {
    return std::unexpected(DecodeError::invalid_payload);
  }
  if (used_ < frame_header_bytes) {
    return std::optional<Message>{};
  }
  const auto input = std::span(storage_).first(used_);
  if (!std::ranges::equal(input.first(magic.size()), magic)) {
    return std::unexpected(DecodeError::invalid_magic);
  }
  if (read_u16(input, 4) != version) {
    return std::unexpected(DecodeError::unsupported_version);
  }
  const auto kind =
      static_cast<MessageKind>(std::to_integer<std::uint8_t>(input.subspan(6, 1).front()));
  if (!valid_kind(kind) || input.subspan(7, 1).front() != std::byte{0}) {
    return std::unexpected(DecodeError::invalid_kind);
  }
  const auto payload_size = static_cast<std::size_t>(read_u32(input, 8));
  if (payload_size > payload_bytes_max) {
    return std::unexpected(DecodeError::payload_too_large);
  }
  const auto frame_size = frame_header_bytes + payload_size;
  if (used_ < frame_size) {
    return std::optional<Message>{};
  }
  pending_size_ = frame_size;
  return std::optional<Message>(Message{
      .kind = kind,
      .request_id = read_u64(input, 12),
      .payload = input.subspan(frame_header_bytes, payload_size),
  });
}

void Decoder::consume() noexcept {
  if (pending_size_ == 0) {
    return;
  }
  const auto remaining = used_ - pending_size_;
  std::memmove(storage_.data(), std::span(storage_).subspan(pending_size_).data(), remaining);
  used_ = remaining;
  pending_size_ = 0;
}

void Decoder::reset() noexcept {
  used_ = 0;
  pending_size_ = 0;
}

} // namespace lemma::protocol::extension
