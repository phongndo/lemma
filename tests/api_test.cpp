#include "api/action.hpp"
#include "api/json.hpp"
#include "api/schema.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <optional>
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

// GoogleTest assertions and nested schema traversal inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(ApiTest, DefinesStructuredPaneListingGeometry) {
  const auto parsed = parse_json(schema_document());
  ASSERT_TRUE(parsed.value.has_value()) << parsed.error_offset;
  const auto* const definitions = json_member(*parsed.value, "$defs");
  ASSERT_NE(definitions, nullptr);
  const auto* const pane_listing = json_member(*definitions, "paneListing");
  ASSERT_NE(pane_listing, nullptr);
  const auto* const required = json_member(*pane_listing, "required");
  ASSERT_NE(required, nullptr);
  ASSERT_EQ(required->kind, JsonKind::array);
  const auto has_required = [required](const std::string_view field) {
    return std::ranges::any_of(required->array, [field](const JsonValue& entry) {
      return entry.kind == JsonKind::string && entry.string == field;
    });
  };
  EXPECT_TRUE(has_required("column"));
  EXPECT_TRUE(has_required("row"));
  EXPECT_TRUE(has_required("columns"));
  EXPECT_TRUE(has_required("rows"));

  const auto* const action_result = json_member(*definitions, "actionResult");
  ASSERT_NE(action_result, nullptr);
  const auto* const properties = json_member(*action_result, "properties");
  ASSERT_NE(properties, nullptr);
  const auto* const panes = json_member(*properties, "panes");
  ASSERT_NE(panes, nullptr);
  const auto* const items = json_member(*panes, "items");
  ASSERT_NE(items, nullptr);
  EXPECT_EQ(json_string(*items, "$ref"), std::optional<std::string_view>{"#/$defs/paneListing"});
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
