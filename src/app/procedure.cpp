#include "app/procedure.hpp"

#include "daemon/server.hpp"
#include "lemma/command.hpp"
#include "lemma/id.hpp"
#include "lemma/limits.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <initializer_list>
#include <iostream>
#include <limits>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace lemma::app {
namespace {

constexpr std::size_t procedure_bytes_max = std::size_t{1} * 1'024U * 1'024U;
constexpr std::size_t procedure_actions_max = 64;
constexpr std::size_t json_nodes_max = 4'096;
constexpr std::size_t json_depth_max = 32;
constexpr std::size_t procedure_id_bytes_max = 32;
constexpr auto wait_timeout_default = std::chrono::milliseconds(30'000);
constexpr auto wait_timeout_max = std::chrono::minutes(10);

enum class JsonKind : std::uint8_t {
  null,
  boolean,
  number,
  string,
  array,
  object,
};

struct JsonMember;

struct JsonValue final {
  JsonKind kind{JsonKind::null};
  bool boolean{false};
  std::int64_t number{0};
  std::string string;
  std::vector<JsonValue> array;
  std::vector<JsonMember> object;
};

// Keep recursive object entries behind vector's incomplete-element support. Instantiating
// pair<string, JsonValue> inside JsonValue requires the still-incomplete JsonValue on libstdc++.
struct JsonMember final {
  std::string key;
  JsonValue value;
};

// UTF-8 validation rejects overlong, surrogate, truncated, and out-of-range scalar values.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto valid_utf8(const std::string_view value) -> bool {
  std::size_t offset = 0;
  while (offset < value.size()) {
    const auto leading = static_cast<unsigned char>(value.substr(offset, 1).front());
    if (leading <= 0x7fU) {
      ++offset;
      continue;
    }
    std::size_t continuation_count = 0;
    std::uint32_t codepoint = 0;
    std::uint32_t minimum = 0;
    if (leading >= 0xc2U && leading <= 0xdfU) {
      continuation_count = 1;
      codepoint = leading & 0x1fU;
      minimum = 0x80U;
    } else if (leading >= 0xe0U && leading <= 0xefU) {
      continuation_count = 2;
      codepoint = leading & 0x0fU;
      minimum = 0x800U;
    } else if (leading >= 0xf0U && leading <= 0xf4U) {
      continuation_count = 3;
      codepoint = leading & 0x07U;
      minimum = 0x10000U;
    } else {
      return false;
    }
    if (continuation_count > value.size() - offset - 1U) {
      return false;
    }
    for (std::size_t index = 1; index <= continuation_count; ++index) {
      const auto byte = static_cast<unsigned char>(value.substr(offset + index, 1).front());
      if ((byte & 0xc0U) != 0x80U) {
        return false;
      }
      codepoint = (codepoint << 6U) | (byte & 0x3fU);
    }
    if (codepoint < minimum || codepoint > 0x10ffffU ||
        (codepoint >= 0xd800U && codepoint <= 0xdfffU)) {
      return false;
    }
    offset += continuation_count + 1U;
  }
  return true;
}

[[nodiscard]] auto append_utf8(std::string& output, const std::uint32_t codepoint) -> bool {
  if (codepoint <= 0x7fU) {
    output.push_back(static_cast<char>(codepoint));
  } else if (codepoint <= 0x7ffU) {
    output.push_back(static_cast<char>(0xc0U | (codepoint >> 6U)));
    output.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
  } else if (codepoint <= 0xffffU) {
    if (codepoint >= 0xd800U && codepoint <= 0xdfffU) {
      return false;
    }
    output.push_back(static_cast<char>(0xe0U | (codepoint >> 12U)));
    output.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3fU)));
    output.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
  } else if (codepoint <= 0x10ffffU) {
    output.push_back(static_cast<char>(0xf0U | (codepoint >> 18U)));
    output.push_back(static_cast<char>(0x80U | ((codepoint >> 12U) & 0x3fU)));
    output.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3fU)));
    output.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
  } else {
    return false;
  }
  return true;
}

class JsonParser final {
public:
  explicit JsonParser(const std::string_view input) noexcept : input_(input) {}

  [[nodiscard]] auto parse() -> std::optional<JsonValue> {
    auto result = parse_value(0);
    skip_whitespace();
    return result.has_value() && offset_ == input_.size() ? std::move(result) : std::nullopt;
  }

  [[nodiscard]] auto error_offset() const noexcept -> std::size_t { return offset_; }

private:
  void skip_whitespace() {
    while (offset_ < input_.size()) {
      const auto character = input_.substr(offset_, 1).front();
      if (character != ' ' && character != '\t' && character != '\r' && character != '\n') {
        break;
      }
      ++offset_;
    }
  }

  [[nodiscard]] auto consume(const char character) -> bool {
    skip_whitespace();
    if (offset_ >= input_.size() || input_.substr(offset_, 1).front() != character) {
      return false;
    }
    ++offset_;
    return true;
  }

  [[nodiscard]] auto consume_literal(const std::string_view literal) -> bool {
    if (literal.size() > input_.size() - offset_ ||
        input_.substr(offset_, literal.size()) != literal) {
      return false;
    }
    offset_ += literal.size();
    return true;
  }

  [[nodiscard]] auto hex_quad() -> std::optional<std::uint32_t> {
    if (4U > input_.size() - offset_) {
      return std::nullopt;
    }
    std::uint32_t value = 0;
    for (const char character : input_.substr(offset_, 4)) {
      value <<= 4U;
      if (character >= '0' && character <= '9') {
        value |= static_cast<std::uint32_t>(character - '0');
      } else if (character >= 'a' && character <= 'f') {
        value |= static_cast<std::uint32_t>(character - 'a' + 10);
      } else if (character >= 'A' && character <= 'F') {
        value |= static_cast<std::uint32_t>(character - 'A' + 10);
      } else {
        return std::nullopt;
      }
    }
    offset_ += 4U;
    return value;
  }

  // JSON escape handling is complete even though the procedure schema currently uses ASCII keys.
  // NOLINTNEXTLINE(readability-function-cognitive-complexity)
  [[nodiscard]] auto parse_string() -> std::optional<std::string> {
    skip_whitespace();
    if (offset_ >= input_.size() || input_.substr(offset_, 1).front() != '"') {
      return std::nullopt;
    }
    ++offset_;
    std::string output;
    while (offset_ < input_.size()) {
      const auto character = static_cast<unsigned char>(input_.substr(offset_++, 1).front());
      if (character == '"') {
        return valid_utf8(output) ? std::optional{std::move(output)} : std::nullopt;
      }
      if (character < 0x20U) {
        return std::nullopt;
      }
      if (character != '\\') {
        output.push_back(static_cast<char>(character));
        continue;
      }
      if (offset_ >= input_.size()) {
        return std::nullopt;
      }
      const auto escaped = input_.substr(offset_++, 1).front();
      switch (escaped) {
      case '"':
      case '\\':
      case '/':
        output.push_back(escaped);
        break;
      case 'b':
        output.push_back('\b');
        break;
      case 'f':
        output.push_back('\f');
        break;
      case 'n':
        output.push_back('\n');
        break;
      case 'r':
        output.push_back('\r');
        break;
      case 't':
        output.push_back('\t');
        break;
      case 'u': {
        auto codepoint = hex_quad();
        if (!codepoint.has_value()) {
          return std::nullopt;
        }
        if (*codepoint >= 0xd800U && *codepoint <= 0xdbffU) {
          if (!consume_literal("\\u")) {
            return std::nullopt;
          }
          const auto low = hex_quad();
          if (!low.has_value() || *low < 0xdc00U || *low > 0xdfffU) {
            return std::nullopt;
          }
          codepoint = 0x10000U + ((*codepoint - 0xd800U) << 10U) + (*low - 0xdc00U);
        }
        if (!append_utf8(output, *codepoint)) {
          return std::nullopt;
        }
        break;
      }
      default:
        return std::nullopt;
      }
    }
    return std::nullopt;
  }

