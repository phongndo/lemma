#include "render/pane_composition.hpp"

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include <array>
#include <cstddef>
#include <optional>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

namespace lemma::render {
namespace {

[[nodiscard]] auto make_terminal(const std::uint16_t columns, const std::uint16_t rows)
    -> vt::Terminal {
  vt::TerminalOptions options;
  options.size = {.columns = columns, .rows = rows};
  auto terminal = vt::Terminal::create(options);
  EXPECT_TRUE(terminal.has_value());
  return std::move(*terminal);
}

void write_text(vt::Terminal& terminal, const std::string_view text) {
  terminal.write(std::as_bytes(std::span(text.data(), text.size())));
}

[[nodiscard]] auto as_text(const std::span<const std::byte> bytes) -> std::string_view {
  // The frame is an ANSI byte stream and std::string_view is only a non-owning test view.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  return {reinterpret_cast<const char*>(bytes.data()), bytes.size()};
}

[[nodiscard]] auto occurrences(const std::string_view text, const std::string_view needle)
    -> std::size_t {
  std::size_t count = 0;
  std::size_t position = 0;
  while ((position = text.find(needle, position)) != std::string_view::npos) {
    ++count;
    position += needle.size();
  }
  return count;
}

TEST(PaneCompositionTest, PlacesMultipleTerminalSurfacesInOneAtomicFrame) {
  auto left = make_terminal(5, 2);
  auto right = make_terminal(5, 2);
  write_text(left, "left");
  write_text(right, "right");
  const std::array panes{
      PaneSurface{.terminal = &left, .rectangle = {.column = 0, .row = 0, .columns = 5, .rows = 2}},
      PaneSurface{.terminal = &right,
                  .rectangle = {.column = 5, .row = 0, .columns = 5, .rows = 2},
                  .focused = true},
  };
  std::array<std::byte, std::size_t{64} * 1'024U> output{};

  const auto result = compose_frame(panes, {.columns = 10, .rows = 2}, output, true);

  ASSERT_TRUE(result.has_value());
  EXPECT_EQ(result->panes, panes.size());
  EXPECT_EQ(result->rows, 4U);
  EXPECT_TRUE(result->full);
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1;1H"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1;6H"));
  EXPECT_THAT(encoded, testing::HasSubstr("left"));
  EXPECT_THAT(encoded, testing::HasSubstr("right"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1;10H\x1B[?25h"));
  EXPECT_EQ(occurrences(encoded, "\x1B[?2026h"), 1U);
  EXPECT_EQ(occurrences(encoded, "\x1B[?2026l"), 1U);
  EXPECT_EQ(occurrences(encoded, "\x1B[2J"), 1U);
}

TEST(PaneCompositionTest, LeftAlignsMinimalTabStatusAbovePaneContent) {
  auto terminal = make_terminal(40, 2);
  write_text(terminal, "content");
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 40, .rows = 2},
      .focused = true,
  };
  const std::array tabs{
      StatusTab{.number = 1, .title = "zsh"},
      StatusTab{.number = 2, .title = "nvim", .active = true},
      StatusTab{.number = 3, .title = "logs"},
  };
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 40, .rows = 3}, output, true,
                                    {.session_name = {},
                                     .tabs = tabs,
                                     .prompt_target = StatusPromptTarget::none,
                                     .prompt_feedback = StatusPromptFeedback::none,
                                     .prompt_value = {},
                                     .input_context = {},
                                     .prompt_cursor = 0,
                                     .dirty = true});

  ASSERT_TRUE(result.has_value());
  EXPECT_TRUE(result->status);
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1;1H\x1B[0m1:zsh"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[0;1m[ 2:nvim ]"));
  EXPECT_THAT(encoded, testing::HasSubstr("  +"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[2;1H"));
  EXPECT_THAT(encoded, testing::HasSubstr("content"));
}

TEST(PaneCompositionTest, StatusControlHitTestMatchesRenderedLabelsAndOverflow) {
  const std::array tabs{
      StatusTab{.number = 1, .title = "zsh"},
      StatusTab{.number = 2, .title = "nvim", .active = true},
      StatusTab{.number = 3, .title = "logs"},
  };
  const StatusLine status{.session_name = "lemma",
                          .tabs = tabs,
                          .prompt_target = StatusPromptTarget::none,
                          .prompt_feedback = StatusPromptFeedback::none,
                          .prompt_value = {},
                          .input_context = {},
                          .prompt_cursor = 0,
                          .dirty = false};

  EXPECT_EQ(status_target_at_column(status, {.columns = 40, .rows = 3}, 10),
            (StatusTarget{.kind = StatusTargetKind::tab, .tab_position = 0}));
  EXPECT_EQ(status_target_at_column(status, {.columns = 40, .rows = 3}, 17),
            (StatusTarget{.kind = StatusTargetKind::tab, .tab_position = 1}));
  EXPECT_EQ(status_target_at_column(status, {.columns = 40, .rows = 3}, 29),
            (StatusTarget{.kind = StatusTargetKind::tab, .tab_position = 2}));
  EXPECT_EQ(status_target_at_column(status, {.columns = 40, .rows = 3}, 37),
            (StatusTarget{.kind = StatusTargetKind::create_tab, .tab_position = 0}));
  EXPECT_EQ(status_target_at_column(status, {.columns = 40, .rows = 3}, 0), std::nullopt);
  EXPECT_EQ(status_target_at_column(status, {.columns = 40, .rows = 3}, 8), std::nullopt);
  EXPECT_EQ(status_target_at_column(status, {.columns = 40, .rows = 3}, 15), std::nullopt);

  const std::array overflow_tabs{
      StatusTab{.number = 1, .title = "shell"},
      StatusTab{.number = 2, .title = "api"},
      StatusTab{.number = 3, .title = "nvim", .active = true},
      StatusTab{.number = 4, .title = "tests"},
      StatusTab{.number = 5, .title = "logs"},
  };
  const StatusLine overflow{.session_name = {},
                            .tabs = overflow_tabs,
                            .prompt_target = StatusPromptTarget::none,
                            .prompt_feedback = StatusPromptFeedback::none,
                            .prompt_value = {},
                            .input_context = {},
                            .prompt_cursor = 0,
                            .dirty = false};
  EXPECT_EQ(status_target_at_column(overflow, {.columns = 18, .rows = 3}, 2),
            (StatusTarget{.kind = StatusTargetKind::tab, .tab_position = 2}));
  EXPECT_EQ(status_target_at_column(overflow, {.columns = 18, .rows = 3}, 11),
            (StatusTarget{.kind = StatusTargetKind::tab, .tab_position = 2}));
  EXPECT_EQ(status_target_at_column(overflow, {.columns = 18, .rows = 3}, 16),
            (StatusTarget{.kind = StatusTargetKind::create_tab, .tab_position = 0}));
  EXPECT_EQ(status_target_at_column(overflow, {.columns = 18, .rows = 3}, 0), std::nullopt);
  EXPECT_EQ(status_target_at_column(overflow, {.columns = 18, .rows = 3}, 12), std::nullopt);

  auto prompting = status;
  prompting.prompt_target = StatusPromptTarget::active_tab;
  prompting.prompt_value = "nvim";
  prompting.prompt_cursor = prompting.prompt_value.size();
  EXPECT_EQ(status_target_at_column(prompting, {.columns = 40, .rows = 3}, 17), std::nullopt);

  auto modal = status;
  modal.input_context = "RESIZE";
  EXPECT_EQ(status_target_at_column(modal, {.columns = 40, .rows = 3}, 17), std::nullopt);
}

TEST(PaneCompositionTest, ActiveInputContextReplacesStatusRowWithoutABadge) {
  auto terminal = make_terminal(40, 2);
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 40, .rows = 2},
      .focused = true,
  };
  const std::array tabs{StatusTab{.number = 1, .title = "shell", .active = true}};
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 40, .rows = 3}, output, true,
                                    {.session_name = "work",
                                     .tabs = tabs,
                                     .prompt_target = StatusPromptTarget::none,
                                     .prompt_feedback = StatusPromptFeedback::none,
                                     .prompt_value = {},
                                     .input_context = "RESIZE",
                                     .prompt_cursor = 0,
                                     .dirty = true});

  ASSERT_TRUE(result.has_value());
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1;1H\x1B[0;1mRESIZE"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("\x1B[0;7m")));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("[ 1:shell ]")));
}

TEST(PaneCompositionTest, EditsActiveTabInlineAndOwnsTheVisibleCursor) {
  auto terminal = make_terminal(20, 2);
  write_text(terminal, "content");
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 20, .rows = 2},
      .focused = true,
  };
  const std::array tabs{StatusTab{.number = 1, .title = "zsh", .active = true}};
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 20, .rows = 3}, output, true,
                                    {.session_name = "work",
                                     .tabs = tabs,
                                     .prompt_target = StatusPromptTarget::active_tab,
                                     .prompt_feedback = StatusPromptFeedback::none,
                                     .prompt_value = "abc",
                                     .input_context = {},
                                     .prompt_cursor = 1,
                                     .dirty = true});

  ASSERT_TRUE(result.has_value());
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[0;1m work \x1B[0m | "));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[0;1m[ 1:\x1B[0;1;4mabc\x1B[0;1m ]"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1;15H\x1B[2 q\x1B[?25h"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("\x1B[0;2m")));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("[ 1:zsh ]")));
}

TEST(PaneCompositionTest, CommandLineUsesTheWholeStatusRowWithoutAnnotations) {
  auto terminal = make_terminal(64, 2);
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 64, .rows = 2},
      .focused = true,
  };
  const std::array tabs{StatusTab{.number = 1, .title = "zsh", .active = true}};
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 64, .rows = 3}, output, true,
                                    {.session_name = "work",
                                     .tabs = tabs,
                                     .prompt_target = StatusPromptTarget::command_line,
                                     .prompt_feedback = StatusPromptFeedback::none,
                                     .prompt_value = "pane split --right",
                                     .input_context = {},
                                     .prompt_cursor = 18,
                                     .dirty = true});

  ASSERT_TRUE(result.has_value());
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr(":pane split --right"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("\x1B[0;1;4m")));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("Split the current pane")));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1;20H\x1B[2 q\x1B[?25h"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("[ 1:zsh ]")));
}

TEST(PaneCompositionTest, CommandFailureReplacesTheStatusRowWithALeftAlignedMessage) {
  auto terminal = make_terminal(40, 2);
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 40, .rows = 2},
      .focused = true,
  };
  const std::array tabs{StatusTab{.number = 1, .title = "zsh", .active = true}};
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 40, .rows = 3}, output, true,
                                    {.session_name = "work",
                                     .tabs = tabs,
                                     .prompt_target = StatusPromptTarget::message,
                                     .prompt_feedback = StatusPromptFeedback::none,
                                     .prompt_value = {},
                                     .input_context = "Error: Unknown command",
                                     .prompt_cursor = 0,
                                     .dirty = true});

  ASSERT_TRUE(result.has_value());
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1;1H\x1B[0;1mError: Unknown command"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("[ 1:zsh ]")));
}

