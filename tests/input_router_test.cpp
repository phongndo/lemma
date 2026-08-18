#include "input/input_router.hpp"

#include <gtest/gtest.h>

#include <array>
#include <cstddef>
#include <span>
#include <variant>

namespace lemma::input {
namespace {

TEST(InputMapTest, RejectsDuplicateBindingsBeforePublication) {
  InputMapDraft draft;
  const auto normal = draft.add_context({});
  ASSERT_TRUE(normal.has_value());
  ASSERT_TRUE(draft.bind(*normal, InputChord::byte('x'), invoke(InputCommand::close_pane)));
  ASSERT_TRUE(draft.bind(*normal, InputChord::byte('x'), invoke(InputCommand::toggle_zoom)));

  const auto compiled = draft.compile();

  ASSERT_FALSE(compiled.has_value());
  EXPECT_EQ(compiled.error(), InputMapError::duplicate_binding);
}

TEST(InputMapTest, RejectsUnresolvedContextTransitionsBeforePublication) {
  InputMapDraft draft;
  const auto normal = draft.add_context({});
  ASSERT_TRUE(normal.has_value());
  ASSERT_TRUE(draft.bind(*normal, InputChord::byte('m'), EnterContextBinding{}));

  const auto compiled = draft.compile();

  ASSERT_FALSE(compiled.has_value());
  EXPECT_EQ(compiled.error(), InputMapError::invalid_context);
}

TEST(InputMapTest, RejectsInvalidCommandDiscriminantsBeforePublication) {
  InputMapDraft draft;
  const auto normal = draft.add_context({});
  ASSERT_TRUE(normal.has_value());
  ASSERT_TRUE(draft.bind(*normal, InputChord::byte('x'),
                         CommandBinding{.command = InputCommand::count,
                                        .context = CommandContextDisposition::retain}));

  const auto compiled = draft.compile();

  ASSERT_FALSE(compiled.has_value());
  EXPECT_EQ(compiled.error(), InputMapError::invalid_action);
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(InputMapTest, RejectsContextGraphsThatCannotFitTheRuntimeStack) {
  InputMapDraft draft;
  std::array<InputContextId, input_context_stack_max + 1U> contexts{};
  for (auto& stored : contexts) {
    const auto context = draft.add_context({});
    ASSERT_TRUE(context.has_value());
    stored = *context;
  }
  for (std::size_t index = 1; index < contexts.size(); ++index) {
    const auto enter = enter_context(contexts.at(index));
    ASSERT_TRUE(enter.has_value());
    ASSERT_TRUE(draft.bind(contexts.at(index - 1U), InputChord::byte('a'), *enter));
  }

  const auto compiled = draft.compile();

  ASSERT_FALSE(compiled.has_value());
  EXPECT_EQ(compiled.error(), InputMapError::context_depth);
}

TEST(InputMapTest, RequiresAValidInvariantPreservingBaseContext) {
  InputMapDraft empty;
  EXPECT_EQ(empty.compile().error(), InputMapError::missing_base);

  InputMapDraft invalid_base;
  const auto context = invalid_base.add_context({.label = {},
                                                 .lifetime = ContextLifetime::one_shot,
                                                 .unbound = UnboundBehavior::replay_deferred,
                                                 .preempts_interaction = false});
  ASSERT_FALSE(context.has_value());
  EXPECT_EQ(context.error(), InputMapError::invalid_options);

  InputMapDraft invalid_label;
  const auto control_label = invalid_label.add_context({.label = "\n"});
  ASSERT_FALSE(control_label.has_value());
  EXPECT_EQ(control_label.error(), InputMapError::invalid_options);
}

TEST(InputRouterTest, PreservesUnboundRunsAndRoutesOneShotPrefixCommands) {
  InputRouter router(default_input_map());
  const std::array input{std::byte{'a'}, std::byte{'b'}, std::byte{0x02}, std::byte{'h'}};

  EXPECT_FALSE(router.legacy_route_requires_checkpoint());
  const auto ordinary = router.route_legacy(input, input.size());
  ASSERT_EQ(ordinary.consumed, 2U);
  const auto* const forwarded = std::get_if<ForwardLegacyInput>(&ordinary.effect);
  ASSERT_NE(forwarded, nullptr);
  EXPECT_TRUE(forwarded->prefix_size == 0U && forwarded->current.size() == 2U);

  const auto prefix = router.route_legacy(std::span(input).subspan(2), 2);
  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(prefix.effect));
  EXPECT_EQ(prefix.consumed, 1U);
  EXPECT_TRUE(router.active_label().empty());
  EXPECT_TRUE(router.legacy_route_requires_checkpoint());

  const auto command = router.route_legacy(std::span(input).subspan(3), 1);
  const auto* const routed = std::get_if<RoutedCommand>(&command.effect);
  ASSERT_NE(routed, nullptr);
  EXPECT_EQ(routed->command, InputCommand::focus_left);
  EXPECT_TRUE(router.active_label().empty());
  EXPECT_FALSE(router.legacy_route_requires_checkpoint());
}

TEST(InputRouterTest, ReplaysAnUnboundPrefixWithoutLosingInput) {
  InputRouter router(default_input_map());
  constexpr std::array prefix{std::byte{0x02}};
  constexpr std::array unbound{std::byte{'!'}};
  ASSERT_TRUE(std::holds_alternative<ConsumedInput>(router.route_legacy(prefix, 1).effect));

  const auto result = router.route_legacy(unbound, 1);

  const auto* const forwarded = std::get_if<ForwardLegacyInput>(&result.effect);
  ASSERT_NE(forwarded, nullptr);
  ASSERT_EQ(forwarded->prefix_size, 1U);
  EXPECT_EQ(forwarded->prefix.front(), std::byte{0x02});
  ASSERT_EQ(forwarded->current.size(), 1U);
  EXPECT_EQ(forwarded->current.front(), std::byte{'!'});
  EXPECT_TRUE(router.active_label().empty());
}

TEST(InputRouterTest, StopsLegacyBatchBeforeAResolvableEscapeChord) {
  InputMapDraft draft;
  const auto normal = draft.add_context({});
  ASSERT_TRUE(normal.has_value());
  ASSERT_TRUE(draft.bind(*normal, InputChord::key(PhysicalKey::arrow_left),
                         invoke(InputCommand::resize_left)));
  const auto map = draft.compile();
  ASSERT_TRUE(map.has_value());
  InputRouter router(*map);
  constexpr std::array input{std::byte{'x'}, std::byte{0x1B}, std::byte{'['}, std::byte{'D'}};

  const auto ordinary = router.route_legacy(input, input.size());
  ASSERT_NE(std::get_if<ForwardLegacyInput>(&ordinary.effect), nullptr);
  EXPECT_EQ(ordinary.consumed, 1U);

  const auto arrow = router.route_legacy(std::span(input).subspan(1), input.size() - 1U);
  ASSERT_NE(std::get_if<RoutedCommand>(&arrow.effect), nullptr);
  EXPECT_EQ(std::get<RoutedCommand>(arrow.effect).command, InputCommand::resize_left);
  EXPECT_EQ(arrow.consumed, 3U);
}

TEST(InputRouterTest, OneShotForwardContextReturnsToItsParentBeforeTheNextByte) {
  InputMapDraft draft;
  const auto normal = draft.add_context({});
  const auto one_shot = draft.add_context({.label = " ONCE ",
                                           .lifetime = ContextLifetime::one_shot,
                                           .unbound = UnboundBehavior::forward,
                                           .preempts_interaction = false});
  ASSERT_TRUE(normal.has_value() && one_shot.has_value());
  const auto enter = enter_context(*one_shot);
  ASSERT_TRUE(enter.has_value());
  ASSERT_TRUE(draft.bind(*normal, InputChord::byte('x'), *enter));
  const auto map = draft.compile();
  ASSERT_TRUE(map.has_value());
  InputRouter router(*map);
  constexpr std::array enter_and_text{std::byte{'x'}, std::byte{'a'}, std::byte{'b'}};

  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(
      router.route_legacy(enter_and_text, enter_and_text.size()).effect));
  const auto forwarded =
      router.route_legacy(std::span(enter_and_text).subspan(1), enter_and_text.size() - 1U);

