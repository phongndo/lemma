#include "core/layout.hpp"

#include <gtest/gtest.h>

#include <cstdint>

namespace lemma::core {
namespace {

[[nodiscard]] constexpr auto pane(const std::uint32_t slot,
                                  const std::uint32_t generation = 1) noexcept -> PaneId {
  return PaneId::from_parts(slot, generation);
}

[[nodiscard]] auto rectangle(const PaneLayout& layout, const PaneId id,
                             const PaneRectangle viewport) -> PaneRectangle {
  const auto projection = layout.project(viewport);
  EXPECT_TRUE(projection.has_value());
  const auto result = projection.has_value() ? projection->rectangle(id) : std::nullopt;
  EXPECT_TRUE(result.has_value());
  return result.value_or(PaneRectangle{});
}

TEST(PaneLayoutTest, EqualSplitPreservesExistingOddCellBehavior) {
  PaneLayout layout(pane(0));
  ASSERT_TRUE(layout.split(pane(0), pane(1), SplitAxis::left_right));

  const auto projection = layout.project({.columns = 80, .rows = 23});

  ASSERT_TRUE(projection.has_value());
  const auto projected = projection.value_or(LayoutProjection{});
  EXPECT_EQ(projected.pane_count, 2U);
  EXPECT_EQ(projected.rectangle(pane(0)),
            (PaneRectangle{.column = 0, .row = 0, .columns = 40, .rows = 23}));
  EXPECT_EQ(projected.rectangle(pane(1)),
            (PaneRectangle{.column = 41, .row = 0, .columns = 39, .rows = 23}));
  EXPECT_FALSE(projected.rectangle(pane(0, 2)).has_value());
  EXPECT_TRUE(layout.valid());
}

TEST(PaneLayoutTest, OneCellResizePersistsAcrossViewportChanges) {
  PaneLayout layout(pane(0));
  ASSERT_TRUE(layout.split(pane(0), pane(1), SplitAxis::left_right));
  constexpr PaneRectangle original_viewport{.columns = 80, .rows = 23};

  ASSERT_EQ(layout.resize(pane(1), ResizeDirection::left, original_viewport),
            LayoutResizeStatus::applied);
  EXPECT_EQ(rectangle(layout, pane(0), original_viewport).columns, 39U);
  EXPECT_EQ(rectangle(layout, pane(1), original_viewport).columns, 40U);

  constexpr PaneRectangle larger_viewport{.columns = 100, .rows = 23};
  EXPECT_EQ(rectangle(layout, pane(0), larger_viewport).columns, 49U);
  EXPECT_EQ(rectangle(layout, pane(1), larger_viewport).columns, 50U);

  const auto retained = layout;
  ASSERT_TRUE(layout.project({.columns = 3, .rows = 1}).has_value());
  EXPECT_EQ(layout, retained) << "projection and minimum clamping must not rewrite the ratio";
  EXPECT_EQ(rectangle(layout, pane(0), original_viewport).columns, 39U);
  EXPECT_EQ(rectangle(layout, pane(1), original_viewport).columns, 40U);
}

TEST(PaneLayoutTest, DividerHitMovesToPointerAndClampsAtStructuralMinimum) {
  PaneLayout layout(pane(0));
  ASSERT_TRUE(layout.split(pane(0), pane(1), SplitAxis::left_right));
  constexpr PaneRectangle viewport{.columns = 80, .rows = 23};

  const auto divider = layout.divider_at(viewport, 40, 10);

  ASSERT_TRUE(divider.has_value());
  const auto captured = divider.value_or(LayoutDivider{});
  EXPECT_EQ(captured,
            (LayoutDivider{.first = pane(0), .second = pane(1), .axis = SplitAxis::left_right}));
  EXPECT_EQ(layout.divider_rectangle(captured, viewport),
            (PaneRectangle{.column = 40, .row = 0, .columns = 1, .rows = 23}));
  EXPECT_FALSE(layout.divider_at(viewport, 39, 10).has_value());
  EXPECT_FALSE(layout.divider_at(viewport, 41, 10).has_value());
  ASSERT_EQ(layout.resize_divider(captured, 45, viewport), LayoutResizeStatus::applied);
  EXPECT_EQ(rectangle(layout, pane(0), viewport).columns, 45U);
  EXPECT_EQ(rectangle(layout, pane(1), viewport).columns, 34U);

  ASSERT_EQ(layout.resize_divider(captured, 0, viewport), LayoutResizeStatus::applied);
  EXPECT_EQ(rectangle(layout, pane(0), viewport).columns, 1U);
  EXPECT_EQ(rectangle(layout, pane(1), viewport).columns, 78U);
  EXPECT_EQ(layout.resize_divider(captured, 0, viewport), LayoutResizeStatus::no_effect);
  EXPECT_TRUE(layout.valid());
}

TEST(PaneLayoutTest, DividerHitSelectsExactNestedBranchAndStaleHandleDoesNotRetarget) {
  PaneLayout layout(pane(0));
  ASSERT_TRUE(layout.split(pane(0), pane(1), SplitAxis::left_right));
  ASSERT_TRUE(layout.split(pane(0), pane(2), SplitAxis::top_bottom));
  constexpr PaneRectangle viewport{.columns = 100, .rows = 41};

  const auto nested = layout.divider_at(viewport, 10, 20);
  const auto outer = layout.divider_at(viewport, 50, 20);

  ASSERT_TRUE(nested.has_value());
  ASSERT_TRUE(outer.has_value());
  const auto captured_nested = nested.value_or(LayoutDivider{});
  const auto captured_outer = outer.value_or(LayoutDivider{});
  EXPECT_EQ(captured_nested,
            (LayoutDivider{.first = pane(0), .second = pane(2), .axis = SplitAxis::top_bottom}));
  EXPECT_EQ(captured_outer,
            (LayoutDivider{.first = pane(0), .second = pane(1), .axis = SplitAxis::left_right}));
  EXPECT_EQ(layout.divider_rectangle(captured_nested, viewport),
            (PaneRectangle{.column = 0, .row = 20, .columns = 50, .rows = 1}));
  EXPECT_EQ(layout.divider_rectangle(captured_outer, viewport),
            (PaneRectangle{.column = 50, .row = 0, .columns = 1, .rows = 41}));
  const auto outer_pane_before = rectangle(layout, pane(1), viewport);
  ASSERT_EQ(layout.resize_divider(captured_nested, 25, viewport), LayoutResizeStatus::applied);
  EXPECT_EQ(rectangle(layout, pane(0), viewport).rows, 25U);
  EXPECT_EQ(rectangle(layout, pane(1), viewport), outer_pane_before);

  ASSERT_TRUE(layout.remove(pane(0)).has_value());
  EXPECT_EQ(layout.resize_divider(captured_nested, 10, viewport), LayoutResizeStatus::invalid);
  EXPECT_EQ(layout.resize_divider(captured_outer, 40, viewport), LayoutResizeStatus::invalid);
  EXPECT_FALSE(layout.divider_rectangle(captured_nested, viewport).has_value());
  EXPECT_FALSE(layout.divider_rectangle(captured_outer, viewport).has_value());
  EXPECT_TRUE(layout.valid());
}

TEST(PaneLayoutTest, DividerCoordinatesRemainAbsoluteInsideOffsetSubtree) {
  PaneLayout layout(pane(0));
  ASSERT_TRUE(layout.split(pane(0), pane(1), SplitAxis::left_right));
  ASSERT_TRUE(layout.split(pane(1), pane(2), SplitAxis::left_right));
  constexpr PaneRectangle viewport{.columns = 100, .rows = 23};
  const auto outer_left_before = rectangle(layout, pane(0), viewport);

  const auto divider = layout.divider_at(viewport, 75, 10);

  ASSERT_TRUE(divider.has_value());
  const auto captured = divider.value_or(LayoutDivider{});
  EXPECT_EQ(captured,
            (LayoutDivider{.first = pane(1), .second = pane(2), .axis = SplitAxis::left_right}));
  ASSERT_EQ(layout.resize_divider(captured, 80, viewport), LayoutResizeStatus::applied);
  EXPECT_EQ(layout.divider_rectangle(captured, viewport),
            (PaneRectangle{.column = 80, .row = 0, .columns = 1, .rows = 23}));
  EXPECT_EQ(rectangle(layout, pane(0), viewport), outer_left_before);
  EXPECT_EQ(rectangle(layout, pane(1), viewport).columns, 29U);
  EXPECT_EQ(rectangle(layout, pane(2), viewport).columns, 19U);
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PaneLayoutTest, EveryProjectedCellIsEitherPaneOrDivider) {
  PaneLayout layout(pane(0));
  ASSERT_TRUE(layout.split(pane(0), pane(1), SplitAxis::left_right));
  ASSERT_TRUE(layout.split(pane(0), pane(2), SplitAxis::top_bottom));
  ASSERT_TRUE(layout.split(pane(1), pane(3), SplitAxis::top_bottom));
  constexpr PaneRectangle viewport{.columns = 11, .rows = 7};
  const auto projection = layout.project(viewport);
  ASSERT_TRUE(projection.has_value());
  const auto projected = projection.value_or(LayoutProjection{});

  for (std::uint16_t row = 0; row < viewport.rows; ++row) {
    for (std::uint16_t column = 0; column < viewport.columns; ++column) {
      bool pane_cell = false;
      for (const auto id : {pane(0), pane(1), pane(2), pane(3)}) {
        const auto projected_pane = projected.rectangle(id).value_or(PaneRectangle{});
        pane_cell =
            pane_cell ||
            (column >= projected_pane.column && row >= projected_pane.row &&
             column < static_cast<std::uint32_t>(projected_pane.column) + projected_pane.columns &&
             row < static_cast<std::uint32_t>(projected_pane.row) + projected_pane.rows);
      }
      EXPECT_NE(pane_cell, layout.divider_at(viewport, column, row).has_value())
          << "column=" << column << " row=" << row;
    }
  }
}

TEST(PaneLayoutTest, StructuralMinimumPreventsZeroSizedNestedPanes) {
  PaneLayout layout(pane(0));
  ASSERT_TRUE(layout.split(pane(0), pane(1), SplitAxis::left_right));
  ASSERT_TRUE(layout.split(pane(0), pane(2), SplitAxis::left_right));
  constexpr PaneRectangle minimum_viewport{.columns = 5, .rows = 1};

  const auto projection = layout.project(minimum_viewport);

  ASSERT_TRUE(projection.has_value());
  EXPECT_EQ(projection.value_or(LayoutProjection{}).pane_count, 3U);
  EXPECT_EQ(rectangle(layout, pane(0), minimum_viewport).columns, 1U);
  EXPECT_EQ(rectangle(layout, pane(1), minimum_viewport).columns, 1U);
  EXPECT_EQ(rectangle(layout, pane(2), minimum_viewport).columns, 1U);
  EXPECT_FALSE(layout.project({.columns = 4, .rows = 1}).has_value());

  const auto retained = layout;
  EXPECT_EQ(layout.resize(pane(0), ResizeDirection::left, minimum_viewport),
            LayoutResizeStatus::no_effect);
  EXPECT_EQ(layout.resize(pane(0), ResizeDirection::right, minimum_viewport),
            LayoutResizeStatus::no_effect);
  EXPECT_EQ(layout, retained);
}

TEST(PaneLayoutTest, ResizeSelectsNearestMatchingStructuralAncestor) {
  PaneLayout layout(pane(0));
  ASSERT_TRUE(layout.split(pane(0), pane(1), SplitAxis::left_right));
  ASSERT_TRUE(layout.split(pane(0), pane(2), SplitAxis::top_bottom));
  ASSERT_TRUE(layout.split(pane(0), pane(3), SplitAxis::left_right));
  constexpr PaneRectangle viewport{.columns = 100, .rows = 41};
  const auto outer_right_before = rectangle(layout, pane(1), viewport);
  const auto target_before = rectangle(layout, pane(0), viewport);

  ASSERT_EQ(layout.resize(pane(0), ResizeDirection::right, viewport), LayoutResizeStatus::applied);

  const auto outer_right_after = rectangle(layout, pane(1), viewport);
  const auto target_after = rectangle(layout, pane(0), viewport);
  EXPECT_EQ(outer_right_after, outer_right_before) << "the outer aligned divider must not move";
  EXPECT_EQ(target_after.columns, target_before.columns + 1U);
}

TEST(PaneLayoutTest, RemovePromotesSiblingWithoutInvalidatingRetainedTopology) {
  PaneLayout layout(pane(0));
  ASSERT_TRUE(layout.split(pane(0), pane(1), SplitAxis::left_right));
  ASSERT_TRUE(layout.split(pane(1), pane(2), SplitAxis::top_bottom));
  constexpr PaneRectangle viewport{.columns = 80, .rows = 23};
  ASSERT_EQ(layout.resize(pane(2), ResizeDirection::up, viewport), LayoutResizeStatus::applied);

  const auto focus_candidate = layout.remove(pane(0));

  ASSERT_TRUE(focus_candidate.has_value());
  EXPECT_TRUE(layout.valid());
  EXPECT_EQ(layout.pane_count(), 2U);
  EXPECT_FALSE(layout.contains(pane(0)));
  EXPECT_TRUE(layout.contains(pane(1)));
  EXPECT_TRUE(layout.contains(pane(2)));
  const auto projection = layout.project(viewport);
  ASSERT_TRUE(projection.has_value());
  EXPECT_EQ(projection.value_or(LayoutProjection{}).pane_count, 2U);
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PaneLayoutTest, SupportsMaximumBoundedDepthAndPaneCount) {
  PaneLayout layout(pane(0));
  for (std::uint32_t slot = 1; slot < pane_layout_panes_max; ++slot) {
    ASSERT_TRUE(layout.split(pane(0), pane(slot), SplitAxis::left_right)) << slot;
  }

  EXPECT_EQ(layout.pane_count(), pane_layout_panes_max);
  EXPECT_TRUE(layout.valid());
  const auto projection = layout.project(
      {.columns = static_cast<std::uint16_t>((pane_layout_panes_max * 2U) - 1U), .rows = 1});
  ASSERT_TRUE(projection.has_value());
  EXPECT_EQ(projection.value_or(LayoutProjection{}).pane_count, pane_layout_panes_max);
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PaneLayoutTest, FixedPointRatioRoundTripsEverySupportedOneCellBoundary) {
  constexpr std::uint16_t columns_max = 500;
  for (std::uint16_t columns = 3; columns <= columns_max; ++columns) {
    PaneLayout layout(pane(0));
    ASSERT_TRUE(layout.split(pane(0), pane(1), SplitAxis::left_right));
    const PaneRectangle viewport{.columns = columns, .rows = 1};
    auto previous = rectangle(layout, pane(0), viewport).columns;
    while (layout.resize(pane(0), ResizeDirection::right, viewport) ==
           LayoutResizeStatus::applied) {
      const auto current = rectangle(layout, pane(0), viewport).columns;
      ASSERT_EQ(current, previous + 1U) << "viewport columns=" << columns;
      previous = current;
    }
    EXPECT_EQ(previous, columns - 2U) << "viewport columns=" << columns;
    EXPECT_TRUE(layout.valid());
  }
}

} // namespace
} // namespace lemma::core