TEST(PaneCompositionTest, MessageViewReplacesPaneContentWithAnOpaqueBoundedLog) {
  auto terminal = make_terminal(40, 3);
  write_text(terminal, "underlying pane content");
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 40, .rows = 3},
      .focused = true,
  };
  const std::array tabs{StatusTab{.number = 1, .title = "zsh", .active = true}};
  const std::array lines{
      MessageViewLine{.text = "[2026-03-01 10:00:00] Information", .error = false},
      MessageViewLine{.text = "[2026-03-01 10:00:01] Error: Unknown command", .error = true},
  };
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 40, .rows = 4}, output, true,
                                    {.session_name = "work",
                                     .tabs = tabs,
                                     .prompt_target = StatusPromptTarget::none,
                                     .prompt_feedback = StatusPromptFeedback::none,
                                     .prompt_value = {},
                                     .input_context = "LOG",
                                     .prompt_cursor = 0,
                                     .dirty = true},
                                    std::nullopt, {.lines = lines, .active = true});

  ASSERT_TRUE(result.has_value());
  EXPECT_EQ(result->panes, 0U);
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("[2026-03-01 10:00:00] Information"));
  EXPECT_THAT(encoded, testing::HasSubstr("[2026-03-01 10:00:01] Error: Unknown "));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1;1H\x1B[0;1mLOG"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("\x1B[0;7m")));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("[ 1:zsh ]")));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("underlying pane content")));
}

TEST(PaneCompositionTest, LeavingStatusPromptRestoresFocusedPaneCursorBlinking) {
  auto terminal = make_terminal(20, 2);
  write_text(terminal, "\x1B[1 qcontent");
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 20, .rows = 2},
      .focused = true,
  };
  const std::array tabs{StatusTab{.number = 1, .title = "zsh", .active = true}};
  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  auto outer = make_terminal(20, 3);

  const StatusLine normal_status{
      .session_name = "work",
      .tabs = tabs,
      .prompt_target = StatusPromptTarget::none,
      .prompt_feedback = StatusPromptFeedback::none,
      .prompt_value = {},
      .input_context = {},
      .prompt_cursor = 0,
      .dirty = true,
  };
  const auto initial =
      compose_frame(std::span(&pane, 1), {.columns = 20, .rows = 3}, output, true, normal_status);
  ASSERT_TRUE(initial.has_value());
  outer.write(std::span(output).first(initial->bytes));

  const StatusLine prompt_status{
      .session_name = "work",
      .tabs = tabs,
      .prompt_target = StatusPromptTarget::active_tab,
      .prompt_feedback = StatusPromptFeedback::none,
      .prompt_value = "zsh",
      .input_context = {},
      .prompt_cursor = 1,
      .dirty = true,
  };
  const auto prompt = compose_frame(std::span(&pane, 1), {.columns = 20, .rows = 3}, output, false,
                                    prompt_status, initial->outer_modes);
  ASSERT_TRUE(prompt.has_value());
  outer.write(std::span(output).first(prompt->bytes));

  const auto restored = compose_frame(std::span(&pane, 1), {.columns = 20, .rows = 3}, output,
                                      false, normal_status, prompt->outer_modes);
  ASSERT_TRUE(restored.has_value());
  outer.write(std::span(output).first(restored->bytes));

  outer.invalidate_ansi_render_state();
  const auto projected = outer.render_ansi(output, true);
  ASSERT_TRUE(projected.has_value());
  const auto encoded = as_text(std::span(output).first(projected->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1 q"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("\x1B[2 q")));
}

TEST(PaneCompositionTest, NarrowTabEditorShowsOnlyItsBoundedField) {
  auto terminal = make_terminal(4, 2);
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 4, .rows = 2},
      .focused = true,
  };
  const std::array tabs{
      StatusTab{.number = 1, .title = "shell"},
      StatusTab{.number = 2, .title = "nvim", .active = true},
      StatusTab{.number = 3, .title = "logs"},
  };
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 4, .rows = 3}, output, true,
                                    {.session_name = "work",
                                     .tabs = tabs,
                                     .prompt_target = StatusPromptTarget::active_tab,
                                     .prompt_feedback = StatusPromptFeedback::none,
                                     .prompt_value = "abcdef",
                                     .input_context = {},
                                     .prompt_cursor = 6,
                                     .dirty = true});

  ASSERT_TRUE(result.has_value());
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[0;1;4mdef\x1B[0;1m "));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1;4H\x1B[2 q\x1B[?25h"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("…")));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("[2:")));
}

