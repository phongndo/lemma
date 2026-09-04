#include "lemma/terminal/terminal.hpp"

#include "support/terminal_response_buffer.hpp"

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace lemma::vt {
namespace {

void write_text(Terminal& terminal, const std::string_view text,
                const PtyResponseSink responses = {}) {
  terminal.write(std::as_bytes(std::span(text.data(), text.size())), responses);
}

[[nodiscard]] auto make_terminal(const TerminalOptions& options = {}) -> Terminal {
  auto result = Terminal::create(options);
  EXPECT_TRUE(result.has_value());
  return std::move(result).value();
}

[[nodiscard]] auto snapshot_u32(const std::span<const std::byte> bytes,
                                const std::size_t offset) noexcept -> std::uint32_t {
  const auto value = bytes.subspan(offset, 4);
  return std::to_integer<std::uint32_t>(value.front()) |
         (std::to_integer<std::uint32_t>(value.subspan(1U, 1U).front()) << 8U) |
         (std::to_integer<std::uint32_t>(value.subspan(2U, 1U).front()) << 16U) |
         (std::to_integer<std::uint32_t>(value.subspan(3U, 1U).front()) << 24U);
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void expect_full_projection_equal(Terminal& canonical, Terminal& replayed) {
  std::array<std::byte, std::size_t{512} * 1'024U> canonical_visible{};
  std::array<std::byte, std::size_t{512} * 1'024U> replayed_visible{};
  const auto canonical_visible_bytes =
      canonical.format_screen(ScreenFormat::plain, canonical_visible);
  const auto replayed_visible_bytes = replayed.format_screen(ScreenFormat::plain, replayed_visible);
  ASSERT_TRUE(canonical_visible_bytes.has_value());
  ASSERT_TRUE(replayed_visible_bytes.has_value());
  // Construct owning diagnostics only in the test oracle so failures show the semantic difference.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string canonical_text(reinterpret_cast<const char*>(canonical_visible.data()),
                                   *canonical_visible_bytes);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string replayed_text(reinterpret_cast<const char*>(replayed_visible.data()),
                                  *replayed_visible_bytes);
  EXPECT_EQ(canonical_text, replayed_text);

  canonical.invalidate_ansi_render_state();
  replayed.invalidate_ansi_render_state();
  std::array<std::byte, std::size_t{512} * 1'024U> canonical_output{};
  std::array<std::byte, std::size_t{512} * 1'024U> replayed_output{};
  const auto canonical_frame = canonical.render_ansi(canonical_output, true);
  const auto replayed_frame = replayed.render_ansi(replayed_output, true);
  ASSERT_TRUE(canonical_frame.has_value());
  ASSERT_TRUE(replayed_frame.has_value());
  EXPECT_TRUE(std::ranges::equal(std::span(canonical_output).first(canonical_frame->bytes),
                                 std::span(replayed_output).first(replayed_frame->bytes)));
}

void project_and_expect_convergence(Terminal& canonical, Terminal& projected,
                                    const bool force_full = false) {
  std::array<std::byte, std::size_t{512} * 1'024U> output{};
  const auto rendered = canonical.render_ansi(output, force_full);
  ASSERT_TRUE(rendered.has_value());
  projected.write(std::span(output).first(rendered->bytes));
  expect_full_projection_equal(canonical, projected);
}

TEST(TerminalTest, RejectsInvalidAndUnfundedConfigurations) {
  TerminalOptions invalid_dimensions;
  invalid_dimensions.size.columns = 0;
  const auto invalid_result = Terminal::create(invalid_dimensions);
  ASSERT_FALSE(invalid_result.has_value());
  EXPECT_EQ(invalid_result.error(), Error::invalid_options);

  TerminalOptions excessive_scrollback;
  excessive_scrollback.scrollback_bytes_max = limits::terminal_scrollback_bytes_hard_max + 1U;
  const auto excessive_scrollback_result = Terminal::create(excessive_scrollback);
  ASSERT_FALSE(excessive_scrollback_result.has_value());
  EXPECT_EQ(excessive_scrollback_result.error(), Error::invalid_options);

  TerminalOptions excessive_scrollback_lines;
  excessive_scrollback_lines.scrollback_lines_max = limits::terminal_scrollback_lines_hard_max + 1U;
  const auto excessive_scrollback_lines_result = Terminal::create(excessive_scrollback_lines);
  ASSERT_FALSE(excessive_scrollback_lines_result.has_value());
  EXPECT_EQ(excessive_scrollback_lines_result.error(), Error::invalid_options);

  TerminalOptions exhausted;
  exhausted.allocation_bytes_max = 1;
  const auto exhausted_result = Terminal::create(exhausted);
  ASSERT_FALSE(exhausted_result.has_value());
  EXPECT_EQ(exhausted_result.error(), Error::out_of_memory);

  TerminalOptions excessive_continuation;
  excessive_continuation.snapshot_continuation_bytes_max =
      limits::snapshot_continuation_bytes_max + 1U;
  const auto excessive_continuation_result = Terminal::create(excessive_continuation);
  ASSERT_FALSE(excessive_continuation_result.has_value());
  EXPECT_EQ(excessive_continuation_result.error(), Error::invalid_options);
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, CompleteSnapshotRestoresCanonicalStateAndAdapterCallbacks) {
  TerminalOptions options;
  options.size = {.columns = 24, .rows = 4, .cell_width_px = 8, .cell_height_px = 16};
  options.scrollback_lines_max = 256;
  options.snapshot_continuation_bytes_max = 4'096;
  auto canonical = make_terminal(options);

  write_text(canonical, "\x1B]2;snapshot title\x1B\\\x1B]7;file:///tmp/snapshot\x1B\\");
  write_text(canonical, "\x1B]4;2;rgb:12/34/56\x1B\\\x1B[?1000h\x1B[?2004h");
  for (std::size_t index = 0; index < 20; ++index) {
    write_text(canonical,
               "\x1B[1;3" + std::to_string(index % 8U) + "mhistory e\xCC\x81\x1B[0m\r\n");
  }
  write_text(canonical, "primary tail\x1B[?1049h\x1B[38;5;2malt \xF0\x9F\x99\x82\x1B[0m "
                        "\x1B]8;;https://example.invalid/snapshot\x1B\\linked\x1B]8;;\x1B\\");
  const auto selected = canonical.select(SelectionUnit::all);
  ASSERT_TRUE(selected.has_value());
  ASSERT_TRUE(*selected);
  const auto selected_size = canonical.snapshot_size();
  ASSERT_FALSE(selected_size.has_value());
  EXPECT_EQ(selected_size.error(), Error::invalid_state);
  std::array<std::byte, 4'096> selected_output{};
  const auto selected_encode = canonical.encode_snapshot(selected_output);
  ASSERT_FALSE(selected_encode.has_value());
  EXPECT_EQ(selected_encode.error(), Error::invalid_state);
  canonical.clear_selection();

  const auto required = canonical.snapshot_size();
  ASSERT_TRUE(required.has_value());
  ASSERT_GT(*required, 0U);
  ASSERT_LE(*required, limits::snapshot_bytes_max);
  std::vector<std::byte> encoded(*required);
  const auto encoded_size = canonical.encode_snapshot(encoded);
  ASSERT_TRUE(encoded_size.has_value());
  ASSERT_EQ(*encoded_size, encoded.size());

  auto restored_result = Terminal::restore_snapshot(options, encoded);
  ASSERT_TRUE(restored_result.has_value()) << static_cast<unsigned>(restored_result.error());
  auto restored = std::move(restored_result).value();
  expect_full_projection_equal(canonical, restored);
  EXPECT_EQ(canonical.size(), restored.size());
  EXPECT_EQ(canonical.title(), restored.title());
  EXPECT_EQ(canonical.pwd(), restored.pwd());
  EXPECT_EQ(canonical.mouse_tracking(), restored.mouse_tracking());
  EXPECT_EQ(canonical.selection_active(), restored.selection_active());

  std::array<std::byte, 64> canonical_input{};
  std::array<std::byte, 64> restored_input{};
  std::array<std::byte, 1> paste_input{std::byte{'x'}};
  auto canonical_paste = paste_input;
  auto restored_paste = paste_input;
  const auto canonical_paste_size = canonical.encode_paste(canonical_paste, canonical_input);
  const auto restored_paste_size = restored.encode_paste(restored_paste, restored_input);
  ASSERT_TRUE(canonical_paste_size.has_value());
  ASSERT_TRUE(restored_paste_size.has_value());
  EXPECT_TRUE(std::ranges::equal(std::span(canonical_input).first(*canonical_paste_size),
                                 std::span(restored_input).first(*restored_paste_size)));

  test_support::TerminalResponseBuffer canonical_responses;
  test_support::TerminalResponseBuffer restored_responses;
  write_text(canonical, "\x1B[6n", canonical_responses.sink());
  write_text(restored, "\x1B[6n", restored_responses.sink());
  EXPECT_TRUE(
      std::ranges::equal(canonical_responses.readable_span(), restored_responses.readable_span()));

  write_text(canonical, "\x1B[?1049l");
  write_text(restored, "\x1B[?1049l");
  expect_full_projection_equal(canonical, restored);
  std::array<std::byte, std::size_t{512} * 1'024U> canonical_history{};
  std::array<std::byte, std::size_t{512} * 1'024U> restored_history{};
  const auto canonical_history_size =
      canonical.format_recent(ScreenFormat::vt_full, 100, canonical_history);
  const auto restored_history_size =
      restored.format_recent(ScreenFormat::vt_full, 100, restored_history);
  ASSERT_TRUE(canonical_history_size.has_value());
  ASSERT_TRUE(restored_history_size.has_value());
  EXPECT_TRUE(std::ranges::equal(std::span(canonical_history).first(*canonical_history_size),
                                 std::span(restored_history).first(*restored_history_size)));

  const TerminalSize resized{.columns = 30, .rows = 6, .cell_width_px = 9, .cell_height_px = 18};
  ASSERT_TRUE(canonical.resize(resized).has_value());
  ASSERT_TRUE(restored.resize(resized).has_value());
  expect_full_projection_equal(canonical, restored);

  write_text(restored, "\x1B]2;after restore\x1B\\");
  EXPECT_EQ(restored.take_effects().title_changes, 1U);
}

// GoogleTest assertions inside the case loop inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, SnapshotPreservesUnfinishedVtAndUtf8Continuations) {
  TerminalOptions options;
  options.size = {.columns = 16, .rows = 2};
  options.snapshot_continuation_bytes_max = 4'096;
  const std::array cases{
      std::pair<std::string_view, std::string_view>{"\x1B[38;2;1;2", ";3mred"},
      std::pair<std::string_view, std::string_view>{"\xF0\x9F", "\x99\x82"},
  };

  for (const auto& [prefix, suffix] : cases) {
    auto canonical = make_terminal(options);
    write_text(canonical, prefix);
    const auto required = canonical.snapshot_size();
    ASSERT_TRUE(required.has_value());
    std::vector<std::byte> encoded(*required);
    ASSERT_EQ(canonical.encode_snapshot(encoded), required);
    auto restored_result = Terminal::restore_snapshot(options, encoded);
    ASSERT_TRUE(restored_result.has_value());
    auto restored = std::move(restored_result).value();

    write_text(canonical, suffix);
    write_text(restored, suffix);
    expect_full_projection_equal(canonical, restored);
  }
}

// GoogleTest assertions inside the history loop inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, SnapshotReadyRestorePublishesEarlyAndPrependsBoundedHistoryPages) {
  TerminalOptions options;
  options.size = {.columns = 215, .rows = 2};
  options.scrollback_lines_max = 2'000;
  options.snapshot_continuation_bytes_max = 4'096;
  auto canonical = make_terminal(options);
  for (std::size_t index = 0; index < 1'000; ++index) {
    write_text(canonical, "snapshot history " + std::to_string(index) + "\r\n");
  }

  const auto required = canonical.snapshot_size();
  ASSERT_TRUE(required.has_value());
  std::vector<std::byte> encoded(*required);
  ASSERT_EQ(canonical.encode_snapshot(encoded), required);

  auto restore_result = TerminalSnapshotRestore::begin(options, encoded);
  ASSERT_TRUE(restore_result.has_value());
  auto restore = std::move(*restore_result);
  EXPECT_FALSE(restore.complete());
  const auto ready = restore.ready_info();
  EXPECT_GT(ready.primary_history_rows, 0U);
  EXPECT_GT(ready.source_bytes_consumed, 0U);
  EXPECT_LT(ready.source_bytes_consumed, encoded.size());
  std::array<std::byte, std::size_t{512} * 1'024U> canonical_ready{};
  std::array<std::byte, std::size_t{512} * 1'024U> restored_ready{};
  const auto canonical_ready_frame = canonical.render_ansi(canonical_ready, true);
  const auto restored_ready_frame = restore.terminal().render_ansi(restored_ready, true);
  ASSERT_TRUE(canonical_ready_frame.has_value());
  ASSERT_TRUE(restored_ready_frame.has_value());
  EXPECT_TRUE(std::ranges::equal(std::span(canonical_ready).first(canonical_ready_frame->bytes),
                                 std::span(restored_ready).first(restored_ready_frame->bytes)));

  std::size_t history_pages = 0;
  auto source_offset = ready.source_bytes_consumed;
  while (true) {
    const auto progress = restore.next_history();
    ASSERT_TRUE(progress.has_value());
    if (!progress->has_value()) {
      break;
    }
    ++history_pages;
    EXPECT_GE(progress->value().source_bytes_consumed, source_offset);
    EXPECT_LE(progress->value().source_bytes_consumed, encoded.size());
    source_offset = progress->value().source_bytes_consumed;
  }
  EXPECT_GT(history_pages, 0U);
  EXPECT_TRUE(restore.complete());
  const auto already_complete = restore.next_history();
  ASSERT_TRUE(already_complete.has_value());
  EXPECT_FALSE(already_complete->has_value());

  auto restored_result = std::move(restore).take_terminal();
  ASSERT_TRUE(restored_result.has_value());
  auto restored = std::move(*restored_result);
  expect_full_projection_equal(canonical, restored);
  std::array<std::byte, std::size_t{512} * 1'024U> canonical_history{};
  std::array<std::byte, std::size_t{512} * 1'024U> restored_history{};
  const auto canonical_history_size =
      canonical.format_recent(ScreenFormat::plain, 1'100, canonical_history);
  const auto restored_history_size =
      restored.format_recent(ScreenFormat::plain, 1'100, restored_history);
  ASSERT_TRUE(canonical_history_size.has_value());
  ASSERT_TRUE(restored_history_size.has_value());
  EXPECT_TRUE(std::ranges::equal(std::span(canonical_history).first(*canonical_history_size),
                                 std::span(restored_history).first(*restored_history_size)));
}

TEST(TerminalTest, SnapshotBoundaryRejectsTruncationCorruptionTrailingBytesAndWrongGeometry) {
  TerminalOptions options;
  options.size = {.columns = 16, .rows = 3};
  options.snapshot_continuation_bytes_max = 1'024;
  auto canonical = make_terminal(options);
  write_text(canonical, "snapshot payload");
  const auto required = canonical.snapshot_size();
  ASSERT_TRUE(required.has_value());
  std::vector<std::byte> encoded(*required);
  ASSERT_EQ(canonical.encode_snapshot(encoded), required);

  std::array<std::byte, 1> insufficient{};
  const auto out_of_space = canonical.encode_snapshot(insufficient);
  ASSERT_FALSE(out_of_space.has_value());
  EXPECT_EQ(out_of_space.error(), Error::out_of_space);

  const auto truncated = Terminal::restore_snapshot(
      options, std::span<const std::byte>(encoded).first(encoded.size() - 1U));
  ASSERT_FALSE(truncated.has_value());
  EXPECT_EQ(truncated.error(), Error::invalid_state);

  auto corrupted = encoded;
  corrupted.at(corrupted.size() / 2U) ^= std::byte{1};
  const auto corrupt = Terminal::restore_snapshot(options, corrupted);
  ASSERT_FALSE(corrupt.has_value());
  EXPECT_EQ(corrupt.error(), Error::invalid_state);

  auto unsupported_version = encoded;
  unsupported_version.at(8) ^= std::byte{1};
  const auto unsupported = Terminal::restore_snapshot(options, unsupported_version);
  ASSERT_FALSE(unsupported.has_value());
  EXPECT_EQ(unsupported.error(), Error::invalid_state);

  // Move two complete records without changing their headers, payloads, or CRCs. This isolates
  // record ordering from the corruption checks above: SCREEN before TERMINAL must fail closed.
  constexpr std::size_t envelope_bytes = 10;
  constexpr std::size_t record_header_bytes = 10;
  ASSERT_GE(encoded.size(), envelope_bytes + (2U * record_header_bytes));
  const auto first_record_bytes = record_header_bytes + snapshot_u32(encoded, envelope_bytes + 2U);
  const auto second_record_offset = envelope_bytes + first_record_bytes;
  ASSERT_LE(second_record_offset + record_header_bytes, encoded.size());
  const auto second_record_bytes =
      record_header_bytes + snapshot_u32(encoded, second_record_offset + 2U);
  const auto records_tail_offset = second_record_offset + second_record_bytes;
  ASSERT_LE(records_tail_offset, encoded.size());
  ASSERT_EQ(std::span(encoded).subspan(envelope_bytes, 1U).front(), std::byte{1});
  ASSERT_EQ(std::span(encoded).subspan(second_record_offset, 1U).front(), std::byte{2});
  std::vector<std::byte> reordered_records;
  reordered_records.reserve(encoded.size());
  reordered_records.insert(reordered_records.end(), encoded.begin(),
                           encoded.begin() + static_cast<std::ptrdiff_t>(envelope_bytes));
  reordered_records.insert(reordered_records.end(),
                           encoded.begin() + static_cast<std::ptrdiff_t>(second_record_offset),
                           encoded.begin() + static_cast<std::ptrdiff_t>(records_tail_offset));
  reordered_records.insert(reordered_records.end(),
                           encoded.begin() + static_cast<std::ptrdiff_t>(envelope_bytes),
                           encoded.begin() + static_cast<std::ptrdiff_t>(second_record_offset));
  reordered_records.insert(reordered_records.end(),
                           encoded.begin() + static_cast<std::ptrdiff_t>(records_tail_offset),
                           encoded.end());
  ASSERT_EQ(reordered_records.size(), encoded.size());
  const auto reordered = Terminal::restore_snapshot(options, reordered_records);
  ASSERT_FALSE(reordered.has_value());
  EXPECT_EQ(reordered.error(), Error::invalid_state);

  auto trailing = encoded;
  trailing.push_back(std::byte{0});
  const auto with_trailing = Terminal::restore_snapshot(options, trailing);
  ASSERT_FALSE(with_trailing.has_value());
  EXPECT_EQ(with_trailing.error(), Error::invalid_state);

  auto wrong_geometry = options;
  ++wrong_geometry.size.columns;
  const auto mismatched = Terminal::restore_snapshot(wrong_geometry, encoded);
  ASSERT_FALSE(mismatched.has_value());
  EXPECT_EQ(mismatched.error(), Error::invalid_options);

  const auto fresh_peak = make_terminal(options).allocation_stats().bytes_peak;
  auto constrained_options = options;
  constrained_options.allocation_bytes_max = fresh_peak;
  const auto constrained_fresh = Terminal::create(constrained_options);
  ASSERT_TRUE(constrained_fresh.has_value());
  const auto allocation_failure = TerminalSnapshotRestore::begin(constrained_options, encoded);
  ASSERT_FALSE(allocation_failure.has_value());
  EXPECT_EQ(allocation_failure.error(), Error::out_of_memory);

  // Destroying a READY decoder before FINISH is the bounded cancellation path. Decoder teardown
  // must precede its borrowed terminal teardown and release every quota-charged allocation.
  const auto cancelled = TerminalSnapshotRestore::begin(options, encoded);
  ASSERT_TRUE(cancelled.has_value());
  EXPECT_FALSE(cancelled->complete());
}

TEST(TerminalTest, ParsesUtf8AndReportsDamage) {
  auto terminal = make_terminal();

  const auto initial = terminal.update_render_state();
  ASSERT_TRUE(initial.has_value());
  EXPECT_EQ(initial->dirty, DirtyState::full);
  EXPECT_EQ(initial->columns, 80);
  EXPECT_EQ(initial->rows, 24);
  ASSERT_TRUE(terminal.mark_rendered().has_value());

  write_text(terminal, "h\xC3\xA9llo");
  const auto update = terminal.update_render_state();
  ASSERT_TRUE(update.has_value());
  EXPECT_NE(update->dirty, DirtyState::clean);
  EXPECT_GE(update->dirty_rows, 1U);
  EXPECT_EQ(update->cursor_column, 5);
  EXPECT_EQ(update->cursor_row, 0);

  ASSERT_TRUE(terminal.mark_rendered().has_value());
  const auto clean = terminal.update_render_state();
  ASSERT_TRUE(clean.has_value());
  EXPECT_EQ(clean->dirty, DirtyState::clean);
  EXPECT_EQ(clean->dirty_rows, 0U);
}

TEST(TerminalTest, ReportsNewDamageWithoutConsumingPreviouslyPendingRows) {
  auto terminal = make_terminal();
  ASSERT_TRUE(terminal.update_render_state().has_value());
  ASSERT_TRUE(terminal.mark_rendered().has_value());

  test_support::TerminalResponseBuffer responses;
  constexpr std::string_view query_text = "\x1B[5n";
  const auto query = terminal.write_and_report_damage(
      std::as_bytes(std::span(query_text.data(), query_text.size())), responses.sink());
  ASSERT_TRUE(query.has_value());
  EXPECT_EQ(*query, DirtyState::clean);
  EXPECT_GT(responses.size(), 0U);

  constexpr std::string_view visible_text = "visible";
  const auto visible = terminal.write_and_report_damage(
      std::as_bytes(std::span(visible_text.data(), visible_text.size())));
  ASSERT_TRUE(visible.has_value());
  EXPECT_NE(*visible, DirtyState::clean);

  const auto query_after_damage = terminal.write_and_report_damage(
      std::as_bytes(std::span(query_text.data(), query_text.size())), responses.sink());
  ASSERT_TRUE(query_after_damage.has_value());
  EXPECT_EQ(*query_after_damage, DirtyState::clean);

  const auto retained = terminal.update_render_state();
  ASSERT_TRUE(retained.has_value());
  EXPECT_NE(retained->dirty, DirtyState::clean);
  EXPECT_GE(retained->dirty_rows, 1U);
}

TEST(TerminalTest, FormatScreenPreservesPendingWrap) {
  TerminalOptions options;
  options.size = {.columns = 8, .rows = 2};
  auto canonical = make_terminal(options);
  auto replayed = make_terminal(options);
  write_text(canonical, "xxxxxxxx");

  std::array<std::byte, std::size_t{16} * 1'024U> formatted{};
  const auto formatted_size = canonical.format_screen(ScreenFormat::vt, formatted);
  ASSERT_TRUE(formatted_size.has_value());
  replayed.write(std::span(formatted).first(*formatted_size));

  write_text(canonical, "y");
  write_text(replayed, "y");
  expect_full_projection_equal(canonical, replayed);
}

TEST(TerminalTest, FormatsDiagnosticSnapshotsIntoCallerStorage) {
  auto terminal = make_terminal();
  write_text(terminal, "plain \x1B[1;32mgreen\x1B[0m");

  std::array<std::byte, 1'024> plain_output{};
  const auto plain_size = terminal.format_screen(ScreenFormat::plain, plain_output);
  ASSERT_TRUE(plain_size.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view plain_text(reinterpret_cast<const char*>(plain_output.data()),
                                    *plain_size);
  EXPECT_THAT(plain_text, testing::HasSubstr("plain green"));

  std::array<std::byte, std::size_t{8} * 1'024U> full_output{};
  const auto full_size = terminal.format_screen(ScreenFormat::vt_full, full_output);
  ASSERT_TRUE(full_size.has_value());
  EXPECT_GT(*full_size, *plain_size);

  std::array<std::byte, 1> insufficient_output{};
  const auto insufficient = terminal.format_screen(ScreenFormat::vt, insufficient_output);
  ASSERT_FALSE(insufficient.has_value());
  EXPECT_EQ(insufficient.error(), Error::out_of_space);
}

TEST(TerminalTest, InspectsTerminalMetadataAndChildReportedPwd) {
  TerminalOptions options;
  options.size = {.columns = 20, .rows = 3};
  auto terminal = make_terminal(options);
  write_text(terminal, "\x1B]7;file:///tmp/project\x07");
  write_text(terminal, "one\r\ntwo\r\nthree\r\nfour\r\nfive");

  const auto inspected = terminal.inspection();
  ASSERT_TRUE(inspected.has_value());
  EXPECT_EQ(inspected->active_screen, ActiveScreen::primary);
  EXPECT_GE(inspected->scrollback_rows, 2U);
  EXPECT_TRUE(inspected->viewport.follows_output);
  const auto pwd = terminal.pwd();
  ASSERT_TRUE(pwd.has_value());
  EXPECT_EQ(*pwd, "file:///tmp/project");
}

TEST(TerminalTest, VisibleCaptureTracksCanonicalViewport) {
  TerminalOptions options;
  options.size = {.columns = 20, .rows = 3};
  auto terminal = make_terminal(options);
  write_text(terminal, "one\r\ntwo\r\nthree\r\nfour\r\nfive");

  std::array<std::byte, 1'024> bottom_output{};
  const auto bottom_size =
      terminal.format_visible_tail(ScreenFormat::plain, options.size.rows, bottom_output);
  ASSERT_TRUE(bottom_size.has_value());
  terminal.scroll_viewport(ViewportScroll::top);
  std::array<std::byte, 1'024> top_output{};
  const auto top_size =
      terminal.format_visible_tail(ScreenFormat::plain, options.size.rows, top_output);
  ASSERT_TRUE(top_size.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view bottom(reinterpret_cast<const char*>(bottom_output.data()), *bottom_size);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view top(reinterpret_cast<const char*>(top_output.data()), *top_size);
  EXPECT_NE(top, bottom);
  EXPECT_THAT(top, testing::HasSubstr("one"));
  EXPECT_THAT(bottom, testing::HasSubstr("five"));
}

TEST(TerminalTest, VisibleAnsiTailCarriesStyleAtSelectionBoundary) {
  TerminalOptions options;
  options.size = {.columns = 20, .rows = 3};
  auto terminal = make_terminal(options);
  write_text(terminal, "\x1B[31mone\r\ntwo");

  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  const auto size = terminal.format_visible_tail(ScreenFormat::vt, 1, output);
  ASSERT_TRUE(size.has_value()) << static_cast<int>(size.error());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view text(reinterpret_cast<const char*>(output.data()), *size);
  EXPECT_THAT(text, testing::HasSubstr("two"));
  EXPECT_THAT(text, testing::Not(testing::HasSubstr("one")));
  EXPECT_TRUE(text.contains("31m") || text.contains("38;5;1m")) << text;
}

TEST(TerminalTest, RecentCaptureUsesLastContentRatherThanCursorPosition) {
  TerminalOptions options;
  options.size = {.columns = 20, .rows = 5};
  auto terminal = make_terminal(options);
  write_text(terminal, "one\r\ntwo\r\nthree\x1B[H");

  std::array<std::byte, 1'024> recent{};
  const auto recent_size = terminal.format_recent(ScreenFormat::plain, 2, recent, true);
  ASSERT_TRUE(recent_size.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view recent_text(reinterpret_cast<const char*>(recent.data()), *recent_size);
  EXPECT_THAT(recent_text, testing::HasSubstr("two"));
  EXPECT_THAT(recent_text, testing::HasSubstr("three"));
  EXPECT_THAT(recent_text, testing::Not(testing::HasSubstr("one")));
}

TEST(TerminalTest, LastCommandCaptureDoesNotFallBackToOlderOutput) {
  TerminalOptions options;
  options.size = {.columns = 20, .rows = 6};
  auto unmarked = make_terminal(options);
  write_text(unmarked, "ordinary output");
  std::array<std::byte, 128> unavailable{};
  EXPECT_FALSE(unmarked.format_last_command(ScreenFormat::plain, unavailable).has_value());

  auto semantic = make_terminal(options);
  write_text(semantic, "\x1B]133;A\a$ \x1B]133;B\aecho hi\x1B]133;C\a\r\nhi\r\n"
                       "\x1B]133;D;0\a\x1B]133;A\a$ ");
  std::array<std::byte, 1'024> command{};
  const auto prompt = semantic.cursor_at_prompt();
  ASSERT_TRUE(prompt.has_value());
  EXPECT_TRUE(*prompt);
  const auto command_size = semantic.format_last_command(ScreenFormat::plain, command);
  ASSERT_TRUE(command_size.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view command_text(reinterpret_cast<const char*>(command.data()), *command_size);
  EXPECT_THAT(command_text, testing::HasSubstr("hi"));

  write_text(semantic, "\x1B]133;B\atrue\x1B]133;C\a\r\n\x1B]133;D;0\a\x1B]133;A\a$ ");
  const auto empty_size = semantic.format_last_command(ScreenFormat::plain, command);
  ASSERT_TRUE(empty_size.has_value());
  EXPECT_EQ(*empty_size, 0U);
}

TEST(TerminalTest, RendersOnlyChangedAnsiRows) {
  TerminalOptions options;
  options.size = {.columns = 20, .rows = 4};
  auto terminal = make_terminal(options);
  write_text(terminal, "first row\r\nsecond row");

  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  const auto full = terminal.render_ansi(output, true);
  ASSERT_TRUE(full.has_value());
  EXPECT_TRUE(full->full);
  EXPECT_EQ(full->rows, options.size.rows);

  const auto clean = terminal.render_ansi(output);
  ASSERT_TRUE(clean.has_value());
  EXPECT_FALSE(clean->full);
  EXPECT_EQ(clean->rows, 0U);
  EXPECT_LT(clean->bytes, full->bytes);

  const auto allocations_before = terminal.allocation_stats().allocations_total;
  write_text(terminal, "\x1B[1;1Hchanged");
  const auto changed = terminal.render_ansi(output);
  ASSERT_TRUE(changed.has_value());
  EXPECT_FALSE(changed->full);
  EXPECT_EQ(changed->rows, 1U);
  EXPECT_LT(changed->bytes, full->bytes);
  EXPECT_EQ(terminal.allocation_stats().allocations_total, allocations_before);
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, ProjectsEveryCursorStyleAsABlock) {
  struct CursorProjection final {
    std::string_view canonical;
    std::string_view projected;
  };
  constexpr std::array projections{
      CursorProjection{.canonical = "\x1B[1 q", .projected = "\x1B[1 q"},
      CursorProjection{.canonical = "\x1B[2 q", .projected = "\x1B[2 q"},
      CursorProjection{.canonical = "\x1B[3 q", .projected = "\x1B[1 q"},
      CursorProjection{.canonical = "\x1B[4 q", .projected = "\x1B[2 q"},
      CursorProjection{.canonical = "\x1B[5 q", .projected = "\x1B[1 q"},
      CursorProjection{.canonical = "\x1B[6 q", .projected = "\x1B[2 q"},
  };
  auto terminal = make_terminal();
  std::array<std::byte, 8'192> output{};

  for (const auto& projection : projections) {
    write_text(terminal, projection.canonical);
    const auto rendered = terminal.render_ansi(output, true);
    ASSERT_TRUE(rendered.has_value());
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    const std::string_view ansi(reinterpret_cast<const char*>(output.data()), rendered->bytes);
    EXPECT_THAT(ansi, testing::HasSubstr(projection.projected));
    if (projection.canonical != projection.projected) {
      EXPECT_THAT(ansi, testing::Not(testing::HasSubstr(projection.canonical)));
    }
  }
}

TEST(TerminalTest, HyperlinksConvergeAsTextWithoutLeakingUnsupportedOuterState) {
  TerminalOptions options;
  options.size = {.columns = 40, .rows = 4};
  auto canonical = make_terminal(options);
  auto projected = make_terminal(options);
  write_text(canonical,
             "\x1B]8;id=docs;https://example.test/lemma\x1B\\linked\x1B]8;;\x1B\\ plain");

  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  const auto rendered = canonical.render_ansi(output, true);
  ASSERT_TRUE(rendered.has_value());
  // Lemma does not currently delegate OSC 8 activation to the outer terminal. The visible text is
  // projected while the URI and hyperlink control state remain pane-local.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view ansi(reinterpret_cast<const char*>(output.data()), rendered->bytes);
  EXPECT_THAT(ansi, testing::HasSubstr("linked"));
  EXPECT_THAT(ansi, testing::Not(testing::HasSubstr("example.test")));
  EXPECT_THAT(ansi, testing::Not(testing::HasSubstr("\x1B]8;")));

  projected.write(std::span(output).first(rendered->bytes));
  expect_full_projection_equal(canonical, projected);
}

TEST(TerminalTest, EncodesOnlyChangedCellSpan) {
  TerminalOptions options;
  options.size = {.columns = 40, .rows = 4};
  auto terminal = make_terminal(options);
  write_text(terminal, "\x1B[2;1Hunchanged-prefix-and-suffix");

  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  ASSERT_TRUE(terminal.render_ansi(output, true).has_value());
  write_text(terminal, "\x1B[2;13HX");
  const auto changed = terminal.render_ansi(output);
  ASSERT_TRUE(changed.has_value());
  EXPECT_EQ(changed->rows, 1U);
  EXPECT_LT(changed->bytes, 128U);

  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded(reinterpret_cast<const char*>(output.data()), changed->bytes);
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[2;13H"));
  EXPECT_THAT(encoded, testing::Not(testing::HasSubstr("unchanged-prefix")));
}

TEST(TerminalTest, DetectsAndEncodesVerticalScroll) {
  TerminalOptions options;
  options.size = {.columns = 20, .rows = 4};
  auto terminal = make_terminal(options);
  write_text(terminal, "one\r\ntwo\r\nthree\r\nfour");

  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  ASSERT_TRUE(terminal.render_ansi(output, true).has_value());
  write_text(terminal, "\r\nfive");
  const auto changed = terminal.render_ansi(output);
  ASSERT_TRUE(changed.has_value());
  EXPECT_EQ(changed->scrolled_rows, 1);
  EXPECT_EQ(changed->rows, 1U);

  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded(reinterpret_cast<const char*>(output.data()), changed->bytes);
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[1S"));
  EXPECT_THAT(encoded, testing::HasSubstr("five"));
}

TEST(TerminalTest, PartialDamageRefreshesScrollHashesBeforeReenablingScrollProjection) {
  TerminalOptions options;
  options.size = {.columns = 20, .rows = 4};
  auto terminal = make_terminal(options);
  write_text(terminal, "one\r\ntwo\r\nthree\r\nfour");

  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  ASSERT_TRUE(terminal.render_ansi(output, true).has_value());
  write_text(terminal, "\x1B[2;1HTWO");
  const auto partial = terminal.render_ansi(output);
  ASSERT_TRUE(partial.has_value());
  EXPECT_EQ(partial->scrolled_rows, 0);

  write_text(terminal, "\x1B[4;5H\r\nfive");
  const auto refresh = terminal.render_ansi(output);
  ASSERT_TRUE(refresh.has_value());
  EXPECT_EQ(refresh->scrolled_rows, 0);
  EXPECT_EQ(refresh->rows, options.size.rows);

  write_text(terminal, "\r\nsix");
  const auto scrolled = terminal.render_ansi(output);
  ASSERT_TRUE(scrolled.has_value());
  EXPECT_EQ(scrolled->scrolled_rows, 1);
  EXPECT_EQ(scrolled->rows, 1U);
}

TEST(TerminalTest, ScrollDetectionHashesCompleteGraphemes) {
  TerminalOptions options;
  options.size = {.columns = 2, .rows = 4};
  auto canonical = make_terminal(options);
  auto projected = make_terminal(options);
  write_text(canonical, "a\xCC\x81\r\na\xCC\x82\r\na\xCC\x83\r\na\xCC\x84");

  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  const auto initial = canonical.render_ansi(output, true);
  ASSERT_TRUE(initial.has_value());
  projected.write(std::span(output).first(initial->bytes));

  write_text(canonical, "\r\na\xCC\x85\r\na\xCC\x86");
  const auto changed = canonical.render_ansi(output);
  ASSERT_TRUE(changed.has_value());
  EXPECT_EQ(changed->scrolled_rows, 2);
  EXPECT_EQ(changed->rows, 2U);
  projected.write(std::span(output).first(changed->bytes));

  canonical.invalidate_ansi_render_state();
  projected.invalidate_ansi_render_state();
  std::array<std::byte, std::size_t{16} * 1'024U> canonical_output{};
  std::array<std::byte, std::size_t{16} * 1'024U> projected_output{};
  const auto canonical_full = canonical.render_ansi(canonical_output, true);
  const auto projected_full = projected.render_ansi(projected_output, true);
  ASSERT_TRUE(canonical_full.has_value());
  ASSERT_TRUE(projected_full.has_value());
  EXPECT_TRUE(std::ranges::equal(std::span(canonical_output).first(canonical_full->bytes),
                                 std::span(projected_output).first(projected_full->bytes)));
}

TEST(TerminalTest, PaletteChangesInvalidateEveryRetainedScrollHash) {
  TerminalOptions options;
  options.size = {.columns = 8, .rows = 4};
  auto terminal = make_terminal(options);
  write_text(terminal, "\x1B[31msame\r\nsame\r\nsame\r\nsame");

  std::array<std::byte, std::size_t{16} * 1'024U> output{};
  ASSERT_TRUE(terminal.render_ansi(output, true).has_value());
  write_text(terminal, "\x1B]4;1;rgb:12/34/56\x1B\\");
  const auto changed = terminal.render_ansi(output);
  ASSERT_TRUE(changed.has_value());
  EXPECT_EQ(changed->scrolled_rows, 0);
  EXPECT_GT(changed->rows, 0U);

  // A pane-local palette mutation must be projected as RGB rather than the host's palette index.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded(reinterpret_cast<const char*>(output.data()), changed->bytes);
  EXPECT_THAT(encoded, testing::HasSubstr("38;2;18;52;86"));
}

TEST(TerminalTest, FragmentedWritesPreserveCanonicalState) {
  TerminalOptions options;
  options.size = {.columns = 12, .rows = 3};
  auto single_write = make_terminal(options);
  constexpr std::string_view input = "primary\x1B[2;3H\x1B[1;38;5;4m"
                                     "\xE7\x95\x8C"
                                     "e\xCC\x81\x1B[0m";
  const auto bytes = std::as_bytes(std::span(input.data(), input.size()));
  single_write.write(bytes);

  for (std::size_t split = 1; split < bytes.size(); ++split) {
    auto fragmented = make_terminal(options);
    fragmented.write(bytes.first(split));
    fragmented.write(bytes.subspan(split));
    expect_full_projection_equal(single_write, fragmented);
  }
}

TEST(TerminalTest, AnsiRoundTripConvergesVisibleContentAcrossAlternateScreenTransitions) {
  TerminalOptions options;
  options.size = {.columns = 12, .rows = 3};
  auto canonical = make_terminal(options);
  auto projected = make_terminal(options);

  write_text(canonical, "primary \x1B[1;32m"
                        "\xE7\x95\x8C"
                        "e\xCC\x81\x1B[0m");
  project_and_expect_convergence(canonical, projected, true);

  write_text(canonical, "\x1B[?1049h\x1B[2 q\x1B[?25lalt \x1B[38;2;10;20;30m"
                        "\xE7\x95\x8C"
                        "e\xCC\x82\x1B[0m");
  project_and_expect_convergence(canonical, projected);

  write_text(canonical, "\x1B[?1049l\x1B[6 q\x1B[?25h");
  project_and_expect_convergence(canonical, projected);
}

TEST(TerminalTest, ReusedRowScratchDoesNotCarryAGraphemeSuffixIntoTheNextCell) {
  TerminalOptions options;
  options.size = {.columns = 8, .rows = 2};
  auto canonical = make_terminal(options);
  auto projected = make_terminal(options);
  write_text(canonical, "a\xCC\x81\xCC\x82\xCC\x83"
                        "b\xCC\x84"
                        "c");

  project_and_expect_convergence(canonical, projected, true);
  std::array<std::byte, 1'024> plain{};
  const auto formatted = projected.format_screen(ScreenFormat::plain, plain);
  ASSERT_TRUE(formatted.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view text(reinterpret_cast<const char*>(plain.data()), *formatted);
  EXPECT_THAT(text, testing::HasSubstr("a\xCC\x81\xCC\x82\xCC\x83"
                                       "b\xCC\x84"
                                       "c"));
}

TEST(TerminalTest, PreservesPinnedMaximumGraphemeThroughRenderAndSearch) {
  TerminalOptions options;
  options.size = {.columns = 4, .rows = 2};
  auto canonical = make_terminal(options);
  auto projected = make_terminal(options);
  std::string grapheme{"a"};
  constexpr std::string_view four_byte_combining_mark = "\xF0\x9E\x80\x80";
  for (std::size_t suffix = 0; suffix + 1U < pane_grapheme_codepoints_max; ++suffix) {
    grapheme.append(four_byte_combining_mark);
  }
  grapheme.push_back('Z');
  write_text(canonical, grapheme);

  project_and_expect_convergence(canonical, projected, true);
  std::optional<SearchCursor> cursor;
  SearchStepResult search{};
  for (std::size_t slice = 0; slice < options.size.columns; ++slice) {
    const auto result = canonical.search_literal_step("Z", SearchDirection::forward, cursor, 1);
    ASSERT_TRUE(result.has_value());
    search = *result;
    if (search.status != SearchStepStatus::pending) {
      break;
    }
    cursor = search.next;
  }
  EXPECT_EQ(search.status, SearchStepStatus::found);
}

TEST(TerminalTest, ResizesWithCheckedPixelDimensions) {
  auto terminal = make_terminal();
  const TerminalSize resized{
      .columns = 120,
      .rows = 40,
      .cell_width_px = 9,
      .cell_height_px = 18,
  };

  ASSERT_TRUE(terminal.resize(resized).has_value());
  EXPECT_EQ(terminal.size(), resized);

  const auto update = terminal.update_render_state();
  ASSERT_TRUE(update.has_value());
  EXPECT_EQ(update->columns, resized.columns);
  EXPECT_EQ(update->rows, resized.rows);
}

TEST(TerminalTest, OmitsFallbackTextOnKeyRelease) {
  auto terminal = make_terminal();
  std::array<std::byte, 128> output{};
  const KeyEvent unidentified_release{
      .action = KeyAction::release,
      .key = Key::unidentified,
      .text = "a",
  };
  const auto released = terminal.encode_key(unidentified_release, output);
  ASSERT_TRUE(released.has_value());
  EXPECT_EQ(*released, 0U);

  const KeyEvent unidentified_press{
      .action = KeyAction::press,
      .key = Key::unidentified,
      .text = "a",
  };
  const auto pressed = terminal.encode_key(unidentified_press, output);
  ASSERT_TRUE(pressed.has_value());
  ASSERT_EQ(*pressed, 1U);
  EXPECT_EQ(output.front(), std::byte{'a'});

  const KeyEvent letter_release_legacy{
      .action = KeyAction::release,
      .key = Key::a,
      .unshifted_codepoint = 'a',
      .text = "a",
  };
  const auto legacy_release = terminal.encode_key(letter_release_legacy, output);
  ASSERT_TRUE(legacy_release.has_value());
  EXPECT_EQ(*legacy_release, 0U);

  write_text(terminal, "\x1B[>3u");
  const KeyEvent letter_release{
      .action = KeyAction::release,
      .key = Key::a,
      .unshifted_codepoint = 'a',
      .text = "a",
  };
  const auto kitty_release = terminal.encode_key(letter_release, output);
  ASSERT_TRUE(kitty_release.has_value());
  ASSERT_GT(*kitty_release, 0U);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded(reinterpret_cast<const char*>(output.data()), *kitty_release);
  EXPECT_THAT(encoded, testing::StartsWith("\x1B["));
  EXPECT_THAT(encoded, testing::Not(testing::StrEq("a")));
}

TEST(TerminalTest, EncodesNormalizedLegacyAndKittyKeys) {
  auto terminal = make_terminal();
  std::array<std::byte, 128> output{};
  const KeyEvent control_c{
      .key = Key::c,
      .modifiers = key_modifier_control,
      .unshifted_codepoint = 'c',
      .text = "c",
  };

  const auto legacy = terminal.encode_key(control_c, output);
  ASSERT_TRUE(legacy.has_value());
  ASSERT_EQ(*legacy, 1U);
  EXPECT_EQ(output.front(), std::byte{0x03});

  const KeyEvent enter_as_control_m{
      .key = Key::m,
      .modifiers = key_modifier_control,
      .unshifted_codepoint = 'm',
      .text = "m",
  };
  const auto enter = terminal.encode_key(enter_as_control_m, output);
  ASSERT_TRUE(enter.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded_control_m(reinterpret_cast<const char*>(output.data()), *enter);
  EXPECT_THAT(encoded_control_m, testing::StrEq("\x1B[109;5u"));

  write_text(terminal, "\x1B[>1u");
  const auto kitty = terminal.encode_key(control_c, output);
  ASSERT_TRUE(kitty.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded(reinterpret_cast<const char*>(output.data()), *kitty);
  EXPECT_THAT(encoded, testing::StrEq("\x1B[99;5u"));

  const KeyEvent enter_key{.key = Key::enter, .text = {}};
  const auto kitty_enter = terminal.encode_key(enter_key, output);
  ASSERT_TRUE(kitty_enter.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded_enter(reinterpret_cast<const char*>(output.data()), *kitty_enter);
  EXPECT_THAT(encoded_enter, testing::StrEq("\r"));
}

TEST(TerminalTest, KeyEncoderTracksCursorApplicationMode) {
  auto terminal = make_terminal();
  std::array<std::byte, 128> output{};
  const KeyEvent up{.key = Key::arrow_up, .text = {}};

  const auto normal = terminal.encode_key(up, output);
  ASSERT_TRUE(normal.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(output.data()), *normal), "\x1B[A");

  write_text(terminal, "\x1B[?1h");
  const auto application = terminal.encode_key(up, output);
  ASSERT_TRUE(application.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(output.data()), *application), "\x1BOA");
}

TEST(TerminalTest, EncodesFocusAndMouseFromCanonicalModes) {
  auto terminal = make_terminal();
  std::array<std::byte, 128> output{};

  auto tracking = terminal.mouse_tracking();
  ASSERT_TRUE(tracking.has_value());
  EXPECT_EQ(*tracking, MouseTrackingState{});
  EXPECT_EQ(terminal.encode_focus(FocusEvent::gained, output), 0U);
  write_text(terminal, "\x1B[?1004h");
  const auto focus = terminal.encode_focus(FocusEvent::gained, output);
  ASSERT_TRUE(focus.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(output.data()), *focus), "\x1B[I");

  write_text(terminal, "\x1B[?1000h\x1B[?1006h");
  tracking = terminal.mouse_tracking();
  ASSERT_TRUE(tracking.has_value());
  EXPECT_EQ(*tracking, (MouseTrackingState{.enabled = true}));
  const MouseEvent mouse{
      .action = MouseAction::press,
      .button = MouseButton::left,
      .x = 4,
      .y = 2,
      .geometry = {.screen_width = 80, .screen_height = 24},
      .any_button_pressed = true,
  };
  const auto encoded = terminal.encode_mouse(mouse, output);
  ASSERT_TRUE(encoded.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(output.data()), *encoded),
            "\x1B[<0;5;3M");

  write_text(terminal, "\x1B[?1003h");
  tracking = terminal.mouse_tracking();
  ASSERT_TRUE(tracking.has_value());
  EXPECT_EQ(*tracking, (MouseTrackingState{.enabled = true, .unbuttoned_motion = true}));
}

TEST(TerminalTest, RoutesAlternateScreenWheelFromCanonicalModes) {
  auto terminal = make_terminal();

  EXPECT_EQ(terminal.wheel_uses_alternate_scroll(), false);
  write_text(terminal, "\x1B[?1049h");
  EXPECT_EQ(terminal.wheel_uses_alternate_scroll(), true);
  write_text(terminal, "\x1B[?1007l");
  EXPECT_EQ(terminal.wheel_uses_alternate_scroll(), false);
  write_text(terminal, "\x1B[?1007h\x1B[?1000h");
  EXPECT_EQ(terminal.wheel_uses_alternate_scroll(), false);
  write_text(terminal, "\x1B[?1000l");
  EXPECT_EQ(terminal.wheel_uses_alternate_scroll(), true);
  write_text(terminal, "\x1B[?1049l");
  EXPECT_EQ(terminal.wheel_uses_alternate_scroll(), false);
}

TEST(TerminalTest, EncodesOpaquePasteThroughGhosttyPolicy) {
  auto terminal = make_terminal();
  std::array<std::byte, 64> output{};
  std::array input{std::byte{'a'}, std::byte{'\n'}, std::byte{0x1B}, std::byte{'b'}};
  EXPECT_FALSE(terminal.paste_is_safe(input));

  auto encoded = terminal.encode_paste(input, output);
  ASSERT_TRUE(encoded.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(output.data()), *encoded), "a\r b");

  write_text(terminal, "\x1B[?2004h");
  input = {std::byte{'a'}, std::byte{'\n'}, std::byte{0x1B}, std::byte{'b'}};
  encoded = terminal.encode_paste(input, output);
  ASSERT_TRUE(encoded.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(output.data()), *encoded),
            "\x1B[200~a\n b\x1B[201~");
}

TEST(TerminalTest, DisablesUnsupportedGraphicsUntilBoundedPresentationExists) {
  auto terminal = make_terminal();
  const auto allocations = terminal.allocation_stats().bytes_current;
  write_text(terminal, "\x1B_Gi=1,a=q,s=1,v=1,f=24;AAAA\x1B\\");
  write_text(terminal, "\x1B_25a1;s\x1B\\");
  write_text(terminal, "\x1B_25a1;r;cp=e0a0;AAAAAAAAAAAAAA==\x1B\\");

  EXPECT_FALSE(terminal.integrity_failed());
  EXPECT_EQ(terminal.allocation_stats().bytes_current, allocations);
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, PtyResponseOverflowIsStickyTerminalIntegrityFailure) {
  auto terminal = make_terminal();
  std::string queries;
  constexpr std::string_view query = "\x1B[6n";
  queries.reserve(query.size() * 20'000U);
  for (std::size_t count = 0; count < 20'000U; ++count) {
    queries.append(query);
  }
  test_support::TerminalResponseBuffer responses;
  write_text(terminal, queries, responses.sink());

  EXPECT_GT(responses.size(), 0U);
  EXPECT_LE(responses.size(), limits::terminal_pty_response_bytes_max);
  EXPECT_TRUE(terminal.pty_response_overflowed());
  EXPECT_TRUE(terminal.integrity_failed());
  EXPECT_TRUE(terminal.take_effects().pty_response_overflowed);
  EXPECT_TRUE(terminal.pty_response_overflowed());
  EXPECT_TRUE(terminal.integrity_failed());
}

TEST(TerminalTest, ReportsInBandSizeWhenMode2048IsEnabled) {
  TerminalOptions options;
  options.size = {
      .columns = 80,
      .rows = 24,
      .cell_width_px = 9,
      .cell_height_px = 18,
  };
  auto terminal = make_terminal(options);
  test_support::TerminalResponseBuffer responses;
  write_text(terminal, "\x1B[?2048h", responses.sink());

  std::array<std::byte, 128> response{};
  const auto response_size = responses.read(response);
  ASSERT_GT(response_size, 0U);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded(reinterpret_cast<const char*>(response.data()), response_size);
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[48;24;80;432;720t"));
}

TEST(TerminalTest, ReportsInBandSizeWhenResizedAfterMode2048) {
  TerminalOptions options;
  options.size = {
      .columns = 80,
      .rows = 24,
      .cell_width_px = 9,
      .cell_height_px = 18,
  };
  auto terminal = make_terminal(options);
  test_support::TerminalResponseBuffer responses;
  write_text(terminal, "\x1B[?2048h", responses.sink());
  std::array<std::byte, 128> discarded{};
  ASSERT_GT(responses.read(discarded), 0U);

  const TerminalSize resized{
      .columns = 100,
      .rows = 18,
      .cell_width_px = 9,
      .cell_height_px = 18,
  };
  ASSERT_TRUE(terminal.resize(resized, responses.sink()).has_value());
  std::array<std::byte, 128> response{};
  const auto response_size = responses.read(response);
  ASSERT_GT(response_size, 0U);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded(reinterpret_cast<const char*>(response.data()), response_size);
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[48;18;100;324;900t"));
}

TEST(TerminalTest, ReportsTruthfulChildVisibleIdentityAndGeometry) {
  auto terminal = make_terminal();
  test_support::TerminalResponseBuffer responses;
  write_text(terminal, "\x1B[c\x1B[>q\x1B[18t\x1B[?996n\x1BP+q544e\x1B\\", responses.sink());

  std::array<std::byte, 512> response{};
  const auto response_size = responses.read(response);
  ASSERT_GT(response_size, 0U);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded(reinterpret_cast<const char*>(response.data()), response_size);
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[?62;22c"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1BP>|lemma\x1B\\"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[8;24;80t"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1B[?997;1n"));
  EXPECT_THAT(encoded, testing::HasSubstr("\x1BP1+r544E=787465726D2D323536636F6C6F72\x1B\\"));
}

TEST(TerminalTest, CapturesEffectsWithoutCallingApplicationCode) {
  auto terminal = make_terminal();
  test_support::TerminalResponseBuffer responses;
  write_text(terminal,
             "\a\x1B]2;lemma title\x1B\\\x1B]7;file:///tmp\x1B\\"
             "\x1B]777;notify;Codex;Needs attention\a\x1B]9;4;1;42\x1B\\"
             "\x1B]52;c;YQ==\x1B\\\x1B_unsupported\x1B\\\x05\x1B[?7$p",
             responses.sink());

  const auto effects = terminal.take_effects();
  EXPECT_EQ(effects.bells, 1U);
  EXPECT_EQ(effects.title_changes, 1U);
  EXPECT_EQ(effects.pwd_changes, 1U);
  EXPECT_EQ(effects.desktop_notifications, 1U);
  EXPECT_EQ(effects.progress_reports, 1U);
  EXPECT_EQ(effects.clipboard_writes_denied, 1U);
  EXPECT_EQ(effects.unknown_sequences_dropped, 1U);
  EXPECT_FALSE(effects.unknown_sequence_truncated);
  EXPECT_FALSE(effects.pty_response_overflowed);

  const auto title = terminal.title();
  ASSERT_TRUE(title.has_value());
  EXPECT_THAT(*title, testing::StrEq("lemma title"));

  ASSERT_GT(responses.size(), 0U);
  std::array<std::byte, 64> response{};
  const auto response_size = responses.read(response);
  EXPECT_GT(response_size, 0U);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view encoded(reinterpret_cast<const char*>(response.data()), response_size);
  EXPECT_THAT(encoded, testing::HasSubstr("lemma"));
  EXPECT_TRUE(responses.empty());
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)

TEST(TerminalTest, UsesGhosttyGesturesAndTrackedSelectionEndpoints) {
  TerminalOptions options;
  options.size = {.columns = 12, .rows = 3};
  options.scrollback_bytes_max = limits::terminal_scrollback_bytes_hard_max;
  options.scrollback_lines_max = 100;
  auto terminal = make_terminal(options);
  write_text(terminal, "hello world\r\nsecond line");

  auto gesture = terminal.selection_gesture({
      .phase = SelectionGesturePhase::press,
      .point = {.space = PointSpace::viewport, .column = 0, .row = 0},
      .pointer_x = 2,
      .pointer_y = 4,
      .cell_width = 10,
      .screen_height = 30,
      .has_pointer_position = true,
  });
  ASSERT_TRUE(gesture.has_value());
  EXPECT_FALSE(gesture->selection_changed);
  gesture = terminal.selection_gesture({
      .phase = SelectionGesturePhase::drag,
      .point = {.space = PointSpace::viewport, .column = 5, .row = 0},
      .pointer_x = 55,
      .pointer_y = 4,
      .cell_width = 10,
      .screen_height = 30,
      .has_pointer_position = true,
  });
  ASSERT_TRUE(gesture.has_value());
  EXPECT_TRUE(gesture->selection_changed);
  EXPECT_TRUE(gesture->dragged);

  std::array<std::byte, 128> selected{};
  auto selected_size = terminal.format_selection(ScreenFormat::plain, selected);
  ASSERT_TRUE(selected_size.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(selected.data()), *selected_size),
            "hello");

  ASSERT_TRUE(
      terminal.select(SelectionUnit::word, {.space = PointSpace::viewport, .column = 6, .row = 0})
          .value_or(false));
  write_text(terminal, "\r\nthird\r\nfourth\r\nfifth");
  selected_size = terminal.format_selection(ScreenFormat::plain, selected);
  ASSERT_TRUE(selected_size.has_value());
  // The terminal-owned active selection uses tracked Ghostty refs and follows "world" into history.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(selected.data()), *selected_size),
            "world");
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, MovesCopyCursorByGhosttyWordSemantics) {
  TerminalOptions options;
  options.size = {.columns = 20, .rows = 2};
  auto terminal = make_terminal(options);
  write_text(terminal, "alpha bravo");
  ASSERT_TRUE(
      terminal.select(SelectionUnit::word, {.space = PointSpace::viewport, .column = 0, .row = 0})
          .value_or(false));
  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::word_right, false).value_or(false));

  std::array<std::byte, 32> selected{};
  const auto selected_size = terminal.format_selection(ScreenFormat::plain, selected);
  ASSERT_TRUE(selected_size.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(selected.data()), *selected_size), "b");

  ASSERT_TRUE(
      terminal.select(SelectionUnit::cell, {.space = PointSpace::viewport, .column = 2, .row = 0})
          .value_or(false));
  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::word_right, false).value_or(false));
  selected.fill(std::byte{0});
  const auto from_inside = terminal.format_selection(ScreenFormat::plain, selected);
  ASSERT_TRUE(from_inside.has_value());
  // `w` skips the remainder of the current Ghostty word and lands on the next word's start.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(selected.data()), *from_inside), "b");

  ASSERT_TRUE(
      terminal.select(SelectionUnit::cell, {.space = PointSpace::viewport, .column = 8, .row = 0})
          .value_or(false));
  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::word_left, false).value_or(false));
  selected.fill(std::byte{0});
  const auto backward = terminal.format_selection(ScreenFormat::plain, selected);
  ASSERT_TRUE(backward.has_value());
  // `b` from inside a word lands on that word's start rather than stepping one cell.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(selected.data()), *backward), "b");
}

