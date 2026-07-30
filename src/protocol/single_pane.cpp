#include "protocol/single_pane.hpp"

#include "fiber/assert.hpp"

#include <cstring>

namespace fiber::protocol {
namespace {

constexpr std::byte packet_input{'I'};
constexpr std::byte packet_resize{'R'};
constexpr std::byte packet_detach{'D'};
constexpr std::byte packet_pane_command{'P'};

void encode_u16(const std::uint16_t value, const std::span<std::byte, 2> output) noexcept {
  output.front() = static_cast<std::byte>(value >> 8U);
  output.back() = static_cast<std::byte>(value & 0xFFU);
}

[[nodiscard]] constexpr auto decode_u16(const std::byte high, const std::byte low) noexcept
    -> std::uint16_t {
  const auto high_value = std::to_integer<std::uint16_t>(high);
  const auto low_value = std::to_integer<std::uint16_t>(low);
  return static_cast<std::uint16_t>((high_value << 8U) | low_value);
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
  case PaneCommand::create_window:
  case PaneCommand::next_window:
  case PaneCommand::previous_window:
  case PaneCommand::kill_window:
  case PaneCommand::select_window_0:
  case PaneCommand::select_window_1:
  case PaneCommand::select_window_2:
  case PaneCommand::select_window_3:
  case PaneCommand::select_window_4:
  case PaneCommand::select_window_5:
  case PaneCommand::select_window_6:
  case PaneCommand::select_window_7:
  case PaneCommand::select_window_8:
  case PaneCommand::select_window_9:
    return command;
  }
  return std::nullopt;
}

[[nodiscard]] auto encode_dimensions_packet(const std::byte type,
                                            const Dimensions dimensions) noexcept
    -> std::array<std::byte, 5> {
  std::array<std::byte, 5> packet{type};
  encode_u16(dimensions.columns, std::span(packet).subspan<1, 2>());
  encode_u16(dimensions.rows, std::span(packet).subspan<3, 2>());
  return packet;
}

} // namespace

[[nodiscard]] auto encode_workspace_header(const ControlCommand command,
                                           const std::string_view workspace) noexcept
    -> std::array<std::byte, 2> {
  FIBER_ASSERT(!workspace.empty());
  FIBER_ASSERT(workspace.size() <= workspace_name_bytes_max);
  return {wire_byte(command), static_cast<std::byte>(workspace.size())};
}

[[nodiscard]] auto encode_dimensions(const Dimensions dimensions) noexcept
    -> std::array<std::byte, 4> {
  std::array<std::byte, 4> packet{};
  encode_u16(dimensions.columns, std::span(packet).subspan<0, 2>());
  encode_u16(dimensions.rows, std::span(packet).subspan<2, 2>());
  return packet;
}

[[nodiscard]] auto encode_resize(const Dimensions dimensions) noexcept -> std::array<std::byte, 5> {
  return encode_dimensions_packet(packet_resize, dimensions);
}

[[nodiscard]] auto encode_input_header(const std::size_t bytes) noexcept
    -> std::array<std::byte, 3> {
  FIBER_ASSERT(bytes <= input_bytes_max * 2U);
  std::array<std::byte, 3> header{packet_input};
  encode_u16(static_cast<std::uint16_t>(bytes), std::span(header).subspan<1, 2>());
  return header;
}

[[nodiscard]] auto encode_detach() noexcept -> std::array<std::byte, 1> { return {packet_detach}; }

[[nodiscard]] auto encode_pane_command(const PaneCommand command) noexcept
    -> std::array<std::byte, 2> {
  FIBER_ASSERT(command != PaneCommand::none);
  return {packet_pane_command, static_cast<std::byte>(command)};
}

[[nodiscard]] auto decode_dimensions(const std::span<const std::byte, 4> bytes) noexcept
    -> Dimensions {
  return {
      .columns = decode_u16(bytes.front(), bytes.subspan<1>().front()),
      .rows = decode_u16(bytes.subspan<2>().front(), bytes.subspan<3>().front()),
  };
}

