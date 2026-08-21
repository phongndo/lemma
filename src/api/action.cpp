#include "api/action.hpp"

#include "api/json.hpp"
#include "lemma/command.hpp"
#include "lemma/id.hpp"
#include "lemma/limits.hpp"

#include <algorithm>
#include <array>
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

[[nodiscard]] auto decode_focus_policy(const JsonValue& document, Action& action) noexcept -> bool {
  const auto* const value = json_member(document, "focus");
  if (value == nullptr) {
    return true;
  }
  const auto name = json_string(document, "focus");
  if (name == std::optional<std::string_view>{"created"}) {
    action.focus = FocusPolicy::created;
    return true;
  }
  if (name == std::optional<std::string_view>{"preserve"}) {
    action.focus = FocusPolicy::preserve;
    return true;
  }
  return false;
}

constexpr std::array input_key_names{
    std::string_view{"a"},       std::string_view{"b"},         std::string_view{"c"},
    std::string_view{"d"},       std::string_view{"e"},         std::string_view{"f"},
    std::string_view{"g"},       std::string_view{"h"},         std::string_view{"i"},
    std::string_view{"j"},       std::string_view{"k"},         std::string_view{"l"},
    std::string_view{"m"},       std::string_view{"n"},         std::string_view{"o"},
    std::string_view{"p"},       std::string_view{"q"},         std::string_view{"r"},
    std::string_view{"s"},       std::string_view{"t"},         std::string_view{"u"},
    std::string_view{"v"},       std::string_view{"w"},         std::string_view{"x"},
    std::string_view{"y"},       std::string_view{"z"},         std::string_view{"enter"},
    std::string_view{"tab"},     std::string_view{"backspace"}, std::string_view{"escape"},
    std::string_view{"space"},   std::string_view{"up"},        std::string_view{"down"},
    std::string_view{"left"},    std::string_view{"right"},     std::string_view{"home"},
    std::string_view{"end"},     std::string_view{"insert"},    std::string_view{"delete"},
    std::string_view{"page_up"}, std::string_view{"page_down"}, std::string_view{"f1"},
    std::string_view{"f2"},      std::string_view{"f3"},        std::string_view{"f4"},
    std::string_view{"f5"},      std::string_view{"f6"},        std::string_view{"f7"},
    std::string_view{"f8"},      std::string_view{"f9"},        std::string_view{"f10"},
    std::string_view{"f11"},     std::string_view{"f12"},
};
static_assert(input_key_names.size() == static_cast<std::size_t>(InputKey::f12) + 1U);

// Branches mirror the closed text, paste, and logical-key event schemas.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto decode_input_events(const JsonValue& document, Action& action) -> bool {
  const auto* const value = json_member(document, "events");
  if (value == nullptr || value->kind != JsonKind::array || value->array.empty() ||
      value->array.size() > input_events_max) {
    return false;
  }
  std::size_t text_bytes = 0;
  for (const auto& encoded : value->array) {
    if (encoded.kind != JsonKind::object) {
      return false;
    }
    const auto kind = json_string(encoded, "kind");
    if (kind == std::optional<std::string_view>{"text"} ||
        kind == std::optional<std::string_view>{"paste"}) {
      if (unknown_field(encoded, {"kind", "text"}).has_value()) {
        return false;
      }
      const auto text = json_string(encoded, "text");
      if (!text.has_value() || text->empty() ||
          text->size() > limits::environment_bytes_max - text_bytes) {
        return false;
      }
      text_bytes += text->size();
      action.input_events.push_back(
          {.kind = *kind == "text" ? InputEventKind::text : InputEventKind::paste,
           .text = std::string(*text)});
      continue;
    }
    if (kind != std::optional<std::string_view>{"key"} ||
        unknown_field(encoded, {"kind", "key", "modifiers", "action"}).has_value()) {
      return false;
    }
    const auto key = json_string(encoded, "key");
    const auto parsed_key = key.has_value() ? parse_input_key_name(*key) : std::nullopt;
    if (!parsed_key.has_value()) {
      return false;
    }
    InputEvent event{.kind = InputEventKind::key, .text = {}, .key = *parsed_key};
    if (const auto* const modifiers = json_member(encoded, "modifiers"); modifiers != nullptr) {
      if (modifiers->kind != JsonKind::array || modifiers->array.size() > 4U) {
        return false;
      }
      for (const auto& modifier : modifiers->array) {
        if (modifier.kind != JsonKind::string) {
          return false;
        }
        std::uint16_t bit = 0;
        if (modifier.string == "shift") {
          bit = input_modifier_shift;
        } else if (modifier.string == "control") {
          bit = input_modifier_control;
        } else if (modifier.string == "alt") {
          bit = input_modifier_alt;
        } else if (modifier.string == "super") {
          bit = input_modifier_super;
        } else {
          return false;
        }
        if ((event.modifiers & bit) != 0) {
          return false;
        }
        event.modifiers |= bit;
      }
    }
    if (const auto* const key_action = json_member(encoded, "action"); key_action != nullptr) {
      const auto name = json_string(encoded, "action");
      if (name == std::optional<std::string_view>{"press"}) {
        event.action = InputKeyAction::press;
      } else if (name == std::optional<std::string_view>{"repeat"}) {
        event.action = InputKeyAction::repeat;
      } else if (name == std::optional<std::string_view>{"release"}) {
        event.action = InputKeyAction::release;
      } else {
        return false;
      }
    }
    action.input_events.push_back(std::move(event));
  }
  return true;
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