  [[nodiscard]] auto parse_number() -> std::optional<std::int64_t> {
    const auto start = offset_;
    if (offset_ < input_.size() && input_.substr(offset_, 1).front() == '-') {
      ++offset_;
    }
    const auto digits = offset_;
    while (offset_ < input_.size()) {
      const auto character = input_.substr(offset_, 1).front();
      if (character < '0' || character > '9') {
        break;
      }
      ++offset_;
    }
    if (digits == offset_ || (offset_ - digits > 1U && input_.substr(digits, 1).front() == '0')) {
      return std::nullopt;
    }
    std::int64_t value = 0;
    const auto token = input_.substr(start, offset_ - start);
    const auto parsed = std::from_chars(token.begin(), token.end(), value);
    return parsed.ec == std::errc{} && parsed.ptr == token.end() ? std::optional{value}
                                                                 : std::nullopt;
  }

  [[nodiscard]] auto parse_array(const std::size_t depth) -> std::optional<JsonValue> {
    JsonValue result{.kind = JsonKind::array,
                     .boolean = false,
                     .number = 0,
                     .string = {},
                     .array = {},
                     .object = {}};
    if (consume(']')) {
      return result;
    }
    while (true) {
      auto value = parse_value(depth + 1U);
      if (!value.has_value()) {
        return std::nullopt;
      }
      result.array.push_back(std::move(*value));
      if (consume(']')) {
        return result;
      }
      if (!consume(',')) {
        return std::nullopt;
      }
    }
  }

  [[nodiscard]] auto parse_object(const std::size_t depth) -> std::optional<JsonValue> {
    JsonValue result{.kind = JsonKind::object,
                     .boolean = false,
                     .number = 0,
                     .string = {},
                     .array = {},
                     .object = {}};
    if (consume('}')) {
      return result;
    }
    while (true) {
      auto key = parse_string();
      if (!key.has_value() || !consume(':') ||
          std::ranges::any_of(result.object,
                              [&](const JsonMember& entry) { return entry.key == *key; })) {
        return std::nullopt;
      }
      auto value = parse_value(depth + 1U);
      if (!value.has_value()) {
        return std::nullopt;
      }
      result.object.push_back(JsonMember{.key = std::move(*key), .value = std::move(*value)});
      if (consume('}')) {
        return result;
      }
      if (!consume(',')) {
        return std::nullopt;
      }
    }
  }

  // JSON value alternatives are explicit and bounded by depth and node count.
  // NOLINTNEXTLINE(readability-function-cognitive-complexity)
  [[nodiscard]] auto parse_value(const std::size_t depth) -> std::optional<JsonValue> {
    skip_whitespace();
    if (depth > json_depth_max || offset_ >= input_.size() || ++nodes_ > json_nodes_max) {
      return std::nullopt;
    }
    const auto character = input_.substr(offset_, 1).front();
    if (character == '"') {
      auto string = parse_string();
      return string.has_value() ? std::optional{JsonValue{.kind = JsonKind::string,
                                                          .boolean = false,
                                                          .number = 0,
                                                          .string = std::move(*string),
                                                          .array = {},
                                                          .object = {}}}
                                : std::nullopt;
    }
    if (character == '[') {
      ++offset_;
      return parse_array(depth);
    }
    if (character == '{') {
      ++offset_;
      return parse_object(depth);
    }
    if (character == 't' && consume_literal("true")) {
      return JsonValue{.kind = JsonKind::boolean,
                       .boolean = true,
                       .number = 0,
                       .string = {},
                       .array = {},
                       .object = {}};
    }
    if (character == 'f' && consume_literal("false")) {
      return JsonValue{.kind = JsonKind::boolean,
                       .boolean = false,
                       .number = 0,
                       .string = {},
                       .array = {},
                       .object = {}};
    }
    if (character == 'n' && consume_literal("null")) {
      return JsonValue{};
    }
    if (character == '-' || (character >= '0' && character <= '9')) {
      const auto number = parse_number();
      return number.has_value() ? std::optional{JsonValue{.kind = JsonKind::number,
                                                          .boolean = false,
                                                          .number = *number,
                                                          .string = {},
                                                          .array = {},
                                                          .object = {}}}
                                : std::nullopt;
    }
    return std::nullopt;
  }

  std::string_view input_;
  std::size_t offset_{0};
  std::size_t nodes_{0};
};

[[nodiscard]] auto member(const JsonValue& object, const std::string_view key) noexcept
    -> const JsonValue* {
  if (object.kind != JsonKind::object) {
    return nullptr;
  }
  const auto found = std::ranges::find_if(
      object.object, [&](const JsonMember& entry) { return entry.key == key; });
  return found == object.object.end() ? nullptr : &found->value;
}

[[nodiscard]] auto string_member(const JsonValue& object, const std::string_view key) noexcept
    -> std::optional<std::string_view> {
  const auto* const value = member(object, key);
  return value != nullptr && value->kind == JsonKind::string
             ? std::optional{std::string_view(value->string)}
             : std::nullopt;
}

[[nodiscard]] auto bool_member(const JsonValue& object, const std::string_view key,
                               const bool fallback) noexcept -> std::optional<bool> {
  const auto* const value = member(object, key);
  if (value == nullptr) {
    return fallback;
  }
  return value->kind == JsonKind::boolean ? std::optional{value->boolean} : std::nullopt;
}

[[nodiscard]] auto unsigned_member(const JsonValue& object, const std::string_view key,
                                   const std::uint64_t fallback) noexcept
    -> std::optional<std::uint64_t> {
  const auto* const value = member(object, key);
  if (value == nullptr) {
    return fallback;
  }
  return value->kind == JsonKind::number && value->number >= 0
             ? std::optional{static_cast<std::uint64_t>(value->number)}
             : std::nullopt;
}

struct ParsedProcessExpectation final {
  bool valid{true};
  std::optional<daemon::ProcessExpectation> value;
};

[[nodiscard]] auto process_expectation(const JsonValue& action) noexcept
    -> ParsedProcessExpectation {
  const auto* const exit = member(action, "exit");
  if (exit == nullptr) {
    return {};
  }
  if (exit->kind == JsonKind::boolean) {
    return exit->boolean
               ? ParsedProcessExpectation{.valid = true, .value = daemon::ProcessExpectation{}}
               : ParsedProcessExpectation{.valid = false, .value = std::nullopt};
  }
  if (exit->kind != JsonKind::object || exit->object.size() != 1U) {
    return {.valid = false, .value = std::nullopt};
  }
  const auto& [key, expected] = exit->object.front();
  if (expected.kind != JsonKind::number || expected.number < 0) {
    return {.valid = false, .value = std::nullopt};
  }
  const auto value = static_cast<std::uint64_t>(expected.number);
  if (key == "code" && value <= 255U) {
    return {.valid = true,
            .value = daemon::ProcessExpectation{.kind = daemon::ProcessExpectationKind::exit_code,
                                                .value = static_cast<std::uint32_t>(value)}};
  }
  if (key == "signal" && value > 0 && value <= 127U) {
    return {.valid = true,
            .value = daemon::ProcessExpectation{.kind = daemon::ProcessExpectationKind::signal,
                                                .value = static_cast<std::uint32_t>(value)}};
  }
  return {.valid = false, .value = std::nullopt};
}

