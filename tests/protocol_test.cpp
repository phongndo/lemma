#include "protocol/attachment.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <ranges>
#include <span>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>

namespace lemma::protocol {
namespace {

// Assertions above each access make optional test failures explicit.
// NOLINTBEGIN(bugprone-unchecked-optional-access)

void append(std::vector<std::byte>& destination, const std::span<const std::byte> bytes) {
  destination.insert(destination.end(), bytes.begin(), bytes.end());
}

template <std::size_t Size>
void append(std::vector<std::byte>& destination, const std::array<std::byte, Size>& bytes) {
  append(destination, std::span(bytes));
}

TEST(ProtocolTest, HasDeterministicGoldenClientHelloEncoding) {
  const auto encoded =
      encode_client_hello("project", {.columns = 132, .rows = 43}, 1, current_version);
  const std::array expected{
      std::byte{0x89}, std::byte{'L'},  std::byte{'M'},  std::byte{'A'},  std::byte{0x02},
      std::byte{0x05}, std::byte{0x01}, std::byte{0x00}, std::byte{0x00}, std::byte{0x00},
      std::byte{0x00}, std::byte{0x0D}, std::byte{0x00}, std::byte{0x00}, std::byte{0x00},
      std::byte{0x01}, std::byte{0x07}, std::byte{0x00}, std::byte{0x84}, std::byte{0x00},
      std::byte{0x2B}, std::byte{0x00}, std::byte{'p'},  std::byte{'r'},  std::byte{'o'},
      std::byte{'j'},  std::byte{'e'},  std::byte{'c'},  std::byte{'t'},
  };

  EXPECT_TRUE(std::ranges::equal(encoded.bytes(), expected));
}

TEST(ProtocolTest, RoundTripsBoundedHostThemeInClientHello) {
  HostTerminalTheme theme;
  theme.foreground = RgbColor{.red = 1, .green = 2, .blue = 3};
  theme.background = RgbColor{.red = 4, .green = 5, .blue = 6};
  theme.set_palette_color(0, {.red = 7, .green = 8, .blue = 9});
  theme.set_palette_color(15, {.red = 10, .green = 11, .blue = 12});
  const auto encoded =
      encode_client_hello("themed", {.columns = 80, .rows = 24}, 1, current_version, theme);
  ClientDecoder decoder;
  ASSERT_TRUE(decoder.prepare().has_value());
  std::ranges::copy(encoded.bytes(), decoder.writable_bytes().begin());
  ASSERT_TRUE(decoder.commit(encoded.bytes().size()).has_value());

  const auto decoded = decoder.next();

  ASSERT_TRUE(decoded.has_value() && decoded->has_value());
  ASSERT_NE((**decoded).host_theme, nullptr);
  EXPECT_EQ(*(**decoded).host_theme, theme);
  EXPECT_EQ((**decoded).session, "themed");
}

TEST(ProtocolTest, RoundTripsTypedPasteFocusAndMouseInput) {
  ClientDecoder decoder;
  ASSERT_TRUE(decoder.prepare().has_value());
  decoder.reset(2, false);
  const std::array paste{std::byte{'a'}, std::byte{0x02}, std::byte{'b'}};
  const auto paste_header = encode_paste_header(paste.size(), 2);
  std::vector<std::byte> encoded;
  append(encoded, paste_header);
  append(encoded, paste);
  const auto focus = encode_focus(FocusInput::gained, 3);
  append(encoded, focus.bytes());
  const MouseInput mouse{
      .action = MouseInputAction::press,
      .button = MouseInputButton::left,
      .modifiers = 5,
      .column = 4,
      .row = 2,
      .geometry = {.columns = 80, .rows = 24},
      .any_button_pressed = true,
  };
  const auto mouse_message = encode_mouse(mouse, 4);
  append(encoded, mouse_message.bytes());
  const KeyInput key{
      .action = KeyInputAction::repeat,
      .key = KeyInputKey::b,
      .modifiers = key_input_modifier_control,
      .consumed_modifiers = 0,
      .unshifted_codepoint = 'b',
      .composing = false,
  };
  const std::array key_text{std::byte{'b'}};
  const auto key_message = encode_key(key, key_text, 5);
  append(encoded, key_message.bytes());
  std::ranges::copy(encoded, decoder.writable_bytes().begin());
  ASSERT_TRUE(decoder.commit(encoded.size()).has_value());

  const auto decoded_paste = decoder.next();
  ASSERT_TRUE(decoded_paste.has_value() && decoded_paste->has_value());
  EXPECT_EQ((**decoded_paste).kind, ClientMessageKind::paste);
  EXPECT_TRUE(std::ranges::equal((**decoded_paste).input, paste));
  decoder.consume();

  const auto decoded_focus = decoder.next();
  ASSERT_TRUE(decoded_focus.has_value() && decoded_focus->has_value());
  EXPECT_EQ((**decoded_focus).kind, ClientMessageKind::focus);
  EXPECT_EQ((**decoded_focus).focus, FocusInput::gained);
  decoder.consume();

  const auto decoded_mouse = decoder.next();
  ASSERT_TRUE(decoded_mouse.has_value() && decoded_mouse->has_value());
  EXPECT_EQ((**decoded_mouse).kind, ClientMessageKind::mouse);
  EXPECT_EQ((**decoded_mouse).mouse, mouse);
  decoder.consume();

  const auto decoded_key = decoder.next();
  ASSERT_TRUE(decoded_key.has_value() && decoded_key->has_value());
  EXPECT_EQ((**decoded_key).kind, ClientMessageKind::key);
  EXPECT_EQ((**decoded_key).key, key);
  EXPECT_TRUE(std::ranges::equal((**decoded_key).input, key_text));
}

TEST(ProtocolTest, SupportsOpaquePasteLargerThanLegacyReadMessages) {
  ClientDecoder decoder;
  ASSERT_TRUE(decoder.prepare().has_value());
  decoder.reset(2, false);
  std::vector<std::byte> paste(std::size_t{16} * 1'024U, std::byte{0x02});
  const auto header = encode_paste_header(paste.size(), 2);
  std::ranges::copy(header, decoder.writable_bytes().begin());
  ASSERT_TRUE(decoder.commit(header.size()).has_value());
  const auto header_only = decoder.next();
  ASSERT_TRUE(header_only.has_value());
  ASSERT_FALSE(header_only->has_value());
  std::ranges::copy(paste, decoder.writable_bytes().begin());
  ASSERT_TRUE(decoder.commit(paste.size()).has_value());

  const auto decoded = decoder.next();

  ASSERT_TRUE(decoded.has_value() && decoded->has_value());
  EXPECT_EQ((**decoded).kind, ClientMessageKind::paste);
  EXPECT_TRUE(std::ranges::equal((**decoded).input, paste));
}

TEST(ProtocolTest, RoundTripsLiveHostThemeUpdate) {
  HostTerminalTheme theme;
  theme.foreground = RgbColor{.red = 1, .green = 2, .blue = 3};
  theme.set_palette_color(7, {.red = 4, .green = 5, .blue = 6});
  const auto encoded = encode_host_theme_update(theme, 2);
  ClientDecoder decoder;
  ASSERT_TRUE(decoder.prepare().has_value());
  decoder.reset(2, false);
  std::ranges::copy(encoded.bytes(), decoder.writable_bytes().begin());
  ASSERT_TRUE(decoder.commit(encoded.bytes().size()).has_value());

  const auto decoded = decoder.next();

  ASSERT_TRUE(decoded.has_value() && decoded->has_value());
  EXPECT_EQ((**decoded).kind, ClientMessageKind::host_theme);
  ASSERT_NE((**decoded).host_theme, nullptr);
  EXPECT_EQ(*(**decoded).host_theme, theme);
}

TEST(ProtocolTest, HasDeterministicGoldenRenderEncoding) {
  const auto encoded = encode_render_frame_header(3, 2, 1, true);
  const std::array expected{
      std::byte{0x89}, std::byte{'L'},  std::byte{'M'},  std::byte{'A'},  std::byte{0x02},
      std::byte{0x05}, std::byte{0x06}, std::byte{0x01}, std::byte{0x00}, std::byte{0x00},
      std::byte{0x00}, std::byte{0x07}, std::byte{0x00}, std::byte{0x00}, std::byte{0x00},
      std::byte{0x02}, std::byte{0x00}, std::byte{0x00}, std::byte{0x00}, std::byte{0x01},
  };

  EXPECT_EQ(encoded, expected);
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(ProtocolTest, DecodesClientHelloAtEveryFragmentBoundary) {
  const auto encoded = encode_client_hello("fragmented", {.columns = 100, .rows = 31});
  for (std::size_t split = 0; split < encoded.bytes().size(); ++split) {
    ClientDecoder decoder;
    ASSERT_TRUE(decoder.prepare().has_value());
    auto writable = decoder.writable_bytes();
    std::ranges::copy(encoded.bytes().first(split), writable.begin());
    ASSERT_TRUE(decoder.commit(split).has_value());
    const auto first = decoder.next();
    ASSERT_TRUE(first.has_value());
    EXPECT_FALSE(first->has_value()) << split;
    writable = decoder.writable_bytes();
    std::ranges::copy(encoded.bytes().subspan(split), writable.begin());
    ASSERT_TRUE(decoder.commit(encoded.bytes().size() - split).has_value());
    const auto decoded = decoder.next();
    ASSERT_TRUE(decoded.has_value() && decoded->has_value()) << split;
    const auto& message = **decoded;
    EXPECT_EQ(message.kind, ClientMessageKind::hello);
    EXPECT_EQ(message.session, "fragmented");
    EXPECT_EQ(message.dimensions, (Dimensions{.columns = 100, .rows = 31}));
  }
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(ProtocolTest, DecodesCoalescedLiveClientMessagesInSequence) {
  ClientDecoder decoder;
  ASSERT_TRUE(decoder.prepare().has_value());
  decoder.reset(2, false);
  std::vector<std::byte> encoded;
  constexpr std::array input{std::byte{'a'}, std::byte{'b'}, std::byte{'c'}};
  append(encoded, encode_input_header(input.size(), 2));
  append(encoded, input);
  append(encoded, encode_resize({.columns = 132, .rows = 43}, 3).bytes());
  append(encoded, encode_pane_command(PaneCommand::split_left_right, 4).bytes());
  append(encoded, encode_detach(5).bytes());
  std::ranges::copy(encoded, decoder.writable_bytes().begin());
  ASSERT_TRUE(decoder.commit(encoded.size()).has_value());

  auto message = decoder.next();
  ASSERT_TRUE(message.has_value() && message->has_value());
  EXPECT_EQ((**message).kind, ClientMessageKind::input);
  EXPECT_TRUE(std::ranges::equal((**message).input, input));
  decoder.consume();

  message = decoder.next();
  ASSERT_TRUE(message.has_value() && message->has_value());
  EXPECT_EQ((**message).kind, ClientMessageKind::resize);
  EXPECT_EQ((**message).dimensions, (Dimensions{.columns = 132, .rows = 43}));
  decoder.consume();

  message = decoder.next();
  ASSERT_TRUE(message.has_value() && message->has_value());
  EXPECT_EQ((**message).kind, ClientMessageKind::pane_command);
  EXPECT_EQ((**message).pane_command, PaneCommand::split_left_right);
  decoder.consume();

  message = decoder.next();
  ASSERT_TRUE(message.has_value() && message->has_value());
  EXPECT_EQ((**message).kind, ClientMessageKind::detach);
  decoder.consume();
  ASSERT_TRUE(decoder.next().has_value());
  EXPECT_FALSE(decoder.next()->has_value());
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(ProtocolTest, RoundTripsEveryTypedPaneResizeCommand) {
  constexpr std::array commands{PaneCommand::resize_left, PaneCommand::resize_right,
                                PaneCommand::resize_up, PaneCommand::resize_down};
  for (const auto command : commands) {
    ClientDecoder decoder;
    ASSERT_TRUE(decoder.prepare().has_value());
    decoder.reset(2, false);
    const auto encoded = encode_pane_command(command, 2);
    std::ranges::copy(encoded.bytes(), decoder.writable_bytes().begin());
    ASSERT_TRUE(decoder.commit(encoded.bytes().size()).has_value());

    const auto decoded = decoder.next();

    ASSERT_TRUE(decoded.has_value() && decoded->has_value());
    EXPECT_EQ((**decoded).kind, ClientMessageKind::pane_command);
    EXPECT_EQ((**decoded).pane_command, command);
  }
}

TEST(ProtocolTest, RepeatsBorrowedClientMessageUntilConsumed) {
  ClientDecoder decoder;
  ASSERT_TRUE(decoder.prepare().has_value());
  decoder.reset(2, false);
  constexpr std::array payload{std::byte{'a'}, std::byte{'b'}};
  const auto header = encode_input_header(payload.size(), 2);
  auto output = std::ranges::copy(header, decoder.writable_bytes().begin()).out;
  std::ranges::copy(payload, output);
  ASSERT_TRUE(decoder.commit(header.size() + payload.size()).has_value());

  const auto first = decoder.next();
  const auto repeated = decoder.next();

  ASSERT_TRUE(first.has_value() && first->has_value());
  ASSERT_TRUE(repeated.has_value() && repeated->has_value());
  EXPECT_TRUE(std::ranges::equal((**repeated).input, payload));
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(ProtocolTest, RejectsMalformedClientEnvelopesBeforePayloadMutation) {
  const auto expect_error = [](const std::span<const std::byte> bytes, const DecodeError error) {
    ClientDecoder decoder;
    if (!decoder.prepare().has_value()) {
      return false;
    }
    std::ranges::copy(bytes, decoder.writable_bytes().begin());
    if (!decoder.commit(bytes.size()).has_value()) {
      return false;
    }
    const auto result = decoder.next();
    return !result.has_value() && result.error() == error;
  };

  auto invalid_magic = encode_header(MessageKind::hello, 0, 6, 1);
  invalid_magic.front() = std::byte{0};
  EXPECT_TRUE(expect_error(invalid_magic, DecodeError::invalid_magic));

  const auto mismatch = encode_header(MessageKind::hello, 0, 6, 1, {.major = 1, .minor = 0});
  EXPECT_TRUE(expect_error(mismatch, DecodeError::version_mismatch));

  auto invalid_kind = encode_header(MessageKind::hello, 0, 6, 1);
  std::span(invalid_kind).subspan<6, 1>().front() = std::byte{0xFF};
  EXPECT_TRUE(expect_error(invalid_kind, DecodeError::invalid_kind));

  const auto flags = encode_header(MessageKind::hello, 1, 6, 1);
  EXPECT_TRUE(expect_error(flags, DecodeError::invalid_flags));

  const auto wrong_sequence = encode_header(MessageKind::hello, 0, 6, 2);
  EXPECT_TRUE(expect_error(wrong_sequence, DecodeError::invalid_sequence));

  ClientDecoder live;
  ASSERT_TRUE(live.prepare().has_value());
  live.reset(2, false);
  const auto oversized = encode_header(MessageKind::input, 0, input_message_bytes_max + 1U, 2);
  std::ranges::copy(oversized, live.writable_bytes().begin());
  ASSERT_TRUE(live.commit(oversized.size()).has_value());
  const auto oversized_result = live.next();
  ASSERT_FALSE(oversized_result.has_value());
  EXPECT_EQ(oversized_result.error(), DecodeError::oversized);
}

TEST(ProtocolTest, RejectsInvalidClientPayloadValues) {
  ClientDecoder resize_decoder;
  ASSERT_TRUE(resize_decoder.prepare().has_value());
  resize_decoder.reset(2, false);
  auto resize = encode_header(MessageKind::resize, 0, 4, 2);
  auto destination = std::ranges::copy(resize, resize_decoder.writable_bytes().begin()).out;
  std::ranges::fill_n(destination, 4, std::byte{0});
  ASSERT_TRUE(resize_decoder.commit(resize.size() + 4U).has_value());
  const auto invalid_resize = resize_decoder.next();
  ASSERT_FALSE(invalid_resize.has_value());
  EXPECT_EQ(invalid_resize.error(), DecodeError::invalid_dimensions);

  ClientDecoder command_decoder;
  ASSERT_TRUE(command_decoder.prepare().has_value());
  command_decoder.reset(2, false);
  auto command = encode_header(MessageKind::pane_command, 0, 1, 2);
  destination = std::ranges::copy(command, command_decoder.writable_bytes().begin()).out;
  *destination = std::byte{0xFF};
  ASSERT_TRUE(command_decoder.commit(command.size() + 1U).has_value());
  const auto invalid_command = command_decoder.next();
  ASSERT_FALSE(invalid_command.has_value());
  EXPECT_EQ(invalid_command.error(), DecodeError::invalid_enum);

  auto hello = encode_client_hello("valid", {.columns = 80, .rows = 24});
  std::vector malformed(hello.bytes().begin(), hello.bytes().end());
  malformed.back() = std::byte{'.'};
  ClientDecoder hello_decoder;
  ASSERT_TRUE(hello_decoder.prepare().has_value());
  std::ranges::copy(malformed, hello_decoder.writable_bytes().begin());
  ASSERT_TRUE(hello_decoder.commit(malformed.size()).has_value());
  const auto invalid_session = hello_decoder.next();
  ASSERT_FALSE(invalid_session.has_value());
  EXPECT_EQ(invalid_session.error(), DecodeError::invalid_session);
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(ProtocolTest, ServerDecoderHandlesFragmentationCoalescingAndRedrawRecovery) {
  ServerDecoder decoder;
  ASSERT_TRUE(decoder.prepare().has_value());
  const auto hello = encode_daemon_hello({.columns = 80, .rows = 24});
  for (const auto byte : hello.bytes()) {
    decoder.writable_bytes().front() = byte;
    ASSERT_TRUE(decoder.commit(1).has_value());
  }
  auto decoded = decoder.next();
  ASSERT_TRUE(decoded.has_value() && decoded->has_value());
  EXPECT_EQ((**decoded).kind, ServerMessageKind::hello);
  decoder.consume();

  std::vector<std::byte> frames;
  constexpr std::array first{std::byte{'A'}};
  constexpr std::array delta{std::byte{'B'}};
  constexpr std::array recovery{std::byte{'C'}};
  append(frames, encode_render_frame_header(first.size(), 2, 1, true));
  append(frames, first);
  append(frames, encode_render_frame_header(delta.size(), 3, 1, false));
  append(frames, delta);
  append(frames, encode_render_frame_header(recovery.size(), 4, 2, true));
  append(frames, recovery);
  std::ranges::copy(frames, decoder.writable_bytes().begin());
  ASSERT_TRUE(decoder.commit(frames.size()).has_value());

  decoded = decoder.next();
  ASSERT_TRUE(decoded.has_value() && decoded->has_value());
  EXPECT_TRUE((**decoded).full_redraw);
  EXPECT_EQ((**decoded).full_redraw_generation, 1U);
  EXPECT_TRUE(std::ranges::equal((**decoded).ansi, first));
  decoder.consume();

  decoded = decoder.next();
  ASSERT_TRUE(decoded.has_value() && decoded->has_value());
  EXPECT_FALSE((**decoded).full_redraw);
  EXPECT_EQ((**decoded).full_redraw_generation, 1U);
  decoder.consume();

  decoded = decoder.next();
  ASSERT_TRUE(decoded.has_value() && decoded->has_value());
  EXPECT_TRUE((**decoded).full_redraw);
  EXPECT_EQ((**decoded).full_redraw_generation, 2U);
}

TEST(ProtocolTest, ServerDecoderRejectsMissingFullRedrawAndOversizedFrame) {
  ServerDecoder decoder;
  ASSERT_TRUE(decoder.prepare().has_value());
  const auto hello = encode_daemon_hello({.columns = 80, .rows = 24});
  std::ranges::copy(hello.bytes(), decoder.writable_bytes().begin());
  ASSERT_TRUE(decoder.commit(hello.bytes().size()).has_value());
  ASSERT_TRUE(decoder.next().has_value());
  decoder.consume();

  const auto delta = encode_render_frame_header(1, 2, 1, false);
  auto destination = std::ranges::copy(delta, decoder.writable_bytes().begin()).out;
  *destination = std::byte{'x'};
  ASSERT_TRUE(decoder.commit(delta.size() + 1U).has_value());
  const auto result = decoder.next();
  ASSERT_FALSE(result.has_value());
  EXPECT_EQ(result.error(), DecodeError::invalid_generation);

  ServerDecoder oversized_decoder;
  ASSERT_TRUE(oversized_decoder.prepare().has_value());
  std::ranges::copy(hello.bytes(), oversized_decoder.writable_bytes().begin());
  ASSERT_TRUE(oversized_decoder.commit(hello.bytes().size()).has_value());
  ASSERT_TRUE(oversized_decoder.next().has_value());
  oversized_decoder.consume();
  const auto oversized = encode_header(MessageKind::render_frame, render_full_redraw_flag,
                                       render_payload_bytes_max + 1U, 2);
  std::ranges::copy(oversized, oversized_decoder.writable_bytes().begin());
  ASSERT_TRUE(oversized_decoder.commit(oversized.size()).has_value());
  const auto oversized_result = oversized_decoder.next();
  ASSERT_FALSE(oversized_result.has_value());
  EXPECT_EQ(oversized_result.error(), DecodeError::oversized);
}

TEST(ProtocolTest, EncodesAndDecodesTypedDisconnectDiagnostic) {
  const auto encoded =
      encode_disconnect(DisconnectReason::version_mismatch, "attach protocol version mismatch");
  ServerDecoder decoder;
  ASSERT_TRUE(decoder.prepare().has_value());
  std::ranges::copy(encoded.bytes(), decoder.writable_bytes().begin());
  ASSERT_TRUE(decoder.commit(encoded.bytes().size()).has_value());

  const auto decoded = decoder.next();

  ASSERT_TRUE(decoded.has_value() && decoded->has_value());
  EXPECT_EQ((**decoded).kind, ServerMessageKind::disconnect);
  EXPECT_EQ((**decoded).reason, DisconnectReason::version_mismatch);
  EXPECT_EQ((**decoded).diagnostic, "attach protocol version mismatch");
}

TEST(ProtocolTest, EncodesBoundedControlContextSize) {
  const auto encoded = encode_bounded_size(4'096);

  EXPECT_EQ(encoded.front(), std::byte{0x10});
  EXPECT_EQ(encoded.back(), std::byte{0x00});
  EXPECT_EQ(decode_bounded_size(encoded), 4'096U);
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

TEST(ProtocolTest, PrefixParserCapturesTmuxSplitsInInputOrder) {
  PrefixParser parser;
  const std::array input{std::byte{'a'},  std::byte{0x02}, std::byte{'%'}, std::byte{'b'},
                         std::byte{0x02}, std::byte{'"'},  std::byte{'c'}};
  std::array<std::byte, input.size() * 2U> output{};

  const auto result = parser.parse(input, output);

  ASSERT_EQ(result.bytes, 3U);
  ASSERT_EQ(result.action_count, 2U);
  EXPECT_EQ(result.actions.front().input_bytes, 1U);
  EXPECT_EQ(result.actions.front().command, PaneCommand::split_left_right);
  EXPECT_EQ((std::span(result.actions).subspan<1, 1>().front().command),
            PaneCommand::split_top_bottom);
}

TEST(ProtocolTest, PrefixParserCapturesCtrlHjklResizeBindingsInInputOrder) {
  PrefixParser parser;
  const std::array input{
      std::byte{0x02}, std::byte{0x08}, std::byte{0x02}, std::byte{0x0A},
      std::byte{0x02}, std::byte{0x0B}, std::byte{0x02}, std::byte{0x0C},
  };
  std::array<std::byte, input.size() * 2U> output{};

  const auto result = parser.parse(input, output);

  ASSERT_EQ(result.action_count, 4U);
  EXPECT_EQ(result.bytes, 0U);
  const auto actions = std::span(result.actions);
  EXPECT_EQ((actions.subspan<0, 1>().front().command), PaneCommand::resize_left);
  EXPECT_EQ((actions.subspan<1, 1>().front().command), PaneCommand::resize_down);
  EXPECT_EQ((actions.subspan<2, 1>().front().command), PaneCommand::resize_up);
  EXPECT_EQ((actions.subspan<3, 1>().front().command), PaneCommand::resize_right);
}

TEST(ProtocolTest, PrefixParserCapturesAltHjklResizeBindingsInInputOrder) {
  PrefixParser parser;
  const std::array input{
      std::byte{0x02}, std::byte{0x1B}, std::byte{'h'},  std::byte{0x02},
      std::byte{0x1B}, std::byte{'j'},  std::byte{0x02}, std::byte{0x1B},
      std::byte{'k'},  std::byte{0x02}, std::byte{0x1B}, std::byte{'l'},
  };
  std::array<std::byte, input.size() * 2U> output{};

  const auto result = parser.parse(input, output);

  ASSERT_EQ(result.action_count, 4U);
  EXPECT_EQ(result.bytes, 0U);
  const auto actions = std::span(result.actions);
  EXPECT_EQ((actions.subspan<0, 1>().front().command), PaneCommand::resize_left);
  EXPECT_EQ((actions.subspan<1, 1>().front().command), PaneCommand::resize_down);
  EXPECT_EQ((actions.subspan<2, 1>().front().command), PaneCommand::resize_up);
  EXPECT_EQ((actions.subspan<3, 1>().front().command), PaneCommand::resize_right);
}

TEST(ProtocolTest, PrefixParserCapturesHjklFocusAndShiftHjklSwapBindings) {
  PrefixParser parser;
  const std::array input{
      std::byte{0x02}, std::byte{'h'}, std::byte{0x02}, std::byte{'j'},
      std::byte{0x02}, std::byte{'k'}, std::byte{0x02}, std::byte{'l'},
      std::byte{0x02}, std::byte{'H'}, std::byte{0x02}, std::byte{'J'},
      std::byte{0x02}, std::byte{'K'}, std::byte{0x02}, std::byte{'L'},
  };
  std::array<std::byte, input.size() * 2U> output{};

  const auto result = parser.parse(input, output);

  ASSERT_EQ(result.action_count, 8U);
  EXPECT_EQ(result.bytes, 0U);
  const auto actions = std::span(result.actions);
  EXPECT_EQ((actions.subspan<0, 1>().front().command), PaneCommand::focus_left);
  EXPECT_EQ((actions.subspan<1, 1>().front().command), PaneCommand::focus_down);
  EXPECT_EQ((actions.subspan<2, 1>().front().command), PaneCommand::focus_up);
  EXPECT_EQ((actions.subspan<3, 1>().front().command), PaneCommand::focus_right);
  EXPECT_EQ((actions.subspan<4, 1>().front().command), PaneCommand::swap_pane_left);
  EXPECT_EQ((actions.subspan<5, 1>().front().command), PaneCommand::swap_pane_down);
  EXPECT_EQ((actions.subspan<6, 1>().front().command), PaneCommand::swap_pane_up);
  EXPECT_EQ((actions.subspan<7, 1>().front().command), PaneCommand::swap_pane_right);
}

TEST(ProtocolTest, PrefixParserCapturesRenameAndReorderButPreservesUnboundLegacyKeys) {
  PrefixParser parser;
  const std::array input{
      std::byte{0x02}, std::byte{'R'}, std::byte{0x02}, std::byte{'r'},
      std::byte{0x02}, std::byte{'P'}, std::byte{0x02}, std::byte{'N'},
      std::byte{0x02}, std::byte{'$'}, std::byte{0x02}, std::byte{','},
      std::byte{0x02}, std::byte{'<'}, std::byte{0x02}, std::byte{'>'},
  };
  std::array<std::byte, input.size() * 2U> output{};

  const auto result = parser.parse(input, output);

  ASSERT_EQ(result.action_count, 4U);
  ASSERT_EQ(result.bytes, 8U);
  const auto actions = std::span(result.actions);
  EXPECT_EQ((actions.subspan<0, 1>().front().command), PaneCommand::begin_rename_session);
  EXPECT_EQ((actions.subspan<1, 1>().front().command), PaneCommand::begin_rename_tab);
  EXPECT_EQ((actions.subspan<2, 1>().front().command), PaneCommand::move_tab_left);
  EXPECT_EQ((actions.subspan<3, 1>().front().command), PaneCommand::move_tab_right);
  constexpr std::array expected{
      std::byte{0x02}, std::byte{'$'}, std::byte{0x02}, std::byte{','},
      std::byte{0x02}, std::byte{'<'}, std::byte{0x02}, std::byte{'>'},
  };
  EXPECT_TRUE(std::ranges::equal(std::span(output).first(result.bytes), expected));
}

TEST(ProtocolTest, PrefixParserEntersCopyModeWithoutForwardingBinding) {
  PrefixParser parser;
  const std::array input{std::byte{'a'}, std::byte{0x02}, std::byte{'['}, std::byte{'b'}};
  std::array<std::byte, input.size() * 2U> output{};

  const auto result = parser.parse(input, output);

  ASSERT_EQ(result.action_count, 1U);
  EXPECT_EQ(result.actions.front().command, PaneCommand::enter_copy_mode);
  EXPECT_EQ(result.bytes, 2U);
  EXPECT_EQ(output.front(), std::byte{'a'});
  EXPECT_EQ(std::span(output).subspan(1, 1).front(), std::byte{'b'});
}

TEST(ProtocolTest, PrefixParserCapturesDirectCopySearchWithoutForwardingBinding) {
  PrefixParser parser;
  const std::array input{std::byte{0x02}, std::byte{'/'}, std::byte{0x02}, std::byte{'?'}};
  std::array<std::byte, input.size() * 2U> output{};

  const auto result = parser.parse(input, output);

  ASSERT_EQ(result.action_count, 2U);
  EXPECT_EQ(result.bytes, 0U);
  EXPECT_EQ(result.actions.front().command, PaneCommand::enter_copy_search_forward);
  EXPECT_EQ((std::span(result.actions).subspan<1, 1>().front().command),
            PaneCommand::enter_copy_search_backward);
}

TEST(ProtocolTest, PrefixParserPreservesUnboundFragmentedArrowKey) {
  PrefixParser parser;
  std::array<std::byte, 8> output{};
  const std::array prefix_and_escape{std::byte{0x02}, std::byte{0x1B}};
  const std::array csi{std::byte{'['}};
  const std::array direction{std::byte{'D'}};

  EXPECT_EQ(parser.parse(prefix_and_escape, output).action_count, 0U);
  EXPECT_EQ(parser.parse(csi, output).action_count, 0U);
  const auto result = parser.parse(direction, output);

  EXPECT_EQ(result.action_count, 0U);
  ASSERT_EQ(result.bytes, 4U);
  EXPECT_EQ(output.front(), std::byte{0x02});
  EXPECT_EQ((std::span(output).subspan<1, 1>().front()), std::byte{0x1B});
  EXPECT_EQ((std::span(output).subspan<2, 1>().front()), std::byte{'['});
  EXPECT_EQ((std::span(output).subspan<3, 1>().front()), std::byte{'D'});
  EXPECT_FALSE(parser.has_pending_input());
}

TEST(ProtocolTest, PrefixParserFlushesInterruptedPrefixEscape) {
  PrefixParser parser;
  std::array<std::byte, 8> output{};
  const std::array input{std::byte{0x02}, std::byte{0x1B}};

  EXPECT_EQ(parser.parse(input, output).bytes, 0U);
  ASSERT_EQ(parser.flush_pending(output), 2U);
  EXPECT_EQ(output.front(), std::byte{0x02});
  EXPECT_EQ(std::span(output).subspan(1, 1).front(), std::byte{0x1B});
}

// NOLINTEND(bugprone-unchecked-optional-access)

} // namespace
} // namespace lemma::protocol
