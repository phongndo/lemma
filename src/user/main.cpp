#include "api/json.hpp"
#include "extension/client.hpp"
#include "extension/protocol.hpp"
#include "lemma/limits.hpp"
#include "render/pane_composition.hpp"
#include "render/ui.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <memory>
#include <optional>
#include <print>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

#include <poll.h>
#include <unistd.h>

namespace {
namespace api = lemma::api;
namespace ext = lemma::extension;
namespace render = lemma::render;
using api::JsonValue;

[[nodiscard]] auto member(const JsonValue& value, const std::string_view name) -> const JsonValue& {
  const auto* const found = api::json_member(value, name);
  if (found == nullptr) {
    throw std::runtime_error("missing extension response field");
  }
  return *found;
}

[[nodiscard]] auto text(const JsonValue& value, const std::string_view name) -> std::string_view {
  return api::json_string(value, name).value_or(std::string_view{});
}

[[nodiscard]] auto number(const JsonValue& value, const std::string_view name) -> std::uint64_t {
  return api::json_unsigned(value, name).value_or(0);
}

[[nodiscard]] auto enabled(const JsonValue& value, const std::string_view name) -> bool {
  return api::json_boolean(value, name).value_or(false);
}

[[nodiscard]] auto selector(const std::string_view value) -> std::string {
  return "{\"id\":" + ext::json_quote(value) + '}';
}

[[nodiscard]] auto command(ext::Client& client, const std::string_view document) -> JsonValue {
  auto result = client.proc('[' + std::string(document) + ']');
  const auto& results = member(result, "results");
  if (!enabled(result, "ok") || results.array.size() != 1U) {
    throw std::runtime_error("extension command failed: " + ext::json_encode(result));
  }
  return member(results.array.front(), "result");
}

[[nodiscard]] auto hello(const std::string_view session, const bool presentation) -> std::string {
  return std::string{
             R"({"schema":"lemma.extension/v1","name":"lemma-ui","capabilities":["observe","proc","surface"],"events":{"schema":"lemma.events/v1","session":)"} +
         selector(session) + (presentation ? R"(,"presentation":true}})" : "}}");
}

[[nodiscard]] auto plain(const std::string_view value) -> std::string {
  std::string result;
  for (const char character : value) {
    const auto byte = static_cast<unsigned char>(character);
    result += byte >= 32U && byte < 127U ? static_cast<char>(byte) : '?';
  }
  return result;
}

struct Status final {
  ext::Client client;
  std::string session;
  std::string surface;
  JsonValue state;
  std::string prompt_text;
  bool prompting{false};
  std::string dragged;
  std::optional<std::size_t> drag_position;
  std::vector<JsonValue> preview;

  Status(const std::string_view endpoint, std::string id)
      : client(endpoint, hello(id, true)), session(std::move(id)) {}

