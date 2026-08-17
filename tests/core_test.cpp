#include "core/copy_mode.hpp"
#include "core/session.hpp"
#include "lemma/bounded_byte_queue.hpp"
#include "lemma/command.hpp"
#include "lemma/generational_store.hpp"
#include "lemma/id.hpp"

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <span>
#include <type_traits>

namespace lemma {
namespace {

using core::Attachment;
using core::CopyActionKind;
using core::CopyKey;
using core::CopyKeyKind;
using core::CopyModePhase;
using core::LaunchEnvironmentMode;
using core::Pane;
using core::Session;
using core::Tab;

static_assert(std::is_trivially_copyable_v<Command>);
static_assert(std::is_trivially_copyable_v<CommandResult>);
static_assert(!std::is_same_v<AttachmentId, ConnectionId>);
static_assert(std::is_trivially_destructible_v<Attachment>);

struct CommandCapture final {
  Command command;
  CommandResult result;
  std::size_t calls{0};
  std::size_t observations{0};
};

[[nodiscard]] auto capture_command(void* const context, const Command& command) noexcept
    -> CommandResult {
  auto& capture = *static_cast<CommandCapture*>(context);
  capture.command = command;
  ++capture.calls;
  return {.status = CommandStatus::applied};
}

void observe_command(void* const context, const Command& command,
                     const CommandResult result) noexcept {
  auto& capture = *static_cast<CommandCapture*>(context);
  capture.command = command;
  capture.result = result;
  ++capture.observations;
}

TEST(CommandDispatcherTest, DispatchesValidatedBoundedValue) {
  CommandCapture capture;
  const CommandDispatcher dispatcher(&capture_command, &capture, &observe_command, &capture);
  const Command command{
      .kind = CommandKind::select_tab,
      .origin = CommandOrigin::extension,
      .target = {.session = SessionId::from_parts(2, 3),
                 .tab = TabId::from_parts(4, 5),
                 .pane = {},
                 .peer_pane = {},
                 .attachment = {}},
      .argument = 7,
  };

  const auto result = dispatcher.dispatch(command);

  EXPECT_TRUE(result.succeeded());
  EXPECT_EQ(result.status, CommandStatus::applied);
  EXPECT_EQ(capture.calls, 1U);
  EXPECT_EQ(capture.observations, 1U);
  EXPECT_EQ(capture.result.status, CommandStatus::applied);
  EXPECT_EQ(capture.command.kind, CommandKind::select_tab);
  EXPECT_EQ(capture.command.origin, CommandOrigin::extension);
  EXPECT_EQ(capture.command.target.session, command.target.session);
  EXPECT_EQ(capture.command.target.tab, command.target.tab);
  EXPECT_EQ(capture.command.argument, 7U);
}

TEST(CommandDispatcherTest, DispatchesTypedOneCellResizeCommand) {
  CommandCapture capture;
  const CommandDispatcher dispatcher(&capture_command, &capture);

  const auto result =
      dispatcher.dispatch({.kind = CommandKind::resize_left, .origin = CommandOrigin::keymap});

  EXPECT_EQ(result.status, CommandStatus::applied);
  EXPECT_EQ(capture.calls, 1U);
  EXPECT_EQ(capture.command.kind, CommandKind::resize_left);
  EXPECT_EQ(
      dispatcher
          .dispatch(
              {.kind = CommandKind::resize_right, .origin = CommandOrigin::keymap, .argument = 1})
          .status,
      CommandStatus::invalid_command);
}

TEST(CommandDispatcherTest, DispatchesGenerationSafeDividerResizeCommand) {
  CommandCapture capture;
  const CommandDispatcher dispatcher(&capture_command, &capture);
  const Command command{
      .kind = CommandKind::resize_left_right_divider,
      .origin = CommandOrigin::client,
      .target = {.session = SessionId::from_parts(1, 2),
                 .tab = TabId::from_parts(3, 4),
                 .pane = PaneId::from_parts(5, 6),
                 .peer_pane = PaneId::from_parts(7, 8),
                 .attachment = AttachmentId::from_parts(1, 2)},
      .argument = 45,
  };

  const auto result = dispatcher.dispatch(command);

  EXPECT_EQ(result.status, CommandStatus::applied);
  EXPECT_EQ(capture.calls, 1U);
  EXPECT_EQ(capture.command.kind, CommandKind::resize_left_right_divider);
  EXPECT_EQ(capture.command.target.peer_pane, command.target.peer_pane);
  EXPECT_EQ(capture.command.argument, 45U);
}

TEST(CommandDispatcherTest, RejectsInvalidValuesBeforeExecutor) {
  CommandCapture capture;
  const CommandDispatcher dispatcher(&capture_command, &capture, &observe_command, &capture);

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
                           .target = {.session = {},
                                      .tab = {},
                                      .pane = PaneId::from_parts(1, 1),
                                      .peer_pane = {},
                                      .attachment = {}}})
                .status,
            CommandStatus::invalid_target);
  EXPECT_EQ(dispatcher
                .dispatch({.kind = CommandKind::close_tab,
                           .origin = CommandOrigin::extension,
                           .target = {.session = {},
                                      .tab = TabId::from_parts(1, 1),
                                      .pane = {},
                                      .peer_pane = {},
                                      .attachment = {}}})
                .status,
            CommandStatus::invalid_target);
  EXPECT_EQ(dispatcher
                .dispatch({.kind = CommandKind::detach_client,
                           .origin = CommandOrigin::client,
                           .target = {.session = {},
                                      .tab = {},
                                      .pane = {},
                                      .peer_pane = {},
                                      .attachment = AttachmentId::from_parts(1, 1)}})
                .status,
            CommandStatus::invalid_target);
  EXPECT_EQ(
      dispatcher
          .dispatch(
              {.kind = CommandKind::focus_next, .origin = CommandOrigin::client, .argument = 1})
          .status,
      CommandStatus::invalid_command);
  EXPECT_EQ(dispatcher
                .dispatch({.kind = CommandKind::resize_left_right_divider,
                           .origin = CommandOrigin::client,
                           .target = {.session = SessionId::from_parts(1, 1),
                                      .tab = TabId::from_parts(1, 1),
                                      .pane = PaneId::from_parts(1, 1),
                                      .peer_pane = {},
                                      .attachment = AttachmentId::from_parts(1, 1)},
                           .argument = 10})
                .status,
            CommandStatus::invalid_target);
  EXPECT_EQ(dispatcher
                .dispatch({.kind = CommandKind::focus_next,
                           .origin = CommandOrigin::client,
                           .target = {.session = SessionId::from_parts(1, 1),
                                      .tab = TabId::from_parts(1, 1),
                                      .pane = PaneId::from_parts(1, 1),
                                      .peer_pane = PaneId::from_parts(2, 1),
                                      .attachment = AttachmentId::from_parts(1, 1)}})
                .status,
            CommandStatus::invalid_target);
  EXPECT_EQ(capture.calls, 0U);
  EXPECT_EQ(capture.observations, 8U);

  const CommandDispatcher missing_executor(nullptr, nullptr);
  EXPECT_EQ(missing_executor
                .dispatch({.kind = CommandKind::focus_next, .origin = CommandOrigin::internal})
                .status,
            CommandStatus::failed);
}