auto parse_input_key_name(const std::string_view value) noexcept -> std::optional<InputKey> {
  const auto* const found = std::ranges::find(input_key_names, value);
  if (found == input_key_names.end()) {
    return std::nullopt;
  }
  return static_cast<InputKey>(static_cast<std::size_t>(found - input_key_names.begin()));
}

auto input_key_name(const InputKey key) noexcept -> std::string_view {
  const auto index = static_cast<std::size_t>(key);
  return index < input_key_names.size() ? std::span(input_key_names).subspan(index, 1).front()
                                        : std::string_view{};
}

auto wait_condition_name(const WaitCondition condition) noexcept -> std::string_view {
  switch (condition) {
  case WaitCondition::process_exit:
    return "process-exit";
  case WaitCondition::exit_code:
    return "exit-code";
  case WaitCondition::signal:
    return "signal";
  case WaitCondition::contains:
    return "contains";
  case WaitCondition::prompt:
    return "prompt";
  }
  return {};
}

auto action_name(const ActionKind kind) noexcept -> std::string_view {
  switch (kind) {
  case ActionKind::daemon_inspect:
    return "daemon.inspect";
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
  case ActionKind::tab_inspect:
    return "tab.inspect";
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
  case ActionKind::pane_inspect:
    return "pane.inspect";
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
  case ActionKind::pane_input:
    return "pane.input";
  case ActionKind::pane_capture:
    return "pane.capture";
  case ActionKind::pane_wait:
    return "pane.wait";
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

[[nodiscard]] constexpr auto focus_name(const FocusPolicy focus) noexcept -> std::string_view {
  return focus == FocusPolicy::preserve ? std::string_view{"preserve"}
                                        : std::string_view{"created"};
}

[[nodiscard]] constexpr auto capture_source_name(const CaptureSource source) noexcept
    -> std::string_view {
  switch (source) {
  case CaptureSource::visible:
    return "visible";
  case CaptureSource::recent:
    return "recent";
  case CaptureSource::last_command:
    return "last-command";
  }
  return {};
}

auto append_capture(std::string& output, const CaptureSource source, const CaptureFormat format,
                    const CaptureWrap wrap, const std::uint64_t terminal_generation,
                    const bool truncated, const std::string_view text) -> bool {
  try {
    output += R"({"source":)";
    if (!append_json_string(output, capture_source_name(source))) {
      return false;
    }
    output += R"(,"format":)";
    if (!append_json_string(output, format == CaptureFormat::plain ? "plain" : "ansi")) {
      return false;
    }
    output += R"(,"wrap":)";
    if (!append_json_string(output, wrap == CaptureWrap::logical ? "logical" : "rendered")) {
      return false;
    }
    output += R"(,"terminal_generation":)" + std::to_string(terminal_generation) +
              R"(,"truncated":)" + (truncated ? "true" : "false") + R"(,"text":)";
    return append_json_string(output, text) && (output += "}", true);
  } catch (...) {
    return false;
  }
}

[[nodiscard]] constexpr auto input_event_kind_name(const InputEventKind kind) noexcept
    -> std::string_view {
  switch (kind) {
  case InputEventKind::text:
    return "text";
  case InputEventKind::paste:
    return "paste";
  case InputEventKind::key:
    return "key";
  }
  return {};
}

// Branches mirror the closed text, paste, and logical-key event schemas.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto append_input_events(std::string& output,
                                       const std::span<const InputEvent> events) -> bool {
  try {
    output += R"(,"events":[)";
    for (std::size_t index = 0; index < events.size(); ++index) {
      if (index > 0) {
        output += ',';
      }
      const auto& event = events.subspan(index, 1).front();
      output += R"({"kind":)";
      if (!append_json_string(output, input_event_kind_name(event.kind))) {
        return false;
      }
      if (event.kind != InputEventKind::key) {
        if (!append_string_field(output, "text", event.text)) {
          return false;
        }
      } else {
        if (!append_string_field(output, "key", input_key_name(event.key))) {
          return false;
        }
        if (event.modifiers != 0) {
          output += R"(,"modifiers":[)";
          bool separator = false;
          for (const auto [bit, name] :
               std::array{std::pair{input_modifier_shift, std::string_view{"shift"}},
                          std::pair{input_modifier_control, std::string_view{"control"}},
                          std::pair{input_modifier_alt, std::string_view{"alt"}},
                          std::pair{input_modifier_super, std::string_view{"super"}}}) {
            if ((event.modifiers & bit) == 0) {
              continue;
            }
            if (separator) {
              output += ',';
            }
            separator = true;
            if (!append_json_string(output, name)) {
              return false;
            }
          }
          output += ']';
        }
        if (event.action != InputKeyAction::press) {
          if (!append_string_field(output, "action",
                                   event.action == InputKeyAction::repeat
                                       ? std::string_view{"repeat"}
                                       : std::string_view{"release"})) {
            return false;
          }
        }
      }
      output += '}';
    }
    output += ']';
    return true;
  } catch (...) {
    return false;
  }
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto encode_action(const Action& action) -> std::optional<std::string> {
  try {
    std::string output = R"({"schema":"lemma.action/v1","action":)";
    if (!append_json_string(output, action_name(action.kind))) {
      return std::nullopt;
    }
    const bool has_session = action.kind != ActionKind::daemon_inspect &&
                             action.kind != ActionKind::session_list &&
                             action.kind != ActionKind::session_start;
    if (has_session && !append_selector(output, "session", action.session)) {
      return std::nullopt;
    }
    if (action.expected_session_revision.has_value()) {
      if (action.kind == ActionKind::pane_wait) {
        return std::nullopt;
      }
      output += R"(,"if_session_revision":)" + std::to_string(*action.expected_session_revision);
    }
    if (action.kind == ActionKind::session_start && !action.name.empty() &&
        !append_string_field(output, "name", action.name)) {
      return std::nullopt;
    }
    if (action.kind == ActionKind::session_rename &&
        !append_string_field(output, "name", action.name)) {
      return std::nullopt;
    }
    if (action.kind == ActionKind::tab_inspect || action.kind == ActionKind::tab_select ||
        action.kind == ActionKind::tab_move || action.kind == ActionKind::tab_rename ||
        action.kind == ActionKind::tab_kill) {
      if (!append_selector(output, "tab", action.tab)) {
        return std::nullopt;
      }
    }
    if (action.kind == ActionKind::pane_inspect || action.kind == ActionKind::pane_split ||
        action.kind == ActionKind::pane_focus || action.kind == ActionKind::pane_swap ||
        action.kind == ActionKind::pane_resize || action.kind == ActionKind::pane_zoom ||
        action.kind == ActionKind::pane_send || action.kind == ActionKind::pane_input ||
        action.kind == ActionKind::pane_capture || action.kind == ActionKind::pane_wait ||
        action.kind == ActionKind::pane_kill) {
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
    if ((action.kind == ActionKind::tab_new || action.kind == ActionKind::pane_split) &&
        action.focus != FocusPolicy::created &&
        !append_string_field(output, "focus", focus_name(action.focus))) {
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
    if (action.kind == ActionKind::pane_input &&
        !append_input_events(output, action.input_events)) {
      return std::nullopt;
    }
    if (action.kind == ActionKind::pane_capture) {
      if (action.lines > 0) {
        output += R"(,"lines":)" + std::to_string(action.lines);
      }
      if (action.capture_source != CaptureSource::visible &&
          !append_string_field(output, "source", capture_source_name(action.capture_source))) {
        return std::nullopt;
      }
      if (action.capture_format == CaptureFormat::ansi &&
          !append_string_field(output, "format", "ansi")) {
        return std::nullopt;
      }
      if (action.capture_wrap == CaptureWrap::logical &&
          !append_string_field(output, "wrap", "logical")) {
        return std::nullopt;
      }
    }
    if (action.kind == ActionKind::pane_wait) {
      if (action.wait_condition == WaitCondition::exit_code) {
        output += R"(,"exit_code":)" + std::to_string(action.wait_value);
      } else if (action.wait_condition == WaitCondition::signal) {
        output += R"(,"signal":)" + std::to_string(action.wait_value);
      } else if (action.wait_condition == WaitCondition::contains) {
        if (!append_string_field(output, "contains", action.contains)) {
          return std::nullopt;
        }
      } else if (action.wait_condition == WaitCondition::prompt) {
        output += R"(,"until_prompt":true)";
      }
      if (action.after_terminal_generation > 0) {
        output += R"(,"after_generation":)" + std::to_string(action.after_terminal_generation);
      }
      if (action.wait_timeout_milliseconds != wait_timeout_default_milliseconds) {
        output += R"(,"timeout_ms":)" + std::to_string(action.wait_timeout_milliseconds);
      }
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
  if (const auto* const revision = json_member(document, "if_session_revision");
      revision != nullptr) {
    const auto value = json_unsigned(document, "if_session_revision");
    if (!value.has_value() || *value == 0) {
      return failure("invalid_field", "if_session_revision");
    }
    action.expected_session_revision = value;
  }
  const auto reject_unknown = [&](const std::initializer_list<std::string_view> fields)
      -> std::optional<ActionDecodeResult> {
    const auto field = unknown_field(document, fields);
    return field.has_value() ? std::optional{failure("unknown_field", *field)} : std::nullopt;
  };

  if (*name == "daemon.inspect") {
    if (auto rejected = reject_unknown({"schema", "action"}); rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::daemon_inspect;
  } else if (*name == "session.list") {
    if (auto rejected = reject_unknown({"schema", "action"}); rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::session_list;
  } else if (*name == "session.inspect") {
    if (auto rejected = reject_unknown({"schema", "action", "session", "if_session_revision"});
        rejected.has_value()) {
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
    if (auto rejected =
            reject_unknown({"schema", "action", "session", "name", "if_session_revision"});
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
    if (auto rejected = reject_unknown({"schema", "action", "session", "if_session_revision"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::session_kill;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
  } else if (*name == "tab.list" || *name == "pane.list") {
    if (auto rejected = reject_unknown({"schema", "action", "session", "if_session_revision"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = *name == "tab.list" ? ActionKind::tab_list : ActionKind::pane_list;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
  } else if (*name == "tab.inspect") {
    if (auto rejected =
            reject_unknown({"schema", "action", "session", "tab", "if_session_revision"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::tab_inspect;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (auto invalid = require_tab(document, action); invalid.has_value()) {
      return *invalid;
    }
  } else if (*name == "pane.inspect") {
    if (auto rejected =
            reject_unknown({"schema", "action", "session", "pane", "if_session_revision"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::pane_inspect;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (auto invalid = require_pane(document, action); invalid.has_value()) {
      return *invalid;
    }
  } else if (*name == "tab.new") {
    if (auto rejected = reject_unknown({"schema", "action", "session", "title", "cwd", "hold",
                                        "argv", "focus", "if_session_revision"});
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
    if (!decode_focus_policy(document, action)) {
      return failure("invalid_field", "focus");
    }
  } else if (*name == "tab.select" || *name == "tab.kill") {
    if (auto rejected =
            reject_unknown({"schema", "action", "session", "tab", "if_session_revision"});
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
    if (auto rejected = reject_unknown(
            {"schema", "action", "session", "tab", "to_position", "if_session_revision"});
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
    if (auto rejected =
            reject_unknown({"schema", "action", "session", "tab", "title", "if_session_revision"});
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
    if (auto rejected = reject_unknown({"schema", "action", "session", "pane", "direction", "cwd",
                                        "hold", "argv", "focus", "if_session_revision"});
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
    if (!decode_focus_policy(document, action)) {
      return failure("invalid_field", "focus");
    }
  } else if (*name == "pane.focus" || *name == "pane.kill") {
    if (auto rejected =
            reject_unknown({"schema", "action", "session", "pane", "if_session_revision"});
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
    if (auto rejected =
            reject_unknown({"schema", "action", "session", "pane", "other", "if_session_revision"});
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
    if (auto rejected = reject_unknown(
            {"schema", "action", "session", "pane", "direction", "amount", "if_session_revision"});
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
    if (auto rejected = reject_unknown(
            {"schema", "action", "session", "pane", "enabled", "if_session_revision"});
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
    if (auto rejected =
            reject_unknown({"schema", "action", "session", "pane", "text", "if_session_revision"});
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
  } else if (*name == "pane.input") {
    if (auto rejected = reject_unknown(
            {"schema", "action", "session", "pane", "events", "if_session_revision"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::pane_input;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (auto invalid = require_pane(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (!decode_input_events(document, action)) {
      return failure("invalid_field", "events");
    }
  } else if (*name == "pane.capture") {
    if (auto rejected = reject_unknown({"schema", "action", "session", "pane", "lines", "source",
                                        "format", "wrap", "if_session_revision"});
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
    const auto source_value = json_string(document, "source");
    if (json_member(document, "source") != nullptr && !source_value.has_value()) {
      return failure("invalid_field", "source");
    }
    const auto source = source_value.value_or("visible");
    if (source == "visible") {
      action.capture_source = CaptureSource::visible;
    } else if (source == "recent") {
      action.capture_source = CaptureSource::recent;
    } else if (source == "last-command") {
      action.capture_source = CaptureSource::last_command;
    } else {
      return failure("invalid_field", "source");
    }
    const auto format_value = json_string(document, "format");
    if (json_member(document, "format") != nullptr && !format_value.has_value()) {
      return failure("invalid_field", "format");
    }
    const auto format = format_value.value_or("plain");
    if (format == "plain") {
      action.capture_format = CaptureFormat::plain;
    } else if (format == "ansi") {
      action.capture_format = CaptureFormat::ansi;
    } else {
      return failure("invalid_field", "format");
    }
    const auto wrap_value = json_string(document, "wrap");
    if (json_member(document, "wrap") != nullptr && !wrap_value.has_value()) {
      return failure("invalid_field", "wrap");
    }
    const auto wrap = wrap_value.value_or("rendered");
    if (wrap == "rendered") {
      action.capture_wrap = CaptureWrap::rendered;
    } else if (wrap == "logical") {
      action.capture_wrap = CaptureWrap::logical;
    } else {
      return failure("invalid_field", "wrap");
    }
    if (action.capture_source == CaptureSource::last_command && action.lines > 0) {
      return failure("invalid_field", "lines");
    }
  } else if (*name == "pane.wait") {
    if (auto rejected =
            reject_unknown({"schema", "action", "session", "pane", "exit_code", "signal",
                            "contains", "until_prompt", "after_generation", "timeout_ms"});
        rejected.has_value()) {
      return *rejected;
    }
    action.kind = ActionKind::pane_wait;
    if (auto invalid = require_session(document, action); invalid.has_value()) {
      return *invalid;
    }
    if (auto invalid = require_pane(document, action); invalid.has_value()) {
      return *invalid;
    }
    std::size_t condition_count = 0;
    if (const auto* const exit_code = json_member(document, "exit_code"); exit_code != nullptr) {
      const auto value = json_unsigned(document, "exit_code");
      if (!value.has_value() || *value > 255U) {
        return failure("invalid_field", "exit_code");
      }
      action.wait_condition = WaitCondition::exit_code;
      action.wait_value = static_cast<std::uint32_t>(*value);
      ++condition_count;
    }
    if (const auto* const signal = json_member(document, "signal"); signal != nullptr) {
      const auto value = json_unsigned(document, "signal");
      if (!value.has_value() || *value == 0 || *value > 127U) {
        return failure("invalid_field", "signal");
      }
      action.wait_condition = WaitCondition::signal;
      action.wait_value = static_cast<std::uint32_t>(*value);
      ++condition_count;
    }
    if (const auto* const contains = json_member(document, "contains"); contains != nullptr) {
      const auto value = json_string(document, "contains");
      if (!value.has_value() || value->empty() || value->contains('\0') ||
          value->size() > std::numeric_limits<std::uint16_t>::max()) {
        return failure("invalid_field", "contains");
      }
      action.wait_condition = WaitCondition::contains;
      action.contains = *value;
      ++condition_count;
    }
    if (const auto* const prompt = json_member(document, "until_prompt"); prompt != nullptr) {
      const auto value = json_boolean(document, "until_prompt");
      if (value != std::optional{true}) {
        return failure("invalid_field", "until_prompt");
      }
      action.wait_condition = WaitCondition::prompt;
      ++condition_count;
    }
    if (condition_count > 1U) {
      return failure("conflicting_fields", "condition");
    }
    if (const auto* const generation = json_member(document, "after_generation");
        generation != nullptr) {
      const auto value = json_unsigned(document, "after_generation");
      if (!value.has_value() || (action.wait_condition != WaitCondition::contains &&
                                 action.wait_condition != WaitCondition::prompt)) {
        return failure("invalid_field", "after_generation");
      }
      action.after_terminal_generation = *value;
    }
    if (const auto* const timeout = json_member(document, "timeout_ms"); timeout != nullptr) {
      const auto value = json_unsigned(document, "timeout_ms");
      if (!value.has_value() || *value == 0 || *value > wait_timeout_max_milliseconds) {
        return failure("invalid_field", "timeout_ms");
      }
      action.wait_timeout_milliseconds = static_cast<std::uint32_t>(*value);
    }
  } else {
    return failure("unknown_action", "action");
  }
  return {.action = std::move(action), .error = {}};
}

// Legacy one-Pane and bounded multi-Pane selectors share one closed subscription grammar.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto decode_event_subscription(const JsonValue& document) -> EventSubscriptionDecodeResult {
  if (document.kind != JsonKind::object) {
    return {.subscription = std::nullopt, .error = {.reason = "invalid_document", .field = {}}};
  }
  if (json_string(document, "schema") != std::optional<std::string_view>{events_schema}) {
    return {.subscription = std::nullopt, .error = {.reason = "invalid_schema", .field = "schema"}};
  }
  if (const auto field = unknown_field(document, {"schema", "session", "pane", "panes", "screen"});
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
  const bool has_pane = json_member(document, "pane") != nullptr;
  const auto* const panes = json_member(document, "panes");
  if (has_pane && panes != nullptr) {
    return {.subscription = std::nullopt,
            .error = {.reason = "conflicting_fields", .field = "panes"}};
  }
  if (has_pane) {
    const auto pane = decode_pane_selector(document, "pane");
    if (!pane.has_value() || !result.session.has_value()) {
      return {.subscription = std::nullopt,
              .error = {.reason = "invalid_selector", .field = "pane"}};
    }
    result.panes.push_back(*pane);
  } else if (panes != nullptr) {
    if (panes->kind != JsonKind::array || panes->array.empty() ||
        panes->array.size() > event_panes_max || !result.session.has_value()) {
      return {.subscription = std::nullopt,
              .error = {.reason = "invalid_selector", .field = "panes"}};
    }
    for (const auto& candidate : panes->array) {
      JsonValue wrapper{.kind = JsonKind::object,
                        .boolean = false,
                        .number = 0,
                        .string = {},
                        .array = {},
                        .object = {}};
      wrapper.object.push_back({.key = "pane", .value = candidate});
      const auto pane = decode_pane_selector(wrapper, "pane");
      if (!pane.has_value() || std::ranges::any_of(result.panes, [&](const PaneSelector& existing) {
            return existing.id == pane->id;
          })) {
        return {.subscription = std::nullopt,
                .error = {.reason = "invalid_selector", .field = "panes"}};
      }
      result.panes.push_back(*pane);
    }
  }
  if (const auto* const screen = json_member(document, "screen"); screen != nullptr) {
    if (screen->kind != JsonKind::boolean) {
      return {.subscription = std::nullopt,
              .error = {.reason = "invalid_field", .field = "screen"}};
    }
    result.screen = screen->boolean;
  }
  if (result.screen && result.panes.empty()) {
    return {.subscription = std::nullopt, .error = {.reason = "invalid_selector", .field = "pane"}};
  }
  return {.subscription = std::move(result), .error = {}};
}

} // namespace lemma::api
