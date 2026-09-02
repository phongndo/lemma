#include "api/json.hpp"
#include "api/op.hpp"
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
  const auto* const definitions = json_member(*parsed.value, "$defs");
  ASSERT_NE(definitions, nullptr);
  EXPECT_EQ(json_member(*definitions, "waitResult"), nullptr);
  EXPECT_EQ(json_member(*definitions, "action"), nullptr);
  EXPECT_EQ(json_member(*definitions, "actionResult"), nullptr);
  EXPECT_NE(json_member(*definitions, "proc"), nullptr);
  EXPECT_NE(json_member(*definitions, "op"), nullptr);
  EXPECT_NE(json_member(*definitions, "opResult"), nullptr);
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

  const auto* const op_result = json_member(*definitions, "opResult");
  ASSERT_NE(op_result, nullptr);
  const auto* const properties = json_member(*op_result, "properties");
  ASSERT_NE(properties, nullptr);
  const auto* const panes = json_member(*properties, "panes");
  ASSERT_NE(panes, nullptr);
  const auto* const items = json_member(*panes, "items");
  ASSERT_NE(items, nullptr);
  EXPECT_EQ(json_string(*items, "$ref"), std::optional<std::string_view>{"#/$defs/paneListing"});
}

TEST(ApiTest, DecodesConcreteOpAndRejectsUnknownFields) {
  constexpr std::string_view valid = R"({
        "op":"pane.resize",
    "session":{"id":"2:7"},
    "pane":{"id":"4:9"},
    "direction":"left",
    "amount":3
  })";
  const auto document = parse_json(valid);
  ASSERT_TRUE(document.value.has_value());
  const auto decoded = decode_op(*document.value);
  ASSERT_TRUE(decoded.op.has_value()) << decoded.error.reason;
  EXPECT_EQ(decoded.op->kind, OpKind::pane_resize);
  EXPECT_EQ(decoded.op->session.id, SessionId::from_parts(2, 7));
  EXPECT_EQ(decoded.op->pane.id, PaneId::from_parts(4, 9));
  EXPECT_EQ(decoded.op->amount, 3);
  const auto encoded = encode_op(*decoded.op);
  ASSERT_TRUE(encoded.has_value());
  const auto round_trip_document = parse_json(*encoded);
  ASSERT_TRUE(round_trip_document.value.has_value());
  const auto round_trip = decode_op(*round_trip_document.value);
  ASSERT_TRUE(round_trip.op.has_value());
  EXPECT_EQ(round_trip.op->kind, OpKind::pane_resize);
  EXPECT_EQ(round_trip.op->session.id, SessionId::from_parts(2, 7));
  EXPECT_EQ(round_trip.op->pane.id, PaneId::from_parts(4, 9));

  constexpr std::string_view invalid = R"({"op":"session.list","typo":true})";
  const auto invalid_document = parse_json(invalid);
  ASSERT_TRUE(invalid_document.value.has_value());
  const auto rejected = decode_op(*invalid_document.value);
  EXPECT_FALSE(rejected.op.has_value());
  EXPECT_EQ(rejected.error.reason, "unknown_field");
  EXPECT_EQ(rejected.error.field, "typo");
}

TEST(ApiTest, DecodesBoundedWaitOpAndRejectsConflictingConditions) {
  constexpr std::string_view valid = R"({
        "op":"pane.wait",
    "session":{"id":"2:7"},
    "pane":{"id":"4:9"},
    "contains":"ready",
    "after_generation":12,
    "timeout_ms":2000
  })";
  const auto document = parse_json(valid);
  ASSERT_TRUE(document.value.has_value());
  const auto decoded = decode_op(*document.value);
  ASSERT_TRUE(decoded.op.has_value()) << decoded.error.reason;
  EXPECT_EQ(decoded.op->kind, OpKind::pane_wait);
  EXPECT_EQ(decoded.op->wait_condition, WaitCondition::contains);
  EXPECT_EQ(decoded.op->contains, "ready");
  EXPECT_EQ(decoded.op->after_terminal_generation, 12U);
  EXPECT_EQ(decoded.op->wait_timeout_milliseconds, 2000U);
  const auto encoded = encode_op(*decoded.op);
  ASSERT_TRUE(encoded.has_value());
  const auto round_trip_document = parse_json(*encoded);
  ASSERT_TRUE(round_trip_document.value.has_value());
  const auto round_trip = decode_op(*round_trip_document.value);
  ASSERT_TRUE(round_trip.op.has_value());
  EXPECT_EQ(round_trip.op->wait_condition, WaitCondition::contains);
  EXPECT_EQ(round_trip.op->contains, "ready");

  constexpr std::string_view conflicting = R"({
        "op":"pane.wait",
    "session":{"id":"2:7"},
    "pane":{"id":"4:9"},
    "exit_code":0,
    "until_prompt":true
  })";
  const auto conflicting_document = parse_json(conflicting);
  ASSERT_TRUE(conflicting_document.value.has_value());
  const auto rejected = decode_op(*conflicting_document.value);
  EXPECT_FALSE(rejected.op.has_value());
  EXPECT_EQ(rejected.error.reason, "conflicting_fields");

  constexpr std::string_view invalid_generation = R"({
        "op":"pane.wait",
    "session":{"id":"2:7"},
    "pane":{"id":"4:9"},
    "after_generation":12
  })";
  const auto generation_document = parse_json(invalid_generation);
  ASSERT_TRUE(generation_document.value.has_value());
  EXPECT_FALSE(decode_op(*generation_document.value).op.has_value());
}

