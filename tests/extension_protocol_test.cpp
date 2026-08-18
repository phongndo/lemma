#include "protocol/extension.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <ranges>
#include <span>

namespace lemma {
namespace {

using protocol::extension::MessageKind;

TEST(ExtensionProtocolTest, DecodesFragmentedTypedRegistration) {
  std::array<std::byte, 512> encoded{};
  const auto size = protocol::extension::encode_command(
      {.name = "agents.toggle", .description = "Toggle the agent sidebar"}, 42, encoded);
  ASSERT_TRUE(size.has_value());

  protocol::extension::Decoder decoder;
  const auto bytes = std::span(encoded).first(*size);
  std::ranges::copy(bytes.first(7), decoder.writable_bytes().begin());
  ASSERT_TRUE(decoder.commit(7).has_value());
  const auto incomplete = decoder.next();
  ASSERT_TRUE(incomplete.has_value());
  EXPECT_FALSE(incomplete->has_value());

  auto writable = decoder.writable_bytes();
  std::ranges::copy(bytes.subspan(7), writable.begin());
  ASSERT_TRUE(decoder.commit(bytes.size() - 7).has_value());
  const auto message = decoder.next();
  ASSERT_TRUE(message.has_value());
  ASSERT_TRUE(message->has_value());
  // The fatal assertions above establish both expected and optional values.
  // NOLINTNEXTLINE(bugprone-unchecked-optional-access)
  const auto decoded_message = **message;
  EXPECT_EQ(decoded_message.kind, MessageKind::register_command);
  EXPECT_EQ(decoded_message.request_id, 42U);
  const auto command = protocol::extension::decode_command(decoded_message);
  ASSERT_TRUE(command.has_value());
  EXPECT_EQ(command->name, "agents.toggle");
  EXPECT_EQ(command->description, "Toggle the agent sidebar");
}

TEST(ExtensionProtocolTest, DistinguishesSmallOutputFromInvalidPayload) {
  std::array<std::byte, protocol::extension::frame_header_bytes> output{};
  const auto too_small = protocol::extension::encode_command(
      {.name = "valid", .description = "description"}, 0, output);
  ASSERT_FALSE(too_small.has_value());
  EXPECT_EQ(too_small.error(), protocol::extension::EncodeError::output_too_small);

  std::array<char, protocol::extension::key_bytes_max + 1> oversized_key{};
  const auto invalid = protocol::extension::encode_keymap(
      {.mode = "valid",
       .key = std::string_view(oversized_key.data(), oversized_key.size()),
       .command = "valid"},
      0, output);
  ASSERT_FALSE(invalid.has_value());
  EXPECT_EQ(invalid.error(), protocol::extension::EncodeError::invalid_value);
}

TEST(ExtensionProtocolTest, RejectsOversizedPayloadBeforeReceivingIt) {
  std::array<std::byte, protocol::extension::frame_header_bytes> encoded{};
  const auto size = protocol::extension::encode_empty(MessageKind::begin_generation, 0, encoded);
  ASSERT_TRUE(size.has_value());
  auto payload_size = std::span(encoded).subspan(8, 4);
  payload_size.front() = std::byte{0};
  payload_size.subspan(1, 1).front() = std::byte{0};
  payload_size.subspan(2, 1).front() = std::byte{0x40};
  payload_size.back() = std::byte{1};

  protocol::extension::Decoder decoder;
  std::ranges::copy(encoded, decoder.writable_bytes().begin());
  ASSERT_TRUE(decoder.commit(encoded.size()).has_value());
  const auto result = decoder.next();
  ASSERT_FALSE(result.has_value());
  EXPECT_EQ(result.error(), protocol::extension::DecodeError::payload_too_large);
}

} // namespace
} // namespace lemma
