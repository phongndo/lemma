#include "lemma/bounded_byte_queue.hpp"
#include "lemma/command.hpp"
#include "lemma/id.hpp"

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <span>
#include <type_traits>

namespace lemma {
namespace {

static_assert(std::is_trivially_copyable_v<Command>);
static_assert(std::is_trivially_copyable_v<CommandResult>);

struct CommandCapture final {
  Command command;
  std::size_t calls{0};
};

[[nodiscard]] auto capture_command(void* const context, const Command& command) noexcept
    -> CommandResult {
  auto& capture = *static_cast<CommandCapture*>(context);
  capture.command = command;
  ++capture.calls;
  return {.status = CommandStatus::applied};
}

TEST(CommandDispatcherTest, DispatchesValidatedBoundedValue) {
  CommandCapture capture;
  const CommandDispatcher dispatcher(&capture_command, &capture);
  const Command command{
      .kind = CommandKind::select_tab,
      .origin = CommandOrigin::extension,
      .target = {.session = SessionId::from_parts(2, 3),
                 .tab = TabId::from_parts(4, 5),
                 .pane = {}},
      .argument = 7,
  };

  const auto result = dispatcher.dispatch(command);

  EXPECT_TRUE(result.succeeded());
  EXPECT_EQ(result.status, CommandStatus::applied);
  EXPECT_EQ(capture.calls, 1U);
  EXPECT_EQ(capture.command.kind, CommandKind::select_tab);
  EXPECT_EQ(capture.command.origin, CommandOrigin::extension);
  EXPECT_EQ(capture.command.target.session, command.target.session);
  EXPECT_EQ(capture.command.target.tab, command.target.tab);
  EXPECT_EQ(capture.command.argument, 7U);
}

TEST(CommandDispatcherTest, RejectsInvalidValuesBeforeExecutor) {
  CommandCapture capture;
  const CommandDispatcher dispatcher(&capture_command, &capture);

  EXPECT_EQ(dispatcher.dispatch({}).status, CommandStatus::invalid_command);
  EXPECT_EQ(dispatcher
                .dispatch({.kind = CommandKind::select_tab,
                           .origin = CommandOrigin::client,
                           .argument = command_tab_slots_max})
                .status,
            CommandStatus::invalid_command);
  EXPECT_EQ(dispatcher
                .dispatch({.kind = CommandKind::close_pane,
                           .origin = CommandOrigin::client,
                           .target = {.session = {}, .tab = {}, .pane = PaneId::from_parts(1, 1)}})
                .status,
            CommandStatus::invalid_target);
  EXPECT_EQ(
      dispatcher
          .dispatch(
              {.kind = CommandKind::focus_next, .origin = CommandOrigin::client, .argument = 1})
          .status,
      CommandStatus::invalid_command);
  EXPECT_EQ(capture.calls, 0U);

  const CommandDispatcher missing_executor(nullptr, nullptr);
  EXPECT_EQ(missing_executor
                .dispatch({.kind = CommandKind::focus_next, .origin = CommandOrigin::internal})
                .status,
            CommandStatus::failed);
}

TEST(GenerationalIdTest, InvalidUntilCreatedFromValidParts) {
  const SessionId invalid;
  const auto session = SessionId::from_parts(7, 3);

  EXPECT_FALSE(invalid.is_valid());
  EXPECT_FALSE(SessionId::try_from_parts(7, 0).has_value());
  EXPECT_FALSE(SessionId::try_from_parts(std::numeric_limits<std::uint32_t>::max(), 3).has_value());
  EXPECT_TRUE(session.is_valid());
  EXPECT_EQ(session.slot(), 7U);
  EXPECT_EQ(session.generation(), 3U);
}

TEST(BoundedByteQueueTest, PreservesOrderAcrossWraparound) {
  BoundedByteQueue<5> queue;
  const std::array first{std::byte{1}, std::byte{2}, std::byte{3}, std::byte{4}};
  ASSERT_TRUE(queue.append(first));

  std::array<std::byte, 3> first_output{};
  EXPECT_EQ(queue.read(first_output), first_output.size());
  EXPECT_THAT(first_output, testing::ElementsAre(std::byte{1}, std::byte{2}, std::byte{3}));

  const std::array second{std::byte{5}, std::byte{6}, std::byte{7}};
  ASSERT_TRUE(queue.append(second));

  std::array<std::byte, 4> second_output{};
  EXPECT_EQ(queue.read(second_output), second_output.size());
  EXPECT_THAT(second_output,
              testing::ElementsAre(std::byte{4}, std::byte{5}, std::byte{6}, std::byte{7}));
  EXPECT_TRUE(queue.empty());
}

TEST(BoundedByteQueueTest, ExposesAndConsumesContiguousReadableSegments) {
  BoundedByteQueue<5> queue;
  const std::array first{std::byte{1}, std::byte{2}, std::byte{3}, std::byte{4}};
  ASSERT_TRUE(queue.append(first));
  ASSERT_TRUE(queue.consume(3));
  const std::array second{std::byte{5}, std::byte{6}, std::byte{7}};
  ASSERT_TRUE(queue.append(second));

  EXPECT_THAT(queue.readable_span(), testing::ElementsAre(std::byte{4}, std::byte{5}));
  EXPECT_FALSE(queue.consume(5));
  EXPECT_EQ(queue.size(), 4U);
  ASSERT_TRUE(queue.consume(2));
  EXPECT_THAT(queue.readable_span(), testing::ElementsAre(std::byte{6}, std::byte{7}));
  ASSERT_TRUE(queue.consume(2));
  EXPECT_TRUE(queue.empty());
  EXPECT_TRUE(queue.readable_span().empty());
}

TEST(BoundedByteQueueTest, ReusesFullStorageAfterPartialConsumption) {
  BoundedByteQueue<3> queue;
  const std::array full{std::byte{1}, std::byte{2}, std::byte{3}};
  ASSERT_TRUE(queue.append(full));
  EXPECT_EQ(queue.readable_span().size(), full.size());
  ASSERT_TRUE(queue.consume(2));
  const std::array reused{std::byte{4}, std::byte{5}};
  ASSERT_TRUE(queue.append(reused));

  std::array<std::byte, 3> output{};
  EXPECT_EQ(queue.read(output), output.size());
  EXPECT_THAT(output, testing::ElementsAre(std::byte{3}, std::byte{4}, std::byte{5}));
}

TEST(BoundedByteQueueTest, RejectsInputWithoutPartiallyAppending) {
  BoundedByteQueue<3> queue;
  const std::array first{std::byte{1}, std::byte{2}};
  const std::array too_large{std::byte{3}, std::byte{4}};

  ASSERT_TRUE(queue.append(first));
  EXPECT_FALSE(queue.append(too_large));
  EXPECT_EQ(queue.size(), first.size());

  std::array<std::byte, 3> output{};
  EXPECT_EQ(queue.read(output), first.size());
  EXPECT_THAT(std::span(output).first(first.size()),
              testing::ElementsAre(std::byte{1}, std::byte{2}));
}

} // namespace
} // namespace lemma