TEST(SessionModelTest, ConstructsPureSemanticHierarchyAndAttachment) {
  constexpr std::array environment{std::byte{'A'}, std::byte{'='}, std::byte{'1'}, std::byte{0}};
  Session session("semantic", "/tmp", environment, LaunchEnvironmentMode::replace);
  session.id = SessionId::from_parts(3, 7);
  auto pane = std::make_unique<Pane>();
  const auto tab_id = TabId::from_parts(2, 5);
  Tab tab(tab_id, std::move(pane));
  Attachment attachment{
      .id = AttachmentId::from_parts(3, 7),
      .session = session.id,
      .columns = 120,
      .rows = 40,
      .selection_target = {},
      .mouse_capture = {},
      .copy_mode = {},
  };

  EXPECT_EQ(session.session_name(), "semantic");
  EXPECT_EQ(session.cwd(), "/tmp");
  EXPECT_TRUE(std::ranges::equal(session.launch_environment(), environment));
  EXPECT_EQ(session.environment_mode, LaunchEnvironmentMode::replace);
  EXPECT_EQ(tab.id, tab_id);
  EXPECT_EQ(tab.focused_pane, PaneId::from_parts(0, 1));
  EXPECT_EQ(tab.previous_pane, tab.focused_pane);
  EXPECT_EQ(attachment.session, session.id);
  EXPECT_EQ(attachment.columns, 120U);
  EXPECT_EQ(attachment.rows, 40U);
}

