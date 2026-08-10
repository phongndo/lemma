#include "core/client_frame_output.hpp"

#include "core/frame_scheduler.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstddef>
#include <memory>
#include <span>
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
  return std::make_unique<render::FrameBuffer>();
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

TEST(ClientFrameOutputTest, BlockedClientRetainsPartialWritesAcrossEintrAndEagain) {
  auto frame = make_frame();
  constexpr std::string_view message = "retained-frame";
  std::ranges::copy(std::as_bytes(std::span(message.data(), message.size())), frame->begin());
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