// Prefix parsing is a bounded state machine because terminal escape keys may be fragmented across
// reads. Actions retain their position among ordinary input bytes so the client preserves ordering.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto PrefixParser::parse(const std::span<const std::byte> input,
                                       const std::span<std::byte> output) noexcept -> PrefixResult {
  PrefixResult result{};
  const auto append = [&](const std::byte byte) {
    FIBER_ASSERT(result.bytes < output.size());
    output.subspan(result.bytes, 1).front() = byte;
    ++result.bytes;
  };
  const auto command = [&](const PaneCommand pane_command) {
    if (result.action_count >= result.actions.size()) {
      return false;
    }
    std::span(result.actions).subspan(result.action_count, 1).front() = {
        .input_bytes = result.bytes,
        .command = pane_command,
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
      std::optional<PaneCommand> pane_command;
      switch (byte) {
      case std::byte{'A'}:
        pane_command = PaneCommand::focus_up;
        break;
      case std::byte{'B'}:
        pane_command = PaneCommand::focus_down;
        break;
      case std::byte{'C'}:
        pane_command = PaneCommand::focus_right;
        break;
      case std::byte{'D'}:
        pane_command = PaneCommand::focus_left;
        break;
      default:
        break;
      }
      if (!pane_command.has_value() || !command(*pane_command)) {
        append(std::byte{0x02});
        append(std::byte{0x1B});
        append(escape_introducer_);
        append(byte);
      }
      state_ = State::normal;
      continue;
    }

    FIBER_ASSERT(state_ == State::prefix);
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

    std::optional<PaneCommand> pane_command;
    switch (byte) {
    case std::byte{'%'}:
      pane_command = PaneCommand::split_left_right;
      break;
    case std::byte{'"'}:
      pane_command = PaneCommand::split_top_bottom;
      break;
    case std::byte{'o'}:
      pane_command = PaneCommand::focus_next;
      break;
    case std::byte{';'}:
      pane_command = PaneCommand::focus_previous;
      break;
    case std::byte{'x'}:
      pane_command = PaneCommand::close;
      break;
    case std::byte{'z'}:
      pane_command = PaneCommand::zoom;
      break;
    case std::byte{'c'}:
      pane_command = PaneCommand::create_window;
      break;
    case std::byte{'n'}:
      pane_command = PaneCommand::next_window;
      break;
    case std::byte{'p'}:
      pane_command = PaneCommand::previous_window;
      break;
    case std::byte{'&'}:
      pane_command = PaneCommand::kill_window;
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
      pane_command = static_cast<PaneCommand>(std::to_integer<std::uint8_t>(byte));
      break;
    default:
      break;
    }
    if (!pane_command.has_value() || !command(*pane_command)) {
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
    FIBER_ASSERT(bytes < output.size());
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
  FIBER_ASSERT(pending_size_ == 0);
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

// Repeated-message backpressure and all packet variants are intentionally explicit.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto ClientDecoder::next() noexcept
    -> std::expected<std::optional<ClientMessage>, DecodeError> {
  // A caller applying downstream backpressure may inspect the same complete message again without
  // consuming it. Decoder storage and packet boundaries remain unchanged between attempts.
  if (pending_size_ != 0) {
    pending_size_ = 0;
  }
  if (used_ == 0) {
    return std::optional<ClientMessage>{};
  }

  const auto buffered = std::span(storage_).first(used_);
  const auto type = buffered.front();
  if (type == packet_detach) {
    pending_size_ = 1;
    return ClientMessage{
        .kind = ClientMessageKind::detach,
        .input = {},
    };
  }
  if (type == packet_resize) {
    if (used_ < 5) {
      return std::optional<ClientMessage>{};
    }
    pending_size_ = 5;
    return ClientMessage{
        .kind = ClientMessageKind::resize,
        .dimensions = decode_dimensions(std::span(buffered).subspan<1, 4>()),
        .input = {},
    };
  }
  if (type == packet_pane_command) {
    if (used_ < 2) {
      return std::optional<ClientMessage>{};
    }
    const auto decoded_command = pane_command(buffered.subspan<1>().front());
    if (!decoded_command.has_value()) {
      return std::unexpected(DecodeError::invalid_type);
    }
    pending_size_ = 2;
    return ClientMessage{
        .kind = ClientMessageKind::pane_command,
        .pane_command = *decoded_command,
        .input = {},
    };
  }
  if (type != packet_input) {
    return std::unexpected(DecodeError::invalid_type);
  }
  if (used_ < 3) {
    return std::optional<ClientMessage>{};
  }

  const auto length = decode_u16(buffered.subspan<1>().front(), buffered.subspan<2>().front());
  if (length > input_bytes_max * 2U) {
    return std::unexpected(DecodeError::input_too_large);
  }
  const auto packet_size = std::size_t{3} + length;
  if (used_ < packet_size) {
    return std::optional<ClientMessage>{};
  }

  pending_size_ = packet_size;
  return ClientMessage{
      .kind = ClientMessageKind::input,
      .input = buffered.subspan(3, length),
  };
}

void ClientDecoder::consume() noexcept {
  FIBER_ASSERT(pending_size_ > 0);
  FIBER_ASSERT(pending_size_ <= used_);
  std::memmove(storage_.data(), std::span(storage_).subspan(pending_size_).data(),
               used_ - pending_size_);
  used_ -= pending_size_;
  pending_size_ = 0;
}

void ClientDecoder::reset() noexcept {
  used_ = 0;
  pending_size_ = 0;
}

} // namespace fiber::protocol