TEST(CopyModeCoreTest, ReducesVimChordsAndPhaseSpecificEscapeWithoutTerminalState) {
  core::CopyModeState state;
  state.phase = CopyModePhase::navigation;

  EXPECT_EQ(core::copy_action_for_key(state, CopyKey{.byte = static_cast<std::uint8_t>('g')}).kind,
            CopyActionKind::none);
  EXPECT_EQ(state.pending_chord, core::CopyPendingChord::go);
  EXPECT_EQ(core::copy_action_for_key(state, CopyKey{.byte = static_cast<std::uint8_t>('g')}).kind,
            CopyActionKind::history_top);
  EXPECT_EQ(state.pending_chord, core::CopyPendingChord::none);

  state.phase = CopyModePhase::visual_line;
  EXPECT_EQ(core::copy_action_for_key(state, CopyKey{.kind = CopyKeyKind::escape}).kind,
            CopyActionKind::cancel_selection);
  state.phase = CopyModePhase::navigation;
  EXPECT_EQ(core::copy_action_for_key(state, CopyKey{.kind = CopyKeyKind::escape}).kind,
            CopyActionKind::leave);
}

TEST(CopyModeCoreTest, ReducesSearchPromptEditingAndCoherentMotionSet) {
  core::CopyModeState state;
  state.phase = CopyModePhase::search_prompt;

  const auto append =
      core::copy_action_for_key(state, CopyKey{.byte = static_cast<std::uint8_t>('n')});
  EXPECT_EQ(append.kind, CopyActionKind::query_append);
  EXPECT_EQ(append.byte, static_cast<std::uint8_t>('n'));
  EXPECT_EQ(core::copy_action_for_key(state, CopyKey{.kind = CopyKeyKind::backspace}).kind,
            CopyActionKind::query_backspace);
  EXPECT_EQ(core::copy_action_for_key(state, CopyKey{.kind = CopyKeyKind::enter}).kind,
            CopyActionKind::commit_search);
  EXPECT_EQ(core::copy_action_for_key(state, CopyKey{.kind = CopyKeyKind::arrow_up}).kind,
            CopyActionKind::none);

  state.phase = CopyModePhase::searching;
  EXPECT_EQ(core::copy_action_for_key(state, CopyKey{.byte = static_cast<std::uint8_t>('n')}).kind,
            CopyActionKind::none);
  EXPECT_EQ(core::copy_action_for_key(state, CopyKey{.kind = CopyKeyKind::escape}).kind,
            CopyActionKind::cancel_search);

  state.phase = CopyModePhase::navigation;
  EXPECT_EQ(core::copy_action_for_key(state, CopyKey{.byte = static_cast<std::uint8_t>('e')}).kind,
            CopyActionKind::word_end);
  EXPECT_EQ(core::copy_action_for_key(state, CopyKey{.byte = static_cast<std::uint8_t>('H')}).kind,
            CopyActionKind::viewport_top);
  EXPECT_EQ(core::copy_action_for_key(state, CopyKey{.byte = 0x15}).kind,
            CopyActionKind::half_page_up);
  EXPECT_EQ(core::copy_action_for_key(state, CopyKey{.byte = 0x16}).kind,
            CopyActionKind::visual_block);
}

