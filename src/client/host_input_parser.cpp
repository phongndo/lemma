#include "client/host_input_parser.hpp"

#include "lemma/assert.hpp"
#include "lemma/limits.hpp"
#include "protocol/attachment.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <iterator>
#include <limits>
#include <memory>
#include <new>
#include <optional>
#include <span>

namespace lemma::client {
namespace {

constexpr std::array paste_begin{std::byte{0x1B}, std::byte{'['}, std::byte{'2'},
                                 std::byte{'0'},  std::byte{'0'}, std::byte{'~'}};
constexpr std::array paste_end{std::byte{0x1B}, std::byte{'['}, std::byte{'2'},
                               std::byte{'0'},  std::byte{'1'}, std::byte{'~'}};
constexpr std::array focus_gained{std::byte{0x1B}, std::byte{'['}, std::byte{'I'}};
constexpr std::array focus_lost{std::byte{0x1B}, std::byte{'['}, std::byte{'O'}};
constexpr std::array mouse_prefix{std::byte{0x1B}, std::byte{'['}, std::byte{'<'}};

[[nodiscard]] auto prefix_of(const std::span<const std::byte> value,
                             const std::span<const std::byte> complete) noexcept -> bool {
  return value.size() <= complete.size() && std::ranges::equal(value, complete.first(value.size()));
}

[[nodiscard]] auto parse_decimal(const std::span<const std::byte> value) noexcept
    -> std::optional<std::uint32_t> {
  if (value.empty()) {
    return std::nullopt;
  }
  std::uint32_t result = 0;
  for (const auto byte : value) {
    const auto character = std::to_integer<std::uint8_t>(byte);
    if (character < static_cast<std::uint8_t>('0') || character > static_cast<std::uint8_t>('9')) {
      return std::nullopt;
    }
    const auto digit = static_cast<std::uint32_t>(character - static_cast<std::uint8_t>('0'));
    if (result > (std::numeric_limits<std::uint32_t>::max() - digit) / 10U) {
      return std::nullopt;
    }
    result = (result * 10U) + digit;
  }
  return result;
}

[[nodiscard]] auto byte_at(const std::span<const std::byte> input, const std::size_t index) noexcept
    -> std::byte {
  return input.subspan(index, 1).front();
}

struct ParameterParts final {
  std::array<std::span<const std::byte>, 3> values{};
  std::size_t count{0};
};

[[nodiscard]] auto split_parameter(const std::span<const std::byte> input,
                                   const std::byte separator) noexcept -> ParameterParts {
  ParameterParts result;
  std::size_t start = 0;
  for (std::size_t index = 0; index <= input.size(); ++index) {
    if (index == input.size() || byte_at(input, index) == separator) {
      if (result.count == result.values.size()) {
        return {};
      }
      std::span(result.values).subspan(result.count, 1).front() =
          input.subspan(start, index - start);
      ++result.count;
      start = index + 1U;
    }
  }
  return result;
}

[[nodiscard]] auto parameter_at(const ParameterParts& parts, const std::size_t index) noexcept
    -> std::span<const std::byte> {
  return std::span(parts.values).subspan(index, 1).front();
}

[[nodiscard]] auto key_from_codepoint(std::uint32_t codepoint) noexcept -> protocol::KeyInputKey {
  if (codepoint >= static_cast<std::uint32_t>('A') &&
      codepoint <= static_cast<std::uint32_t>('Z')) {
    codepoint += static_cast<std::uint32_t>('a' - 'A');
  }
  if (codepoint >= static_cast<std::uint32_t>('a') &&
      codepoint <= static_cast<std::uint32_t>('z')) {
    return static_cast<protocol::KeyInputKey>(
        static_cast<std::uint8_t>(protocol::KeyInputKey::a) +
        static_cast<std::uint8_t>(codepoint - static_cast<std::uint32_t>('a')));
  }
  switch (codepoint) {
  case 13:
    return protocol::KeyInputKey::enter;
  case 9:
    return protocol::KeyInputKey::tab;
  case 127:
    return protocol::KeyInputKey::backspace;
  case 27:
    return protocol::KeyInputKey::escape;
  case 32:
    return protocol::KeyInputKey::space;
  case 57348:
    return protocol::KeyInputKey::insert;
  case 57349:
    return protocol::KeyInputKey::delete_key;
  case 57350:
    return protocol::KeyInputKey::arrow_left;
  case 57351:
    return protocol::KeyInputKey::arrow_right;
  case 57352:
    return protocol::KeyInputKey::arrow_up;
  case 57353:
    return protocol::KeyInputKey::arrow_down;
  case 57354:
    return protocol::KeyInputKey::page_up;
  case 57355:
    return protocol::KeyInputKey::page_down;
  case 57356:
    return protocol::KeyInputKey::home;
  case 57357:
    return protocol::KeyInputKey::end;
  default:
    break;
  }
  if (codepoint >= 57376 && codepoint <= 57387) {
    return static_cast<protocol::KeyInputKey>(static_cast<std::uint8_t>(protocol::KeyInputKey::f1) +
                                              static_cast<std::uint8_t>(codepoint - 57376U));
  }
  return protocol::KeyInputKey::unidentified;
}

[[nodiscard]] auto append_utf8(const std::uint32_t codepoint,
                               const std::span<std::byte> output) noexcept -> std::size_t {
  if (codepoint <= 0x7FU && !output.empty()) {
    output.front() = static_cast<std::byte>(codepoint);
    return 1;
  }
  if (codepoint <= 0x7FFU && output.size() >= 2) {
    output.subspan(0, 1).front() = static_cast<std::byte>(0xC0U | (codepoint >> 6U));
    output.subspan(1, 1).front() = static_cast<std::byte>(0x80U | (codepoint & 0x3FU));
    return 2;
  }
  if (codepoint <= 0xFFFFU && (codepoint < 0xD800U || codepoint > 0xDFFFU) && output.size() >= 3) {
    output.subspan(0, 1).front() = static_cast<std::byte>(0xE0U | (codepoint >> 12U));
    output.subspan(1, 1).front() = static_cast<std::byte>(0x80U | ((codepoint >> 6U) & 0x3FU));
    output.subspan(2, 1).front() = static_cast<std::byte>(0x80U | (codepoint & 0x3FU));
    return 3;
  }
  if (codepoint <= 0x10FFFFU && output.size() >= 4) {
    output.subspan(0, 1).front() = static_cast<std::byte>(0xF0U | (codepoint >> 18U));
    output.subspan(1, 1).front() = static_cast<std::byte>(0x80U | ((codepoint >> 12U) & 0x3FU));
    output.subspan(2, 1).front() = static_cast<std::byte>(0x80U | ((codepoint >> 6U) & 0x3FU));
    output.subspan(3, 1).front() = static_cast<std::byte>(0x80U | (codepoint & 0x3FU));
    return 4;
  }
  return 0;
}

struct DecodedKittyKey final {
  protocol::KeyInput key{};
  std::array<std::byte, protocol::key_input_text_bytes_max> text{};
  std::size_t text_size{0};
};

[[nodiscard]] auto is_kitty_key_prefix(const std::span<const std::byte> sequence) noexcept -> bool {
  if (sequence.size() < 2 || sequence.front() != std::byte{0x1B} ||
      sequence.subspan(1, 1).front() != std::byte{'['}) {
    return false;
  }
  for (std::size_t index = 2; index < sequence.size(); ++index) {
    const auto byte = byte_at(sequence, index);
    const bool decimal = byte >= std::byte{'0'} && byte <= std::byte{'9'};
    const bool parameter_byte = decimal || byte == std::byte{';'} || byte == std::byte{':'};
    const bool final_byte = byte == std::byte{'u'} && index + 1U == sequence.size();
    if (!parameter_byte && !final_byte) {
      return false;
    }
  }
  return true;
}

[[nodiscard]] constexpr auto kitty_key_action(const std::uint32_t event_type) noexcept
    -> protocol::KeyInputAction {
  switch (event_type) {
  case 1:
    return protocol::KeyInputAction::press;
  case 2:
    return protocol::KeyInputAction::repeat;
  case 3:
    return protocol::KeyInputAction::release;
  default:
    return protocol::KeyInputAction::press;
  }
}

[[nodiscard]] auto kitty_special_key(const std::byte final) noexcept
    -> std::optional<protocol::KeyInputKey> {
  switch (final) {
  case std::byte{'A'}:
    return protocol::KeyInputKey::arrow_up;
  case std::byte{'B'}:
    return protocol::KeyInputKey::arrow_down;
  case std::byte{'C'}:
    return protocol::KeyInputKey::arrow_right;
  case std::byte{'D'}:
    return protocol::KeyInputKey::arrow_left;
  case std::byte{'H'}:
    return protocol::KeyInputKey::home;
  case std::byte{'F'}:
    return protocol::KeyInputKey::end;
  case std::byte{'P'}:
    return protocol::KeyInputKey::f1;
  case std::byte{'Q'}:
    return protocol::KeyInputKey::f2;
  case std::byte{'S'}:
    return protocol::KeyInputKey::f4;
  default:
    return std::nullopt;
  }
}

[[nodiscard]] auto kitty_key_modifiers(const std::uint32_t modifiers) noexcept
    -> std::optional<std::uint16_t> {
  if ((modifiers & ~(1U | 2U | 4U | 8U | 64U | 128U)) != 0) {
    return std::nullopt;
  }
  std::uint16_t result = 0;
  result |= (modifiers & 1U) != 0 ? protocol::key_input_modifier_shift : 0U;
  result |= (modifiers & 2U) != 0 ? protocol::key_input_modifier_alt : 0U;
  result |= (modifiers & 4U) != 0 ? protocol::key_input_modifier_control : 0U;
  result |= (modifiers & 8U) != 0 ? protocol::key_input_modifier_super : 0U;
  result |= (modifiers & 64U) != 0 ? protocol::key_input_modifier_caps_lock : 0U;
  result |= (modifiers & 128U) != 0 ? protocol::key_input_modifier_num_lock : 0U;
  return result;
}

// Kitty's three nested parameter groups are validated before metadata is exposed.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto parse_kitty_key(const std::span<const std::byte> sequence) noexcept
    -> std::optional<DecodedKittyKey> {
  if (sequence.size() < 4 || sequence.back() != std::byte{'u'} || !is_kitty_key_prefix(sequence)) {
    return std::nullopt;
  }
  const auto parameters =
      split_parameter(sequence.subspan(2, sequence.size() - 3U), std::byte{';'});
  if (parameters.count == 0) {
    return std::nullopt;
  }
  const auto key_parameters = split_parameter(parameter_at(parameters, 0), std::byte{':'});
  if (key_parameters.count == 0) {
    return std::nullopt;
  }
  const auto primary = parse_decimal(parameter_at(key_parameters, 0));
  if (!primary.has_value()) {
    return std::nullopt;
  }
  std::uint32_t unshifted = *primary;
  if (key_parameters.count >= 3) {
    const auto base = parse_decimal(parameter_at(key_parameters, 2));
    if (base.has_value()) {
      unshifted = *base;
    }
  } else if (unshifted >= static_cast<std::uint32_t>('A') &&
             unshifted <= static_cast<std::uint32_t>('Z')) {
    unshifted += static_cast<std::uint32_t>('a' - 'A');
  }

  if ((parameters.count == 2 && parameter_at(parameters, 1).empty()) ||
      (parameters.count >= 3 && parameter_at(parameters, 2).empty())) {
    return std::nullopt;
  }

  std::uint32_t encoded_modifiers = 1;
  std::uint32_t event_type = 1;
  if (parameters.count >= 2 && !parameter_at(parameters, 1).empty()) {
    const auto modifier_parameters = split_parameter(parameter_at(parameters, 1), std::byte{':'});
    if (modifier_parameters.count == 0) {
      return std::nullopt;
    }
    const auto decoded_modifiers = parse_decimal(parameter_at(modifier_parameters, 0));
    if (!decoded_modifiers.has_value() || *decoded_modifiers == 0) {
      return std::nullopt;
    }
    encoded_modifiers = *decoded_modifiers;
    if (modifier_parameters.count >= 2) {
      const auto decoded_event = parse_decimal(parameter_at(modifier_parameters, 1));
      if (!decoded_event.has_value()) {
        return std::nullopt;
      }
      event_type = *decoded_event;
    }
  }
  if (event_type == 0 || event_type > 3) {
    return std::nullopt;
  }
  const auto modifiers = kitty_key_modifiers(encoded_modifiers - 1U);
  if (!modifiers.has_value()) {
    return std::nullopt;
  }
  DecodedKittyKey decoded;
  decoded.key = {
      .action = kitty_key_action(event_type),
      .key = key_from_codepoint(unshifted),
      .modifiers = 0,
      .consumed_modifiers = 0,
      .unshifted_codepoint = unshifted,
      .composing = false,
  };
  decoded.key.modifiers = *modifiers;

  if (parameters.count >= 3 && !parameter_at(parameters, 2).empty()) {
    std::size_t start = 0;
    const auto text = parameter_at(parameters, 2);
    for (std::size_t index = 0; index <= text.size(); ++index) {
      if (index != text.size() && byte_at(text, index) != std::byte{':'}) {
        continue;
      }
      const auto codepoint = parse_decimal(text.subspan(start, index - start));
      if (!codepoint.has_value()) {
        return std::nullopt;
      }
      const auto written =
          append_utf8(*codepoint, std::span(decoded.text).subspan(decoded.text_size));
      if (written == 0) {
        return std::nullopt;
      }
      decoded.text_size += written;
      start = index + 1U;
    }
  }
  return decoded;
}

// Kitty retains traditional CSI finals for arrows and several navigation/function keys. With
// event reporting enabled, Ghostty emits forms such as CSI 1;1:1D and CSI 1;1:3D rather than CSI-u.
[[nodiscard]] auto parse_kitty_special_key(const std::span<const std::byte> sequence) noexcept
    -> std::optional<DecodedKittyKey> {
  if (sequence.size() < 6 || sequence.front() != std::byte{0x1B} ||
      byte_at(sequence, 1) != std::byte{'['}) {
    return std::nullopt;
  }
  const auto key = kitty_special_key(sequence.back());
  if (!key.has_value()) {
    return std::nullopt;
  }
  const auto parameters =
      split_parameter(sequence.subspan(2, sequence.size() - 3U), std::byte{';'});
  if (parameters.count != 2 || parse_decimal(parameter_at(parameters, 0)) != 1U) {
    return std::nullopt;
  }
  const auto modifier_parameters = split_parameter(parameter_at(parameters, 1), std::byte{':'});
  if (modifier_parameters.count == 0 || modifier_parameters.count > 2) {
    return std::nullopt;
  }
  const auto encoded_modifiers = parse_decimal(parameter_at(modifier_parameters, 0));
  if (!encoded_modifiers.has_value() || *encoded_modifiers == 0) {
    return std::nullopt;
  }
  std::uint32_t event_type = 1;
  if (modifier_parameters.count == 2) {
    const auto decoded_event = parse_decimal(parameter_at(modifier_parameters, 1));
    if (!decoded_event.has_value()) {
      return std::nullopt;
    }
    event_type = *decoded_event;
  }
  if (event_type == 0 || event_type > 3) {
    return std::nullopt;
  }
  const auto modifiers = kitty_key_modifiers(*encoded_modifiers - 1U);
  if (!modifiers.has_value()) {
    return std::nullopt;
  }
  DecodedKittyKey decoded;
  decoded.key = {
      .action = kitty_key_action(event_type),
      .key = *key,
      .modifiers = *modifiers,
      .consumed_modifiers = 0,
      .unshifted_codepoint = 0,
      .composing = false,
  };
  return decoded;
}

[[nodiscard]] constexpr auto mouse_action(const std::uint32_t value, const std::byte final) noexcept
    -> protocol::MouseInputAction {
  if ((value & 32U) != 0) {
    return protocol::MouseInputAction::motion;
  }
  return final == std::byte{'m'} ? protocol::MouseInputAction::release
                                 : protocol::MouseInputAction::press;
}

// SGR fields and button extensions are independently validated before coordinate translation.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto decode_sgr_mouse(const std::span<const std::byte> sequence,
                                    const protocol::Dimensions geometry,
                                    bool& any_button_pressed) noexcept
    -> std::optional<protocol::MouseInput> {
  if (sequence.size() < mouse_prefix.size() + 6U ||
      !std::ranges::equal(sequence.first(mouse_prefix.size()), mouse_prefix)) {
    return std::nullopt;
  }
  const auto final = sequence.back();
  if (final != std::byte{'M'} && final != std::byte{'m'}) {
    return std::nullopt;
  }
  const auto body =
      sequence.subspan(mouse_prefix.size(), sequence.size() - mouse_prefix.size() - 1U);
  const auto first_separator = std::ranges::find(body, std::byte{';'});
  if (first_separator == body.end()) {
    return std::nullopt;
  }
  const auto first_size = static_cast<std::size_t>(std::distance(body.begin(), first_separator));
  const auto remaining = body.subspan(first_size + 1U);
  const auto second_separator = std::ranges::find(remaining, std::byte{';'});
  if (second_separator == remaining.end()) {
    return std::nullopt;
  }
  const auto second_size =
      static_cast<std::size_t>(std::distance(remaining.begin(), second_separator));
  const auto encoded_button = parse_decimal(body.first(first_size));
  const auto encoded_column = parse_decimal(remaining.first(second_size));
  const auto encoded_row = parse_decimal(remaining.subspan(second_size + 1U));
  if (!encoded_button.has_value() || !encoded_column.has_value() || !encoded_row.has_value() ||
      *encoded_column == 0 || *encoded_row == 0 || *encoded_column > geometry.columns ||
      *encoded_row > geometry.rows) {
    return std::nullopt;
  }

  const auto value = *encoded_button;
  std::uint16_t modifiers = 0;
  if ((value & 4U) != 0) {
    modifiers |= 1U << 0U;
  }
  if ((value & 8U) != 0) {
    modifiers |= 1U << 2U;
  }
  if ((value & 16U) != 0) {
    modifiers |= 1U << 1U;
  }
  const auto basic_button = value & 3U;
  auto button = protocol::MouseInputButton::none;
  if ((value & 64U) != 0) {
    button =
        basic_button == 0 ? protocol::MouseInputButton::four : protocol::MouseInputButton::five;
  } else if ((value & 128U) != 0) {
    const auto encoded = static_cast<std::uint8_t>(protocol::MouseInputButton::six) +
                         static_cast<std::uint8_t>(basic_button);
    button = static_cast<protocol::MouseInputButton>(encoded);
  } else {
    switch (basic_button) {
    case 0:
      button = protocol::MouseInputButton::left;
      break;
    case 1:
      button = protocol::MouseInputButton::middle;
      break;
    case 2:
      button = protocol::MouseInputButton::right;
      break;
    case 3:
      button = protocol::MouseInputButton::none;
      break;
    default:
      return std::nullopt;
    }
  }

  const bool wheel = (value & 64U) != 0;
  const auto action = mouse_action(value, final);
  if (!wheel && action == protocol::MouseInputAction::press) {
    any_button_pressed = true;
  } else if (!wheel && action == protocol::MouseInputAction::release) {
    any_button_pressed = false;
  }
  return protocol::MouseInput{
      .action = action,
      .button = button,
      .modifiers = modifiers,
      .column = static_cast<std::uint16_t>(*encoded_column - 1U),
      .row = static_cast<std::uint16_t>(*encoded_row - 1U),
      .geometry = geometry,
      .any_button_pressed = any_button_pressed,
  };
}

} // namespace