TEST(TerminalTest, MovesCopyCursorAcrossEmptyCellsAndBlankRows) {
  TerminalOptions options;
  options.size = {.columns = 8, .rows = 3};
  auto terminal = make_terminal(options);
  write_text(terminal, "a     z\r\n\r\nthird");
  ASSERT_TRUE(terminal.select(SelectionUnit::cell, {.space = PointSpace::viewport, .row = 0})
                  .value_or(false));

  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::right, false).value_or(false));
  auto endpoint = terminal.selection_endpoint(PointSpace::screen);
  ASSERT_TRUE(endpoint.has_value() && endpoint->has_value());
  auto point = endpoint.value_or(std::optional<TerminalPoint>{}).value_or(TerminalPoint{});
  EXPECT_EQ(point.column, 1U);
  EXPECT_EQ(point.row, 0U);

  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::down, false).value_or(false));
  endpoint = terminal.selection_endpoint(PointSpace::screen);
  ASSERT_TRUE(endpoint.has_value() && endpoint->has_value());
  point = endpoint.value_or(std::optional<TerminalPoint>{}).value_or(TerminalPoint{});
  EXPECT_EQ(point.column, 1U);
  EXPECT_EQ(point.row, 1U);

  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::up, false).value_or(false));
  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::end_of_line, false).value_or(false));
  endpoint = terminal.selection_endpoint(PointSpace::screen);
  ASSERT_TRUE(endpoint.has_value() && endpoint->has_value());
  point = endpoint.value_or(std::optional<TerminalPoint>{}).value_or(TerminalPoint{});
  EXPECT_EQ(point.column, 6U);
}

