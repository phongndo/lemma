#include "core/input.hpp"

#include "lemma/terminal/terminal.hpp"
#include "protocol/single_pane.hpp"

#include <array>
#include <cstddef>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

#include <gtest/gtest.h>

namespace lemma::core {
namespace {

void write_terminal(vt::Terminal& terminal, const std::string_view bytes) noexcept {
  terminal.write(std::as_bytes(std::span(bytes.data(), bytes.size())));
}

TEST(CoreInputTest, EncodesEnterSemanticallyWhenKittyKeyboardModeIsActive) {
  auto terminal_result = vt::Terminal::create({});
  ASSERT_TRUE(terminal_result.has_value());
  auto terminal = std::move(*terminal_result);
  write_terminal(terminal, "\x1B[>1u");

  PanePtyWriteQueue queue;
  const std::array input{std::byte{'l'}, std::byte{'s'}, std::byte{0x0D}};

  ASSERT_EQ(queue_normalized_input(queue, terminal, input), InputQueueResult::queued);
  std::array<std::byte, input.size()> output{};
  ASSERT_EQ(queue.read(output), output.size());
  EXPECT_EQ(output, input);
}

TEST(CoreInputTest, EncodesTypedPrintableKeyThroughGhostty) {
  auto terminal_result = vt::Terminal::create({});
  ASSERT_TRUE(terminal_result.has_value());
  auto terminal = std::move(*terminal_result);
  PanePtyWriteQueue queue;
  const protocol::KeyInput key{
      .action = protocol::KeyInputAction::press,
      .key = protocol::KeyInputKey::unidentified,
      .modifiers = 0,
      .consumed_modifiers = 0,
      .unshifted_codepoint = '7',
      .composing = false,
  };
  const std::array text{std::byte{'7'}};

  ASSERT_EQ(queue_key_input(queue, terminal, key, text), InputQueueResult::queued);
  std::array<std::byte, 8> output{};
  const auto size = queue.read(output);
  ASSERT_EQ(size, 1U);
  EXPECT_EQ(output.front(), std::byte{'7'});
}

TEST(CoreInputTest, EncodesShiftedAssociatedTextAsTextInLegacyChildMode) {
  auto terminal_result = vt::Terminal::create({});
  ASSERT_TRUE(terminal_result.has_value());
  auto terminal = std::move(*terminal_result);
  PanePtyWriteQueue queue;
  const protocol::KeyInput key{
      .action = protocol::KeyInputAction::press,
      .key = protocol::KeyInputKey::a,
      .modifiers = protocol::key_input_modifier_shift,
      .consumed_modifiers = 0,
      .unshifted_codepoint = 'a',
      .composing = false,
  };
  const std::array text{std::byte{'A'}};

  ASSERT_EQ(queue_key_input(queue, terminal, key, text), InputQueueResult::queued);
  std::array<std::byte, 8> output{};
  const auto size = queue.read(output);
  ASSERT_EQ(size, 1U);
  EXPECT_EQ(output.front(), std::byte{'A'});
}

TEST(CoreInputTest, KeepsTypedPasteOpaqueFromMuxPrefixBytes) {
  auto terminal_result = vt::Terminal::create({});
  ASSERT_TRUE(terminal_result.has_value());
  auto terminal = std::move(*terminal_result);
  write_terminal(terminal, "\x1B[?2004h");
  PanePtyWriteQueue queue;
  std::array input{std::byte{'a'}, std::byte{0x02}, std::byte{'b'}};

  ASSERT_EQ(queue_paste_input(queue, terminal, input), InputQueueResult::queued);
  std::array<std::byte, 15> output{};
  const auto size = queue.read(output);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded(reinterpret_cast<const char*>(output.data()), size);
  EXPECT_EQ(encoded, std::string_view("\x1B[200~a\x02"
                                      "b\x1B[201~",
                                      15));
}

TEST(CoreInputTest, LeavesFullQueueUnchangedForBackpressure) {
  auto terminal_result = vt::Terminal::create({});
  ASSERT_TRUE(terminal_result.has_value());
  auto terminal = std::move(*terminal_result);
  PanePtyWriteQueue queue;
  const std::vector<std::byte> filler(PanePtyWriteQueue::capacity());
  ASSERT_TRUE(queue.append(filler));
  const auto original_size = queue.size();
  const std::array input{std::byte{'x'}};

  EXPECT_EQ(queue_normalized_input(queue, terminal, input), InputQueueResult::full);
  EXPECT_EQ(queue.size(), original_size);
}

TEST(CoreInputTest, SuppliesTextForControlKeys) {
  auto terminal_result = vt::Terminal::create({});
  ASSERT_TRUE(terminal_result.has_value());
  auto terminal = std::move(*terminal_result);

  PanePtyWriteQueue queue;
  const std::array input{std::byte{0x03}};

  ASSERT_EQ(queue_normalized_input(queue, terminal, input), InputQueueResult::queued);
  std::array<std::byte, input.size()> output{};
  ASSERT_EQ(queue.read(output), output.size());
  EXPECT_EQ(output, input);
}

} // namespace
} // namespace lemma::core