auto HostInputParser::prepare() noexcept -> std::expected<void, HostInputError> {
  if (paste_storage_ != nullptr) {
    return {};
  }
  try {
    paste_storage_ =
        // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
        std::make_unique_for_overwrite<std::byte[]>(limits::structured_input_payload_bytes_max);
  } catch (const std::bad_alloc&) {
    return std::unexpected(HostInputError::allocation_failed);
  }
  return {};
}

// Input classification and retained-sequence repair intentionally share one bounded pass.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto HostInputParser::parse(const std::span<const std::byte> input,
                            const std::span<std::byte> output,
                            const protocol::Dimensions geometry) noexcept
    -> std::expected<HostInputBatch, HostInputError> {
  if (paste_storage_ == nullptr) {
    return std::unexpected(HostInputError::not_prepared);
  }
  HostInputBatch batch;
  const auto append_event = [&batch](const HostInputEvent& event) noexcept -> bool {
    if (batch.event_count >= batch.events.size()) {
      return false;
    }
    std::span(batch.events).subspan(batch.event_count, 1).front() = event;
    ++batch.event_count;
    return true;
  };
  const auto append_bytes =
      [&batch, output, &append_event](
          const HostInputKind kind,
          const std::span<const std::byte> bytes) noexcept -> std::expected<void, HostInputError> {
    if (bytes.empty()) {
      return {};
    }
    if (bytes.size() > output.size() - batch.bytes) {
      return std::unexpected(HostInputError::output_exhausted);
    }
    const auto offset = batch.bytes;
    std::ranges::copy(bytes, output.subspan(offset, bytes.size()).begin());
    batch.bytes += bytes.size();
    if (batch.event_count > 0) {
      auto& previous = std::span(batch.events).subspan(batch.event_count - 1U, 1).front();
      if (previous.kind == kind && previous.offset + previous.size == offset) {
        previous.size += bytes.size();
        return {};
      }
    }
    return append_event({.kind = kind, .offset = offset, .size = bytes.size()})
               ? std::expected<void, HostInputError>{}
               : std::unexpected(HostInputError::event_limit);
  };
  const auto append_key =
      [&batch, output, &append_event](
          const DecodedKittyKey& decoded) noexcept -> std::expected<void, HostInputError> {
    if (decoded.text_size > output.size() - batch.bytes) {
      return std::unexpected(HostInputError::output_exhausted);
    }
    const auto offset = batch.bytes;
    std::ranges::copy(std::span(decoded.text).first(decoded.text_size),
                      output.subspan(offset, decoded.text_size).begin());
    batch.bytes += decoded.text_size;
    return append_event({.kind = HostInputKind::key,
                         .offset = offset,
                         .size = decoded.text_size,
                         .key = decoded.key})
               ? std::expected<void, HostInputError>{}
               : std::unexpected(HostInputError::event_limit);
  };
  const auto append_paste =
      [this](
          const std::span<const std::byte> bytes) noexcept -> std::expected<void, HostInputError> {
    if (bytes.size() > limits::structured_input_payload_bytes_max - paste_size_) {
      return std::unexpected(HostInputError::output_exhausted);
    }
    std::ranges::copy(bytes,
                      std::span(paste_storage_.get(), limits::structured_input_payload_bytes_max)
                          .subspan(paste_size_, bytes.size())
                          .begin());
    paste_size_ += bytes.size();
    return {};
  };
  const auto emit_pending =
      [this,
       &append_bytes](const HostInputKind kind,
                      const std::size_t count) noexcept -> std::expected<void, HostInputError> {
    LEMMA_ASSERT(count <= pending_size_);
    const auto appended = append_bytes(kind, std::span(pending_).first(count));
    if (!appended.has_value()) {
      return appended;
    }
    std::ranges::copy(std::span(pending_).subspan(count, pending_size_ - count), pending_.begin());
    pending_size_ -= count;
    return {};
  };

  for (const auto byte : input) {
    if (paste_active_) {
      if (pending_size_ == 0 && byte != paste_end.front()) {
        const std::array single{byte};
        const auto appended = append_paste(single);
        if (!appended.has_value()) {
          return std::unexpected(appended.error());
        }
        continue;
      }
      if (pending_size_ >= pending_.size()) {
        return std::unexpected(HostInputError::output_exhausted);
      }
      std::span(pending_).subspan(pending_size_, 1).front() = byte;
      ++pending_size_;
      const auto pending = std::span(pending_).first(pending_size_);
      if (std::ranges::equal(pending, paste_end)) {
        pending_size_ = 0;
        paste_active_ = false;
        const auto completed =
            append_bytes(HostInputKind::paste,
                         std::span(paste_storage_.get(), limits::structured_input_payload_bytes_max)
                             .first(paste_size_));
        paste_size_ = 0;
        if (!completed.has_value()) {
          return std::unexpected(completed.error());
        }
        continue;
      }
      if (prefix_of(pending, paste_end)) {
        continue;
      }
      std::size_t retained = 0;
      for (std::size_t candidate = 1; candidate < pending_size_; ++candidate) {
        const auto suffix = pending.subspan(pending_size_ - candidate);
        if (prefix_of(suffix, paste_end)) {
          retained = candidate;
        }
      }
      const auto emitted_count = pending_size_ - retained;
      const auto retained_paste = append_paste(std::span(pending_).first(emitted_count));
      if (!retained_paste.has_value()) {
        return std::unexpected(retained_paste.error());
      }
      std::ranges::copy(std::span(pending_).subspan(emitted_count, retained), pending_.begin());
      pending_size_ = retained;
      continue;
    }

    if (pending_size_ == 0 && byte != std::byte{0x1B}) {
      const std::array single{byte};
      const auto appended = append_bytes(HostInputKind::ordinary, single);
      if (!appended.has_value()) {
        return std::unexpected(appended.error());
      }
      continue;
    }
    if (pending_size_ >= pending_.size()) {
      const auto emitted = emit_pending(HostInputKind::ordinary, pending_size_);
      if (!emitted.has_value()) {
        return std::unexpected(emitted.error());
      }
    }
    std::span(pending_).subspan(pending_size_, 1).front() = byte;
    ++pending_size_;
    const auto pending = std::span(pending_).first(pending_size_);

    if (std::ranges::equal(pending, paste_begin)) {
      pending_size_ = 0;
      paste_active_ = true;
      continue;
    }
    if (std::ranges::equal(pending, focus_gained) || std::ranges::equal(pending, focus_lost)) {
      const auto focus = std::ranges::equal(pending, focus_gained) ? protocol::FocusInput::gained
                                                                   : protocol::FocusInput::lost;
      if (!append_event({.kind = HostInputKind::focus, .focus = focus})) {
        return std::unexpected(HostInputError::event_limit);
      }
      pending_size_ = 0;
      continue;
    }
    const bool kitty_candidate = is_kitty_key_prefix(pending);
    if (kitty_candidate && pending.back() == std::byte{'u'}) {
      const auto key = parse_kitty_key(pending);
      if (key.has_value()) {
        const auto appended = append_key(*key);
        if (!appended.has_value()) {
          return std::unexpected(appended.error());
        }
        pending_size_ = 0;
        continue;
      }
    }
    if (const auto key = parse_kitty_special_key(pending); key.has_value()) {
      const auto appended = append_key(*key);
      if (!appended.has_value()) {
        return std::unexpected(appended.error());
      }
      pending_size_ = 0;
      continue;
    }
    const bool mouse_candidate =
        pending.size() >= mouse_prefix.size() &&
        std::ranges::equal(pending.first(mouse_prefix.size()), mouse_prefix);
    if (mouse_candidate && (pending.back() == std::byte{'M'} || pending.back() == std::byte{'m'})) {
      const auto mouse = decode_sgr_mouse(pending, geometry, any_button_pressed_);
      if (mouse.has_value()) {
        if (!append_event({.kind = HostInputKind::mouse, .mouse = *mouse})) {
          return std::unexpected(HostInputError::event_limit);
        }
        pending_size_ = 0;
        continue;
      }
    }

    const bool known_prefix =
        prefix_of(pending, paste_begin) || prefix_of(pending, focus_gained) ||
        prefix_of(pending, focus_lost) || prefix_of(pending, mouse_prefix) ||
        (kitty_candidate && pending.back() != std::byte{'u'}) ||
        (mouse_candidate && pending.back() != std::byte{'M'} && pending.back() != std::byte{'m'});
    if (known_prefix) {
      continue;
    }
    const auto retained = pending.back() == std::byte{0x1B} ? std::size_t{1} : std::size_t{0};
    const auto emitted = emit_pending(HostInputKind::ordinary, pending_size_ - retained);
    if (!emitted.has_value()) {
      return std::unexpected(emitted.error());
    }
  }
  return batch;
}

auto HostInputParser::flush_pending(const std::span<std::byte> output) noexcept
    -> std::expected<HostInputBatch, HostInputError> {
  HostInputBatch batch;
  if (pending_size_ == 0 || paste_active_) {
    return batch;
  }
  if (pending_size_ > output.size()) {
    return std::unexpected(HostInputError::output_exhausted);
  }
  std::ranges::copy(std::span(pending_).first(pending_size_), output.begin());
  batch.events.front() = {.kind = HostInputKind::ordinary, .offset = 0, .size = pending_size_};
  batch.event_count = 1;
  batch.bytes = pending_size_;
  pending_size_ = 0;
  return batch;
}

} // namespace lemma::client