TEST(CopyModeCoreTest, KeepsSearchMatchesInCentralSafeZoneAndCentersOutsideIt) {
  EXPECT_EQ(core::copy_search_viewport_offset(45, 40, 20, 100), 40U);
  EXPECT_EQ(core::copy_search_viewport_offset(54, 40, 20, 100), 40U);
  EXPECT_EQ(core::copy_search_viewport_offset(44, 40, 20, 100), 34U);
  EXPECT_EQ(core::copy_search_viewport_offset(55, 40, 20, 100), 45U);
  EXPECT_EQ(core::copy_search_viewport_offset(2, 40, 20, 100), 0U);
  EXPECT_EQ(core::copy_search_viewport_offset(99, 0, 20, 100), 80U);
  EXPECT_EQ(core::copy_search_viewport_offset(7, 4, 20, 10), 0U);
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

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(BoundedGenerationalStoreTest, RejectsStaleIdsAndReportsCapacity) {
  struct Value final {
    int number{0};
  };
  BoundedGenerationalStore<Value, SessionId, 2> store;

  const auto first = store.insert(std::make_unique<Value>(Value{.number = 7}));
  const auto second = store.insert(std::make_unique<Value>(Value{.number = 9}));
  ASSERT_TRUE(first.has_value());
  ASSERT_TRUE(second.has_value());
  const auto first_id = first.value_or(SessionId{});
  const auto second_id = second.value_or(SessionId{});
  EXPECT_EQ(store.size(), 2U);
  EXPECT_EQ(store.get(first_id)->number, 7);
  EXPECT_EQ(store.get(second_id)->number, 9);
  EXPECT_FALSE(store.insert(std::make_unique<Value>()).has_value());

  ASSERT_TRUE(store.erase(first_id));
  EXPECT_FALSE(store.contains(first_id));
  EXPECT_EQ(store.get(first_id), nullptr);
  const auto replacement = store.insert(std::make_unique<Value>(Value{.number = 11}));
  ASSERT_TRUE(replacement.has_value());
  const auto replacement_id = replacement.value_or(SessionId{});
  EXPECT_EQ(replacement_id.slot(), first_id.slot());
  EXPECT_NE(replacement_id.generation(), first_id.generation());
  EXPECT_EQ(store.get(replacement_id)->number, 11);
  EXPECT_FALSE(store.erase(first_id));
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(BoundedGenerationalStoreTest, DeterministicChurnNeverRevivesStaleIds) {
  struct Value final {
    std::uint32_t number{0};
  };
  BoundedGenerationalStore<Value, PaneId, 8> store;
  std::array<PaneId, 8> live{};
  std::array<PaneId, 512> stale{};
  std::size_t stale_count = 0;
  std::uint32_t random = 0xC0FFEEU;

  for (std::uint32_t operation = 0; operation < 4'096U; ++operation) {
    random = (random * 1'664'525U) + 1'013'904'223U;
    const auto slot = static_cast<std::size_t>(random % live.size());
    auto& live_id = std::span(live).subspan(slot, 1).front();
    if (live_id.is_valid()) {
      ASSERT_TRUE(store.erase(live_id));
      std::span(stale).subspan(stale_count % stale.size(), 1).front() = live_id;
      ++stale_count;
      live_id = {};
    } else {
      const auto id = store.insert(std::make_unique<Value>(Value{.number = operation}));
      ASSERT_TRUE(id.has_value());
      const auto inserted = id.value_or(PaneId{});
      live_id = inserted;
      EXPECT_EQ(store.get(inserted)->number, operation);
    }
    const auto retained = std::min(stale_count, stale.size());
    for (std::size_t index = 0; index < retained; ++index) {
      EXPECT_EQ(store.get(std::span(stale).subspan(index, 1).front()), nullptr);
    }
  }
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