  // Bounded UI projection/interaction branches have one owner.
  // NOLINTNEXTLINE(readability-function-cognitive-complexity)
  [[nodiscard]] auto projection(std::array<render::StatusTab, render::status_tabs_max>& tabs,
                                std::string& context) const -> render::StatusLine {
    const auto& values = preview.empty() ? member(state, "tabs").array : preview;
    if (values.size() > tabs.size()) {
      throw std::runtime_error("too many status tabs");
    }
    for (std::size_t index = 0; index < values.size(); ++index) {
      const auto& value = values.at(index);
      tabs.at(index) = {.number = static_cast<std::uint16_t>(number(value, "position")),
                        .title = text(value, "title"),
                        .active = enabled(value, "active")};
    }
    const auto& prompt = member(state, "prompt");
    const auto kind = text(prompt, "kind");
    constexpr std::array names{"none",           "session",         "tab",    "command",
                               "search.forward", "search.backward", "message"};
    const auto* const found = std::ranges::find(names, kind);
    if (found == names.end()) {
      throw std::runtime_error("unknown editor kind");
    }
    const auto target = static_cast<render::StatusPromptTarget>(found - names.begin());
    const auto feedback = text(prompt, "feedback");
    auto prompt_feedback = render::StatusPromptFeedback::none;
    if (feedback == "invalid") {
      prompt_feedback = render::StatusPromptFeedback::invalid;
    } else if (feedback == "conflict") {
      prompt_feedback = render::StatusPromptFeedback::conflict;
    }
    context = text(state, "mode");
    const auto& copy = member(state, "copy");
    if (enabled(copy, "active")) {
      if (enabled(copy, "searching")) {
        context += enabled(copy, "backward") ? " ?" : " /";
        context += plain(text(copy, "query"));
      } else {
        context += " [" + std::to_string(number(copy, "below")) + '/' +
                   std::to_string(number(copy, "history")) + ']';
        constexpr std::array messages{
            "", "no match", "empty", "clipboard busy", "selection too large", "copy failed"};
        constexpr std::array feedback_names{"none",           "no_match",  "empty_selection",
                                            "clipboard_busy", "too_large", "failed"};
        const auto copy_feedback = static_cast<std::size_t>(
            std::ranges::find(feedback_names, text(copy, "feedback")) - feedback_names.begin());
        if (copy_feedback > 0 && copy_feedback < messages.size()) {
          context += ' ';
          context += messages.at(copy_feedback);
        }
      }
    }
    if (target == render::StatusPromptTarget::command_line ||
        target == render::StatusPromptTarget::copy_search_forward ||
        target == render::StatusPromptTarget::copy_search_backward) {
      context.clear();
    } else if (target == render::StatusPromptTarget::message) {
      context = text(state, "message");
    }
    return {.session_name = text(state, "name"),
            .tabs = std::span(tabs).first(values.size()),
            .prompt_target = target,
            .prompt_feedback = prompt_feedback,
            .prompt_value = prompt_text,
            .input_context = context,
            .prompt_cursor = number(prompt, "cursor"),
            .dirty = true};
  }

  // Bounded UI projection/interaction branches have one owner.
  // NOLINTNEXTLINE(readability-function-cognitive-complexity)
  void paint() {
    const auto columns = static_cast<std::uint16_t>(number(state, "columns"));
    const auto rows = static_cast<std::uint16_t>(number(state, "rows"));
    if (columns == 0 || rows < 2 || columns > lemma::limits::terminal_columns_hard_max) {
      return;
    }
    if (surface.empty()) {
      const auto created = command(
          client,
          R"({"command":"surface.create","focusable":false,"placement":{"kind":"dock.top","size":1}})");
      surface = text(created, "surface");
    }
    std::array<render::StatusTab, render::status_tabs_max> tabs{};
    std::string context;
    const auto status = projection(tabs, context);
    prompting = status.prompting();
    std::array<render::ui::Cell, lemma::limits::terminal_columns_hard_max> storage{};
    auto cells = std::span(storage).first(columns);
    std::uint16_t cursor = 0;
    if (!render::project_status_cells(status, {.columns = columns, .rows = rows}, cells, cursor)) {
      throw std::runtime_error("invalid status presentation");
    }
    std::string update =
        R"({"schema":"lemma.surface-update/v1","surface":)" + ext::json_quote(surface) +
        R"(,"styles":[{}, {"bold":true},{"bold":true,"underline":true}],"rows":[{"row":0,"runs":[)";
    std::size_t column = 0;
    bool separator = false;
    while (column < cells.size()) {
      const auto first = column;
      const auto style = cells.subspan(column, 1).front().style.attributes;
      std::string run;
      while (column < cells.size() && cells.subspan(column, 1).front().style.attributes == style) {
        const auto& cell = cells.subspan(column, 1).front();
        if (cell.text_size == 0) {
          run += ' ';
        } else {
          run.append(cell.text.data(), cell.text_size);
        }
        ++column;
      }
      if (separator) {
        update += ',';
      }
      separator = true;
      const auto style_index =
          (style & render::ui::attribute_underline) != 0 ? 2 : static_cast<int>(style != 0);
      update += R"({"column":)" + std::to_string(first) + R"(,"text":)" + ext::json_quote(run) +
                R"(,"style":)" + std::to_string(style_index) + '}';
    }
    update += R"(]}],"cursor":{"row":0,"column":)" + std::to_string(cursor) + R"(,"visible":)" +
              (prompting ? "true}}" : "false}}");
    client.update(update);
  }

