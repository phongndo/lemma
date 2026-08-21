#include "api/action.hpp"

#include "api/json.hpp"
#include "lemma/command.hpp"
#include "lemma/id.hpp"
#include "lemma/limits.hpp"

#include <algorithm>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <limits>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>

namespace lemma::api {
namespace {

template <typename Id>
[[nodiscard]] auto parse_id(const std::string_view value) -> std::optional<Id> {
  const auto separator = value.find(':');
  if (separator == std::string_view::npos || separator == 0 || separator + 1U == value.size()) {
    return std::nullopt;
  }
  std::uint32_t slot = 0;
  std::uint32_t generation = 0;
  const auto slot_text = value.substr(0, separator);
  const auto generation_text = value.substr(separator + 1U);
  const auto slot_result = std::from_chars(slot_text.begin(), slot_text.end(), slot);
  const auto generation_result =
      std::from_chars(generation_text.begin(), generation_text.end(), generation);
  return slot_result.ec == std::errc{} && slot_result.ptr == slot_text.end() &&
                 generation_result.ec == std::errc{} &&
                 generation_result.ptr == generation_text.end()
             ? Id::try_from_parts(slot, generation)
             : std::nullopt;
}

[[nodiscard]] auto unknown_field(const JsonValue& object,
                                 const std::initializer_list<std::string_view> allowed) noexcept
    -> std::optional<std::string_view> {
  for (const auto& entry : object.object) {
    if (std::ranges::find(allowed, std::string_view(entry.key)) == allowed.end()) {
      return entry.key;
    }
  }
  return std::nullopt;
}

[[nodiscard]] auto decode_session_selector(const JsonValue& document)
    -> std::optional<SessionSelector> {
  const auto* const value = json_member(document, "session");
  if (value == nullptr || value->kind != JsonKind::object ||
      unknown_field(*value, {"id", "name"}).has_value()) {
    return std::nullopt;
  }
  const auto id_text = json_string(*value, "id");
  const auto name = json_string(*value, "name");
  if (id_text.has_value() == name.has_value() || value->object.size() != 1U) {
    return std::nullopt;
  }
  if (id_text.has_value()) {
    const auto id = parse_id<SessionId>(*id_text);
    return id.has_value() ? std::optional{SessionSelector{.id = *id, .name = {}}} : std::nullopt;
  }
  return name.has_value() && SessionNameValue::create(*name).has_value()
             ? std::optional{SessionSelector{.id = {}, .name = std::string(*name)}}
             : std::nullopt;
}

[[nodiscard]] auto decode_tab_selector(const JsonValue& document) -> std::optional<TabSelector> {
  const auto* const value = json_member(document, "tab");
  if (value == nullptr || value->kind != JsonKind::object ||
      unknown_field(*value, {"id", "position"}).has_value()) {
    return std::nullopt;
  }
  const auto id_text = json_string(*value, "id");
  const auto position = json_unsigned(*value, "position");
  if (id_text.has_value() == position.has_value() || value->object.size() != 1U) {
    return std::nullopt;
  }
  if (id_text.has_value()) {
    const auto id = parse_id<TabId>(*id_text);
    return id.has_value() ? std::optional{TabSelector{.id = *id, .position = 0}} : std::nullopt;
  }
  return position.has_value() && *position > 0 && *position <= command_tab_slots_max
             ? std::optional{TabSelector{.id = {},
                                         .position = static_cast<std::uint16_t>(*position)}}
             : std::nullopt;
}

[[nodiscard]] auto decode_pane_selector(const JsonValue& document, const std::string_view field)
    -> std::optional<PaneSelector> {
  const auto* const value = json_member(document, field);
  if (value == nullptr || value->kind != JsonKind::object || value->object.size() != 1U ||
      unknown_field(*value, {"id"}).has_value()) {
    return std::nullopt;
  }
  const auto id_text = json_string(*value, "id");
  const auto id = id_text.has_value() ? parse_id<PaneId>(*id_text) : std::nullopt;
  return id.has_value() ? std::optional{PaneSelector{.id = *id}} : std::nullopt;
}

[[nodiscard]] auto decode_arguments(const JsonValue& document, Action& action) -> bool {
  const auto* const value = json_member(document, "argv");
  if (value == nullptr) {
    return true;
  }
  if (value->kind != JsonKind::array || value->array.empty() ||
      value->array.size() > limits::command_arguments_hard_max) {
    return false;
  }
  std::size_t bytes = 0;
  for (const auto& argument : value->array) {
    if (argument.kind != JsonKind::string || argument.string.contains('\0') ||
        (action.arguments.empty() && argument.string.empty()) ||
        argument.string.size() + 1U > limits::command_bytes_hard_max - bytes) {
      return false;
    }
    bytes += argument.string.size() + 1U;
    action.arguments.push_back(argument.string);
  }
  return true;
}

[[nodiscard]] auto decode_environment(const JsonValue& document, Action& action) -> bool {
  const auto* const value = json_member(document, "environment");
  if (value == nullptr) {
    return true;
  }
  if (value->kind != JsonKind::array || value->array.size() > limits::environment_entries_max) {
    return false;
  }
  std::size_t bytes = 0;
  for (const auto& entry : value->array) {
    if (entry.kind != JsonKind::string || entry.string.contains('\0')) {
      return false;
    }
    const auto separator = entry.string.find('=');
    if (separator == 0 || separator == std::string::npos ||
        entry.string.size() + 1U > limits::environment_bytes_max - bytes) {
      return false;
    }
    bytes += entry.string.size() + 1U;
    action.environment.push_back(entry.string);
  }
  action.environment_set = true;
  return true;
}

[[nodiscard]] auto decode_launch(const JsonValue& document, Action& action,
                                 const bool title_allowed) -> std::optional<std::string_view> {
  if (const auto* const cwd = json_member(document, "cwd"); cwd != nullptr) {
    if (cwd->kind != JsonKind::string || cwd->string.empty() || cwd->string.front() != '/' ||
        cwd->string.contains('\0') || cwd->string.size() > limits::working_directory_bytes_max) {
      return "cwd";
    }
    action.working_directory = cwd->string;
  }
  if (const auto* const hold = json_member(document, "hold"); hold != nullptr) {
    if (hold->kind != JsonKind::boolean) {
      return "hold";
    }
    action.hold = hold->boolean;
  }
  if (const auto* const title = json_member(document, "title"); title != nullptr) {
    if (!title_allowed || title->kind != JsonKind::string ||
        !TabTitleValue::create(title->string).has_value()) {
      return "title";
    }
    action.title = title->string;
  }
  return decode_arguments(document, action) ? std::nullopt
                                            : std::optional<std::string_view>{"argv"};
}

[[nodiscard]] auto failure(const std::string_view reason, const std::string_view field = {})
    -> ActionDecodeResult {
  return {.action = std::nullopt, .error = {.reason = reason, .field = field}};
}

[[nodiscard]] auto require_session(const JsonValue& document, Action& action)
    -> std::optional<ActionDecodeResult> {
  const auto selector = decode_session_selector(document);
  if (!selector.has_value()) {
    return failure("invalid_selector", "session");
  }
  action.session = *selector;
  return std::nullopt;
}

[[nodiscard]] auto require_tab(const JsonValue& document, Action& action)
    -> std::optional<ActionDecodeResult> {
  const auto selector = decode_tab_selector(document);
  if (!selector.has_value()) {
    return failure("invalid_selector", "tab");
  }
  action.tab = *selector;
  return std::nullopt;
}

[[nodiscard]] auto require_pane(const JsonValue& document, Action& action,
                                const std::string_view field = "pane")
    -> std::optional<ActionDecodeResult> {
  const auto selector = decode_pane_selector(document, field);
  if (!selector.has_value()) {
    return failure("invalid_selector", field);
  }
  if (field == "pane") {
    action.pane = *selector;
  } else {
    action.other = *selector;
  }
  return std::nullopt;
}

} // namespace

auto action_name(const ActionKind kind) noexcept -> std::string_view {
  switch (kind) {
  case ActionKind::session_list:
    return "session.list";
  case ActionKind::session_inspect:
    return "session.inspect";
  case ActionKind::session_start:
    return "session.start";
  case ActionKind::session_rename:
    return "session.rename";
  case ActionKind::session_kill:
    return "session.kill";
  case ActionKind::tab_list:
    return "tab.list";
  case ActionKind::tab_new:
    return "tab.new";
  case ActionKind::tab_select:
    return "tab.select";
  case ActionKind::tab_move:
    return "tab.move";
  case ActionKind::tab_rename:
    return "tab.rename";
  case ActionKind::tab_kill:
    return "tab.kill";
  case ActionKind::pane_list:
    return "pane.list";
  case ActionKind::pane_split:
    return "pane.split";
  case ActionKind::pane_focus:
    return "pane.focus";
  case ActionKind::pane_swap:
    return "pane.swap";
  case ActionKind::pane_resize:
    return "pane.resize";
  case ActionKind::pane_zoom:
    return "pane.zoom";
  case ActionKind::pane_send:
    return "pane.send";
  case ActionKind::pane_capture:
    return "pane.capture";
  case ActionKind::pane_kill:
    return "pane.kill";
  }
  return {};
}

[[nodiscard]] auto append_selector(std::string& output, const std::string_view field,
                                   const SessionSelector& selector) -> bool {
  try {
    output += ",\"";
    output += field;
    output += "\":{";
    if (selector.id.is_valid()) {
      output += R"("id":")" + std::to_string(selector.id.slot()) + ":" +
                std::to_string(selector.id.generation()) + "\"}";
      return true;
    }
    output += "\"name\":";
    return append_json_string(output, selector.name) && (output += "}", true);
  } catch (...) {
    return false;
  }
}