template <typename Id>
[[nodiscard]] auto parse_id(const std::string_view value) -> std::optional<Id> {
  const auto separator = value.find(':');
  if (separator == std::string_view::npos || separator == 0 || separator + 1U == value.size()) {
    return std::nullopt;
  }
  const auto slot_text = value.substr(0, separator);
  const auto generation_text = value.substr(separator + 1U);
  std::uint32_t slot = 0;
  std::uint32_t generation = 0;
  const auto slot_result = std::from_chars(slot_text.begin(), slot_text.end(), slot);
  const auto generation_result =
      std::from_chars(generation_text.begin(), generation_text.end(), generation);
  return slot_result.ec == std::errc{} && slot_result.ptr == slot_text.end() &&
                 generation_result.ec == std::errc{} &&
                 generation_result.ptr == generation_text.end()
             ? Id::try_from_parts(slot, generation)
             : std::nullopt;
}

enum class QueryArrayKind : std::uint8_t {
  none,
  sessions,
  tabs,
  panes,
};

struct ProcedureResult final {
  std::string id;
  std::string action;
  daemon::OperationStatus status{daemon::OperationStatus::failed};
  std::string session;
  std::string reference_session;
  std::string previous_session;
  std::string text;
  TabId tab;
  PaneId pane;
  std::optional<daemon::PaneStatus> process;
  QueryArrayKind query_array{QueryArrayKind::none};
  bool has_text{false};
};

[[nodiscard]] auto result_by_id(const std::span<const ProcedureResult> results,
                                const std::string_view id) noexcept -> const ProcedureResult* {
  const auto found =
      std::ranges::find_if(results, [&](const ProcedureResult& result) { return result.id == id; });
  return found == results.end() ? nullptr : &*found;
}

[[nodiscard]] auto valid_procedure_id(const std::string_view id) noexcept -> bool {
  return !id.empty() && id.size() <= procedure_id_bytes_max &&
         std::ranges::all_of(id, [](const char character) {
           return (character >= 'a' && character <= 'z') ||
                  (character >= 'A' && character <= 'Z') ||
                  (character >= '0' && character <= '9') || character == '_' || character == '-';
         });
}

[[nodiscard]] auto resolve_session(const JsonValue& action,
                                   const std::span<const ProcedureResult> results)
    -> std::optional<std::string> {
  const auto* const selector = member(action, "session");
  if (selector == nullptr) {
    return std::nullopt;
  }
  if (selector->kind == JsonKind::string) {
    return selector->string;
  }
  if (selector->kind != JsonKind::object) {
    return std::nullopt;
  }
  if (const auto name = string_member(*selector, "name"); name.has_value()) {
    return std::string(*name);
  }
  const auto reference = string_member(*selector, "result");
  const auto field = string_member(*selector, "field");
  const auto* const result = reference.has_value() ? result_by_id(results, *reference) : nullptr;
  return result != nullptr && (!field.has_value() || *field == "session") &&
                 !result->reference_session.empty()
             ? std::optional{result->reference_session}
             : std::nullopt;
}

struct ResolvedPane final {
  std::string session;
  PaneId pane;
};

[[nodiscard]] auto resolve_pane(const JsonValue& action, const std::string_view key,
                                const std::span<const ProcedureResult> results)
    -> std::optional<ResolvedPane> {
  const auto* const selector = member(action, key);
  if (selector == nullptr || selector->kind != JsonKind::object) {
    return std::nullopt;
  }
  if (const auto encoded = string_member(*selector, "id"); encoded.has_value()) {
    const auto id = parse_id<PaneId>(*encoded);
    const auto session = resolve_session(action, results);
    return id.has_value() && session.has_value()
               ? std::optional{ResolvedPane{.session = *session, .pane = *id}}
               : std::nullopt;
  }
  const auto reference = string_member(*selector, "result");
  const auto field = string_member(*selector, "field");
  const auto* const result = reference.has_value() ? result_by_id(results, *reference) : nullptr;
  return result != nullptr && (!field.has_value() || *field == "pane") &&
                 !result->reference_session.empty() && result->pane.is_valid()
             ? std::optional{ResolvedPane{.session = result->reference_session,
                                          .pane = result->pane}}
             : std::nullopt;
}

struct ResolvedTab final {
  std::string session;
  TabId tab;
  std::uint16_t position{0};
};

[[nodiscard]] auto resolve_tab(const JsonValue& action,
                               const std::span<const ProcedureResult> results)
    -> std::optional<ResolvedTab> {
  const auto* const selector = member(action, "tab");
  if (selector == nullptr || selector->kind != JsonKind::object) {
    return std::nullopt;
  }
  if (const auto position = unsigned_member(*selector, "position", 0);
      position.has_value() && *position > 0 && *position <= command_tab_slots_max) {
    const auto session = resolve_session(action, results);
    return session.has_value()
               ? std::optional{ResolvedTab{.session = *session,
                                           .tab = {},
                                           .position = static_cast<std::uint16_t>(*position)}}
               : std::nullopt;
  }
  if (const auto encoded = string_member(*selector, "id"); encoded.has_value()) {
    const auto id = parse_id<TabId>(*encoded);
    const auto session = resolve_session(action, results);
    return id.has_value() && session.has_value()
               ? std::optional{ResolvedTab{.session = *session, .tab = *id, .position = 0}}
               : std::nullopt;
  }
  const auto reference = string_member(*selector, "result");
  const auto field = string_member(*selector, "field");
  const auto* const result = reference.has_value() ? result_by_id(results, *reference) : nullptr;
  return result != nullptr && (!field.has_value() || *field == "tab") &&
                 !result->reference_session.empty() && result->tab.is_valid()
             ? std::optional{ResolvedTab{
                   .session = result->reference_session, .tab = result->tab, .position = 0}}
             : std::nullopt;
}

[[nodiscard]] constexpr auto
action_target(const TabId tab = {}, const PaneId pane = {}, const PaneId peer = {},
              const std::uint16_t tab_position = 0, const std::uint16_t value = 0) noexcept
    -> daemon::ActionTarget {
  return {
      .tab = tab, .pane = pane, .peer_pane = peer, .tab_position = tab_position, .value = value};
}

[[nodiscard]] auto launch_argv(const JsonValue& action, std::vector<std::string_view>& output)
    -> bool {
  const auto* const argv = member(action, "argv");
  if (argv == nullptr) {
    return true;
  }
  if (argv->kind != JsonKind::array || argv->array.empty() ||
      argv->array.size() > limits::command_arguments_hard_max) {
    return false;
  }
  output.reserve(argv->array.size());
  for (const auto& argument : argv->array) {
    if (argument.kind != JsonKind::string) {
      return false;
    }
    output.emplace_back(argument.string);
  }
  return !output.front().empty();
}

struct ValidationFailure final {
  std::size_t action_index{0};
  std::string_view reason;
  std::string_view field;
};

struct ResultShape final {
  std::string_view id;
  bool session{false};
  bool tab{false};
  bool pane{false};
};

[[nodiscard]] auto unknown_field(const JsonValue& object,
                                 const std::initializer_list<std::string_view> allowed) noexcept
    -> std::optional<std::string_view> {
  for (const auto& [key, value] : object.object) {
    static_cast<void>(value);
    if (std::ranges::find(allowed, std::string_view(key)) == allowed.end()) {
      return key;
    }
  }
  return std::nullopt;
}

[[nodiscard]] auto valid_session_name(const std::string_view value) noexcept -> bool {
  return SessionNameValue::create(value).has_value();
}

[[nodiscard]] auto valid_title(const std::string_view value) noexcept -> bool {
  return TabTitleValue::create(value).has_value();
}

[[nodiscard]] auto shape_by_id(const std::span<const ResultShape> shapes,
                               const std::string_view id) noexcept -> const ResultShape* {
  const auto found =
      std::ranges::find_if(shapes, [&](const ResultShape& shape) { return shape.id == id; });
  return found == shapes.end() ? nullptr : &*found;
}

