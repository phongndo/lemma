#include "render/pane_composition.hpp"

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include <array>
#include <cstddef>
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

TEST(PaneCompositionTest, CentersMinimalTabStatus) {
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
                                    {.tabs = tabs, .dirty = true});

  ASSERT_TRUE(result.has_value());
  EXPECT_TRUE(result->status);
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[3;9H1:zsh  [2:nvim]  3:logs"));
}

TEST(PaneCompositionTest, RejectsPaneGeometryThatOverlapsStatusRow) {
  auto terminal = make_terminal(20, 3);
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = 20, .rows = 3},
      .focused = true,
  };
  const std::array tabs{StatusTab{.number = 1, .title = "zsh", .active = true}};
  std::array<std::byte, std::size_t{16} * 1'024U> output{};

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 20, .rows = 3}, output, true,
                                    {.tabs = tabs, .dirty = true});

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
                                    {.tabs = tabs, .dirty = true});

  ASSERT_TRUE(result.has_value());
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::HasSubstr("[3:nvim]"));
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
  ASSERT_TRUE(compose_frame(std::span(&pane, 1), {.columns = 12, .rows = 3}, output, true,
                            {.tabs = tabs, .dirty = true})
                  .has_value());

  const auto result = compose_frame(std::span(&pane, 1), {.columns = 12, .rows = 3}, output, false,
                                    {.tabs = tabs, .dirty = false});

  ASSERT_TRUE(result.has_value());
  EXPECT_FALSE(result->status);
  const auto encoded = as_text(std::span(output).first(result->bytes));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("[1:zsh]")));
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
  EXPECT_THAT(as_text(std::span(output).first(result->bytes)), testing::HasSubstr("\x1B[?2004h"));

  panes.front().focused = false;
  panes.back().focused = true;
  result = compose_frame(panes, {.columns = 8, .rows = 1}, output, false);
  ASSERT_TRUE(result.has_value());
  EXPECT_THAT(as_text(std::span(output).first(result->bytes)), testing::HasSubstr("\x1B[?2004l"));
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