  // Bounded UI projection/interaction branches have one owner.
  // NOLINTNEXTLINE(readability-function-cognitive-complexity)
  void mouse(const JsonValue& event) {
    if (prompting || surface.empty() || number(event, "button") != 1) {
      return;
    }
    const auto column = api::json_unsigned(event, "column");
    if (!column.has_value() || *column >= number(state, "columns")) {
      return;
    }
    std::array<render::StatusTab, render::status_tabs_max> tabs{};
    std::string context;
    const auto hit = render::status_target_at_column(
        projection(tabs, context),
        {.columns = static_cast<std::uint16_t>(number(state, "columns")),
         .rows = static_cast<std::uint16_t>(number(state, "rows"))},
        static_cast<std::uint16_t>(*column));
    const auto action = number(event, "action");
    if (action == 0 && hit.has_value()) {
      if (hit->kind == render::StatusTargetKind::create_tab) {
        static_cast<void>(
            command(client, R"({"command":"tab.new","session":)" + selector(session) + '}'));
        return;
      }
      preview = member(state, "tabs").array;
      dragged = text(preview.at(hit->tab_position), "id");
      drag_position = hit->tab_position;
      static_cast<void>(command(client, R"({"command":"tab.select","session":)" +
                                            selector(session) + R"(,"tab":)" + selector(dragged) +
                                            '}'));
    } else if (action == 2 && !dragged.empty() && hit.has_value()) {
      drag_position = hit->kind == render::StatusTargetKind::create_tab ? preview.size() - 1U
                                                                        : hit->tab_position;
      const auto source = std::ranges::find_if(
          preview, [&](const auto& tab) { return text(tab, "id") == dragged; });
      if (source != preview.end()) {
        auto tab = std::move(*source);
        preview.erase(source);
        preview.insert(preview.begin() + static_cast<std::ptrdiff_t>(*drag_position),
                       std::move(tab));
        paint();
      }
    } else if (action == 1 && !dragged.empty()) {
      if (drag_position.has_value()) {
        static_cast<void>(command(client, R"({"command":"tab.move","session":)" +
                                              selector(session) + R"(,"tab":)" + selector(dragged) +
                                              R"(,"to_position":)" +
                                              std::to_string(*drag_position + 1U) + '}'));
      }
      dragged.clear();
      drag_position.reset();
      preview.clear();
    }
  }