TEST(TerminalTest, CopyCursorDoesNotStopOnWideSpacerCells) {
  TerminalOptions options;
  options.size = {.columns = 8, .rows = 2};
  auto terminal = make_terminal(options);
  write_text(terminal, "A界B");
  ASSERT_TRUE(
      terminal.select(SelectionUnit::cell, {.space = PointSpace::viewport}).value_or(false));

  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::right, false).value_or(false));
  auto endpoint = terminal.selection_endpoint(PointSpace::screen);
  ASSERT_TRUE(endpoint.has_value() && endpoint->has_value());
  auto point = endpoint.value_or(std::optional<TerminalPoint>{}).value_or(TerminalPoint{});
  EXPECT_EQ(point.column, 1U);
  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::right, false).value_or(false));
  endpoint = terminal.selection_endpoint(PointSpace::screen);
  ASSERT_TRUE(endpoint.has_value() && endpoint->has_value());
  point = endpoint.value_or(std::optional<TerminalPoint>{}).value_or(TerminalPoint{});
  EXPECT_EQ(point.column, 3U);
}

TEST(TerminalTest, SkipsWideSpacerAtSoftWrapBoundary) {
  TerminalOptions options;
  options.size = {.columns = 4, .rows = 2};
  auto terminal = make_terminal(options);
  write_text(terminal, "abc界");
  ASSERT_TRUE(
      terminal.select(SelectionUnit::cell, {.space = PointSpace::viewport, .column = 2, .row = 0})
          .value_or(false));

  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::right, false).value_or(false));
  const auto endpoint = terminal.selection_endpoint(PointSpace::viewport);
  ASSERT_TRUE(endpoint.has_value() && endpoint->has_value());
  const auto point = endpoint.value_or(std::optional<TerminalPoint>{}).value_or(TerminalPoint{});
  EXPECT_EQ(point.column, 0U);
  EXPECT_EQ(point.row, 1U);

  std::array<std::byte, 8> selected{};
  const auto selected_size = terminal.format_selection(ScreenFormat::plain, selected);
  ASSERT_TRUE(selected_size.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(selected.data()), *selected_size), "界");
}