  ASSERT_NE(std::get_if<ForwardLegacyInput>(&forwarded.effect), nullptr);
  EXPECT_EQ(forwarded.consumed, 1U);
  EXPECT_TRUE(forwarded.presentation_changed);
  EXPECT_TRUE(router.active_label().empty());
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(InputRouterTest, TransientResizeContextRepeatsAndExitsWithoutCoreModeState) {
  InputRouter router(default_input_map());
  constexpr std::array enter{std::byte{0x02}, std::byte{'m'}};
  ASSERT_TRUE(std::holds_alternative<ConsumedInput>(router.route_legacy(enter, 2).effect));
  const auto entered = router.route_legacy(std::span(enter).subspan(1), 1);
  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(entered.effect));
  EXPECT_TRUE(entered.presentation_changed);
  EXPECT_TRUE(entered.interaction_preemption_requested);
  EXPECT_EQ(router.active_label(), " RESIZE ");
  EXPECT_FALSE(router.legacy_route_requires_checkpoint());

  constexpr std::array directions{std::byte{'h'}, std::byte{'h'}, std::byte{'j'}};
  for (std::size_t index = 0; index < directions.size(); ++index) {
    const auto routed = router.route_legacy(std::span(directions).subspan(index), 1);
    const auto* const command = std::get_if<RoutedCommand>(&routed.effect);
    ASSERT_NE(command, nullptr);
    EXPECT_EQ(command->command, index < 2U ? InputCommand::resize_left : InputCommand::resize_down);
    EXPECT_EQ(router.active_label(), " RESIZE ");
  }

