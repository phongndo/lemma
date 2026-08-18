#include "core/layout.hpp"
#include "lemma/generational_store.hpp"
#include "lemma/id.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <vector>

namespace lemma {
namespace {

[[nodiscard]] constexpr auto pane(const std::uint32_t slot,
                                  const std::uint32_t generation = 1) noexcept -> PaneId {
  return PaneId::from_parts(slot, generation);
}

[[nodiscard]] auto rectangle(const core::PaneLayout& layout, const PaneId id,
                             const PaneRectangle viewport) -> PaneRectangle {
  const auto projection = layout.project(viewport);
  EXPECT_TRUE(projection.has_value());
  const auto result = projection.has_value() ? projection->rectangle(id) : std::nullopt;
  EXPECT_TRUE(result.has_value());
  return result.value_or(PaneRectangle{});
}

// Assertion macros deliberately make every generated invariant failure independently visible.
// NOLINTBEGIN(bugprone-unchecked-optional-access,readability-function-cognitive-complexity)
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

TEST(PaneLayoutTest, FixedPointRatioRoundTripsEverySupportedOneCellBoundary) {
  constexpr std::uint16_t columns_max = 500;
  for (std::uint16_t columns = 3; columns <= columns_max; ++columns) {
    core::PaneLayout layout(pane(0));
    ASSERT_TRUE(layout.split(pane(0), pane(1), core::SplitAxis::left_right));
    const PaneRectangle viewport{.columns = columns, .rows = 1};
    auto previous = rectangle(layout, pane(0), viewport).columns;
    while (layout.resize(pane(0), core::ResizeDirection::right, viewport) ==
           core::LayoutResizeStatus::applied) {
      const auto current = rectangle(layout, pane(0), viewport).columns;
      ASSERT_EQ(current, previous + 1U) << "viewport columns=" << columns;
      previous = current;
    }
    EXPECT_EQ(previous, columns - 2U) << "viewport columns=" << columns;
    EXPECT_TRUE(layout.valid());
  }
}

// Generated topology changes exercise state-machine interactions that isolated examples miss.
// The fixed seed and operation log make every failure exactly reproducible.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PaneLayoutStateMachineStressTest, DeterministicOperationsPreserveProjectionAndIdentity) {
  constexpr std::uint32_t seed = 0x51A7E123U;
  constexpr std::size_t slots_max = 16;
  constexpr PaneRectangle viewport{.columns = 120, .rows = 80};
  std::uint32_t random = seed;
  std::array<std::uint32_t, slots_max> generations{};
  std::array<bool, slots_max> occupied{};
  generations.front() = 1;
  occupied.front() = true;
  core::PaneLayout layout(pane(0));
  std::vector<PaneId> stale;
  stale.reserve(2'048);
  std::string operations;
  operations.reserve(32'768);

  const auto next_random = [&random]() {
    random = (random * 1'664'525U) + 1'013'904'223U;
    return random;
  };
  const auto live_ids = [&]() {
    std::vector<PaneId> result;
    for (std::size_t slot = 0; slot < occupied.size(); ++slot) {
      if (occupied.at(slot)) {
        result.push_back(pane(static_cast<std::uint32_t>(slot), generations.at(slot)));
      }
    }
    return result;
  };

  for (std::size_t operation = 0; operation < 2'048; ++operation) {
    auto live = live_ids();
    const auto choice = next_random() % 4U;
    if (choice == 0U && live.size() < slots_max) {
      auto* const free = std::ranges::find(occupied, false);
      ASSERT_NE(free, occupied.end());
      const auto slot = static_cast<std::size_t>(free - occupied.begin());
      generations.at(slot) = generations.at(slot) == 0 ? 1U : generations.at(slot) + 1U;
      const auto id = pane(static_cast<std::uint32_t>(slot), generations.at(slot));
      const auto target = live.at(next_random() % live.size());
      const auto axis =
          next_random() % 2U == 0 ? core::SplitAxis::left_right : core::SplitAxis::top_bottom;
      ASSERT_TRUE(layout.split(target, id, axis)) << "seed=" << seed << "\n" << operations;
      occupied.at(slot) = true;
      operations +=
          "split " + std::to_string(target.slot()) + " -> " + std::to_string(id.slot()) + "; ";
    } else if (choice == 1U && live.size() > 1U) {
      const auto id = live.at(next_random() % live.size());
      ASSERT_TRUE(layout.remove(id).has_value()) << "seed=" << seed << "\n" << operations;
      occupied.at(id.slot()) = false;
      stale.push_back(id);
      operations += "remove " + std::to_string(id.slot()) + "; ";
    } else if (choice == 2U && live.size() > 1U) {
      const auto first = live.at(next_random() % live.size());
      auto second = live.at(next_random() % live.size());
      if (first == second) {
        second = live.at((second.slot() + 1U) % live.size());
      }
      if (first != second) {
        ASSERT_TRUE(layout.swap(first, second)) << "seed=" << seed << "\n" << operations;
        operations +=
            "swap " + std::to_string(first.slot()) + " " + std::to_string(second.slot()) + "; ";
      }
    } else {
      constexpr std::array directions{
          core::ResizeDirection::left,
          core::ResizeDirection::right,
          core::ResizeDirection::up,
          core::ResizeDirection::down,
      };
      const auto id = live.at(next_random() % live.size());
      const auto direction = directions.at(next_random() % directions.size());
      static_cast<void>(layout.resize(id, direction, viewport));
      operations += "resize " + std::to_string(id.slot()) + "; ";
    }

    live = live_ids();
    ASSERT_TRUE(layout.valid()) << "seed=" << seed << " operation=" << operation << "\n"
                                << operations;
    ASSERT_EQ(layout.pane_count(), live.size())
        << "seed=" << seed << " operation=" << operation << "\n"
        << operations;
    const auto projection = layout.project(viewport);
    ASSERT_TRUE(projection.has_value()) << "seed=" << seed << " operation=" << operation << "\n"
                                        << operations;
    ASSERT_EQ(projection->pane_count, live.size());
    for (std::size_t index = 0; index < live.size(); ++index) {
      const auto first = projection->rectangle(live.at(index));
      ASSERT_TRUE(first.has_value()) << "seed=" << seed << "\n" << operations;
      EXPECT_GT(first->columns, 0U);
      EXPECT_GT(first->rows, 0U);
      EXPECT_LE(static_cast<std::uint32_t>(first->column) + first->columns, viewport.columns);
      EXPECT_LE(static_cast<std::uint32_t>(first->row) + first->rows, viewport.rows);
      for (std::size_t other = index + 1U; other < live.size(); ++other) {
        const auto second = projection->rectangle(live.at(other));
        ASSERT_TRUE(second.has_value());
        const bool separated =
            static_cast<std::uint32_t>(first->column) + first->columns <= second->column ||
            static_cast<std::uint32_t>(second->column) + second->columns <= first->column ||
            static_cast<std::uint32_t>(first->row) + first->rows <= second->row ||
            static_cast<std::uint32_t>(second->row) + second->rows <= first->row;
        ASSERT_TRUE(separated) << "seed=" << seed << " operation=" << operation << "\n"
                               << operations;
      }
    }
    for (const auto id : stale) {
      EXPECT_FALSE(layout.contains(id))
          << "stale=" << id.slot() << ":" << id.generation() << " seed=" << seed << "\n"
          << operations;
      EXPECT_FALSE(projection->rectangle(id).has_value());
    }
  }
}
// NOLINTEND(bugprone-unchecked-optional-access,readability-function-cognitive-complexity)

} // namespace
} // namespace lemma