TEST(TerminalTest, NormalizesLineAndBlockVisualSelection) {
  TerminalOptions options;
  options.size = {.columns = 8, .rows = 3};
  auto terminal = make_terminal(options);
  write_text(terminal, "alpha\r\nbravo\r\ncharlie");
  ASSERT_TRUE(
      terminal.select(SelectionUnit::cell, {.space = PointSpace::viewport, .column = 2, .row = 0})
          .value_or(false));

  ASSERT_TRUE(terminal.selection_set_unit(SelectionUnit::line).value_or(false));
  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::down, true).value_or(false));
  ASSERT_TRUE(terminal.selection_normalize_unit(SelectionUnit::line).value_or(false));
  auto range = terminal.selection_range(PointSpace::screen);
  ASSERT_TRUE(range.has_value() && range->has_value());
  auto selected = range.value_or(std::optional<SelectionRange>{}).value_or(SelectionRange{});
  EXPECT_EQ(selected.start.column, 0U);
  EXPECT_EQ(selected.start.row, 0U);
  EXPECT_EQ(selected.end.column, 7U);
  EXPECT_EQ(selected.end.row, 1U);
  EXPECT_FALSE(selected.rectangular);

  ASSERT_TRUE(terminal.collapse_selection_to_endpoint().value_or(false));
  ASSERT_TRUE(terminal.selection_set_unit(SelectionUnit::block).value_or(false));
  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::down, true).value_or(false));
  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::left, true).value_or(false));
  ASSERT_TRUE(terminal.selection_normalize_unit(SelectionUnit::block).value_or(false));
  range = terminal.selection_range(PointSpace::screen);
  ASSERT_TRUE(range.has_value() && range->has_value());
  selected = range.value_or(std::optional<SelectionRange>{}).value_or(SelectionRange{});
  EXPECT_TRUE(selected.rectangular);
  EXPECT_EQ(selected.end.row, 2U);
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, WordNavigationRetainsProgressAcrossLongBlankRuns) {
  TerminalOptions options;
  options.size = {.columns = limits::terminal_columns_hard_max, .rows = 2};
  auto terminal = make_terminal(options);
  write_text(terminal, "alpha\r\nbravo");
  ASSERT_TRUE(
      terminal.select(SelectionUnit::word, {.space = PointSpace::viewport, .column = 0, .row = 0})
          .value_or(false));

  for (std::size_t step = 0; step < 4; ++step) {
    ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::word_right, false).value_or(false));
  }

  std::array<std::byte, 16> selected{};
  const auto selected_size = terminal.format_selection(ScreenFormat::plain, selected);
  ASSERT_TRUE(selected_size.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(selected.data()), *selected_size), "b");
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, NavigatesViewportAndFormatsAdjustedSelectionWithinCallerBound) {
  TerminalOptions options;
  options.size = {.columns = 10, .rows = 2};
  options.scrollback_bytes_max = limits::terminal_scrollback_bytes_hard_max;
  auto terminal = make_terminal(options);
  for (std::size_t row = 0; row < 20; ++row) {
    write_text(terminal, "history\r\n");
  }

  auto viewport = terminal.viewport_state();
  ASSERT_TRUE(viewport.has_value());
  EXPECT_TRUE(viewport->follows_output);
  EXPECT_GT(viewport->offset, 0U);
  terminal.scroll_viewport(ViewportScroll::top);
  viewport = terminal.viewport_state();
  ASSERT_TRUE(viewport.has_value());
  EXPECT_FALSE(viewport->follows_output);
  EXPECT_EQ(viewport->offset, 0U);

  ASSERT_TRUE(
      terminal.select(SelectionUnit::cell, {.space = PointSpace::viewport, .column = 0, .row = 0})
          .value_or(false));
  ASSERT_TRUE(terminal.selection_adjust(SelectionAdjustment::end_of_line, true).value_or(false));
  std::array<std::byte, 64> output{};
  const auto formatted = terminal.format_selection(ScreenFormat::plain, output);
  ASSERT_TRUE(formatted.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_THAT(std::string_view(reinterpret_cast<const char*>(output.data()), *formatted),
              testing::HasSubstr("history"));

  std::array<std::byte, 1> insufficient{};
  const auto bounded = terminal.format_selection(ScreenFormat::plain, insufficient);
  ASSERT_FALSE(bounded.has_value());
  EXPECT_EQ(bounded.error(), Error::out_of_space);
  const auto followed = terminal.scroll_viewport_to_bottom();
  ASSERT_TRUE(followed.has_value());
  EXPECT_TRUE(*followed);
  EXPECT_TRUE(terminal.viewport_state()->follows_output);
  EXPECT_EQ(terminal.scroll_viewport_to_bottom(), false);
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, SearchesIncrementallyWithoutRetainingDuplicateGrid) {
  TerminalOptions options;
  options.size = {.columns = 16, .rows = 3};
  options.scrollback_bytes_max = limits::terminal_scrollback_bytes_hard_max;
  auto terminal = make_terminal(options);
  write_text(terminal, "alpha\r\nbeta needle\r\ngamma");

  std::optional<SearchCursor> cursor;
  SearchStepResult step{};
  for (std::size_t slice = 0; slice < 1'000; ++slice) {
    const auto result = terminal.search_literal_step("needle", SearchDirection::forward, cursor, 2);
    ASSERT_TRUE(result.has_value());
    step = *result;
    if (step.status != SearchStepStatus::pending) {
      break;
    }
    cursor = step.next;
  }

  ASSERT_EQ(step.status, SearchStepStatus::found);
  ASSERT_TRUE(terminal.select_search_match(step.match).has_value());
  ASSERT_TRUE(terminal.scroll_selection_into_view().has_value());
  std::array<std::byte, 32> output{};
  const auto formatted = terminal.format_selection(ScreenFormat::plain, output);
  ASSERT_TRUE(formatted.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(output.data()), *formatted), "needle");

  ASSERT_TRUE(terminal.collapse_selection_to_endpoint().value_or(false));
  output.fill(std::byte{0});
  const auto collapsed = terminal.format_selection(ScreenFormat::plain, output);
  ASSERT_TRUE(collapsed.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(output.data()), *collapsed), "e");
}