TEST(PaneCompositionTest, RejectsControlBytesInEditableStatusValues) {
  auto terminal = make_terminal(20, 2);
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 20, .rows = 2},
      .focused = true,
  };
  const std::array tabs{StatusTab{.number = 1, .title = "zsh", .active = true}};
  constexpr std::array prompt{'b', 'a', 'd', '\x1B', 'x'};
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 20, .rows = 3}, output, true,
                                    {.session_name = "work",
                                     .tabs = tabs,
                                     .prompt_target = StatusPromptTarget::active_tab,
                                     .prompt_feedback = StatusPromptFeedback::none,
                                     .prompt_value = std::string_view(prompt.data(), prompt.size()),
                                     .input_context = {},
                                     .prompt_cursor = prompt.size(),
                                     .dirty = true});

  ASSERT_FALSE(result.has_value());
  EXPECT_EQ(result.error(), CompositionError::invalid_status);
}

TEST(PaneCompositionTest, EditsSessionInlineWithActiveTabContextAndConflictFeedback) {
  auto terminal = make_terminal(80, 2);
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 80, .rows = 2},
      .focused = true,
  };
  const std::array tabs{
      StatusTab{.number = 1, .title = "zsh", .active = true},
      StatusTab{.number = 2, .title = "nvim"},
  };
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 80, .rows = 3}, output, true,
                                    {.session_name = "original",
                                     .tabs = tabs,
                                     .prompt_target = StatusPromptTarget::session,
                                     .prompt_feedback = StatusPromptFeedback::conflict,
                                     .prompt_value = "occupied",
                                     .input_context = {},
                                     .prompt_cursor = 8,
                                     .dirty = true});

  ASSERT_TRUE(result.has_value());
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[0;1m \x1B[0;1;4moccupied\x1B[0;1m "));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[0m | \x1B[0;1m[ 1:zsh ]"));
  EXPECT_THAT(encoded, testing::HasSubstr("Session already exists"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1;10H\x1B[2 q\x1B[?25h"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("\x1B[0;2m")));
}

TEST(PaneCompositionTest, CopySearchUsesTheWholeStatusRowAndOwnsTheCursor) {
  auto terminal = make_terminal(12, 2);
  write_text(terminal, "underlay");
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 12, .rows = 2},
      .cursor_override_column = 1,
      .cursor_override_row = 1,
      .focused = true,
      .cursor_override = true,
  };
  const std::array tabs{StatusTab{.number = 1, .title = "zsh", .active = true}};
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 12, .rows = 3}, output, true,
                                    {.session_name = {},
                                     .tabs = tabs,
                                     .prompt_target = StatusPromptTarget::copy_search_forward,
                                     .prompt_feedback = StatusPromptFeedback::none,
                                     .prompt_value = "ls",
                                     .input_context = {},
                                     .prompt_cursor = 2,
                                     .dirty = true});

  ASSERT_TRUE(result.has_value());
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1;1H\x1B[0;1m/ls"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1;4H\x1B[2 q\x1B[?25h"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("[ 1:zsh ]")));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("\x1B[0;7m")));
}