[[nodiscard]] auto valid_session_selector(const JsonValue& action,
                                          const std::span<const ResultShape> shapes) noexcept
    -> bool {
  const auto* const selector = member(action, "session");
  if (selector == nullptr || selector->kind != JsonKind::object ||
      unknown_field(*selector, {"name", "result", "field"}).has_value()) {
    return false;
  }
  const auto name = string_member(*selector, "name");
  const auto reference = string_member(*selector, "result");
  const auto field = string_member(*selector, "field");
  if (name.has_value() == reference.has_value()) {
    return false;
  }
  if (name.has_value()) {
    return !field.has_value() && valid_session_name(*name) && selector->object.size() == 1U;
  }
  if (!reference.has_value()) {
    return false;
  }
  const auto* const shape = shape_by_id(shapes, *reference);
  return shape != nullptr && shape->session && (!field.has_value() || *field == "session") &&
         selector->object.size() == (field.has_value() ? 2U : 1U);
}

[[nodiscard]] auto valid_pane_selector(const JsonValue& action, const std::string_view key,
                                       const std::span<const ResultShape> shapes) -> bool {
  const auto* const selector = member(action, key);
  if (selector == nullptr || selector->kind != JsonKind::object ||
      unknown_field(*selector, {"id", "result", "field"}).has_value()) {
    return false;
  }
  const auto encoded = string_member(*selector, "id");
  const auto reference = string_member(*selector, "result");
  const auto field = string_member(*selector, "field");
  if (encoded.has_value() == reference.has_value()) {
    return false;
  }
  if (encoded.has_value()) {
    return !field.has_value() && parse_id<PaneId>(*encoded).has_value() &&
           selector->object.size() == 1U && valid_session_selector(action, shapes);
  }
  if (!reference.has_value()) {
    return false;
  }
  const auto* const shape = shape_by_id(shapes, *reference);
  return shape != nullptr && shape->pane && (!field.has_value() || *field == "pane") &&
         selector->object.size() == (field.has_value() ? 2U : 1U);
}

[[nodiscard]] auto valid_tab_selector(const JsonValue& action,
                                      const std::span<const ResultShape> shapes) -> bool {
  const auto* const selector = member(action, "tab");
  if (selector == nullptr || selector->kind != JsonKind::object ||
      unknown_field(*selector, {"position", "id", "result", "field"}).has_value()) {
    return false;
  }
  const auto* const position_value = member(*selector, "position");
  const auto encoded = string_member(*selector, "id");
  const auto reference = string_member(*selector, "result");
  const auto field = string_member(*selector, "field");
  const auto alternatives = static_cast<unsigned>(position_value != nullptr) +
                            static_cast<unsigned>(encoded.has_value()) +
                            static_cast<unsigned>(reference.has_value());
  if (alternatives != 1U) {
    return false;
  }
  if (position_value != nullptr) {
    const auto position = unsigned_member(*selector, "position", 0);
    return !field.has_value() && position.has_value() && *position > 0 &&
           *position <= command_tab_slots_max && selector->object.size() == 1U &&
           valid_session_selector(action, shapes);
  }
  if (encoded.has_value()) {
    return !field.has_value() && parse_id<TabId>(*encoded).has_value() &&
           selector->object.size() == 1U && valid_session_selector(action, shapes);
  }
  if (!reference.has_value()) {
    return false;
  }
  const auto* const shape = shape_by_id(shapes, *reference);
  return shape != nullptr && shape->tab && (!field.has_value() || *field == "tab") &&
         selector->object.size() == (field.has_value() ? 2U : 1U);
}

[[nodiscard]] auto valid_launch_argv(const JsonValue& action) noexcept -> bool {
  const auto* const argv = member(action, "argv");
  if (argv == nullptr) {
    return true;
  }
  if (argv->kind != JsonKind::array || argv->array.empty() ||
      argv->array.size() > limits::command_arguments_hard_max) {
    return false;
  }
  std::size_t bytes = 0;
  for (const auto& argument : argv->array) {
    if (argument.kind != JsonKind::string || argument.string.contains('\0') ||
        (bytes == 0 && argument.string.empty()) ||
        argument.string.size() + 1U > limits::command_bytes_hard_max - bytes) {
      return false;
    }
    bytes += argument.string.size() + 1U;
  }
  return true;
}

[[nodiscard]] auto invalid_launch_field(const JsonValue& action, const bool allow_title) noexcept
    -> std::optional<std::string_view> {
  if (const auto* const cwd = member(action, "cwd");
      cwd != nullptr &&
      (cwd->kind != JsonKind::string || cwd->string.empty() || cwd->string.contains('\0') ||
       cwd->string.size() > limits::working_directory_bytes_max)) {
    return "cwd";
  }
  if (const auto* const hold = member(action, "hold");
      hold != nullptr && hold->kind != JsonKind::boolean) {
    return "hold";
  }
  if (const auto* const title = member(action, "title"); title != nullptr) {
    if (!allow_title || title->kind != JsonKind::string || !valid_title(title->string)) {
      return "title";
    }
  }
  return valid_launch_argv(action) ? std::nullopt : std::optional<std::string_view>{"argv"};
}

[[nodiscard]] auto validation_failure(const std::size_t index, const std::string_view reason,
                                      const std::string_view field = {}) noexcept
    -> std::optional<ValidationFailure> {
  return ValidationFailure{.action_index = index, .reason = reason, .field = field};
}