TEST(TerminalTest, SelectionCheckpointTracksReflowWithoutStoringCoordinates) {
  TerminalOptions options;
  options.size = {.columns = 12, .rows = 3};
  options.scrollback_bytes_max = limits::terminal_scrollback_bytes_hard_max;
  auto terminal = make_terminal(options);
  write_text(terminal, "alpha target\r\nsecond\r\nthird");
  ASSERT_TRUE(
      terminal.select(SelectionUnit::cell, {.space = PointSpace::viewport, .column = 6, .row = 0})
          .value_or(false));
  ASSERT_TRUE(terminal.checkpoint_selection().value_or(false));
  ASSERT_TRUE(
      terminal.select(SelectionUnit::cell, {.space = PointSpace::viewport, .column = 1, .row = 2})
          .value_or(false));

  const auto checkpoint = terminal.selection_checkpoint_endpoint(PointSpace::screen);
  ASSERT_TRUE(checkpoint.has_value() && checkpoint->has_value());
  std::array<std::byte, 8> previewed{};
  const auto previewed_size = terminal.format_selection(ScreenFormat::plain, previewed);
  ASSERT_TRUE(previewed_size.has_value());
  // Reading the checkpoint endpoint must not reinstall it over the active preview.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(previewed.data()), *previewed_size),
            "h");

  ASSERT_TRUE(terminal.resize({.columns = 6, .rows = 3}).has_value());
  ASSERT_TRUE(terminal.selection_checkpoint_endpoint(PointSpace::screen)
                  .value_or(std::nullopt)
                  .has_value());
  ASSERT_TRUE(terminal.restore_selection_checkpoint().value_or(false));
  std::array<std::byte, 8> selected{};
  const auto selected_size = terminal.format_selection(ScreenFormat::plain, selected);
  ASSERT_TRUE(selected_size.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  EXPECT_EQ(std::string_view(reinterpret_cast<const char*>(selected.data()), *selected_size), "t");

  terminal.clear_selection_checkpoint();
  EXPECT_EQ(terminal.restore_selection_checkpoint(), false);
}

