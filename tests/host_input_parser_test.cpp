#include "client/host_input_parser.hpp"

#include <gtest/gtest.h>

#include <array>
#include <cstddef>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace lemma::client {
namespace {

struct ObservedEvent final {
  HostInputKind kind{HostInputKind::ordinary};
  std::string bytes;
  protocol::KeyInput key{};
  protocol::FocusInput focus{protocol::FocusInput::lost};
  protocol::MouseInput mouse{};
};

void collect(const HostInputBatch& batch, const std::span<const std::byte> storage,
             std::vector<ObservedEvent>& output) {
  for (const auto& event : std::span(batch.events).first(batch.event_count)) {
    const auto bytes = storage.subspan(event.offset, event.size);
    output.push_back({
        .kind = event.kind,
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
        .bytes = std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size()),
        .key = event.key,
        .focus = event.focus,
        .mouse = event.mouse,
    });
  }
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(HostInputParserTest, PreservesTypedBoundariesAcrossEveryFragmentationPoint) {
  constexpr std::string_view encoded = "x\x1B[200~paste\x02"
                                       "bytes\x1B[201~\x1B[I\x1B[<0;5;3My";
  const auto encoded_bytes = std::as_bytes(std::span(encoded));
  for (std::size_t split = 0; split <= encoded.size(); ++split) {
    HostInputParser parser;
    ASSERT_TRUE(parser.prepare().has_value());
    std::vector<ObservedEvent> observed;
    const auto first = encoded_bytes.first(split);
    const auto second = encoded_bytes.subspan(split);
    std::array<std::byte, protocol::input_bytes_max * 2U> storage{};
    const auto first_batch = parser.parse(first, storage, {.columns = 80, .rows = 24});
    ASSERT_TRUE(first_batch.has_value()) << split;
    collect(*first_batch, storage, observed);
    const auto second_batch = parser.parse(second, storage, {.columns = 80, .rows = 24});
    ASSERT_TRUE(second_batch.has_value()) << split;
    collect(*second_batch, storage, observed);
    ASSERT_FALSE(parser.has_pending_sequence()) << split;

    ASSERT_EQ(observed.size(), 5U) << split;
    EXPECT_EQ(observed.at(0).kind, HostInputKind::ordinary);
    EXPECT_EQ(observed.at(0).bytes, "x");
    EXPECT_EQ(observed.at(1).kind, HostInputKind::paste);
    EXPECT_EQ(observed.at(1).bytes, std::string("paste\x02"
                                                "bytes",
                                                11));
    EXPECT_EQ(observed.at(2).kind, HostInputKind::focus);
    EXPECT_EQ(observed.at(2).focus, protocol::FocusInput::gained);
    EXPECT_EQ(observed.at(3).kind, HostInputKind::mouse);
    EXPECT_EQ(observed.at(3).mouse.action, protocol::MouseInputAction::press);
    EXPECT_EQ(observed.at(3).mouse.button, protocol::MouseInputButton::left);
    EXPECT_EQ(observed.at(3).mouse.column, 4);
    EXPECT_EQ(observed.at(3).mouse.row, 2);
    EXPECT_EQ(observed.at(3).mouse.geometry, (protocol::Dimensions{.columns = 80, .rows = 24}));
    EXPECT_EQ(observed.at(4).kind, HostInputKind::ordinary);
    EXPECT_EQ(observed.at(4).bytes, "y");
  }
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(HostInputParserTest, DecodesKittyKeyMetadataAcrossEveryFragmentationPoint) {
  constexpr std::string_view encoded = "\x1B[98;5:1;98u\x1B[57352;1:2u";
  const auto input = std::as_bytes(std::span(encoded));
  for (std::size_t split = 0; split <= input.size(); ++split) {
    HostInputParser parser;
    ASSERT_TRUE(parser.prepare().has_value());
    std::array<std::byte, 64> storage{};
    std::vector<HostInputEvent> events;
    for (const auto fragment : {std::span(input).first(split), std::span(input).subspan(split)}) {
      const auto parsed = parser.parse(fragment, storage, {.columns = 80, .rows = 24});
      ASSERT_TRUE(parsed.has_value()) << split;
      for (const auto& event : std::span(parsed->events).first(parsed->event_count)) {
        events.push_back(event);
      }
    }
    ASSERT_EQ(events.size(), 2U) << split;
    EXPECT_EQ(events.at(0).kind, HostInputKind::key);
    EXPECT_EQ(events.at(0).key.key, protocol::KeyInputKey::b);
    EXPECT_EQ(events.at(0).key.modifiers, protocol::key_input_modifier_control);
    EXPECT_EQ(events.at(0).key.action, protocol::KeyInputAction::press);
    EXPECT_EQ(events.at(0).size, 1U);
    EXPECT_EQ(events.at(1).kind, HostInputKind::key);
    EXPECT_EQ(events.at(1).key.key, protocol::KeyInputKey::arrow_up);
    EXPECT_EQ(events.at(1).key.action, protocol::KeyInputAction::repeat);
    EXPECT_EQ(events.at(1).size, 0U);
  }
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(HostInputParserTest, DecodesGhosttyAssociatedTextWithDefaultModifierField) {
  constexpr std::string_view encoded = "\x1B[108;;108u";
  const auto input = std::as_bytes(std::span(encoded));
  for (std::size_t split = 0; split <= input.size(); ++split) {
    HostInputParser parser;
    ASSERT_TRUE(parser.prepare().has_value());
    std::array<std::byte, 64> storage{};
    std::vector<ObservedEvent> events;
    for (const auto fragment : {std::span(input).first(split), std::span(input).subspan(split)}) {
      const auto parsed = parser.parse(fragment, storage, {.columns = 80, .rows = 24});
      ASSERT_TRUE(parsed.has_value()) << split;
      collect(*parsed, storage, events);
    }
    ASSERT_EQ(events.size(), 1U) << split;
    EXPECT_EQ(events.front().kind, HostInputKind::key);
    EXPECT_EQ(events.front().key.key, protocol::KeyInputKey::l);
    EXPECT_EQ(events.front().key.unshifted_codepoint, static_cast<std::uint32_t>('l'));
    EXPECT_EQ(events.front().bytes, "l");
  }
}

TEST(HostInputParserTest, LeavesUnknownEscapeSequenceAsOrdinaryInput) {
  HostInputParser parser;
  ASSERT_TRUE(parser.prepare().has_value());
  std::array<std::byte, 64> storage{};
  constexpr std::string_view first = "\x1B[";
  constexpr std::string_view second = "A";
  ASSERT_TRUE(parser.parse(std::as_bytes(std::span(first)), storage, {.columns = 80, .rows = 24})
                  .has_value());
  const auto parsed =
      parser.parse(std::as_bytes(std::span(second)), storage, {.columns = 80, .rows = 24});
  ASSERT_TRUE(parsed.has_value());
  ASSERT_EQ(parsed->event_count, 1U);
  const auto event = parsed->events.front();
  ASSERT_EQ(event.kind, HostInputKind::ordinary);
  const auto bytes = std::span(storage).subspan(event.offset, event.size);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size()), "\x1B[A");
}

} // namespace
} // namespace lemma::client