// Every action schema is validated, including references and unknown fields, before execution can
// make the first daemon request.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto validate_action(const JsonValue& action, const std::size_t index,
                                   std::vector<ResultShape>& shapes)
    -> std::optional<ValidationFailure> {
  if (action.kind != JsonKind::object) {
    return validation_failure(index, "action_not_object");
  }
  const auto action_name = string_member(action, "action");
  if (!action_name.has_value()) {
    return validation_failure(index, "missing_or_invalid_field", "action");
  }
  const auto reject_unknown = [&](const std::initializer_list<std::string_view> allowed)
      -> std::optional<ValidationFailure> {
    const auto field = unknown_field(action, allowed);
    return field.has_value() ? validation_failure(index, "unknown_field", *field) : std::nullopt;
  };
  const auto require_session = [&]() -> std::optional<ValidationFailure> {
    return valid_session_selector(action, shapes)
               ? std::nullopt
               : validation_failure(index, "invalid_selector", "session");
  };
  const auto require_pane = [&](const std::string_view key) -> std::optional<ValidationFailure> {
    return valid_pane_selector(action, key, shapes)
               ? std::nullopt
               : validation_failure(index, "invalid_selector", key);
  };
  const auto require_tab = [&]() -> std::optional<ValidationFailure> {
    return valid_tab_selector(action, shapes)
               ? std::nullopt
               : validation_failure(index, "invalid_selector", "tab");
  };
  const auto record_creation = [&](const bool session, const bool tab,
                                   const bool pane) -> std::optional<ValidationFailure> {
    const auto* const id = member(action, "id");
    if (id == nullptr) {
      return std::nullopt;
    }
    if (id->kind != JsonKind::string || !valid_procedure_id(id->string) ||
        shape_by_id(shapes, id->string) != nullptr) {
      return validation_failure(index, "invalid_or_duplicate_id", "id");
    }
    shapes.push_back({.id = id->string, .session = session, .tab = tab, .pane = pane});
    return std::nullopt;
  };

  if (*action_name == "session.list") {
    return reject_unknown({"action"});
  }
  if (*action_name == "session.inspect" || *action_name == "tab.list" ||
      *action_name == "pane.list") {
    if (auto failure = reject_unknown({"action", "session"}); failure.has_value()) {
      return failure;
    }
    return require_session();
  }
  if (*action_name == "session.start") {
    if (auto failure = reject_unknown({"action", "id", "name", "cwd", "hold", "argv"});
        failure.has_value()) {
      return failure;
    }
    if (const auto* const name = member(action, "name");
        name != nullptr && (name->kind != JsonKind::string || !valid_session_name(name->string))) {
      return validation_failure(index, "invalid_field", "name");
    }
    if (const auto field = invalid_launch_field(action, false); field.has_value()) {
      return validation_failure(index, "invalid_field", *field);
    }
    return record_creation(true, true, true);
  }
  if (*action_name == "session.rename") {
    if (auto failure = reject_unknown({"action", "session", "name"}); failure.has_value()) {
      return failure;
    }
    const auto name = string_member(action, "name");
    if (!name.has_value() || !valid_session_name(*name)) {
      return validation_failure(index, "invalid_field", "name");
    }
    return require_session();
  }
  if (*action_name == "session.kill") {
    if (auto failure = reject_unknown({"action", "session"}); failure.has_value()) {
      return failure;
    }
    return require_session();
  }
  if (*action_name == "tab.new") {
    if (auto failure = reject_unknown({"action", "id", "session", "title", "cwd", "hold", "argv"});
        failure.has_value()) {
      return failure;
    }
    if (auto failure = require_session(); failure.has_value()) {
      return failure;
    }
    if (const auto field = invalid_launch_field(action, true); field.has_value()) {
      return validation_failure(index, "invalid_field", *field);
    }
    return record_creation(true, true, true);
  }
  if (*action_name == "tab.select" || *action_name == "tab.kill") {
    if (auto failure = reject_unknown({"action", "session", "tab"}); failure.has_value()) {
      return failure;
    }
    return require_tab();
  }
  if (*action_name == "tab.move") {
    if (auto failure = reject_unknown({"action", "session", "tab", "to_position"});
        failure.has_value()) {
      return failure;
    }
    if (auto failure = require_tab(); failure.has_value()) {
      return failure;
    }
    const auto destination = unsigned_member(action, "to_position", 0);
    return destination.has_value() && *destination > 0 && *destination <= command_tab_slots_max
               ? std::nullopt
               : validation_failure(index, "invalid_field", "to_position");
  }
  if (*action_name == "tab.rename") {
    if (auto failure = reject_unknown({"action", "session", "tab", "title"}); failure.has_value()) {
      return failure;
    }
    if (auto failure = require_tab(); failure.has_value()) {
      return failure;
    }
    const auto* const selector = member(action, "tab");
    const auto* const position = selector == nullptr ? nullptr : member(*selector, "position");
    const auto* const title = member(action, "title");
    return position != nullptr && (title == nullptr ||
                                   (title->kind == JsonKind::string && valid_title(title->string)))
               ? std::nullopt
               : validation_failure(index, "invalid_field", position == nullptr ? "tab" : "title");
  }
  if (*action_name == "pane.split") {
    if (auto failure =
            reject_unknown({"action", "id", "session", "pane", "direction", "cwd", "hold", "argv"});
        failure.has_value()) {
      return failure;
    }
    if (auto failure = require_pane("pane"); failure.has_value()) {
      return failure;
    }
    const auto direction = string_member(action, "direction");
    if (!direction.has_value() || (*direction != "right" && *direction != "down")) {
      return validation_failure(index, "invalid_field", "direction");
    }
    if (const auto field = invalid_launch_field(action, false); field.has_value()) {
      return validation_failure(index, "invalid_field", *field);
    }
    return record_creation(true, true, true);
  }
  if (*action_name == "pane.focus" || *action_name == "pane.kill") {
    if (auto failure = reject_unknown({"action", "session", "pane"}); failure.has_value()) {
      return failure;
    }
    return require_pane("pane");
  }
  if (*action_name == "pane.swap") {
    if (auto failure = reject_unknown({"action", "session", "pane", "other"});
        failure.has_value()) {
      return failure;
    }
    if (auto failure = require_pane("pane"); failure.has_value()) {
      return failure;
    }
    return require_pane("other");
  }
  if (*action_name == "pane.resize") {
    if (auto failure = reject_unknown({"action", "session", "pane", "direction", "amount"});
        failure.has_value()) {
      return failure;
    }
    if (auto failure = require_pane("pane"); failure.has_value()) {
      return failure;
    }
    const auto direction = string_member(action, "direction");
    const auto amount = unsigned_member(action, "amount", 1);
    const bool valid_direction =
        direction.has_value() && (*direction == "left" || *direction == "right" ||
                                  *direction == "up" || *direction == "down");
    return valid_direction && amount.has_value() && *amount > 0 && *amount <= 100
               ? std::nullopt
               : validation_failure(index, "invalid_field",
                                    valid_direction ? "amount" : "direction");
  }
  if (*action_name == "pane.zoom") {
    if (auto failure = reject_unknown({"action", "session", "pane", "enabled"});
        failure.has_value()) {
      return failure;
    }
    if (auto failure = require_pane("pane"); failure.has_value()) {
      return failure;
    }
    const auto* const enabled = member(action, "enabled");
    return enabled != nullptr && enabled->kind == JsonKind::boolean
               ? std::nullopt
               : validation_failure(index, "invalid_field", "enabled");
  }
  if (*action_name == "pane.send") {
    if (auto failure = reject_unknown({"action", "session", "pane", "text"}); failure.has_value()) {
      return failure;
    }
    if (auto failure = require_pane("pane"); failure.has_value()) {
      return failure;
    }
    const auto text = string_member(action, "text");
    return text.has_value() && !text->empty() && text->size() <= limits::environment_bytes_max - 8U
               ? std::nullopt
               : validation_failure(index, "invalid_field", "text");
  }
  if (*action_name == "pane.capture") {
    if (auto failure = reject_unknown({"action", "session", "pane", "lines"});
        failure.has_value()) {
      return failure;
    }
    if (auto failure = require_pane("pane"); failure.has_value()) {
      return failure;
    }
    const auto* const lines_value = member(action, "lines");
    const auto lines = unsigned_member(action, "lines", 1);
    return lines_value == nullptr || (lines.has_value() && *lines > 0)
               ? std::nullopt
               : validation_failure(index, "invalid_field", "lines");
  }
  if (*action_name == "pane.wait") {
    if (auto failure =
            reject_unknown({"action", "session", "pane", "contains", "exit", "timeout_ms"});
        failure.has_value()) {
      return failure;
    }
    if (auto failure = require_pane("pane"); failure.has_value()) {
      return failure;
    }
    const auto contains = string_member(action, "contains");
    const auto* const contains_value = member(action, "contains");
    const auto expected = process_expectation(action);
    const auto timeout = unsigned_member(action, "timeout_ms", wait_timeout_default.count());
    const auto maximum = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(wait_timeout_max).count());
    if ((contains_value != nullptr && (!contains.has_value() || contains->empty())) ||
        !expected.valid || expected.value.has_value() == contains.has_value() ||
        !timeout.has_value() || *timeout == 0 || *timeout > maximum) {
      return validation_failure(index, "invalid_wait_condition");
    }
    return std::nullopt;
  }
  return validation_failure(index, "unknown_action", "action");
}

[[nodiscard]] auto validate_actions(const JsonValue& actions) -> std::optional<ValidationFailure> {
  std::vector<ResultShape> shapes;
  shapes.reserve(actions.array.size());
  for (std::size_t index = 0; index < actions.array.size(); ++index) {
    const auto& action = std::span(actions.array).subspan(index, 1).front();
    if (auto failure = validate_action(action, index, shapes); failure.has_value()) {
      return failure;
    }
  }
  return std::nullopt;
}

