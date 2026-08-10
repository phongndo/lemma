#include "core/client_frame_output.hpp"

#include "core/frame_scheduler.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <gtest/gtest.h>

namespace lemma::core {
namespace {

using namespace std::chrono_literals;

constexpr auto origin = ClientFrameOutput::TimePoint{};

struct ScriptedClientWriter final {
  std::vector<ClientFrameWriteAttempt> attempts;
  std::size_t next{0};
  std::array<std::byte, attached_client_write_bytes_per_client_turn_max + 1'024U> written{};
  std::size_t written_size{0};
  std::size_t calls{0};
};

struct ScriptedFrameAllocator final {
  std::size_t calls{0};
  bool fail{false};
};

[[nodiscard]] auto allocate_test_frame(void* const context, const std::size_t bytes) noexcept
    -> render::FrameStorage {
  auto& script = *static_cast<ScriptedFrameAllocator*>(context);
  ++script.calls;
  if (script.fail) {
    return nullptr;
  }
  try {
    // Test allocation mirrors runtime-sized frame ownership.
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
    return std::make_unique_for_overwrite<std::byte[]>(bytes);
  } catch (const std::bad_alloc&) {
    return nullptr;
  }
}

[[nodiscard]] auto scripted_client_write(void* const context,
                                         const std::span<const std::byte> bytes) noexcept
    -> ClientFrameWriteAttempt {
  auto& script = *static_cast<ScriptedClientWriter*>(context);
  ++script.calls;
  ClientFrameWriteAttempt result{.bytes = static_cast<std::ptrdiff_t>(bytes.size())};
  if (script.next < script.attempts.size()) {
    result = std::span(script.attempts).subspan(script.next, 1).front();
    ++script.next;
  }
  if (result.bytes > 0) {
    const auto size = static_cast<std::size_t>(result.bytes);
    if (size <= bytes.size() && size <= script.written.size() - script.written_size) {
      std::ranges::copy(bytes.first(size),
                        std::span(script.written).subspan(script.written_size, size).begin());
      script.written_size += size;
    }
  }
  return result;
}

[[nodiscard]] auto make_frame() -> std::unique_ptr<render::FrameBuffer> {
  auto frame = std::make_unique<render::FrameBuffer>();
  EXPECT_TRUE(frame->prepare({.columns = 80, .rows = 24}));
  return frame;
}

[[nodiscard]] auto target_for(render::FrameBuffer& frame, ClientFrameOutput& output,
                              ScriptedClientWriter& writer, const int descriptor = 7)
    -> ClientFrameFlushTarget {
  return {
      .descriptor = descriptor,
      .frame = &frame,
      .output = &output,
      .write = &scripted_client_write,
      .context = &writer,
  };
}

TEST(ClientFrameOutputTest, RejectsCapacityAndPreservesStorageAfterFailedLifecycleGrowth) {
  ScriptedFrameAllocator allocator;
  render::FrameBuffer frame(&allocate_test_frame, &allocator);

  const auto invalid = render::frame_capacity_for_viewport({.columns = 0, .rows = 24});
  ASSERT_FALSE(invalid.has_value());
  EXPECT_EQ(invalid.error(), render::FrameCapacityError::invalid_viewport);
  EXPECT_FALSE(frame.prepare(
      {.columns = static_cast<std::uint16_t>(limits::terminal_columns_hard_max + 1U), .rows = 24}));
  EXPECT_EQ(allocator.calls, 0U);

  const auto protocol_maximum = render::frame_capacity_for_viewport({.columns = 500, .rows = 200});
  ASSERT_TRUE(protocol_maximum.has_value());
  EXPECT_EQ(*protocol_maximum, render::frame_bytes_max);

  ASSERT_TRUE(frame.prepare({.columns = 80, .rows = 24}));
  ASSERT_FALSE(frame.writable().empty());
  frame.writable().front() = std::byte{0x5A};
  const auto previous_capacity = frame.capacity();
  const auto* const previous_storage = frame.writable().data();
  allocator.fail = true;

  constexpr render::Viewport larger_viewport{.columns = 500, .rows = 200};
  EXPECT_FALSE(frame.prepare(larger_viewport));
  EXPECT_EQ(frame.capacity(), previous_capacity);
  EXPECT_EQ(frame.writable().data(), previous_storage);
  EXPECT_EQ(frame.writable().front(), std::byte{0x5A});
  EXPECT_EQ(allocator.calls, 2U);

  allocator.fail = false;
  EXPECT_FALSE(frame.prepare(larger_viewport, previous_capacity + 1U));
  EXPECT_EQ(allocator.calls, 2U);
  ASSERT_TRUE(frame.prepare(larger_viewport, 1));
  EXPECT_GT(frame.capacity(), previous_capacity);
  EXPECT_NE(frame.writable().data(), previous_storage);
  EXPECT_EQ(frame.writable().front(), std::byte{0x5A});
  EXPECT_EQ(allocator.calls, 3U);
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(ClientFrameOutputTest, SizesFrameForRendererBoundAndComposesAlternatingStyles) {
  constexpr std::uint16_t columns = 80;
  constexpr std::uint16_t rows = 24;
  vt::TerminalOptions options;
  options.size = {.columns = columns, .rows = rows};
  auto terminal_result = vt::Terminal::create(options);
  ASSERT_TRUE(terminal_result.has_value());
  auto terminal = std::move(*terminal_result);

  constexpr std::string_view first_style = "\x1B[1;31m";
  constexpr std::string_view second_style = "\x1B[1;32m";
  std::string contents;
  const auto cell_count = static_cast<std::size_t>(columns) * rows;
  contents.reserve(cell_count * (first_style.size() + 1U));
  for (std::size_t cell = 0; cell < cell_count; ++cell) {
    contents.append(cell % 2U == 0 ? first_style : second_style);
    contents.push_back('X');
  }
  terminal.write(std::as_bytes(std::span(contents.data(), contents.size())));

  render::FrameBuffer frame;
  ASSERT_TRUE(frame.prepare({.columns = columns, .rows = rows}));
  EXPECT_EQ(frame.capacity(), render::frame_fixed_overhead_bytes +
                                  (cell_count * render::frame_bytes_per_viewport_cell));

  const auto composition = render::compose_retained_single_pane(terminal, frame, true);
  ASSERT_TRUE(composition.has_value());
  EXPECT_LE(composition->bytes, frame.capacity());
}

TEST(ClientFrameOutputTest, CompositionAndFlushDoNotAllocateFrameStorage) {
  ScriptedFrameAllocator allocator;
  render::FrameBuffer frame(&allocate_test_frame, &allocator);
  ASSERT_TRUE(frame.prepare({.columns = 80, .rows = 24}));
  ASSERT_EQ(allocator.calls, 1U);
  auto terminal_result = vt::Terminal::create({});
  ASSERT_TRUE(terminal_result.has_value());
  auto terminal = std::move(*terminal_result);
  ASSERT_TRUE(render::compose_retained_single_pane(terminal, frame, true).has_value());
  constexpr std::string_view damage = "steady state";
  terminal.write(std::as_bytes(std::span(damage.data(), damage.size())));
  const auto terminal_allocations = terminal.allocation_stats().allocations_total;

  const auto composition = render::compose_retained_single_pane(terminal, frame, false);
  ASSERT_TRUE(composition.has_value());
  EXPECT_EQ(allocator.calls, 1U);
  EXPECT_EQ(terminal.allocation_stats().allocations_total, terminal_allocations);

  ClientFrameOutput output;
  ASSERT_TRUE(output.queue(composition->bytes, origin));
  ScriptedClientWriter writer;
  auto target = target_for(frame, output, writer);
  std::size_t budget = attached_client_write_bytes_per_turn_max;
  EXPECT_EQ(flush_client_frame(target, budget, origin), ClientFrameFlushStatus::drained);
  EXPECT_EQ(allocator.calls, 1U);
}

TEST(ClientFrameOutputTest, BlockedClientRetainsPartialWritesAcrossEintrAndEagain) {
  auto frame = make_frame();
  constexpr std::string_view message = "retained-frame";
  std::ranges::copy(std::as_bytes(std::span(message.data(), message.size())),
                    frame->writable().begin());
  ClientFrameOutput output;
  ASSERT_TRUE(output.queue(message.size(), origin));
  ScriptedClientWriter writer;
  writer.attempts = {
      {.bytes = 2}, {.bytes = -1, .error = EINTR}, {.bytes = 3}, {.bytes = -1, .error = EAGAIN}};
  auto target = target_for(*frame, output, writer);
  std::size_t budget = 1'024;

  EXPECT_EQ(flush_client_frame(target, budget, origin + 1ms), ClientFrameFlushStatus::blocked);
  EXPECT_EQ(output.offset(), 5U);
  EXPECT_EQ(output.size(), message.size());
  EXPECT_EQ(budget, 1'019U);
  EXPECT_FALSE(output.write_ready());

  output.mark_write_ready();
  EXPECT_EQ(flush_client_frame(target, budget, origin + 2ms), ClientFrameFlushStatus::drained);
  EXPECT_FALSE(output.busy());
  const auto expected = std::as_bytes(std::span(message.data(), message.size()));
  EXPECT_TRUE(std::ranges::equal(std::span(writer.written).first(writer.written_size), expected));
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(ClientFrameOutputTest, FloodedPaneKeepsOneFrameAndCollapsesDamageIntoFullRecovery) {
  auto terminal_result = vt::Terminal::create({});
  ASSERT_TRUE(terminal_result.has_value());
  auto terminal = std::move(*terminal_result);
  constexpr std::string_view initial = "initial\r\n";
  terminal.write(std::as_bytes(std::span(initial.data(), initial.size())));
  auto frame = make_frame();
  const auto initial_frame = render::compose_retained_single_pane(terminal, *frame);
  ASSERT_TRUE(initial_frame.has_value());

  ClientFrameOutput output;
  ASSERT_TRUE(output.queue(initial_frame->bytes, origin));
  ScriptedClientWriter writer;
  writer.attempts = {{.bytes = -1, .error = EAGAIN}};
  auto target = target_for(*frame, output, writer);
  std::size_t budget = attached_client_write_bytes_per_turn_max;
  ASSERT_EQ(flush_client_frame(target, budget, origin), ClientFrameFlushStatus::blocked);

  FrameScheduler scheduler;
  constexpr std::string_view damage = "flooded pane damage\r\n";
  for (std::size_t update = 0; update < 100; ++update) {
    terminal.write(std::as_bytes(std::span(damage.data(), damage.size())));
    scheduler.request(FrameUrgency::burst, false, origin + 1ms, FrameSinkState::blocked);
  }
  EXPECT_FALSE(output.queue(initial_frame->bytes, origin + 1ms))
      << "an in-flight frame must not be replaced";
  EXPECT_TRUE(scheduler.pending());
  EXPECT_TRUE(scheduler.force_full());
  EXPECT_FALSE(scheduler.deadline(FrameSinkState::blocked).has_value());

  output.mark_write_ready();
  ASSERT_EQ(flush_client_frame(target, budget, origin + 2ms), ClientFrameFlushStatus::drained);
  EXPECT_TRUE(scheduler.due(origin + 1s, FrameSinkState::ready));
  const auto recovery =
      render::compose_retained_single_pane(terminal, *frame, scheduler.force_full());
  ASSERT_TRUE(recovery.has_value());
  EXPECT_TRUE(recovery->full);
  EXPECT_TRUE(output.queue(recovery->bytes, origin + 1s));
}

TEST(ClientFrameOutputTest, FloodedWritableClientCannotExceedItsPerTurnBudget) {
  auto frame = make_frame();
  ClientFrameOutput output;
  ASSERT_TRUE(output.queue(attached_client_write_bytes_per_client_turn_max + 1U, origin));
  ScriptedClientWriter writer;
  auto target = target_for(*frame, output, writer);
  std::size_t budget = attached_client_write_bytes_per_client_turn_max * 2U;

  EXPECT_EQ(flush_client_frame(target, budget, origin), ClientFrameFlushStatus::pending);
  EXPECT_EQ(output.offset(), attached_client_write_bytes_per_client_turn_max);
  EXPECT_EQ(budget, attached_client_write_bytes_per_client_turn_max);
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(ClientFrameOutputTest, ManyWritableClientsShareOneGlobalBudget) {
  constexpr std::size_t client_count = 16;
  constexpr std::size_t frame_size = 1'024;
  auto frame = make_frame();
  std::array<ClientFrameOutput, client_count> outputs;
  std::array<ScriptedClientWriter, client_count> writers;
  std::array<ClientFrameFlushTarget, client_count> targets;
  for (std::size_t index = 0; index < client_count; ++index) {
    ASSERT_TRUE(std::span(outputs).subspan(index, 1).front().queue(frame_size, origin));
    std::span(targets).subspan(index, 1).front() =
        target_for(*frame, std::span(outputs).subspan(index, 1).front(),
                   std::span(writers).subspan(index, 1).front(), static_cast<int>(index));
  }

  std::size_t cursor = 0;
  for (std::size_t turn = 0; turn < 4; ++turn) {
    std::size_t budget = frame_size * 4U;
    flush_ready_client_frames(targets, cursor, budget, origin + std::chrono::milliseconds(turn));
    EXPECT_EQ(budget, 0U);
  }
  for (const auto& output : outputs) {
    EXPECT_FALSE(output.busy());
  }
  for (const auto& writer : writers) {
    EXPECT_EQ(writer.written_size, frame_size);
  }
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(ClientFrameOutputTest, RoundRobinCursorPreventsLowSlotFloodStarvation) {
  constexpr std::size_t client_count = 3;
  auto frame = make_frame();
  std::array<ClientFrameOutput, client_count> outputs;
  std::array<ScriptedClientWriter, client_count> writers;
  std::array<ClientFrameFlushTarget, client_count> targets;
  std::size_t cursor = 0;

  for (std::size_t turn = 0; turn < client_count; ++turn) {
    for (std::size_t index = 0; index < client_count; ++index) {
      auto& output = std::span(outputs).subspan(index, 1).front();
      if (!output.busy() &&
          (index == 0 || std::span(writers).subspan(index, 1).front().calls == 0)) {
        ASSERT_TRUE(output.queue(1, origin + std::chrono::milliseconds(turn)));
      }
      std::span(targets).subspan(index, 1).front() = target_for(
          *frame, output, std::span(writers).subspan(index, 1).front(), static_cast<int>(index));
    }
    std::size_t budget = 1;
    flush_ready_client_frames(targets, cursor, budget, origin + std::chrono::milliseconds(turn));
    EXPECT_EQ(budget, 0U);
  }

  EXPECT_GE(writers.front().calls, 1U);
  EXPECT_EQ(std::span(writers).subspan(1, 1).front().calls, 1U);
  EXPECT_EQ(std::span(writers).subspan(2, 1).front().calls, 1U);
}

TEST(ClientFrameOutputTest, ProgressAndTotalFrameDeadlinesAreBothBounded) {
  ClientFrameOutput no_progress;
  ASSERT_TRUE(no_progress.queue(10, origin));
  EXPECT_FALSE(no_progress.expired(origin + attached_client_no_progress_timeout - 1ns));
  EXPECT_TRUE(no_progress.expired(origin + attached_client_no_progress_timeout));
  auto frame = make_frame();
  ScriptedClientWriter writer;
  auto target = target_for(*frame, no_progress, writer);
  std::size_t budget = 1'024;
  EXPECT_EQ(flush_client_frame(target, budget, origin + attached_client_no_progress_timeout),
            ClientFrameFlushStatus::deadline_exceeded);
  EXPECT_EQ(writer.calls, 0U);

  ClientFrameOutput trickling;
  ASSERT_TRUE(trickling.queue(10, origin));
  ASSERT_TRUE(trickling.consume(1, origin + attached_client_frame_total_timeout - 1s));
  EXPECT_FALSE(trickling.expired(origin + attached_client_frame_total_timeout - 1ns));
  EXPECT_TRUE(trickling.expired(origin + attached_client_frame_total_timeout));
}

} // namespace
} // namespace lemma::core