TEST(PaneCompositionTest, DrawsBoldSessionBeforeLeftAlignedTabs) {
  auto terminal = make_terminal(40, 2);
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 40, .rows = 2},
      .focused = true,
  };
  const std::array tabs{
      StatusTab{.number = 1, .title = "zsh"},
      StatusTab{.number = 2, .title = "nvim", .active = true},
      StatusTab{.number = 3, .title = "logs"},
  };
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 40, .rows = 3}, output, true,
                                    {.session_name = "lemma",
                                     .tabs = tabs,
                                     .prompt_target = StatusPromptTarget::none,
                                     .prompt_feedback = StatusPromptFeedback::none,
                                     .prompt_value = {},
                                     .input_context = {},
                                     .prompt_cursor = 0,
                                     .dirty = true});

  ASSERT_TRUE(result.has_value());
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1;1H\x1B[0;1m lemma \x1B[0m | 1:zsh"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[0;1m[ 2:nvim ]"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("\x1B[0;2m")));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("\x1B[38")));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("\x1B[48")));
}

TEST(PaneCompositionTest, OffsetsPaneSeparatorsBelowTopStatus) {
  auto terminal = make_terminal(4, 2);
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 4, .rows = 2},
      .focused = true,
      .border_right = true,
  };
  const std::array tabs{StatusTab{.number = 1, .title = "zsh", .active = true}};
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 5, .rows = 3}, output, true,
                                    {.session_name = {},
                                     .tabs = tabs,
                                     .prompt_target = StatusPromptTarget::none,
                                     .prompt_feedback = StatusPromptFeedback::none,
                                     .prompt_value = {},
                                     .input_context = {},
                                     .prompt_cursor = 0,
                                     .dirty = true});

  ASSERT_TRUE(result.has_value());
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[2;5H│"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[3;5H│"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("\x1B[1;5H│")));
}