// Waiting is shared with the one-shot frontend and retains no waiter state in the reactor.
[[nodiscard]] auto execute_wait(const daemon::RuntimeEndpoint& endpoint, const JsonValue& action,
                                const ResolvedPane& target) -> ProcedureResult {
  ProcedureResult result{.id = {},
                         .action = "pane.wait",
                         .status = daemon::OperationStatus::failed,
                         .session = target.session,
                         .reference_session = target.session,
                         .previous_session = {},
                         .text = {},
                         .tab = {},
                         .pane = target.pane,
                         .process = std::nullopt,
                         .query_array = QueryArrayKind::none,
                         .has_text = false};
  const auto contains = string_member(action, "contains");
  const auto expected = process_expectation(action);
  const auto timeout = unsigned_member(action, "timeout_ms", wait_timeout_default.count());
  if (!expected.valid || !timeout.has_value()) {
    return result;
  }
  const auto waited = daemon::wait_pane(endpoint, target.session, target.pane,
                                        {.contains = contains.value_or(std::string_view{}),
                                         .process = expected.value,
                                         .timeout = std::chrono::milliseconds(*timeout)});
  result.status = waited.status;
  result.process = waited.process;
  return result;
}

// Each branch is one public procedure action and delegates to the same daemon client operations as
// the one-shot CLI.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto execute_action(const daemon::RuntimeEndpoint& endpoint, const JsonValue& action,
                                  const std::span<const ProcedureResult> prior) -> ProcedureResult {
  ProcedureResult result;
  const auto action_name = string_member(action, "action");
  if (!action_name.has_value()) {
    return result;
  }
  result.action = *action_name;
  const auto* const id_value = member(action, "id");
  if (id_value != nullptr) {
    if (id_value->kind != JsonKind::string || !valid_procedure_id(id_value->string) ||
        result_by_id(prior, id_value->string) != nullptr) {
      return result;
    }
    result.id = id_value->string;
  }

  if (*action_name == "session.list" || *action_name == "session.inspect" ||
      *action_name == "tab.list" || *action_name == "pane.list") {
    auto kind = daemon::QueryKind::sessions;
    std::optional<std::string> session;
    if (*action_name != "session.list") {
      session = resolve_session(action, prior);
      if (!session.has_value()) {
        return result;
      }
      result.session = *session;
      if (*action_name == "session.inspect") {
        kind = daemon::QueryKind::session;
      } else if (*action_name == "tab.list") {
        kind = daemon::QueryKind::tabs;
      } else {
        kind = daemon::QueryKind::panes;
      }
    }
    const auto query_session =
        session.has_value() ? std::string_view(*session) : std::string_view{};
    auto queried = daemon::query(endpoint, kind, query_session);
    result.status = queried.status;
    result.text = std::move(queried.text);
    if (*action_name == "session.list" || *action_name == "session.inspect") {
      result.query_array = QueryArrayKind::sessions;
    } else if (*action_name == "tab.list") {
      result.query_array = QueryArrayKind::tabs;
    } else {
      result.query_array = QueryArrayKind::panes;
    }
    return result;
  }
  if (*action_name == "session.start") {
    const auto* const name_value = member(action, "name");
    const auto* const cwd_value = member(action, "cwd");
    if ((name_value != nullptr && name_value->kind != JsonKind::string) ||
        (cwd_value != nullptr && cwd_value->kind != JsonKind::string)) {
      return result;
    }
    const auto name = string_member(action, "name");
    const auto cwd = string_member(action, "cwd").value_or(std::string_view{});
    const auto hold = bool_member(action, "hold", false);
    std::vector<std::string_view> argv;
    if (!hold.has_value() || !launch_argv(action, argv)) {
      return result;
    }
    const auto created = daemon::create_detailed(
        endpoint, name, {.working_directory = cwd, .command = argv, .hold = *hold});
    result.status = created.status;
    result.session = created.session;
    result.tab = created.tab;
    result.pane = created.pane;
    return result;
  }
  if (*action_name == "session.kill" || *action_name == "session.rename") {
    const auto session = resolve_session(action, prior);
    if (!session.has_value()) {
      return result;
    }
    result.session = *session;
    if (*action_name == "session.kill") {
      result.status =
          daemon::perform_action(endpoint, *session, daemon::SemanticAction::session_kill, {});
    } else {
      const auto name = string_member(action, "name");
      if (!name.has_value()) {
        return result;
      }
      result.status = daemon::rename_session_status(endpoint, *session, *name);
      if (result.status == daemon::OperationStatus::applied) {
        result.previous_session = result.session;
        result.session = *name;
      }
    }
    return result;
  }
  if (*action_name == "tab.new") {
    const auto* const cwd_value = member(action, "cwd");
    const auto* const title_value = member(action, "title");
    if ((cwd_value != nullptr && cwd_value->kind != JsonKind::string) ||
        (title_value != nullptr && title_value->kind != JsonKind::string)) {
      return result;
    }
    const auto session = resolve_session(action, prior);
    const auto cwd = string_member(action, "cwd").value_or(std::string_view{});
    const auto title = string_member(action, "title").value_or(std::string_view{});
    const auto hold = bool_member(action, "hold", false);
    std::vector<std::string_view> argv;
    if (!session.has_value() || !hold.has_value() || !launch_argv(action, argv)) {
      return result;
    }
    const auto created = daemon::create_surface(
        endpoint, *session, daemon::SurfaceCreateKind::tab, {},
        {.working_directory = cwd, .command = argv, .title = title, .hold = *hold});
    result.status = created.status;
    result.session = created.session;
    result.tab = created.tab;
    result.pane = created.pane;
    return result;
  }
  if (*action_name == "tab.select" || *action_name == "tab.move" || *action_name == "tab.kill" ||
      *action_name == "tab.rename") {
    const auto target = resolve_tab(action, prior);
    if (!target.has_value()) {
      return result;
    }
    result.session = target->session;
    result.tab = target->tab;
    if (*action_name == "tab.rename") {
      const auto* const title_value = member(action, "title");
      if (title_value != nullptr && title_value->kind != JsonKind::string) {
        return result;
      }
      const auto title = string_member(action, "title").value_or(std::string_view{});
      result.status = target->position > 0 ? daemon::rename_tab_status(endpoint, target->session,
                                                                       target->position, title)
                                           : daemon::OperationStatus::failed;
      return result;
    }
    const auto destination = unsigned_member(action, "to_position", 0);
    if (!destination.has_value() || *destination > std::numeric_limits<std::uint16_t>::max()) {
      return result;
    }
    auto semantic = daemon::SemanticAction::tab_select;
    if (*action_name == "tab.move") {
      semantic = daemon::SemanticAction::tab_move;
    } else if (*action_name == "tab.kill") {
      semantic = daemon::SemanticAction::tab_kill;
    }
    result.status = daemon::perform_action(endpoint, target->session, semantic,
                                           action_target(target->tab, {}, {}, target->position,
                                                         static_cast<std::uint16_t>(*destination)));
    return result;
  }
  if (*action_name == "pane.split") {
    const auto* const direction_value = member(action, "direction");
    const auto* const cwd_value = member(action, "cwd");
    if ((direction_value != nullptr && direction_value->kind != JsonKind::string) ||
        (cwd_value != nullptr && cwd_value->kind != JsonKind::string)) {
      return result;
    }
    const auto target = resolve_pane(action, "pane", prior);
    const auto direction = string_member(action, "direction");
    const auto cwd = string_member(action, "cwd").value_or(std::string_view{});
    const auto hold = bool_member(action, "hold", false);
    std::vector<std::string_view> argv;
    if (!target.has_value() || !direction.has_value() || !hold.has_value() ||
        (*direction != "right" && *direction != "down") || !launch_argv(action, argv)) {
      return result;
    }
    const auto kind = *direction == "right" ? daemon::SurfaceCreateKind::split_right
                                            : daemon::SurfaceCreateKind::split_down;
    const auto created = daemon::create_surface(
        endpoint, target->session, kind, target->pane,
        {.working_directory = cwd, .command = argv, .title = {}, .hold = *hold});
    result.status = created.status;
    result.session = created.session;
    result.tab = created.tab;
    result.pane = created.pane;
    return result;
  }

  const auto target = resolve_pane(action, "pane", prior);
  if (!target.has_value()) {
    return result;
  }
  result.session = target->session;
  result.pane = target->pane;
  if (*action_name == "pane.send") {
    const auto text = string_member(action, "text");
    result.status = text.has_value()
                        ? daemon::send_pane(endpoint, target->session, target->pane, *text)
                        : daemon::OperationStatus::failed;
  } else if (*action_name == "pane.capture") {
    auto [status, text] = daemon::capture_pane(endpoint, target->session, target->pane);
    result.status = status;
    result.text = std::move(text);
    result.has_text = true;
    const auto lines = unsigned_member(action, "lines", 0);
    if (!lines.has_value()) {
      result.status = daemon::OperationStatus::failed;
    } else if (*lines > 0) {
      std::size_t offset = result.text.size();
      std::uint64_t found = 0;
      if (offset > 0 && result.text.back() == '\n') {
        --offset;
      }
      while (offset > 0) {
        --offset;
        if (result.text.substr(offset, 1).front() == '\n' && ++found == *lines) {
          ++offset;
          break;
        }
      }
      if (offset > 0) {
        result.text.erase(0, offset);
      }
    }
  } else if (*action_name == "pane.wait") {
    auto waited = execute_wait(endpoint, action, *target);
    waited.id = result.id;
    return waited;
  } else if (*action_name == "pane.kill") {
    result.status =
        daemon::perform_action(endpoint, target->session, daemon::SemanticAction::pane_kill,
                               action_target({}, target->pane));
  } else if (*action_name == "pane.focus") {
    result.status =
        daemon::perform_action(endpoint, target->session, daemon::SemanticAction::pane_focus,
                               action_target({}, target->pane));
  } else if (*action_name == "pane.swap") {
    const auto other = resolve_pane(action, "other", prior);
    if (other.has_value() && other->session == target->session) {
      result.status =
          daemon::perform_action(endpoint, target->session, daemon::SemanticAction::pane_swap,
                                 action_target({}, target->pane, other->pane));
    }
  } else if (*action_name == "pane.resize") {
    const auto direction = string_member(action, "direction");
    const auto amount = unsigned_member(action, "amount", 1);
    std::optional<daemon::SemanticAction> semantic;
    if (direction == std::optional<std::string_view>{"left"}) {
      semantic = daemon::SemanticAction::pane_resize_left;
    } else if (direction == std::optional<std::string_view>{"right"}) {
      semantic = daemon::SemanticAction::pane_resize_right;
    } else if (direction == std::optional<std::string_view>{"up"}) {
      semantic = daemon::SemanticAction::pane_resize_up;
    } else if (direction == std::optional<std::string_view>{"down"}) {
      semantic = daemon::SemanticAction::pane_resize_down;
    }
    if (semantic.has_value() && amount.has_value() && *amount > 0 && *amount <= 100) {
      result.status = daemon::perform_action(
          endpoint, target->session, *semantic,
          action_target({}, target->pane, {}, 0, static_cast<std::uint16_t>(*amount)));
    }
  } else if (*action_name == "pane.zoom") {
    const auto* const enabled = member(action, "enabled");
    if (enabled != nullptr && enabled->kind == JsonKind::boolean) {
      result.status =
          daemon::perform_action(endpoint, target->session,
                                 enabled->boolean ? daemon::SemanticAction::pane_zoom_on
                                                  : daemon::SemanticAction::pane_zoom_off,
                                 action_target({}, target->pane));
    }
  }
  return result;
}