  constexpr std::array legacy_arrow{std::byte{0x1B}, std::byte{'['}, std::byte{'D'}};
  const auto arrow_command = router.route_legacy(legacy_arrow, legacy_arrow.size());
  ASSERT_NE(std::get_if<RoutedCommand>(&arrow_command.effect), nullptr);
  EXPECT_EQ(std::get<RoutedCommand>(arrow_command.effect).command, InputCommand::resize_left);
  EXPECT_EQ(arrow_command.consumed, legacy_arrow.size());

  constexpr std::array nested_prefix{std::byte{0x02}, std::byte{'z'}};
  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(router.route_legacy(nested_prefix, 2).effect));
  const auto nested_command = router.route_legacy(std::span(nested_prefix).subspan(1), 1);
  ASSERT_NE(std::get_if<RoutedCommand>(&nested_command.effect), nullptr);
  EXPECT_EQ(std::get<RoutedCommand>(nested_command.effect).command, InputCommand::toggle_zoom);
  EXPECT_EQ(router.active_label(), " RESIZE ");

  constexpr std::array rename{std::byte{0x02}, std::byte{'r'}};
  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(router.route_legacy(rename, 2).effect));
  const auto rename_command = router.route_legacy(std::span(rename).subspan(1), 1);
  ASSERT_NE(std::get_if<RoutedCommand>(&rename_command.effect), nullptr);
  EXPECT_EQ(std::get<RoutedCommand>(rename_command.effect).command, InputCommand::begin_rename_tab);
  EXPECT_TRUE(router.active_label().empty());

  ASSERT_TRUE(std::holds_alternative<ConsumedInput>(router.route_legacy(enter, 2).effect));
  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(
      router.route_legacy(std::span(enter).subspan(1), 1).effect));
  EXPECT_EQ(router.active_label(), " RESIZE ");

  constexpr std::array leave{std::byte{'q'}};
  const auto exited = router.route_legacy(leave, 1);
  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(exited.effect));
  EXPECT_TRUE(exited.presentation_changed);
  EXPECT_TRUE(router.active_label().empty());
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(InputRouterTest, TypedKeyOwnershipSurvivesContextTransitionsAndRepeats) {
  InputRouter router(default_input_map());
  const auto key = [](const KeyAction action, const PhysicalKey physical,
                      const std::uint16_t modifiers, const std::uint32_t codepoint) {
    return KeyEvent{.action = action,
                    .key = physical,
                    .modifiers = modifiers,
                    .unshifted_codepoint = codepoint,
                    .text = {}};
  };
  const auto prefix_press = key(KeyAction::press, PhysicalKey::b, key_modifier_control, 'b');
  const auto prefix_release = key(KeyAction::release, PhysicalKey::b, key_modifier_control, 'b');
  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(router.route_key(prefix_press).effect));
  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(router.route_key(prefix_release).effect));

  const auto unbound_press = key(KeyAction::press, PhysicalKey::e, 0, 'e');
  const auto unbound_release = key(KeyAction::release, PhysicalKey::e, 0, 'e');
  EXPECT_TRUE(
      std::holds_alternative<ForwardBytesThenCurrentKey>(router.route_key(unbound_press).effect));
  EXPECT_TRUE(std::holds_alternative<ForwardCurrentKey>(router.route_key(unbound_release).effect));

  const auto held_press = key(KeyAction::press, PhysicalKey::h, 0, 'h');
  const auto held_repeat = key(KeyAction::repeat, PhysicalKey::h, 0, 'h');
  const auto held_release = key(KeyAction::release, PhysicalKey::h, 0, 'h');
  EXPECT_TRUE(std::holds_alternative<ForwardCurrentKey>(router.route_key(held_press).effect));
  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(router.route_key(prefix_press).effect));
  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(router.route_key(prefix_release).effect));
  const auto resize_press = key(KeyAction::press, PhysicalKey::m, 0, 'm');
  const auto resize_release = key(KeyAction::release, PhysicalKey::m, 0, 'm');
  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(router.route_key(resize_press).effect));
  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(router.route_key(resize_release).effect));
  EXPECT_TRUE(std::holds_alternative<ForwardCurrentKey>(router.route_key(held_repeat).effect));
  EXPECT_TRUE(std::holds_alternative<ForwardCurrentKey>(router.route_key(held_release).effect));

  const auto resize_left_press = key(KeyAction::press, PhysicalKey::h, 0, 'h');
  const auto resize_left_repeat = key(KeyAction::repeat, PhysicalKey::h, 0, 'h');
  const auto resize_left_release = key(KeyAction::release, PhysicalKey::h, 0, 'h');
  EXPECT_EQ(std::get<RoutedCommand>(router.route_key(resize_left_press).effect).command,
            InputCommand::resize_left);
  EXPECT_EQ(std::get<RoutedCommand>(router.route_key(resize_left_repeat).effect).command,
            InputCommand::resize_left);
  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(router.route_key(resize_left_release).effect));

  const auto exit_press = key(KeyAction::press, PhysicalKey::q, 0, 'q');
  const auto exit_repeat = key(KeyAction::repeat, PhysicalKey::q, 0, 'q');
  const auto exit_release = key(KeyAction::release, PhysicalKey::q, 0, 'q');
  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(router.route_key(exit_press).effect));
  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(router.route_key(exit_repeat).effect));
  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(router.route_key(exit_release).effect));
}