TEST(PaneCompositionTest, RejectsPaneGeometryThatExceedsStatusReservedContent) {
  auto terminal = make_terminal(20, 3);
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 20, .rows = 3},
      .focused = true,
  };
  const std::array tabs{StatusTab{.number = 1, .title = "zsh", .active = true}};
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 20, .rows = 3}, output, true,
                                    {.session_name = {},
                                     .tabs = tabs,
                                     .prompt_target = StatusPromptTarget::none,
                                     .prompt_feedback = StatusPromptFeedback::none,
                                     .prompt_value = {},
                                     .input_context = {},
                                     .prompt_cursor = 0,
                                     .dirty = true});

  ASSERT_FALSE(result.has_value());
  EXPECT_EQ(result.error(), CompositionError::invalid_pane);
}

TEST(PaneCompositionTest, KeepsActiveTabVisibleWhenStatusOverflows) {
  auto terminal = make_terminal(18, 2);
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 18, .rows = 2},
      .focused = true,
  };
  const std::array tabs{
      StatusTab{.number = 1, .title = "shell"},
      StatusTab{.number = 2, .title = "api"},
      StatusTab{.number = 3, .title = "nvim", .active = true},
      StatusTab{.number = 4, .title = "tests"},
      StatusTab{.number = 5, .title = "logs"},
  };
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 18, .rows = 3}, output, true,
                                    {.session_name = {},
                                     .tabs = tabs,
                                     .prompt_target = StatusPromptTarget::none,
                                     .prompt_feedback = StatusPromptFeedback::none,
                                     .prompt_value = {},
                                     .input_context = {},
                                     .prompt_cursor = 0,
                                     .dirty = true});

  ASSERT_TRUE(result.has_value());
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("[ 3:nvim ]"));
  EXPECT_THAT(encoded, testing::HasSubstr("…"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("1:shell")));
}

TEST(PaneCompositionTest, OmitsCleanStatusFromIncrementalFrame) {
  auto terminal = make_terminal(12, 2);
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 12, .rows = 2},
      .focused = true,
  };
  const std::array tabs{StatusTab{.number = 1, .title = "zsh", .active = true}};
  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  const StatusLine dirty_status{.session_name = {},
                                .tabs = tabs,
                                .prompt_target = StatusPromptTarget::none,
                                .prompt_feedback = StatusPromptFeedback::none,
                                .prompt_value = {},
                                .input_context = {},
                                .prompt_cursor = 0,
                                .dirty = true};
  ASSERT_TRUE(
      compose_frame(std::span(&pane, 1), {.columns = 12, .rows = 3}, output, true, dirty_status)
          .has_value());

  auto clean_status = dirty_status;
  clean_status.dirty = false;
  const auto result =
      compose_frame(std::span(&pane, 1), {.columns = 12, .rows = 3}, output, false, clean_status);

  ASSERT_TRUE(result.has_value());
  EXPECT_FALSE(result->status);
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("[ 1:zsh ]")));
}