TEST(ApiTest, DecodesBoundedMultiPaneObservation) {
  constexpr std::string_view valid = R"({
    "schema":"lemma.events/v1",
    "session":{"id":"0:1"},
    "panes":[{"id":"1:1"},{"id":"2:1"}],
    "screen":true
  })";
  const auto document = parse_json(valid);
  ASSERT_TRUE(document.value.has_value());
  const auto decoded = decode_event_subscription(*document.value);
  ASSERT_TRUE(decoded.subscription.has_value()) << decoded.error.reason;
  ASSERT_EQ(decoded.subscription->panes.size(), 2U);
  EXPECT_EQ(decoded.subscription->panes.at(1).id, PaneId::from_parts(2, 1));

  constexpr std::string_view duplicate = R"({
    "schema":"lemma.events/v1",
    "session":{"id":"0:1"},
    "panes":[{"id":"1:1"},{"id":"1:1"}],
    "screen":true
  })";
  const auto duplicate_document = parse_json(duplicate);
  ASSERT_TRUE(duplicate_document.value.has_value());
  EXPECT_FALSE(decode_event_subscription(*duplicate_document.value).subscription.has_value());
}

TEST(ApiTest, RejectsAgentInputBatchCapacityOverflow) {
  std::string input = R"({"op":"pane.input","session":{"id":"0:1"},"pane":{"id":"0:1"},"events":[)";
  for (std::size_t index = 0; index <= input_events_max; ++index) {
    input += index == 0 ? R"({"kind":"key","key":"a"})" : R"(,{"kind":"key","key":"a"})";
  }
  input += "]}";
  const auto input_document = parse_json(input);
  ASSERT_TRUE(input_document.value.has_value());
  EXPECT_FALSE(decode_op(*input_document.value).op.has_value());
}

TEST(ApiTest, RejectsObservationPaneCapacityOverflow) {
  std::string subscription = R"({"schema":"lemma.events/v1","session":{"id":"0:1"},"panes":[)";
  for (std::size_t index = 0; index <= event_panes_max; ++index) {
    if (index > 0) {
      subscription += ',';
    }
    subscription += R"({"id":")" + std::to_string(index) + R"(:1"})";
  }
  subscription += "]}";
  const auto subscription_document = parse_json(subscription);
  ASSERT_TRUE(subscription_document.value.has_value());
  EXPECT_FALSE(decode_event_subscription(*subscription_document.value).subscription.has_value());
}

TEST(ApiTest, RequiresPaneFilterForScreenObservation) {
  constexpr std::string_view invalid = R"({"schema":"lemma.events/v1","screen":true})";
  const auto document = parse_json(invalid);
  ASSERT_TRUE(document.value.has_value());
  const auto rejected = decode_event_subscription(*document.value);
  EXPECT_FALSE(rejected.subscription.has_value());
  EXPECT_EQ(rejected.error.field, "pane");
}