TEST(TerminalTest, StopsBoundedSearchBeforeCallerBoundary) {
  TerminalOptions options;
  options.size = {.columns = 12, .rows = 2};
  auto terminal = make_terminal(options);
  write_text(terminal, "alpha alpha");
  const TerminalPoint stop{.space = PointSpace::screen, .column = 6, .row = 0};

  const auto result = terminal.search_literal_step("alpha", SearchDirection::forward,
                                                   SearchCursor{.candidate = stop}, 4, stop);

  ASSERT_TRUE(result.has_value());
  EXPECT_EQ(result->status, SearchStepStatus::not_found);
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(TerminalTest, RefreshesTrackedSelectionAfterReflowBeforeRendering) {
  TerminalOptions options;
  options.size = {.columns = 80, .rows = 23};
  options.scrollback_bytes_max = limits::terminal_scrollback_bytes_hard_max;
  auto terminal = make_terminal(options);
  for (std::size_t row = 0; row < 20; ++row) {
    write_text(terminal,
               "history abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\r\n");
  }
  write_text(terminal,
             "tracked abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\r\n");
  for (std::size_t row = 0; row < 25; ++row) {
    write_text(terminal,
               "history abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\r\n");
  }

  std::optional<SearchCursor> cursor;
  SearchStepResult step{};
  for (std::size_t slice = 0; slice < 1'000; ++slice) {
    const auto result =
        terminal.search_literal_step("tracked", SearchDirection::backward, cursor, 32);
    ASSERT_TRUE(result.has_value());
    step = *result;
    if (step.status != SearchStepStatus::pending) {
      break;
    }
    cursor = step.next;
  }
  ASSERT_EQ(step.status, SearchStepStatus::found);
  ASSERT_TRUE(terminal.select_search_match(step.match).has_value());
  ASSERT_TRUE(terminal.scroll_selection_into_view().has_value());

  ASSERT_TRUE(terminal.resize({.columns = 40, .rows = 23}).has_value());
  ASSERT_TRUE(terminal.refresh_selection().value_or(false));
  ASSERT_TRUE(terminal.scroll_selection_into_view().has_value());
  const auto endpoint = terminal.selection_endpoint(PointSpace::viewport);
  ASSERT_TRUE(endpoint.has_value());
  const auto endpoint_point = endpoint.value_or(std::optional<TerminalPoint>{});
  ASSERT_TRUE(endpoint_point.has_value());
  const auto point = endpoint_point.value_or(TerminalPoint{});

  std::array<std::byte, std::size_t{512} * 1'024U> output{};
  const PaneRenderOptions render_options{
      .cursor_override_column = point.column,
      .cursor_override_row = static_cast<std::uint16_t>(point.row),
      .force_full = true,
      .focused = true,
      .cursor_override = true,
  };
  const auto rendered = terminal.render_pane_ansi(output, render_options);
  if (!rendered.has_value()) {
    ADD_FAILURE() << "render error: " << static_cast<unsigned>(rendered.error());
  }
}

TEST(TerminalTest, RetainsPartialSearchMatchWhenSliceWorkIsExhausted) {
  TerminalOptions options;
  options.size = {.columns = 16, .rows = 2};
  auto terminal = make_terminal(options);
  write_text(terminal, "a");

  const auto first = terminal.search_literal_step("aZ", SearchDirection::forward, std::nullopt, 1);
  ASSERT_TRUE(first.has_value());
  ASSERT_EQ(first->status, SearchStepStatus::pending);
  EXPECT_TRUE(first->next.matching);
  EXPECT_EQ(first->next.query_offset, 1);
  EXPECT_EQ(first->next.candidate, (TerminalPoint{.space = PointSpace::screen}));
  EXPECT_EQ(first->next.text, (TerminalPoint{.space = PointSpace::screen, .column = 1, .row = 0}));

  const auto second = terminal.search_literal_step("aZ", SearchDirection::forward, first->next, 1);
  ASSERT_TRUE(second.has_value());
  EXPECT_EQ(second->status, SearchStepStatus::pending);
  EXPECT_EQ(second->next.query_offset, 1);
  EXPECT_EQ(second->next.text, (TerminalPoint{.space = PointSpace::screen, .column = 2, .row = 0}));
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)

TEST(TerminalTest, ProjectsHostSelectionColorsInsteadOfReverseVideo) {
  TerminalOptions options;
  options.size = {.columns = 12, .rows = 2};
  options.theme = default_theme();
  options.theme->selection_background = RgbColor{.red = 10, .green = 20, .blue = 30};
  options.theme->selection_foreground = RgbColor{.red = 200, .green = 210, .blue = 220};
  auto terminal = make_terminal(options);
  write_text(terminal, "selected");
  ASSERT_TRUE(
      terminal.select(SelectionUnit::word, {.space = PointSpace::viewport, .column = 0, .row = 0})
          .value_or(false));

  std::array<std::byte, 8'192> output{};
  const auto rendered = terminal.render_ansi(output, true);
  ASSERT_TRUE(rendered.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view ansi(reinterpret_cast<const char*>(output.data()), rendered->bytes);

  EXPECT_THAT(ansi, testing::HasSubstr("48;2;10;20;30"));
  EXPECT_THAT(ansi, testing::HasSubstr("38;2;200;210;220"));
  EXPECT_THAT(ansi, testing::Not(testing::HasSubstr("\x1B[0;7m")));
}

TEST(TerminalTest, ProjectsIncrementalSelectionAndCopyCursorHighlight) {
  TerminalOptions options;
  options.size = {.columns = 12, .rows = 2};
  auto terminal = make_terminal(options);
  write_text(terminal, "selected");

  std::array<std::byte, 8'192> output{};
  ASSERT_TRUE(terminal.render_ansi(output, true).has_value());
  ASSERT_TRUE(
      terminal.select(SelectionUnit::word, {.space = PointSpace::viewport, .column = 0, .row = 0})
          .value_or(false));
  const auto endpoint = terminal.selection_endpoint(PointSpace::viewport);
  ASSERT_TRUE(endpoint.has_value());
  const auto endpoint_point = endpoint.value_or(std::optional<TerminalPoint>{});
  ASSERT_TRUE(endpoint_point.has_value());
  const auto point = endpoint_point.value_or(TerminalPoint{});
  EXPECT_EQ(point.column, 7);
  EXPECT_EQ(point.row, 0U);

  output.fill(std::byte{0});
  const PaneRenderOptions render_options{
      .cursor_override_column = point.column,
      .cursor_override_row = static_cast<std::uint16_t>(point.row),
      .focused = true,
      .cursor_override = true,
  };
  const auto rendered = terminal.render_pane_ansi(output, render_options);
  ASSERT_TRUE(rendered.has_value());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view ansi(reinterpret_cast<const char*>(output.data()), rendered->bytes);
  EXPECT_THAT(ansi, testing::HasSubstr("48;2;"));
  EXPECT_THAT(ansi, testing::Not(testing::HasSubstr("\x1B[0;7m")));
  EXPECT_THAT(ansi, testing::HasSubstr("mselected"));
  EXPECT_THAT(ansi, testing::HasSubstr("\x1B[1;8H\x1B[?25h"));
  EXPECT_THAT(ansi, testing::HasSubstr("\x1B[2 q"));
}

TEST(TerminalTest, TracksQuotaAllocatorUsage) {
  auto terminal = make_terminal();
  const auto stats = terminal.allocation_stats();

  EXPECT_GT(stats.bytes_current, 0U);
  EXPECT_GE(stats.bytes_peak, stats.bytes_current);
  EXPECT_LE(stats.bytes_peak, limits::terminal_allocation_bytes_default);
  EXPECT_GT(stats.allocations_current, 0U);
  EXPECT_GE(stats.allocations_total, stats.allocations_current);
  EXPECT_EQ(stats.failures_total, 0U);
}

} // namespace
} // namespace lemma::vt