TEST(PaneCompositionTest, ProjectsOuterMouseModesOnlyWhenTheyChange) {
  auto terminal = make_terminal(12, 2);
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 12, .rows = 2},
      .focused = true,
  };
  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  const auto initial = compose_frame(std::span(&pane, 1), {.columns = 12, .rows = 2}, output, true);
  ASSERT_TRUE(initial.has_value());
  EXPECT_EQ(initial->outer_modes, OuterModeProjection::button_mouse);

  write_text(terminal, "ordinary damage");
  const auto retained = compose_frame(std::span(&pane, 1), {.columns = 12, .rows = 2}, output,
                                      false, {}, initial->outer_modes);
  ASSERT_TRUE(retained.has_value());
  const auto retained_text = as_text(std::span(output).first(retained->bytes));
  EXPECT_THAT(retained_text, testing::Not(testing::HasSubstr("\x1B[?1002h")));
  EXPECT_THAT(retained_text, testing::Not(testing::HasSubstr("\x1B[?1003h")));
  EXPECT_THAT(retained_text, testing::Not(testing::HasSubstr("\x1B[?2004h")));
  EXPECT_THAT(retained_text, testing::Not(testing::HasSubstr("\x1B[?2004l")));
  EXPECT_THAT(retained_text, testing::Not(testing::HasSubstr("\x1B]112\x1B\\")));
  EXPECT_THAT(retained_text, testing::Not(testing::HasSubstr("\x1B[2 q")));

  write_text(terminal, "\x1B[?1003h\x1B[?2004h\x1B[5 qmode change");
  const auto changed = compose_frame(std::span(&pane, 1), {.columns = 12, .rows = 2}, output, false,
                                     {}, retained->outer_modes);
  ASSERT_TRUE(changed.has_value());
  EXPECT_EQ(changed->outer_modes, OuterModeProjection::any_mouse);
  const auto changed_text = as_text(std::span(output).first(changed->bytes));
  EXPECT_THAT(changed_text, testing::HasSubstr("\x1B[?1003h"));
  EXPECT_THAT(changed_text, testing::HasSubstr("\x1B[?2004h"));
  EXPECT_THAT(changed_text, testing::HasSubstr("\x1B[1 q"));
  EXPECT_THAT(changed_text, testing::Not(testing::HasSubstr("\x1B[5 q")));
}

TEST(PaneCompositionTest, DrawsDeclaredPaneSeparators) {
  auto terminal = make_terminal(4, 2);
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.column = 0, .row = 0, .columns = 4, .rows = 2},
      .focused = true,
      .border_right = true,
  };
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 5, .rows = 2}, output, true);

  ASSERT_TRUE(result.has_value());
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1;5H│"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[2;5H│"));

  write_text(terminal, "changed");
  const auto incremental =
      compose_frame(std::span(&pane, 1), {.columns = 5, .rows = 2}, output, false);
  ASSERT_TRUE(incremental.has_value());
  const auto incremental_encoded = as_text(std::span(output).first(incremental->bytes));
  EXPECT_THAT(incremental_encoded, testing::Not(testing::HasSubstr("│")));
  EXPECT_THAT(incremental_encoded, testing::Not(testing::HasSubstr("\x1B[90m")));
}

