#include "diagnostic/latency_trace.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <span>
#include <string_view>

#include <gtest/gtest.h>

namespace lemma::diagnostic {
namespace {

TEST(LatencyTraceTest, DerivesSameNonzeroTokenAcrossFragmentedMarker) {
  constexpr std::string_view marker = "__LEMMA_OUTPUT_0007_ABCDEFGH__";
  const auto bytes = std::as_bytes(std::span(marker));

  const auto complete = latency_trace_marker_token(bytes);
  ASSERT_NE(complete, 0U);

  LatencyTraceMarkerMatcher matcher;
  EXPECT_EQ(matcher.observe(bytes.first(5)), 0U);
  EXPECT_EQ(matcher.observe(bytes.subspan(5, 11)), 0U);
  EXPECT_EQ(matcher.observe(bytes.subspan(16)), complete);

  LatencyTraceMarkerMatcher visible_matcher;
  constexpr std::string_view first = "\x1B[3GABCD";
  constexpr std::string_view second = "EFGH\x1B[0m";
  EXPECT_EQ(visible_matcher.observe_expected_visible(std::as_bytes(std::span(first)), complete),
            0U);
  EXPECT_EQ(visible_matcher.observe_expected_visible(std::as_bytes(std::span(second)), complete),
            complete);
}

TEST(LatencyTraceTest, IgnoresOrdinaryOutputAndRecoversAfterOversizedCandidate) {
  LatencyTraceMarkerMatcher matcher;
  std::array<std::byte, 160> oversized{};
  constexpr std::string_view prefix = "__LEMMA_";
  std::ranges::copy(std::as_bytes(std::span(prefix)), oversized.begin());
  std::ranges::fill(std::span(oversized).subspan(prefix.size()), std::byte{'x'});

  EXPECT_EQ(matcher.observe(oversized), 0U);
  constexpr std::string_view marker = "__LEMMA_IDLE_0001_QWERTYUI__";
  EXPECT_NE(matcher.observe(std::as_bytes(std::span(marker))), 0U);
}

} // namespace
} // namespace lemma::diagnostic