  void event(const JsonValue& document) {
    if (const auto* const presentation = api::json_member(document, "presentation");
        presentation != nullptr) {
      if (!preview.empty()) {
        const auto& values = member(*presentation, "tabs").array;
        if (values.size() != preview.size() || std::ranges::any_of(preview, [&](const auto& tab) {
              return std::ranges::none_of(
                  values, [&](const auto& value) { return text(tab, "id") == text(value, "id"); });
            })) {
          dragged.clear();
          drag_position.reset();
          preview.clear();
        } else {
          for (auto& tab : preview) {
            const auto found = std::ranges::find_if(
                values, [&](const auto& value) { return text(tab, "id") == text(value, "id"); });
            tab = *found;
          }
        }
      }
      state = *presentation;
      prompt_text = plain(text(member(state, "prompt"), "value"));
      paint();
    } else if (text(document, "event") == "surface.mouse") {
      mouse(document);
    } else if (text(document, "event") == "surface.resized" && !state.object.empty()) {
      paint();
    }
  }
};

// Discovery observes bounded Session summaries; only attached Sessions own status Surfaces.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void discover_statuses(const std::string_view endpoint, const JsonValue& document,
                       std::vector<std::unique_ptr<Status>>& statuses) {
  const auto* const sessions = api::json_member(document, "sessions");
  if (sessions != nullptr) {
    std::erase_if(statuses, [&](const auto& status) {
      return std::ranges::none_of(sessions->array, [&](const auto& session) {
        return text(session, "id") == status->session && enabled(session, "attached");
      });
    });
    for (const auto& session : sessions->array) {
      const auto id = text(session, "id");
      if (enabled(session, "attached") && std::ranges::none_of(statuses, [&](const auto& status) {
            return status->session == id;
          })) {
        try {
          statuses.push_back(std::make_unique<Status>(endpoint, std::string(id)));
        } catch (const std::exception& error) {
          std::println(stderr, "status admission: {:.180}", error.what());
        }
      }
    }
  }
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto run_status(const std::string_view endpoint) -> int {
  ext::Client observer(
      endpoint,
      R"({"schema":"lemma.extension/v1","name":"lemma-ui-discovery","capabilities":["observe"],"events":{"schema":"lemma.events/v1"}})");
  std::vector<std::unique_ptr<Status>> statuses;
  while (true) {
    std::vector<pollfd> descriptors{{.fd = observer.descriptor(), .events = POLLIN, .revents = 0}};
    bool ready = observer.ready();
    for (const auto& status : statuses) {
      descriptors.push_back({.fd = status->client.descriptor(), .events = POLLIN, .revents = 0});
      ready = ready || status->client.ready();
    }
    const auto polled = ::poll(descriptors.data(), descriptors.size(), ready ? 0 : -1);
    if (polled < 0 && errno == EINTR) {
      continue;
    }
    if (polled < 0) {
      return 1;
    }
    if (observer.ready() || descriptors.front().revents != 0) {
      if (auto record = observer.next(0); record.has_value()) {
        discover_statuses(endpoint, record->document, statuses);
      }
    }
    // Discovery can replace the vector, so use nonblocking receives rather than stale poll indices.
    std::erase_if(statuses, [](auto& status) {
      try {
        if (auto record = status->client.next(0); record.has_value()) {
          if (record->kind == ext::RecordKind::error) {
            return true;
          }
          status->event(record->document);
        }
        return false;
      } catch (const std::exception& error) {
        std::println(stderr, "status: {:.180}", error.what());
        return true;
      }
    });
  }
}
struct SessionManager final {
  ext::Client client;
  ext::Client observer;
  std::string connection;
  std::string current;
  std::string surface;
  std::vector<JsonValue> sessions;
  std::size_t selected{0};
  std::size_t columns{0};
  std::size_t rows{0};
  bool creating{false};
  std::string name;
  std::string message{"j/k move | Enter switch | n new | q/Esc close"};

  explicit SessionManager(const JsonValue& context)
      : client(text(context, "endpoint"), hello(text(context, "session"), false)),
        observer(
            text(context, "endpoint"),
            R"({"schema":"lemma.extension/v1","name":"session-manager","capabilities":["observe"],"events":{"schema":"lemma.events/v1"}})"),
        connection(text(context, "connection")), current(text(context, "session")) {
    const auto inspected =
        command(client, R"({"command":"session.inspect","session":)" + selector(current) + '}');
    const auto& geometry = member(member(inspected, "session_state"), "geometry");
    columns = std::min<std::size_t>(76, number(geometry, "columns"));
    rows = std::min<std::size_t>(14, number(geometry, "rows"));
    const auto created = command(
        client,
        R"({"command":"surface.create","placement":{"kind":"float","column":0,"row":0,"columns":)" +
            std::to_string(columns) + R"(,"rows":)" + std::to_string(rows) + "}}");
    surface = text(created, "surface");
    const auto listed = command(client, R"({"command":"session.list"})");
    refresh(member(listed, "sessions"));
    static_cast<void>(
        command(client, R"({"command":"surface.focus","surface":)" + selector(surface) + '}'));
  }

  void refresh(const JsonValue& list) {
    const std::string previous =
        sessions.empty() ? current : std::string(text(sessions.at(selected), "id"));
    sessions = list.array;
    selected = 0;
    for (std::size_t index = 0; index < sessions.size(); ++index) {
      if (text(sessions.at(index), "id") == previous) {
        selected = index;
        break;
      }
    }
    paint();
  }

  // Bounded UI projection/interaction branches have one owner.
  // NOLINTNEXTLINE(readability-function-cognitive-complexity)
  void paint() {
    if (columns == 0 || rows == 0) {
      return;
    }
    std::string update = R"({"schema":"lemma.surface-update/v1","surface":)" +
                         ext::json_quote(surface) + R"(,"styles":[{}, {"inverse":true}],"rows":[)";
    const auto visible = rows > 2 ? rows - 2 : 0;
    const auto start = selected >= visible && visible > 0 ? selected - visible + 1 : 0;
    for (std::size_t row = 0; row < rows; ++row) {
      std::string line;
      bool active = false;
      if (row == 0) {
        line = "Sessions";
      } else if (row + 1 == rows) {
        line = creating ? "New session: " + name : message;
      } else if (start + row - 1 < sessions.size()) {
        const auto index = start + row - 1;
        const auto& session = sessions.at(index);
        active = index == selected;
        line = std::string(active ? "> " : "  ") + std::string(text(session, "name"));
        if (text(session, "id") == current) {
          line += " (current)";
        } else if (enabled(session, "attached")) {
          line += " (attached)";
        }
      }
      line = plain(line);
      line.resize(columns, ' ');
      if (row > 0) {
        update += ',';
      }
      update += R"({"row":)" + std::to_string(row) + R"(,"runs":[{"column":0,"text":)" +
                ext::json_quote(line) + R"(,"style":)" + (active ? "1}]}" : "0}]}");
    }
    update += "]}";
    client.update(update);
  }

  auto select(const std::string_view id) -> bool {
    if (id == current) {
      return false;
    }
    const auto request = R"([{"command":"attachment.switch","connection":)" +
                         ext::json_quote(connection) + R"(,"session":)" + selector(id) + "}]";
    for (unsigned attempt = 0; attempt < 50U; ++attempt) {
      const auto result = client.proc(request);
      if (enabled(result, "ok")) {
        return false;
      }
      const auto& results = member(result, "results").array;
      const auto& failure = results.empty() ? result : member(results.back(), "result");
      const auto* error = api::json_member(failure, "error");
      const auto reason = error == nullptr ? text(failure, "status") : text(*error, "reason");
      if (reason != "output_pending") {
        message = "Cannot switch: " + std::string(reason);
        paint();
        return true;
      }
      static_cast<void>(::poll(nullptr, 0, 10));
    }
    message = "Output is busy; try again";
    paint();
    return true;
  }

  // Bounded UI projection/interaction branches have one owner.
  // NOLINTNEXTLINE(readability-function-cognitive-complexity)
  auto key(const std::string_view value) -> bool {
    if (creating) {
      if (value == "escape" || value == "\x03" || value == "\x07") {
        creating = false;
        name.clear();
      } else if (value == "backspace" || value == "\x7f" || value == "\b") {
        if (!name.empty()) {
          name.pop_back();
        }
      } else if (value == "enter" || value == "\r" || value == "\n") {
        const auto result =
            client.proc(R"([{"command":"session.start","name":)" + ext::json_quote(name) + "}]");
        if (enabled(result, "ok")) {
          const auto& created = member(member(result, "results").array.front(), "result");
          return select(text(member(created, "session"), "id"));
        }
        message = "Session name unavailable or invalid";
        creating = false;
      } else if (value.size() == 1 && name.size() < lemma::limits::session_name_bytes_max &&
                 ((value.front() >= 'a' && value.front() <= 'z') ||
                  (value.front() >= 'A' && value.front() <= 'Z') ||
                  (value.front() >= '0' && value.front() <= '9') || value == "_" || value == "-")) {
        name += value;
      }
    } else if (value == "escape" || value == "q" || value == "\x03" || value == "\x07") {
      return false;
    } else if ((value == "down" || value == "j") && !sessions.empty()) {
      selected = (selected + 1U) % sessions.size();
    } else if ((value == "up" || value == "k") && !sessions.empty()) {
      selected = (selected + sessions.size() - 1U) % sessions.size();
    } else if ((value == "enter" || value == "\r" || value == "\n") && !sessions.empty()) {
      return select(text(sessions.at(selected), "id"));
    } else if (value == "n") {
      creating = true;
      name.clear();
    }
    paint();
    return true;
  }

  // Dispatches the small public Surface event vocabulary.
  // NOLINTNEXTLINE(readability-function-cognitive-complexity)
  auto event(const JsonValue& event, std::string& pending) -> bool {
    if (text(event, "surface") != surface) {
      return true;
    }
    const auto type = text(event, "event");
    if (type == "surface.closed" || type == "surface.blurred") {
      return false;
    }
    if (type == "surface.resized") {
      columns = number(event, "columns");
      rows = number(event, "rows");
      paint();
      return true;
    }
    if (type != "surface.key" || number(event, "action") == 0) {
      return true;
    }
    const auto physical = number(event, "key");
    std::string_view logical;
    for (const auto& [code, key_name] :
         std::array{std::pair{27U, "enter"}, std::pair{29U, "backspace"}, std::pair{30U, "escape"},
                    std::pair{32U, "up"}, std::pair{33U, "down"}}) {
      if (physical == code) {
        logical = key_name;
        break;
      }
    }
    if (!logical.empty()) {
      pending.clear();
      return key(logical);
    }
    if (api::json_member(event, "text") != nullptr) {
      pending += text(event, "text");
    } else {
      const auto hex = text(event, "bytes_hex");
      for (std::size_t index = 0; index + 1U < hex.size(); index += 2) {
        unsigned byte = 0;
        const auto digits = hex.substr(index, 2);
        // from_chars consumes the bounded iterator pair, not a C string.
        // NOLINTNEXTLINE(bugprone-suspicious-stringview-data-usage)
        const auto parsed = std::from_chars(digits.data(), std::to_address(digits.end()), byte, 16);
        if (parsed.ec != std::errc{}) {
          return false;
        }
        pending += static_cast<char>(byte);
      }
    }
    return consume(pending);
  }

  auto consume(std::string& pending) -> bool {
    while (!pending.empty()) {
      std::string value(1, pending.front());
      std::size_t consumed = 1;
      if (pending.front() == '\x1b') {
        if (pending == "\x1b" || pending == "\x1b[") {
          break;
        }
        value = "escape";
        if (pending.starts_with("\x1b[A")) {
          value = "up";
        } else if (pending.starts_with("\x1b[B")) {
          value = "down";
        }
        consumed = std::min<std::size_t>(3, pending.size());
      }
      pending.erase(0, consumed);
      if (!key(value)) {
        return false;
      }
    }
    return true;
  }

  // Bounded event polling and dispatch, with no wakeup while idle.
  // NOLINTNEXTLINE(readability-function-cognitive-complexity)
  auto run() -> int {
    std::string pending;
    while (true) {
      std::array<pollfd, 2> descriptors{
          {{.fd = client.descriptor(), .events = POLLIN, .revents = 0},
           {.fd = observer.descriptor(), .events = POLLIN, .revents = 0}}};
      const auto idle_timeout = pending.empty() ? -1 : 50;
      const auto timeout = client.ready() || observer.ready() ? 0 : idle_timeout;
      const auto polled = ::poll(descriptors.data(), descriptors.size(), timeout);
      if (polled < 0 && errno == EINTR) {
        continue;
      }
      if (polled < 0) {
        return 1;
      }
      if (polled == 0 && timeout == 50) {
        return 0;
      }
      if (auto record = observer.next(0); record.has_value()) {
        if (const auto* list = api::json_member(record->document, "sessions"); list != nullptr) {
          refresh(*list);
        }
      }
      const auto record = client.next(0);
      if (!record.has_value()) {
        continue;
      }
      if (!event(record->document, pending)) {
        return 0;
      }
    }
  }
};

} // namespace

int main(const int argc, char** argv) {
  try {
    const std::span arguments(argv, static_cast<std::size_t>(argc));
    const char* const endpoint = std::getenv("LEMMA_EXTENSION_ENDPOINT");
    if (arguments.size() == 2 && std::string_view(arguments.back()) == "status" &&
        endpoint != nullptr) {
      return run_status(endpoint);
    }
    const auto* context_text = std::getenv("LEMMA_COMMAND_CONTEXT");
    if (arguments.size() == 2 && std::string_view(arguments.back()) == "sessions" &&
        context_text != nullptr) {
      const auto context = api::parse_json(context_text);
      if (context.value.has_value()) {
        return SessionManager(*context.value).run();
      }
    }
    return 2;
  } catch (const std::exception& error) {
    const std::string_view message(error.what());
    static_cast<void>(
        ::write(STDERR_FILENO, message.data(), std::min<std::size_t>(180, message.size())));
    static_cast<void>(::write(STDERR_FILENO, "\n", 1));
    return 1;
  }
}