[[nodiscard]] auto append_selector(std::string& output, const std::string_view field,
                                   const TabSelector& selector) -> bool {
  try {
    output += ",\"";
    output += field;
    if (selector.id.is_valid()) {
      output += R"(":{"id":")" + std::to_string(selector.id.slot()) + ":" +
                std::to_string(selector.id.generation()) + "\"}";
    } else {
      output += R"(":{"position":)" + std::to_string(selector.position) + "}";
    }
    return true;
  } catch (...) {
    return false;
  }
}

[[nodiscard]] auto append_selector(std::string& output, const std::string_view field,
                                   const PaneSelector& selector) -> bool {
  if (!selector.id.is_valid()) {
    return false;
  }
  try {
    output += ",\"";
    output += field;
    output += R"(":{"id":")" + std::to_string(selector.id.slot()) + ":" +
              std::to_string(selector.id.generation()) + "\"}";
    return true;
  } catch (...) {
    return false;
  }
}

[[nodiscard]] auto append_string_field(std::string& output, const std::string_view field,
                                       const std::string_view value) -> bool {
  try {
    output += ",\"";
    output += field;
    output += "\":";
    return append_json_string(output, value);
  } catch (...) {
    return false;
  }
}

[[nodiscard]] auto append_string_array(std::string& output, const std::string_view field,
                                       const std::span<const std::string> values) -> bool {
  if (values.empty()) {
    return true;
  }
  try {
    output += ",\"";
    output += field;
    output += "\":[";
    for (std::size_t index = 0; index < values.size(); ++index) {
      if (index > 0) {
        output += ",";
      }
      if (!append_json_string(output, values.subspan(index, 1).front())) {
        return false;
      }
    }
    output += "]";
    return true;
  } catch (...) {
    return false;
  }
}

[[nodiscard]] auto direction_name(const Direction direction) noexcept -> std::string_view {
  switch (direction) {
  case Direction::left:
    return "left";
  case Direction::right:
    return "right";
  case Direction::up:
    return "up";
  case Direction::down:
    return "down";
  case Direction::none:
    return {};
  }
  return {};
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto encode_action(const Action& action) -> std::optional<std::string> {
  try {
    std::string output = R"({"schema":"lemma.action/v1","action":)";
    if (!append_json_string(output, action_name(action.kind))) {
      return std::nullopt;
    }
    const bool has_session =
        action.kind != ActionKind::session_list && action.kind != ActionKind::session_start;
    if (has_session && !append_selector(output, "session", action.session)) {
      return std::nullopt;
    }
    if (action.kind == ActionKind::session_start && !action.name.empty() &&
        !append_string_field(output, "name", action.name)) {
      return std::nullopt;
    }
    if (action.kind == ActionKind::session_rename &&
        !append_string_field(output, "name", action.name)) {
      return std::nullopt;
    }
    if (action.kind == ActionKind::tab_select || action.kind == ActionKind::tab_move ||
        action.kind == ActionKind::tab_rename || action.kind == ActionKind::tab_kill) {
      if (!append_selector(output, "tab", action.tab)) {
        return std::nullopt;
      }
    }
    if (action.kind == ActionKind::pane_split || action.kind == ActionKind::pane_focus ||
        action.kind == ActionKind::pane_swap || action.kind == ActionKind::pane_resize ||
        action.kind == ActionKind::pane_zoom || action.kind == ActionKind::pane_send ||
        action.kind == ActionKind::pane_capture || action.kind == ActionKind::pane_kill) {
      if (!append_selector(output, "pane", action.pane)) {
        return std::nullopt;
      }
    }
    if (action.kind == ActionKind::pane_swap && !append_selector(output, "other", action.other)) {
      return std::nullopt;
    }
    if (action.kind == ActionKind::session_start || action.kind == ActionKind::tab_new ||
        action.kind == ActionKind::pane_split) {
      if (!action.working_directory.empty() &&
          !append_string_field(output, "cwd", action.working_directory)) {
        return std::nullopt;
      }
      if (action.hold) {
        output += R"(,"hold":true)";
      }
      if (!append_string_array(output, "argv", action.arguments)) {
        return std::nullopt;
      }
    }
    if (action.kind == ActionKind::session_start && action.environment_set) {
      if (action.environment.empty()) {
        output += R"(,"environment":[])";
      } else if (!append_string_array(output, "environment", action.environment)) {
        return std::nullopt;
      }
    }
    if (action.kind == ActionKind::tab_new && !action.title.empty() &&
        !append_string_field(output, "title", action.title)) {
      return std::nullopt;
    }
    if (action.kind == ActionKind::tab_move) {
      output += R"(,"to_position":)" + std::to_string(action.to_position);
    }
    if (action.kind == ActionKind::tab_rename &&
        !append_string_field(output, "title", action.title)) {
      return std::nullopt;
    }
    if (action.kind == ActionKind::pane_split || action.kind == ActionKind::pane_resize) {
      if (!append_string_field(output, "direction", direction_name(action.direction))) {
        return std::nullopt;
      }
    }
    if (action.kind == ActionKind::pane_resize) {
      output += R"(,"amount":)" + std::to_string(action.amount);
    }
    if (action.kind == ActionKind::pane_zoom) {
      output += action.enabled ? R"(,"enabled":true)" : R"(,"enabled":false)";
    }
    if (action.kind == ActionKind::pane_send && !append_string_field(output, "text", action.text)) {
      return std::nullopt;
    }
    if (action.kind == ActionKind::pane_capture && action.lines > 0) {
      output += R"(,"lines":)" + std::to_string(action.lines);
    }
    output += "}";
    return output;
  } catch (...) {
    return std::nullopt;
  }
}

// The public Action schema is closed and action-specific. This decoder is the daemon trust
// boundary; frontend parsers construct the same value directly.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto decode_action(const JsonValue& document) -> ActionDecodeResult {
  if (document.kind != JsonKind::object) {
    return failure("invalid_document");
  }
  const auto schema = json_string(document, "schema");
  const auto name = json_string(document, "action");
  if (schema != std::optional<std::string_view>{action_schema}) {
    return failure("invalid_schema", "schema");
  }
  if (!name.has_value()) {
    return failure("missing_or_invalid_field", "action");
  }
  Action action;
  const auto reject_unknown = [&](const std::initializer_list<std::string_view> fields)
      -> std::optional<ActionDecodeResult> {
    const auto field = unknown_field(document, fields);
    return field.has_value() ? std::optional{failure("unknown_field", *field)} : std::nullopt;
  };

  if (*name == "session.list") {
    if (auto rejected = reject_unknown({"schema", "action"}); rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::session_list;
  } else if (*name == "session.inspect") {
    if (auto rejected = reject_unknown({"schema", "action", "session"}); rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::session_inspect;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
  } else if (*name == "session.start") {
    if (auto rejected =
            reject_unknown({"schema", "action", "name", "cwd", "hold", "argv", "environment"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::session_start;
    if (const auto* const candidate = json_member(document, "name"); candidate != nullptr) {
      if (candidate->kind != JsonKind::string ||
          !SessionNameValue::create(candidate->string).has_value()) {
        return failure("invalid_field", "name");
      }
      action.name = candidate->string;
    }
    if (const auto field = decode_launch(document, action, false); field.has_value()) {
      return failure("invalid_field", *field);
    }
    if (!decode_environment(document, action)) {
      return failure("invalid_field", "environment");
    }
  } else if (*name == "session.rename") {
    if (auto rejected = reject_unknown({"schema", "action", "session", "name"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::session_rename;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
    const auto candidate = json_string(document, "name");
    if (!candidate.has_value() || !SessionNameValue::create(*candidate).has_value()) {
      return failure("invalid_field", "name");
    }
    action.name = *candidate;
  } else if (*name == "session.kill") {
    if (auto rejected = reject_unknown({"schema", "action", "session"}); rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::session_kill;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
  } else if (*name == "tab.list" || *name == "pane.list") {
    if (auto rejected = reject_unknown({"schema", "action", "session"}); rejected.has_value()) {
      return *rejected;
    }
    action.kind = *name == "tab.list" ? ActionKind::tab_list : ActionKind::pane_list;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
  } else if (*name == "tab.new") {
    if (auto rejected =
            reject_unknown({"schema", "action", "session", "title", "cwd", "hold", "argv"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::tab_new;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (const auto field = decode_launch(document, action, true); field.has_value()) {
      return failure("invalid_field", *field);
    }
  } else if (*name == "tab.select" || *name == "tab.kill") {
    if (auto rejected = reject_unknown({"schema", "action", "session", "tab"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = *name == "tab.select" ? ActionKind::tab_select : ActionKind::tab_kill;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (auto invalid = require_tab(document, action); invalid.has_value()) {
      return *invalid;
    }
  } else if (*name == "tab.move") {
    if (auto rejected = reject_unknown({"schema", "action", "session", "tab", "to_position"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::tab_move;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (auto invalid = require_tab(document, action); invalid.has_value()) {
      return *invalid;
    }
    const auto destination = json_unsigned(document, "to_position");
    if (!destination.has_value() || *destination == 0 || *destination > command_tab_slots_max) {
      return failure("invalid_field", "to_position");
    }
    action.to_position = static_cast<std::uint16_t>(*destination);
  } else if (*name == "tab.rename") {
    if (auto rejected = reject_unknown({"schema", "action", "session", "tab", "title"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::tab_rename;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (auto invalid = require_tab(document, action); invalid.has_value()) {
      return *invalid;
    }
    const auto title = json_string(document, "title").value_or(std::string_view{});
    if (!TabTitleValue::create(title).has_value()) {
      return failure("invalid_field", "title");
    }
    action.title = title;
  } else if (*name == "pane.split") {
    if (auto rejected = reject_unknown(
            {"schema", "action", "session", "pane", "direction", "cwd", "hold", "argv"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::pane_split;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (auto invalid = require_pane(document, action); invalid.has_value()) {
      return *invalid;
    }
    const auto direction = json_string(document, "direction");
    if (direction == std::optional<std::string_view>{"right"}) {
      action.direction = Direction::right;
    } else if (direction == std::optional<std::string_view>{"down"}) {
      action.direction = Direction::down;
    } else {
      return failure("invalid_field", "direction");
    }
    if (const auto field = decode_launch(document, action, false); field.has_value()) {
      return failure("invalid_field", *field);
    }
  } else if (*name == "pane.focus" || *name == "pane.kill") {
    if (auto rejected = reject_unknown({"schema", "action", "session", "pane"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = *name == "pane.focus" ? ActionKind::pane_focus : ActionKind::pane_kill;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (auto invalid = require_pane(document, action); invalid.has_value()) {
      return *invalid;
    }
  } else if (*name == "pane.swap") {
    if (auto rejected = reject_unknown({"schema", "action", "session", "pane", "other"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::pane_swap;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (auto invalid = require_pane(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (auto invalid = require_pane(document, action, "other"); invalid.has_value()) {
      return *invalid;
    }
  } else if (*name == "pane.resize") {
    if (auto rejected =
            reject_unknown({"schema", "action", "session", "pane", "direction", "amount"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::pane_resize;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (auto invalid = require_pane(document, action); invalid.has_value()) {
      return *invalid;
    }
    const auto direction = json_string(document, "direction");
    if (direction == std::optional<std::string_view>{"left"}) {
      action.direction = Direction::left;
    } else if (direction == std::optional<std::string_view>{"right"}) {
      action.direction = Direction::right;
    } else if (direction == std::optional<std::string_view>{"up"}) {
      action.direction = Direction::up;
    } else if (direction == std::optional<std::string_view>{"down"}) {
      action.direction = Direction::down;
    } else {
      return failure("invalid_field", "direction");
    }
    const auto amount = json_unsigned(document, "amount").value_or(1);
    if (amount == 0 || amount > command_resize_amount_max) {
      return failure("invalid_field", "amount");
    }
    action.amount = static_cast<std::uint16_t>(amount);
  } else if (*name == "pane.zoom") {
    if (auto rejected = reject_unknown({"schema", "action", "session", "pane", "enabled"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::pane_zoom;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (auto invalid = require_pane(document, action); invalid.has_value()) {
      return *invalid;
    }
    const auto enabled = json_boolean(document, "enabled");
    if (!enabled.has_value()) {
      return failure("invalid_field", "enabled");
    }
    action.enabled = *enabled;
  } else if (*name == "pane.send") {
    if (auto rejected = reject_unknown({"schema", "action", "session", "pane", "text"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::pane_send;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (auto invalid = require_pane(document, action); invalid.has_value()) {
      return *invalid;
    }
    const auto text = json_string(document, "text");
    if (!text.has_value() || text->empty() || text->size() > limits::environment_bytes_max - 8U) {
      return failure("invalid_field", "text");
    }
    action.text = *text;
  } else if (*name == "pane.capture") {
    if (auto rejected = reject_unknown({"schema", "action", "session", "pane", "lines"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::pane_capture;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (auto invalid = require_pane(document, action); invalid.has_value()) {
      return *invalid;
    }
    const auto* const lines_value = json_member(document, "lines");
    if (lines_value != nullptr) {
      const auto lines = json_unsigned(document, "lines");
      if (!lines.has_value() || *lines == 0 || *lines > std::numeric_limits<std::uint16_t>::max()) {
        return failure("invalid_field", "lines");
      }
      action.lines = static_cast<std::uint16_t>(*lines);
    }
  } else {
    return failure("unknown_action", "action");
  }
  return {.action = std::move(action), .error = {}};
}

auto decode_event_subscription(const JsonValue& document) -> EventSubscriptionDecodeResult {
  if (document.kind != JsonKind::object) {
    return {.subscription = std::nullopt, .error = {.reason = "invalid_document", .field = {}}};
  }
  if (json_string(document, "schema") != std::optional<std::string_view>{events_schema}) {
    return {.subscription = std::nullopt, .error = {.reason = "invalid_schema", .field = "schema"}};
  }
  if (const auto field = unknown_field(document, {"schema", "session", "pane", "screen"});
      field.has_value()) {
    return {.subscription = std::nullopt, .error = {.reason = "unknown_field", .field = *field}};
  }
  EventSubscription result;
  if (json_member(document, "session") != nullptr) {
    result.session = decode_session_selector(document);
    if (!result.session.has_value()) {
      return {.subscription = std::nullopt,
              .error = {.reason = "invalid_selector", .field = "session"}};
    }
  }
  if (json_member(document, "pane") != nullptr) {
    result.pane = decode_pane_selector(document, "pane");
    if (!result.pane.has_value() || !result.session.has_value()) {
      return {.subscription = std::nullopt,
              .error = {.reason = "invalid_selector", .field = "pane"}};
    }
  }
  if (const auto* const screen = json_member(document, "screen"); screen != nullptr) {
    if (screen->kind != JsonKind::boolean) {
      return {.subscription = std::nullopt,
              .error = {.reason = "invalid_field", .field = "screen"}};
    }
    result.screen = screen->boolean;
  }
  if (result.screen && !result.pane.has_value()) {
    return {.subscription = std::nullopt, .error = {.reason = "invalid_selector", .field = "pane"}};
  }
  return {.subscription = std::move(result), .error = {}};
}

} // namespace lemma::api