TEST(PaneCompositionTest, ConnectsNestedSplitBordersAtJunctions) {
  auto left = make_terminal(4, 5);
  auto top_right = make_terminal(5, 2);
  auto bottom_right = make_terminal(5, 2);
  const std::array panes{
      PaneSurface{.terminal = &left,
                  .rectangle = {.column = 0, .row = 0, .columns = 4, .rows = 5},
                  .border_right = true},
      PaneSurface{.terminal = &top_right,
                  .rectangle = {.column = 5, .row = 0, .columns = 5, .rows = 2},
                  .border_bottom = true},
      PaneSurface{.terminal = &bottom_right,
                  .rectangle = {.column = 5, .row = 3, .columns = 5, .rows = 2},
                  .focused = true},
  };
  std::array<std::byte, std::size_t{32} * 1'024U> output{};

  const auto result = compose_frame(panes, {.columns = 10, .rows = 5}, output, true);

  ASSERT_TRUE(result.has_value());
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[3;5H├"));
}

TEST(PaneCompositionTest, FillsFourPaneCrossJunction) {
  auto top_left = make_terminal(4, 3);
  auto top_right = make_terminal(4, 3);
  auto bottom_left = make_terminal(4, 3);
  auto bottom_right = make_terminal(4, 3);
  const std::array panes{
      PaneSurface{.terminal = &top_left,
                  .rectangle = {.column = 0, .row = 0, .columns = 4, .rows = 3},
                  .border_right = true,
                  .border_bottom = true},
      PaneSurface{.terminal = &top_right,
                  .rectangle = {.column = 5, .row = 0, .columns = 4, .rows = 3},
                  .border_bottom = true},
      PaneSurface{.terminal = &bottom_left,
                  .rectangle = {.column = 0, .row = 4, .columns = 4, .rows = 3},
                  .border_right = true},
      PaneSurface{.terminal = &bottom_right,
                  .rectangle = {.column = 5, .row = 4, .columns = 4, .rows = 3},
                  .focused = true},
  };
  std::array<std::byte, std::size_t{32} * 1'024U> output{};

  const auto result = compose_frame(panes, {.columns = 9, .rows = 7}, output, true);

  ASSERT_TRUE(result.has_value());
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[4;5H┼"));
}

TEST(PaneCompositionTest, IncrementalFrameVisitsCleanPanesWithoutRepaintingTheirCells) {
  auto left = make_terminal(6, 2);
  auto right = make_terminal(6, 2);
  write_text(left, "left");
  write_text(right, "right");
  const std::array panes{
      PaneSurface{.terminal = &left,
                  .rectangle = {.column = 0, .row = 0, .columns = 6, .rows = 2},
                  .focused = true},
      PaneSurface{.terminal = &right,
                  .rectangle = {.column = 6, .row = 0, .columns = 6, .rows = 2}},
  };
  std::array<std::byte, std::size_t{64} * 1'024U> output{};
  ASSERT_TRUE(compose_frame(panes, {.columns = 12, .rows = 2}, output, true).has_value());

  write_text(left, "\x1B[2;1Hnew");
  const auto result = compose_frame(panes, {.columns = 12, .rows = 2}, output, false);

  ASSERT_TRUE(result.has_value());
  EXPECT_EQ(result->rows, 1U);
  EXPECT_FALSE(result->full);
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("new"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("right")));
}

TEST(PaneCompositionTest, FocusedSurfaceAlwaysOwnsOuterTerminalModes) {
  auto left = make_terminal(4, 1);
  auto right = make_terminal(4, 1);
  write_text(left, "\x1B[?2004h");
  std::array panes{
      PaneSurface{.terminal = &left,
                  .rectangle = {.column = 0, .row = 0, .columns = 4, .rows = 1},
                  .focused = true},
      PaneSurface{.terminal = &right,
                  .rectangle = {.column = 4, .row = 0, .columns = 4, .rows = 1}},
  };
  std::array<std::byte, std::size_t{64} * 1'024U> output{};
  auto result = compose_frame(panes, {.columns = 8, .rows = 1}, output, true);
  ASSERT_TRUE(result.has_value());
  auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[?2004h"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[?1002h"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[?1006h"));

  // Parse the actual composed frame rather than merely checking that enable sequences occur.
  // Mouse event/format modes are mutually exclusive, so later competing resets must not silently
  // cancel button tracking or SGR encoding.
  auto outer_terminal = make_terminal(8, 1);
  write_text(outer_terminal, encoded);
  const auto tracking = outer_terminal.mouse_tracking();
  ASSERT_TRUE(tracking.has_value());
  EXPECT_EQ(*tracking, (vt::MouseTrackingState{.enabled = true}));
  std::array<std::byte, 64> mouse_output{};
  const vt::MouseEvent mouse{
      .action = vt::MouseAction::press,
      .button = vt::MouseButton::left,
      .x = 1,
      .geometry = {.screen_width = 8, .screen_height = 1},
  };
  const auto mouse_result = outer_terminal.encode_mouse(mouse, mouse_output);
  ASSERT_TRUE(mouse_result.has_value());
  EXPECT_EQ(as_text(std::span(mouse_output).first(*mouse_result)), "\x1B[<0;2;1M");

  panes.front().focused = false;
  panes.back().focused = true;
  result = compose_frame(panes, {.columns = 8, .rows = 1}, output, false);
  ASSERT_TRUE(result.has_value());
  encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[?2004l"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[?1002h"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[?1006h"));
}

TEST(PaneCompositionTest, PromotesOuterCaptureOnlyForUnbuttonedApplicationMotion) {
  auto terminal = make_terminal(8, 1);
  write_text(terminal, "\x1B[?1003h");
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 8, .rows = 1},
      .focused = true,
  };
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 8, .rows = 1}, output, true);

  ASSERT_TRUE(result.has_value());
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[?1002l"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[?1003h"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[?1006h"));

  auto outer_terminal = make_terminal(8, 1);
  write_text(outer_terminal, encoded);
  const auto tracking = outer_terminal.mouse_tracking();
  ASSERT_TRUE(tracking.has_value());
  EXPECT_EQ(*tracking, (vt::MouseTrackingState{.enabled = true, .unbuttoned_motion = true}));
}

TEST(PaneCompositionTest, ClearsViewportWithoutPaneCoordinatesForSuspendedLayout) {
  std::array<std::byte, 1'024> output{};

  const auto result = compose_frame({}, {.columns = 1, .rows = 1}, output, true);

  ASSERT_TRUE(result.has_value());
  EXPECT_EQ(result->panes, 0U);
  EXPECT_EQ(result->rows, 0U);
  EXPECT_TRUE(result->full);
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[2J\x1B[H"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr(";")));
}

TEST(PaneCompositionTest, RejectsInvalidGeometryAndFocusBeforeRendering) {
  auto terminal = make_terminal(5, 2);
  std::array<std::byte, 1'024> output{};
  const std::array outside{
      PaneSurface{.terminal = &terminal,
                  .rectangle = {.column = 6, .row = 0, .columns = 5, .rows = 2}},
  };
  auto result = compose_frame(outside, {.columns = 10, .rows = 2}, output, false);
  ASSERT_FALSE(result.has_value());
  EXPECT_EQ(result.error(), CompositionError::invalid_pane);

  const std::array duplicate_focus{
      PaneSurface{.terminal = &terminal,
                  .rectangle = {.column = 0, .row = 0, .columns = 5, .rows = 2},
                  .focused = true},
      PaneSurface{.terminal = &terminal,
                  .rectangle = {.column = 5, .row = 0, .columns = 5, .rows = 2},
                  .focused = true},
  };
  result = compose_frame(duplicate_focus, {.columns = 10, .rows = 2}, output, false);
  ASSERT_FALSE(result.has_value());
  EXPECT_EQ(result.error(), CompositionError::multiple_focused_panes);
}

TEST(PaneCompositionTest, RejectsOverlappingPaneRectanglesAndSeparatorsBeforeRendering) {
  auto wide_terminal = make_terminal(3, 1);
  auto narrow_terminal = make_terminal(2, 1);
  std::array<std::byte, 1'024> output{};
  const std::array overlapping_contents{
      PaneSurface{.terminal = &wide_terminal,
                  .rectangle = {.column = 0, .row = 0, .columns = 3, .rows = 1}},
      PaneSurface{.terminal = &wide_terminal,
                  .rectangle = {.column = 2, .row = 0, .columns = 3, .rows = 1}},
  };

  auto result = compose_frame(overlapping_contents, {.columns = 5, .rows = 1}, output, false);
  ASSERT_FALSE(result.has_value());
  EXPECT_EQ(result.error(), CompositionError::invalid_pane);
  EXPECT_EQ(output.front(), std::byte{});

  const std::array separator_overlaps_content{
      PaneSurface{.terminal = &narrow_terminal,
                  .rectangle = {.column = 0, .row = 0, .columns = 2, .rows = 1},
                  .border_right = true},
      PaneSurface{.terminal = &narrow_terminal,
                  .rectangle = {.column = 2, .row = 0, .columns = 2, .rows = 1}},
  };

  result = compose_frame(separator_overlaps_content, {.columns = 4, .rows = 1}, output, false);
  ASSERT_FALSE(result.has_value());
  EXPECT_EQ(result.error(), CompositionError::invalid_pane);
  EXPECT_EQ(output.front(), std::byte{});
}

TEST(PaneCompositionTest, EnforcesPaneAndOutputBounds) {
  auto terminal = make_terminal(1, 1);
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 1, .rows = 1},
  };
  std::vector<PaneSurface> excessive(limits::panes_hard_max + 1U, pane);
  std::array<std::byte, 1> output{};

  auto result = compose_frame(excessive, {.columns = 1, .rows = 1}, output, false);
  ASSERT_FALSE(result.has_value());
  EXPECT_EQ(result.error(), CompositionError::too_many_panes);

  result = compose_frame(std::span(&pane, 1), {.columns = 1, .rows = 1}, output, true);
  ASSERT_FALSE(result.has_value());
  EXPECT_EQ(result.error(), CompositionError::output_exhausted);
}

} // namespace
} // namespace lemma::render