[[nodiscard]] auto read_bounded_stream(std::istream& stream) -> std::optional<std::string> {
  std::string input;
  std::array<char, std::size_t{16} * 1'024U> buffer{};
  while (input.size() <= procedure_bytes_max) {
    const auto remaining = (procedure_bytes_max + 1U) - input.size();
    const auto request = std::min(buffer.size(), remaining);
    stream.read(buffer.data(), static_cast<std::streamsize>(request));
    const auto read = static_cast<std::size_t>(stream.gcount());
    input.append(buffer.data(), read);
    if (read < request) {
      return stream.eof() && input.size() <= procedure_bytes_max ? std::optional{std::move(input)}
                                                                 : std::nullopt;
    }
  }
  return std::nullopt;
}

[[nodiscard]] auto read_procedure(const std::string_view source) -> std::optional<std::string> {
  if (source == "-") {
    return read_bounded_stream(std::cin);
  }
  std::ifstream stream(std::string(source), std::ios::binary);
  return stream ? read_bounded_stream(stream) : std::nullopt;
}

[[nodiscard]] auto write_text(std::FILE* stream, const std::string_view value) noexcept -> bool {
  return std::fwrite(value.data(), 1, value.size(), stream) == value.size();
}

[[nodiscard]] auto write_json_string(std::FILE* stream, const std::string_view value) noexcept
    -> bool {
  if (!write_text(stream, "\"")) {
    return false;
  }
  std::array<char, 7> escaped{};
  for (const char character : value) {
    const auto byte = static_cast<unsigned char>(character);
    std::string_view output;
    switch (character) {
    case '"':
      output = "\\\"";
      break;
    case '\\':
      output = "\\\\";
      break;
    case '\b':
      output = "\\b";
      break;
    case '\f':
      output = "\\f";
      break;
    case '\n':
      output = "\\n";
      break;
    case '\r':
      output = "\\r";
      break;
    case '\t':
      output = "\\t";
      break;
    default:
      if (byte < 0x20U) {
        constexpr std::array digits{'0', '1', '2', '3', '4', '5', '6', '7',
                                    '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'};
        const auto high = std::span(digits).subspan((byte >> 4U) & 0x0fU, 1).front();
        const auto low = std::span(digits).subspan(byte & 0x0fU, 1).front();
        escaped = {'\\', 'u', '0', '0', high, low, '\0'};
        output = {escaped.data(), 6};
      } else {
        output = {&character, 1};
      }
      break;
    }
    if (!write_text(stream, output)) {
      return false;
    }
  }
  return write_text(stream, "\"");
}

[[nodiscard]] constexpr auto operation_succeeded(const daemon::OperationStatus status) noexcept
    -> bool {
  return status == daemon::OperationStatus::applied || status == daemon::OperationStatus::no_effect;
}

[[nodiscard]] constexpr auto status_name(const daemon::OperationStatus status) noexcept
    -> std::string_view {
  switch (status) {
  case daemon::OperationStatus::applied:
    return "applied";
  case daemon::OperationStatus::no_effect:
    return "no_effect";
  case daemon::OperationStatus::missing:
    return "missing";
  case daemon::OperationStatus::conflict:
    return "conflict";
  case daemon::OperationStatus::capacity:
    return "capacity";
  case daemon::OperationStatus::unavailable:
    return "unavailable";
  case daemon::OperationStatus::timeout:
    return "timeout";
  case daemon::OperationStatus::unexpected_exit:
    return "unexpected_exit";
  case daemon::OperationStatus::failed:
    return "failed";
  }
  return "failed";
}

[[nodiscard]] auto write_id(std::FILE* stream, const auto id) -> bool {
  const auto encoded = std::to_string(id.slot()) + ":" + std::to_string(id.generation());
  return write_json_string(stream, encoded);
}

[[nodiscard]] auto write_process(std::FILE* stream, const daemon::PaneStatus& process) noexcept
    -> bool {
  std::string_view state = "running";
  if (process.process == daemon::ProcessState::exited_unknown) {
    state = "exited_unknown";
  } else if (process.process == daemon::ProcessState::exited) {
    state = "exited";
  } else if (process.process == daemon::ProcessState::signaled) {
    state = "signaled";
  }
  std::array<char, 32> value{};
  const auto encoded = std::to_chars(value.begin(), value.end(), process.value);
  return encoded.ec == std::errc{} && write_text(stream, "{\"state\":") &&
         write_json_string(stream, state) && write_text(stream, ",\"value\":") &&
         write_text(stream, {value.data(), static_cast<std::size_t>(encoded.ptr - value.data())}) &&
         write_text(stream, "}");
}

