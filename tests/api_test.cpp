#include "api/action.hpp"
#include "api/json.hpp"
#include "api/schema.hpp"

#include <gtest/gtest.h>

#include <string>
#include <string_view>

namespace lemma::api {
namespace {

// Assertions establish optional presence before the test examines decoded values.
// NOLINTBEGIN(bugprone-unchecked-optional-access)

TEST(ApiTest, EmbedsParseableVersionedSchema) {
  const auto schema = schema_document();
  ASSERT_FALSE(schema.empty());
  const auto parsed = parse_json(schema);
  ASSERT_TRUE(parsed.value.has_value()) << parsed.error_offset;
  EXPECT_EQ(json_string(*parsed.value, "$schema"), "https://json-schema.org/draft/2020-12/schema");
  EXPECT_EQ(json_string(*parsed.value, "$id"), "urn:lemma:schema:api:v1");
}

TEST(ApiTest, DecodesConcreteActionAndRejectsUnknownFields) {
  constexpr std::string_view valid = R"({
    "schema":"lemma.action/v1",
    "action":"pane.resize",
    "session":{"id":"2:7"},
    "pane":{"id":"4:9"},
    "direction":"left",
    "amount":3
  })";
  const auto document = parse_json(valid);
  ASSERT_TRUE(document.value.has_value());
  const auto decoded = decode_action(*document.value);
  ASSERT_TRUE(decoded.action.has_value()) << decoded.error.reason;
  EXPECT_EQ(decoded.action->kind, ActionKind::pane_resize);
  EXPECT_EQ(decoded.action->session.id, SessionId::from_parts(2, 7));
  EXPECT_EQ(decoded.action->pane.id, PaneId::from_parts(4, 9));
  EXPECT_EQ(decoded.action->amount, 3);
  const auto encoded = encode_action(*decoded.action);
  ASSERT_TRUE(encoded.has_value());
  const auto round_trip_document = parse_json(*encoded);
  ASSERT_TRUE(round_trip_document.value.has_value());
  const auto round_trip = decode_action(*round_trip_document.value);
  ASSERT_TRUE(round_trip.action.has_value());
  EXPECT_EQ(round_trip.action->kind, ActionKind::pane_resize);
  EXPECT_EQ(round_trip.action->session.id, SessionId::from_parts(2, 7));
  EXPECT_EQ(round_trip.action->pane.id, PaneId::from_parts(4, 9));

  constexpr std::string_view invalid =
      R"({"schema":"lemma.action/v1","action":"session.list","typo":true})";
  const auto invalid_document = parse_json(invalid);
  ASSERT_TRUE(invalid_document.value.has_value());
  const auto rejected = decode_action(*invalid_document.value);
  EXPECT_FALSE(rejected.action.has_value());
  EXPECT_EQ(rejected.error.reason, "unknown_field");
  EXPECT_EQ(rejected.error.field, "typo");
}

TEST(ApiTest, RequiresPaneFilterForScreenObservation) {
  constexpr std::string_view invalid = R"({"schema":"lemma.events/v1","screen":true})";
  const auto document = parse_json(invalid);
  ASSERT_TRUE(document.value.has_value());
  const auto rejected = decode_event_subscription(*document.value);
  EXPECT_FALSE(rejected.subscription.has_value());
  EXPECT_EQ(rejected.error.field, "pane");
}

TEST(ApiTest, RejectsExplicitZeroCaptureLines) {
  constexpr std::string_view invalid =
      R"({"schema":"lemma.action/v1","action":"pane.capture","session":{"id":"0:1"},"pane":{"id":"0:1"},"lines":0})";
  const auto document = parse_json(invalid);
  ASSERT_TRUE(document.value.has_value());
  const auto rejected = decode_action(*document.value);
  EXPECT_FALSE(rejected.action.has_value());
  EXPECT_EQ(rejected.error.field, "lines");
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(ApiTest, EnforcesJsonDepthNodeAndDuplicateMemberBounds) {
  std::string maximum_depth(32, '[');
  maximum_depth += "null";
  maximum_depth.append(32, ']');
  EXPECT_TRUE(parse_json(maximum_depth).value.has_value());

  std::string excessive_depth(33, '[');
  excessive_depth += "null";
  excessive_depth.append(33, ']');
  EXPECT_FALSE(parse_json(excessive_depth).value.has_value());

  std::string maximum_nodes{"["};
  for (std::size_t index = 0; index < json_nodes_max - 1U; ++index) {
    if (index > 0) {
      maximum_nodes += ',';
    }
    maximum_nodes += "null";
  }
  maximum_nodes += ']';
  EXPECT_TRUE(parse_json(maximum_nodes).value.has_value());
  maximum_nodes.insert(maximum_nodes.size() - 1U, ",null");
  EXPECT_FALSE(parse_json(maximum_nodes).value.has_value());

  EXPECT_FALSE(parse_json(R"({"same":1,"same":2})").value.has_value());
}

TEST(ApiTest, RejectsNonIntegerNumbersAndInvalidUnicode) {
  EXPECT_FALSE(parse_json("1.0").value.has_value());
  EXPECT_FALSE(parse_json("1e2").value.has_value());
  EXPECT_FALSE(parse_json(R"("\uD800")").value.has_value());
  EXPECT_FALSE(parse_json(std::string{"\"\xC0\xAF\"", 4}).value.has_value());
}

// NOLINTEND(bugprone-unchecked-optional-access)

} // namespace
} // namespace lemma::api