TEST(ApiTest, DecodesIntrospectionInputCaptureAndFocusPolicies) {
  constexpr std::string_view input = R"({
        "op":"pane.input",
    "session":{"id":"2:7"},
    "pane":{"id":"4:9"},
    "events":[
      {"kind":"paste","text":"just test"},
      {"kind":"key","key":"c","modifiers":["control"]},
      {"kind":"key","key":"enter"}
    ]
  })";
  const auto input_document = parse_json(input);
  ASSERT_TRUE(input_document.value.has_value());
  const auto decoded_input = decode_op(*input_document.value);
  ASSERT_TRUE(decoded_input.op.has_value()) << decoded_input.error.reason;
  ASSERT_EQ(decoded_input.op->input_events.size(), 3U);
  EXPECT_EQ(decoded_input.op->input_events.at(0).kind, InputEventKind::paste);
  EXPECT_EQ(decoded_input.op->input_events.at(1).modifiers, input_modifier_control);
  EXPECT_EQ(decoded_input.op->input_events.at(2).key, InputKey::enter);
  const auto encoded_input = encode_op(*decoded_input.op);
  ASSERT_TRUE(encoded_input.has_value());
  const auto round_trip_document = parse_json(*encoded_input);
  ASSERT_TRUE(round_trip_document.value.has_value());
  const auto round_trip = decode_op(*round_trip_document.value);
  ASSERT_TRUE(round_trip.op.has_value());
  EXPECT_EQ(round_trip.op->input_events.size(), 3U);

  constexpr std::string_view split = R"({
        "op":"pane.split",
    "session":{"id":"2:7"},
    "pane":{"id":"4:9"},
    "direction":"right",
    "focus":"preserve",
    "if_session_revision":12
  })";
  const auto split_document = parse_json(split);
  ASSERT_TRUE(split_document.value.has_value());
  const auto decoded_split = decode_op(*split_document.value);
  ASSERT_TRUE(decoded_split.op.has_value()) << decoded_split.error.reason;
  EXPECT_EQ(decoded_split.op->focus, FocusPolicy::preserve);
  EXPECT_EQ(decoded_split.op->expected_session_revision, 12U);

  constexpr std::string_view capture = R"({
        "op":"pane.capture",
    "session":{"id":"2:7"},
    "pane":{"id":"4:9"},
    "source":"recent",
    "format":"ansi",
    "wrap":"logical",
    "lines":120
  })";
  const auto capture_document = parse_json(capture);
  ASSERT_TRUE(capture_document.value.has_value());
  const auto decoded_capture = decode_op(*capture_document.value);
  ASSERT_TRUE(decoded_capture.op.has_value()) << decoded_capture.error.reason;
  EXPECT_EQ(decoded_capture.op->capture_source, CaptureSource::recent);
  EXPECT_EQ(decoded_capture.op->capture_format, CaptureFormat::ansi);
  EXPECT_EQ(decoded_capture.op->capture_wrap, CaptureWrap::logical);

  const auto invalid_capture = parse_json(R"({
        "op":"pane.capture",
    "session":{"id":"2:7"},
    "pane":{"id":"4:9"},
    "source":7
  })");
  ASSERT_TRUE(invalid_capture.value.has_value());
  const auto rejected_capture = decode_op(*invalid_capture.value);
  EXPECT_FALSE(rejected_capture.op.has_value());
  EXPECT_EQ(rejected_capture.error.field, "source");

  const auto ignored_lines = parse_json(R"({
        "op":"pane.capture",
    "session":{"id":"2:7"},
    "pane":{"id":"4:9"},
    "source":"last-command",
    "lines":10
  })");
  ASSERT_TRUE(ignored_lines.value.has_value());
  const auto rejected_lines = decode_op(*ignored_lines.value);
  EXPECT_FALSE(rejected_lines.op.has_value());
  EXPECT_EQ(rejected_lines.error.field, "lines");

  const auto daemon_document = parse_json(R"({"op":"daemon.inspect"})");
  ASSERT_TRUE(daemon_document.value.has_value());
  const auto daemon = decode_op(*daemon_document.value);
  ASSERT_TRUE(daemon.op.has_value());
  EXPECT_EQ(daemon.op->kind, OpKind::daemon_inspect);
}

TEST(ApiTest, RejectsExplicitZeroCaptureLines) {
  constexpr std::string_view invalid =
      R"({"op":"pane.capture","session":{"id":"0:1"},"pane":{"id":"0:1"},"lines":0})";
  const auto document = parse_json(invalid);
  ASSERT_TRUE(document.value.has_value());
  const auto rejected = decode_op(*document.value);
  EXPECT_FALSE(rejected.op.has_value());
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