// Each optional result field has one stable JSON projection.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto write_results(const std::span<const ProcedureResult> results, const bool ok)
    -> bool {
  if (!write_text(stdout, R"({"schema":"lemma.results/v1","ok":)") ||
      !write_text(stdout, ok ? "true,\"results\":[" : "false,\"results\":[")) {
    return false;
  }
  for (std::size_t index = 0; index < results.size(); ++index) {
    const auto& result = results.subspan(index, 1).front();
    if ((index > 0 && !write_text(stdout, ",")) || !write_text(stdout, "{\"index\":")) {
      return false;
    }
    std::array<char, 32> number{};
    const auto encoded = std::to_chars(number.begin(), number.end(), index);
    if (encoded.ec != std::errc{} ||
        !write_text(stdout,
                    {number.data(), static_cast<std::size_t>(encoded.ptr - number.data())}) ||
        !write_text(stdout, ",\"action\":") || !write_json_string(stdout, result.action) ||
        !write_text(stdout, ",\"status\":") ||
        !write_json_string(stdout, status_name(result.status))) {
      return false;
    }
    if (!result.id.empty() &&
        (!write_text(stdout, ",\"id\":") || !write_json_string(stdout, result.id))) {
      return false;
    }
    if (!result.session.empty() &&
        (!write_text(stdout, ",\"session\":") || !write_json_string(stdout, result.session))) {
      return false;
    }
    if (result.tab.is_valid() &&
        (!write_text(stdout, ",\"tab\":") || !write_id(stdout, result.tab))) {
      return false;
    }
    if (result.pane.is_valid() &&
        (!write_text(stdout, ",\"pane\":") || !write_id(stdout, result.pane))) {
      return false;
    }
    if (result.has_text &&
        (!write_text(stdout, ",\"text\":") || !write_json_string(stdout, result.text))) {
      return false;
    }
    std::string_view query_field;
    if (result.query_array == QueryArrayKind::sessions) {
      query_field = "sessions";
    } else if (result.query_array == QueryArrayKind::tabs) {
      query_field = "tabs";
    } else if (result.query_array == QueryArrayKind::panes) {
      query_field = "panes";
    }
    if (!query_field.empty() && operation_succeeded(result.status) &&
        (!write_text(stdout, ",\"") || !write_text(stdout, query_field) ||
         !write_text(stdout, "\":") || !write_text(stdout, result.text))) {
      return false;
    }
    if (result.process.has_value() &&
        (!write_text(stdout, ",\"process\":") || !write_process(stdout, *result.process))) {
      return false;
    }
    if (!write_text(stdout, "}")) {
      return false;
    }
  }
  return write_text(stdout, "]}\n");
}

[[nodiscard]] auto write_document_error(
    const std::string_view reason, const std::optional<std::size_t> action_index = std::nullopt,
    const std::string_view field = {}, const std::optional<std::size_t> byte = std::nullopt,
    const bool partial = false) noexcept -> bool {
  if (!write_text(stdout, R"({"schema":"lemma.results/v1","ok":false,"error":{"reason":)") ||
      !write_json_string(stdout, reason)) {
    return false;
  }
  std::array<char, 32> number{};
  if (action_index.has_value()) {
    const auto encoded = std::to_chars(number.begin(), number.end(), *action_index);
    if (encoded.ec != std::errc{} || !write_text(stdout, ",\"action_index\":") ||
        !write_text(stdout,
                    {number.data(), static_cast<std::size_t>(encoded.ptr - number.data())})) {
      return false;
    }
  }
  if (!field.empty() && (!write_text(stdout, ",\"field\":") || !write_json_string(stdout, field))) {
    return false;
  }
  if (byte.has_value()) {
    const auto encoded = std::to_chars(number.begin(), number.end(), *byte);
    if (encoded.ec != std::errc{} || !write_text(stdout, ",\"byte\":") ||
        !write_text(stdout,
                    {number.data(), static_cast<std::size_t>(encoded.ptr - number.data())})) {
      return false;
    }
  }
  return write_text(stdout,
                    partial ? ",\"partial\":true},\"results\":[]}\n" : "},\"results\":[]}\n");
}

} // namespace

// Procedure validation and stop/continue execution are one bounded frontend transaction.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto run_procedure(const daemon::RuntimeEndpoint& endpoint,
                                 const std::string_view source) -> int {
  bool execution_started = false;
  try {
    const auto input = read_procedure(source);
    if (!input.has_value()) {
      static_cast<void>(write_document_error("read_failed"));
      return 2;
    }
    JsonParser parser(*input);
    const auto root = parser.parse();
    if (!root.has_value()) {
      static_cast<void>(
          write_document_error("invalid_json", std::nullopt, {}, parser.error_offset()));
      return 2;
    }
    if (root->kind != JsonKind::object) {
      static_cast<void>(write_document_error("invalid_document"));
      return 2;
    }
    if (const auto field = unknown_field(*root, {"schema", "on_error", "actions"});
        field.has_value()) {
      static_cast<void>(write_document_error("unknown_field", std::nullopt, *field));
      return 2;
    }
    const auto schema = string_member(*root, "schema");
    const auto* const actions = member(*root, "actions");
    const auto* const on_error_value = member(*root, "on_error");
    std::string_view on_error = "stop";
    if (on_error_value != nullptr && on_error_value->kind == JsonKind::string) {
      on_error = on_error_value->string;
    }
    if (schema != std::optional<std::string_view>{"lemma.proc/v1"}) {
      static_cast<void>(write_document_error("invalid_schema", std::nullopt, "schema"));
      return 2;
    }
    if (actions == nullptr || actions->kind != JsonKind::array ||
        actions->array.size() > procedure_actions_max) {
      static_cast<void>(write_document_error("invalid_actions", std::nullopt, "actions"));
      return 2;
    }
    if ((on_error_value != nullptr && on_error_value->kind != JsonKind::string) ||
        (on_error != "stop" && on_error != "continue")) {
      static_cast<void>(write_document_error("invalid_on_error", std::nullopt, "on_error"));
      return 2;
    }
    if (const auto failure = validate_actions(*actions); failure.has_value()) {
      static_cast<void>(
          write_document_error(failure->reason, failure->action_index, failure->field));
      return 2;
    }
    std::vector<ProcedureResult> results;
    results.reserve(actions->array.size());
    bool ok = true;
    for (const auto& action : actions->array) {
      execution_started = true;
      if (action.kind != JsonKind::object) {
        results.push_back({});
      } else {
        results.push_back(execute_action(endpoint, action, results));
      }
      if (results.back().reference_session.empty()) {
        results.back().reference_session = results.back().session;
      }
      if (operation_succeeded(results.back().status) && !results.back().previous_session.empty()) {
        const auto previous = results.back().previous_session;
        const auto renamed = results.back().session;
        for (auto& prior : std::span(results).first(results.size() - 1U)) {
          if (prior.reference_session == previous) {
            prior.reference_session = renamed;
          }
        }
      }
      if (!operation_succeeded(results.back().status)) {
        ok = false;
        if (on_error == "stop") {
          break;
        }
      }
    }
    if (!write_results(results, ok)) {
      return 1;
    }
    return ok ? 0 : 1;
  } catch (...) {
    static_cast<void>(write_document_error("resource_failure", std::nullopt, {}, std::nullopt,
                                           execution_started));
    return 1;
  }
}

} // namespace lemma::app
