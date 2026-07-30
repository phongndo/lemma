#include "core/input.hpp"

#include "fiber/terminal/terminal.hpp"

#include <array>
#include <cstddef>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

#include <gtest/gtest.h>

namespace fiber::core {
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
} // namespace fiber::core