TEST(InputRouterTest, PreservesShiftedControlAndAltLegacyBindingsForTypedKeys) {
  InputRouter router(default_input_map());
  const KeyEvent prefix{.action = KeyAction::press,
                        .key = PhysicalKey::b,
                        .modifiers = key_modifier_control | key_modifier_shift,
                        .unshifted_codepoint = 'b',
                        .text = {}};
  const KeyEvent resize{.action = KeyAction::press,
                        .key = PhysicalKey::h,
                        .modifiers = key_modifier_alt | key_modifier_shift,
                        .unshifted_codepoint = 'h',
                        .text = {}};

  EXPECT_TRUE(std::holds_alternative<ConsumedInput>(router.route_key(prefix).effect));
  const auto routed = router.route_key(resize);

  ASSERT_NE(std::get_if<RoutedCommand>(&routed.effect), nullptr);
  EXPECT_EQ(std::get<RoutedCommand>(routed.effect).command, InputCommand::resize_left);
}

TEST(InputRouterTest, ACompiledMapCanUseDirectBindingsWithoutAnyTransientContext) {
  InputMapDraft draft;
  const auto normal = draft.add_context({});
  ASSERT_TRUE(normal.has_value());
  ASSERT_TRUE(draft.bind(
      *normal, InputChord::key(PhysicalKey::arrow_left, key_modifier_control | key_modifier_alt),
      invoke(InputCommand::resize_left)));
  const auto map = draft.compile();
  ASSERT_TRUE(map.has_value());
  InputRouter router(*map);
  const KeyEvent direct{.action = KeyAction::press,
                        .key = PhysicalKey::arrow_left,
                        .modifiers = key_modifier_control | key_modifier_alt,
                        .unshifted_codepoint = 0,
                        .text = {}};

  const auto result = router.route_key(direct);

  const auto* const command = std::get_if<RoutedCommand>(&result.effect);
  ASSERT_NE(command, nullptr);
  EXPECT_EQ(command->command, InputCommand::resize_left);
  EXPECT_TRUE(router.active_label().empty());
}

} // namespace
} // namespace lemma::input
