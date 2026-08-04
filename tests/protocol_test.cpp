#include "protocol/single_pane.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <span>
#include <string_view>

#include <gtest/gtest.h>

namespace lemma::protocol {
namespace {

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(ProtocolTest, DecodesFragmentedInputPacket) {
  ClientDecoder decoder;
  const std::array payload{std::byte{'a'}, std::byte{'b'}, std::byte{'c'}};
  const auto header = encode_input_header(payload.size());

  auto writable = decoder.writable_bytes();
  std::ranges::copy(header, writable.begin());
  ASSERT_TRUE(decoder.commit(header.size()).has_value());
  const auto incomplete = decoder.next();
  ASSERT_TRUE(incomplete.has_value());
  EXPECT_FALSE(incomplete->has_value());

  writable = decoder.writable_bytes();
  std::ranges::copy(payload, writable.begin());
  ASSERT_TRUE(decoder.commit(payload.size()).has_value());
  const auto decoded = decoder.next();
  // value() turns malformed or incomplete test output into an explicit test exception.
  // NOLINTNEXTLINE(bugprone-unchecked-optional-access)
  const auto& message = decoded.value().value();
  EXPECT_EQ(message.kind, ClientMessageKind::input);
  EXPECT_TRUE(std::ranges::equal(message.input, payload));

  decoder.consume();
  const auto empty = decoder.next();
  ASSERT_TRUE(empty.has_value());
  EXPECT_FALSE(empty->has_value());
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(ProtocolTest, DecodesResizeAndDetachPackets) {
  ClientDecoder decoder;
  const auto resize = encode_resize({.columns = 132, .rows = 43});
  const auto detach = encode_detach();
  auto writable = decoder.writable_bytes();
  auto destination = std::ranges::copy(resize, writable.begin()).out;
  std::ranges::copy(detach, destination);
  ASSERT_TRUE(decoder.commit(resize.size() + detach.size()).has_value());

  const auto decoded_resize = decoder.next();
  // NOLINTNEXTLINE(bugprone-unchecked-optional-access)
  const auto& resize_message = decoded_resize.value().value();
  EXPECT_EQ(resize_message.kind, ClientMessageKind::resize);
  EXPECT_EQ(resize_message.dimensions.columns, 132);
  EXPECT_EQ(resize_message.dimensions.rows, 43);
  decoder.consume();

  const auto decoded_detach = decoder.next();
  // NOLINTNEXTLINE(bugprone-unchecked-optional-access)
  EXPECT_EQ(decoded_detach.value().value().kind, ClientMessageKind::detach);
}

TEST(ProtocolTest, RepeatsUnconsumedMessageForBackpressure) {
  ClientDecoder decoder;
  const std::array payload{std::byte{'a'}, std::byte{'b'}};
  const auto header = encode_input_header(payload.size());
  auto output = std::ranges::copy(header, decoder.writable_bytes().begin()).out;
  std::ranges::copy(payload, output);
  ASSERT_TRUE(decoder.commit(header.size() + payload.size()).has_value());

  const auto first = decoder.next();
  const auto repeated = decoder.next();

  ASSERT_TRUE(first.has_value() && first->has_value());
  ASSERT_TRUE(repeated.has_value() && repeated->has_value());
  // NOLINTNEXTLINE(bugprone-unchecked-optional-access)
  EXPECT_TRUE(std::ranges::equal(repeated.value().value().input, payload));
  decoder.consume();
  const auto empty = decoder.next();
  ASSERT_TRUE(empty.has_value());
  EXPECT_FALSE(empty->has_value());
}

TEST(ProtocolTest, EncodesAndDecodesPaneCommands) {
  ClientDecoder decoder;
  const auto packet = encode_pane_command(PaneCommand::split_left_right);
  std::ranges::copy(packet, decoder.writable_bytes().begin());
  ASSERT_TRUE(decoder.commit(packet.size()).has_value());

  const auto decoded = decoder.next();

  ASSERT_TRUE(decoded.has_value());
  ASSERT_TRUE(decoded->has_value());
  // NOLINTNEXTLINE(bugprone-unchecked-optional-access)
  const auto& message = decoded.value().value();
  EXPECT_EQ(message.kind, ClientMessageKind::pane_command);
  EXPECT_EQ(message.pane_command, PaneCommand::split_left_right);
}

TEST(ProtocolTest, EncodesBoundedContextSize) {
  const auto encoded = encode_bounded_size(4'096);

  EXPECT_EQ(encoded.front(), std::byte{0x10});
  EXPECT_EQ(encoded.back(), std::byte{0x00});
  EXPECT_EQ(decode_bounded_size(encoded), 4'096U);
}

TEST(ProtocolTest, EncodesNamedAttachControlFields) {
  constexpr std::string_view session = "project";

  const auto header = encode_session_header(ControlCommand::attach, session);
  const auto dimensions = encode_dimensions({.columns = 132, .rows = 43});

  EXPECT_EQ(header.front(), wire_byte(ControlCommand::attach));
  EXPECT_EQ(decode_session_name_size(header.back()), session.size());
  const auto decoded_dimensions = decode_dimensions(dimensions);
  EXPECT_EQ(decoded_dimensions.columns, 132);
  EXPECT_EQ(decoded_dimensions.rows, 43);
}

TEST(ProtocolTest, RejectsUnknownPacketType) {
  ClientDecoder decoder;
  decoder.writable_bytes().front() = std::byte{'?'};
  ASSERT_TRUE(decoder.commit(1).has_value());
  const auto decoded = decoder.next();
  ASSERT_FALSE(decoded.has_value());
  EXPECT_EQ(decoded.error(), DecodeError::invalid_type);
}

TEST(ProtocolTest, RejectsOversizedInputBeforeReceivingPayload) {
  ClientDecoder decoder;
  const std::array header{std::byte{'I'}, std::byte{0x20}, std::byte{0x01}};
  std::ranges::copy(header, decoder.writable_bytes().begin());
  ASSERT_TRUE(decoder.commit(header.size()).has_value());

  const auto decoded = decoder.next();

  ASSERT_FALSE(decoded.has_value());
  EXPECT_EQ(decoded.error(), DecodeError::input_too_large);
}

TEST(ProtocolTest, PrefixParserDetachesWithoutForwardingCommand) {
  PrefixParser parser;
  const std::array input{std::byte{'x'}, std::byte{0x02}, std::byte{'d'}, std::byte{'y'}};
  std::array<std::byte, input.size() * 2U> output{};

  const auto result = parser.parse(input, output);

  EXPECT_TRUE(result.detach);
  ASSERT_EQ(result.bytes, 1);
  EXPECT_EQ(output.front(), std::byte{'x'});
}

TEST(ProtocolTest, PrefixParserKeepsBarePrefixPendingWithoutEscapeTimeout) {
  PrefixParser parser;
  const std::array input{std::byte{0x02}};
  std::array<std::byte, 2> output{};

  const auto result = parser.parse(input, output);

  EXPECT_EQ(result.bytes, 0U);
  EXPECT_TRUE(parser.has_pending_input());
  EXPECT_FALSE(parser.has_pending_escape_sequence());
}

TEST(ProtocolTest, PrefixParserForwardsLiteralPrefix) {
  PrefixParser parser;
  const std::array input{std::byte{0x02}, std::byte{0x02}};
  std::array<std::byte, input.size() * 2U> output{};

  const auto result = parser.parse(input, output);

  EXPECT_FALSE(result.detach);
  ASSERT_EQ(result.bytes, 1);
  EXPECT_EQ(output.front(), std::byte{0x02});
}

TEST(ProtocolTest, PrefixParserCapturesTmuxSplitsInInputOrder) {
  PrefixParser parser;
  const std::array input{std::byte{'a'},  std::byte{0x02}, std::byte{'%'}, std::byte{'b'},
                         std::byte{0x02}, std::byte{'"'},  std::byte{'c'}};
  std::array<std::byte, input.size() * 2U> output{};

  const auto result = parser.parse(input, output);

  EXPECT_FALSE(result.detach);
  ASSERT_EQ(result.bytes, 3U);
  const auto output_bytes = std::span(output);
  EXPECT_EQ(output.front(), std::byte{'a'});
  EXPECT_EQ(output_bytes.subspan(1, 1).front(), std::byte{'b'});
  EXPECT_EQ(output_bytes.subspan(2, 1).front(), std::byte{'c'});
  ASSERT_EQ(result.action_count, 2U);
  EXPECT_EQ(result.actions.front().input_bytes, 1U);
  EXPECT_EQ(result.actions.front().command, PaneCommand::split_left_right);
  const auto& second_action = std::span(result.actions).subspan<1, 1>().front();
  EXPECT_EQ(second_action.input_bytes, 2U);
  EXPECT_EQ(second_action.command, PaneCommand::split_top_bottom);
}

TEST(ProtocolTest, PrefixParserCapturesTabCommandsInInputOrder) {
  PrefixParser parser;
  const std::array input{
      std::byte{0x02}, std::byte{'c'},  std::byte{0x02}, std::byte{'n'},  std::byte{0x02},
      std::byte{'p'},  std::byte{0x02}, std::byte{'&'},  std::byte{0x02}, std::byte{'3'},
  };
  std::array<std::byte, input.size() * 2U> output{};

  const auto result = parser.parse(input, output);

  EXPECT_EQ(result.bytes, 0U);
  ASSERT_EQ(result.action_count, 5U);
  const auto actions = std::span(result.actions);
  EXPECT_EQ((actions.subspan<0, 1>().front().command), PaneCommand::create_tab);
  EXPECT_EQ((actions.subspan<1, 1>().front().command), PaneCommand::next_tab);
  EXPECT_EQ((actions.subspan<2, 1>().front().command), PaneCommand::previous_tab);
  EXPECT_EQ((actions.subspan<3, 1>().front().command), PaneCommand::kill_tab);
  EXPECT_EQ((actions.subspan<4, 1>().front().command), PaneCommand::select_tab_3);
}

TEST(ProtocolTest, DecodesTabCommandPacket) {
  ClientDecoder decoder;
  const auto packet = encode_pane_command(PaneCommand::select_tab_9);
  std::ranges::copy(packet, decoder.writable_bytes().begin());
  ASSERT_TRUE(decoder.commit(packet.size()).has_value());

  const auto decoded = decoder.next();

  ASSERT_TRUE(decoded.has_value());
  ASSERT_TRUE(decoded->has_value());
  // value() turns malformed or incomplete test output into an explicit test exception.
  // NOLINTNEXTLINE(bugprone-unchecked-optional-access)
  EXPECT_EQ(decoded.value().value().pane_command, PaneCommand::select_tab_9);
}

TEST(ProtocolTest, PrefixParserCapturesFragmentedArrowKey) {
  PrefixParser parser;
  std::array<std::byte, 8> output{};
  const std::array prefix_and_escape{std::byte{0x02}, std::byte{0x1B}};
  const std::array csi{std::byte{'['}};
  const std::array direction{std::byte{'D'}};

  EXPECT_EQ(parser.parse(prefix_and_escape, output).action_count, 0U);
  EXPECT_TRUE(parser.has_pending_input());
  EXPECT_TRUE(parser.has_pending_escape_sequence());
  EXPECT_EQ(parser.parse(csi, output).action_count, 0U);
  const auto result = parser.parse(direction, output);

  EXPECT_EQ(result.bytes, 0U);
  ASSERT_EQ(result.action_count, 1U);
  EXPECT_EQ(result.actions.front().command, PaneCommand::focus_left);
  EXPECT_FALSE(parser.has_pending_input());
}

TEST(ProtocolTest, PrefixParserFlushesInterruptedPrefixEscape) {
  PrefixParser parser;
  std::array<std::byte, 8> output{};
  const std::array input{std::byte{0x02}, std::byte{0x1B}};

  const auto parsed = parser.parse(input, output);

  EXPECT_EQ(parsed.bytes, 0U);
  ASSERT_TRUE(parser.has_pending_input());
  ASSERT_EQ(parser.flush_pending(output), 2U);
  EXPECT_EQ(output.front(), std::byte{0x02});
  EXPECT_EQ(std::span(output).subspan(1, 1).front(), std::byte{0x1B});
  EXPECT_FALSE(parser.has_pending_input());
}

} // namespace
} // namespace lemma::protocol
