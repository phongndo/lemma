#include "user/session_manager.hpp"

#include "api/json.hpp"
#include "extension/client.hpp"
#include "extension/protocol.hpp"
#include "lemma/limits.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

#include <poll.h>

namespace lemma::user {
namespace {
namespace ext = extension;
using api::JsonValue;
using Clock = std::chrono::steady_clock;

[[nodiscard]] auto member(const JsonValue& value, std::string_view key) -> const JsonValue& {
  const auto* found = api::json_member(value, key);
  if (found == nullptr) {
    throw std::runtime_error("missing picker response field");
  }
  return *found;
}
[[nodiscard]] auto text(const JsonValue& value, std::string_view key) -> std::string {
  return std::string(api::json_string(value, key).value_or(std::string_view{}));
}
[[nodiscard]] auto number(const JsonValue& value, std::string_view key) -> std::uint64_t {
  return api::json_unsigned(value, key).value_or(0);
}
[[nodiscard]] auto enabled(const JsonValue& value, std::string_view key) -> bool {
  return api::json_boolean(value, key).value_or(false);
}
[[nodiscard]] auto selector(std::string_view id) -> std::string {
  return "{\"id\":" + ext::json_quote(id) + '}';
}
[[nodiscard]] auto plain(std::string_view value) -> std::string {
  std::string result;
  for (const char character : value) {
    const auto byte = static_cast<unsigned char>(character);
    result += byte >= 32U && byte < 127U ? static_cast<char>(byte) : '?';
  }
  return result;
}
[[nodiscard]] auto command(ext::Client& client, std::string_view request) -> JsonValue {
  const auto result = client.proc('[' + std::string(request) + ']');
  if (!enabled(result, "ok") || member(result, "results").array.size() != 1U) {
    throw std::runtime_error("picker command failed: " + ext::json_encode(result));
  }
  return member(member(result, "results").array.front(), "result");
}
[[nodiscard]] auto scoped_hello(std::string_view session) -> std::string {
  return R"({"schema":"lemma.extension/v1","name":"session-picker","capabilities":["observe","proc","surface"],"events":{"schema":"lemma.events/v1","presentation":true,"session":)" +
         selector(session) + "}}";
}

struct Target final {
  std::string session;
  std::string tab;
  std::string pane;
  auto operator==(const Target&) const -> bool = default;
};
struct Pane final {
  std::string id;
  std::string command;
  std::string cwd;
  bool launch_cwd{false};
  bool inspected{false};
};

[[nodiscard]] auto process_label(const JsonValue& process) -> std::string {
  auto name = plain(text(process, "observed_title"));
  if (!name.empty()) {
    return name;
  }
  const auto& argv = member(member(process, "launch"), "argv").array;
  if (argv.empty()) {
    return "process";
  }
  name = plain(argv.front().string);
  const auto slash = name.find_last_of('/');
  return slash == std::string::npos ? name : name.substr(slash + 1);
}
struct Tab final {
  std::string id;
  std::string title;
  std::string focused;
  std::size_t position{0};
  std::vector<Pane> panes;
};
struct Session final {
  std::string id;
  std::string name;
  std::string active_tab;
  std::string focused;
  std::uint64_t revision{0};
  std::size_t tab_count{0};
  bool attached{false};
  bool loaded{false};
  std::vector<Tab> tabs;
};
struct Location final {
  Target scope;
  std::string query;
  std::size_t cursor{0};
  std::optional<Target> selected;
};
struct Match final {
  Target target;
  std::string label;
  std::string detail;
  std::vector<std::size_t> highlights;
  int score{0};
};
struct Rectangle final {
  std::size_t x{0};
  std::size_t y{0};
  std::size_t width{0};
  std::size_t height{0};
};
struct Layout final {
  Rectangle surface;
  Rectangle list;
  Rectangle preview;
};

// fzf-lua's flex split: right:60% above 100 picker columns, down:45% otherwise.
// Very small terminals retain the prompt/list rather than unusable preview fragments.
[[nodiscard]] auto layout(std::size_t columns, std::size_t rows) -> Layout {
  const auto width = std::max<std::size_t>(1, columns * 80 / 100);
  const auto height = std::max<std::size_t>(1, rows * 85 / 100);
  Layout result{
      .surface = {.x = (columns - width) / 2,
                  .y = (rows - height) / 2,
                  .width = width,
                  .height = height},
      .list = {.x = 0, .y = 0, .width = width, .height = height > 1 ? height - 1 : height},
      .preview = {}};
  if (width > 100 && height >= 9) {
    const auto left = (width - 1) * 40 / 100;
    result.list.width = left;
    result.preview = {
        .x = left + 1, .y = 0, .width = width - left - 1, .height = result.list.height};
  } else if (width >= 35 && height >= 16) {
    const auto bottom = (result.list.height - 1) * 45 / 100;
    result.list.height -= bottom + 1;
    result.preview = {.x = 0, .y = result.list.height + 1, .width = width, .height = bottom};
  }
  return result;
}

struct Cell final {
  std::string glyph{" "};
  unsigned style{0};
};
struct EncodedRow final {
  std::string text;
  std::size_t nodes{3}; // Row object, index, and run array; each run adds four JSON values.
};
class Grid final {
public:
  Grid(std::size_t columns, std::size_t rows) : columns_(columns), cells_(rows * columns) {}
  void glyph(std::size_t x, std::size_t y, std::string_view value, unsigned style = 0) {
    if (x < columns_ && y < cells_.size() / columns_) {
      cells_.at((y * columns_) + x) = {.glyph = std::string(value), .style = style};
    }
  }
  void put(std::size_t x, std::size_t y, std::string_view value, std::size_t width,
           unsigned style = 0, const std::vector<std::size_t>& highlights = {}) {
    const auto safe = plain(value);
    for (std::size_t i = 0; i < std::min(width, safe.size()); ++i) {
      const auto highlighted = std::ranges::binary_search(highlights, i);
      const auto match_style = style == 3 ? 5U : 4U;
      glyph(x + i, y, safe.substr(i, 1), highlighted ? match_style : style);
    }
  }
  void box(const Rectangle& rect, std::string_view title, std::string_view count = {}) {
    if (rect.width < 2 || rect.height < 2) {
      return;
    }
    const auto right = rect.x + rect.width - 1;
    const auto bottom = rect.y + rect.height - 1;
    for (auto x = rect.x + 1; x < right; ++x) {
      glyph(x, rect.y, "─", 1);
      glyph(x, bottom, "─", 1);
    }
    for (auto y = rect.y + 1; y < bottom; ++y) {
      glyph(rect.x, y, "│", 1);
      glyph(right, y, "│", 1);
    }
    glyph(rect.x, rect.y, "╭", 1);
    glyph(right, rect.y, "╮", 1);
    glyph(rect.x, bottom, "╰", 1);
    glyph(right, bottom, "╯", 1);
    if (rect.width > 6) {
      const auto count_width = rect.width >= 18 ? count.size() : 0;
      const auto title_width = rect.width - 5 - (count_width == 0 ? 0 : count_width + 3);
      put(rect.x + 2, rect.y, ' ' + std::string(title) + ' ', title_width, 2);
      if (count_width != 0) {
        put(right - count_width - 3, rect.y, ' ' + std::string(count) + ' ', count_width + 2, 1);
      }
    }
  }
  [[nodiscard]] auto row(std::size_t y) const -> EncodedRow {
    EncodedRow result{.text = R"({"row":)" + std::to_string(y) + R"(,"runs":[)"};
    std::size_t x = 0;
    while (x < columns_) {
      const auto begin = x;
      const auto style = cells_.at((y * columns_) + x).style;
      std::string run;
      while (x < columns_ && cells_.at((y * columns_) + x).style == style) {
        run += cells_.at((y * columns_) + x).glyph;
        ++x;
      }
      if (begin != 0) {
        result.text += ',';
      }
      result.nodes += 4;
      result.text += R"({"column":)" + std::to_string(begin) + R"(,"style":)" +
                     std::to_string(style) + R"(,"text":)" + ext::json_quote(run) + '}';
    }
    result.text += "]}";
    return result;
  }

private:
  std::size_t columns_;
  std::vector<Cell> cells_;
};

[[nodiscard]] auto lower(char value) -> char {
  return value >= 'A' && value <= 'Z' ? static_cast<char>(value + ('a' - 'A')) : value;
}
struct FuzzyMatch final {
  int score{0};
  std::vector<std::size_t> positions;
};
// Score one term with adjacency and word-boundary bonuses.
[[nodiscard]] auto fuzzy_term(std::string_view value, std::string_view term, FuzzyMatch& result)
    -> bool {
  std::size_t cursor = 0;
  for (const auto character : term) {
    const auto start = cursor;
    while (cursor < value.size() && lower(value.at(cursor)) != lower(character)) {
      ++cursor;
    }
    if (cursor == value.size()) {
      return false;
    }
    result.score += cursor == start ? 12 : 2;
    if (cursor == 0 || std::string_view(" /_-.").contains(value.at(cursor - 1))) {
      result.score += 8;
    }
    result.positions.push_back(cursor++);
  }
  return true;
}
// Terms may match different path fields. This is not fzf's extended operator grammar.
[[nodiscard]] auto fuzzy(std::string_view value, std::string_view query)
    -> std::optional<FuzzyMatch> {
  FuzzyMatch result;
  while (!query.empty()) {
    const auto end = query.find(' ');
    if (!fuzzy_term(value, query.substr(0, end), result)) {
      return std::nullopt;
    }
    if (end == std::string_view::npos) {
      break;
    }
    query.remove_prefix(end + 1);
  }
  std::ranges::sort(result.positions);
  const auto duplicates = std::ranges::unique(result.positions);
  result.positions.erase(duplicates.begin(), duplicates.end());
  return result;
}

enum class JobKind : std::uint8_t { outline, metadata, preview };
struct Job final {
  JobKind kind{JobKind::outline};
  std::uint32_t sequence{0};
  std::string session;
  std::uint64_t revision{0};
  std::vector<std::string> panes;
  Target target;
  std::size_t lines{0};
  Clock::time_point deadline;
};

class SessionManager final {
public:
  explicit SessionManager(const JsonValue& context)
      : client_(text(context, "endpoint"), scoped_hello(text(context, "session"))),
        observer_(
            text(context, "endpoint"),
            R"({"schema":"lemma.extension/v1","name":"picker-data","capabilities":["observe","proc"],"events":{"schema":"lemma.events/v1"}})"),
        connection_(text(context, "connection")), current_(text(context, "session")) {
    const auto inspected =
        command(client_, R"({"command":"session.inspect","session":)" + selector(current_) + '}');
    const auto& geometry = member(member(inspected, "session_state"), "geometry");
    resize(number(geometry, "columns"), number(geometry, "rows"));
    const auto listed = command(client_, R"({"command":"session.list"})");
    reconcile(member(listed, "sessions"));
    location_.selected = Target{.session = current_, .tab = {}, .pane = {}};
    paint();
    refocus();
  }
  [[nodiscard]] auto run() -> int;

private:
  ext::Client client_;
  ext::Client observer_;
  std::string connection_;
  std::string current_;
  std::string surface_;
  std::vector<Session> sessions_;
  Location location_;
  std::vector<Location> history_;
  std::vector<Match> matches_;
  std::optional<Job> job_;
  Layout layout_;
  std::size_t columns_{0};
  std::size_t rows_{0};
  std::vector<std::string> painted_;
  std::optional<Target> captured_;
  std::size_t captured_lines_{0};
  std::string capture_;
  std::string message_;
  std::string pending_;
  bool dirty_{true};
  bool lost_selection_{false};
  bool repairing_{false};
  bool creating_{false};
  std::string new_name_;
  std::size_t new_cursor_{0};
  Clock::time_point escape_deadline_;

  [[nodiscard]] auto session(std::string_view id) -> Session* {
    const auto found = std::ranges::find(sessions_, id, &Session::id);
    return found == sessions_.end() ? nullptr : &*found;
  }
  [[nodiscard]] auto selected() const -> const Match* {
    if (!location_.selected.has_value()) {
      return nullptr;
    }
    const auto found = std::ranges::find(matches_, *location_.selected, &Match::target);
    return found == matches_.end() ? nullptr : &*found;
  }
  [[nodiscard]] auto selected_index() const -> std::size_t {
    const auto* item = selected();
    return item == nullptr ? 0 : static_cast<std::size_t>(item - matches_.data());
  }
  void refocus() {
    const auto focused =
        command(client_, R"({"command":"surface.focus","surface":)" + selector(surface_) + '}');
    // An already-focused Surface emits no focused Event. Only ignore a queued resize blur when
    // an actual focus transition will finish the repair.
    repairing_ = text(focused, "status") == "applied";
  }
  void resize(std::size_t columns, std::size_t rows);
  void reconcile(const JsonValue& list);
  void rebuild(bool choose_first = false);
  void validate_location();
  void add_match(Target target, std::string label, std::string detail, const std::string& search);
  void move(int step);
  void browse();
  void back();
  void refresh();
  void fetch();
  void reply(const ext::ClientRecord& record);
  static void outline(Session& target, const JsonValue& result);
  static void metadata(Session& target, const JsonValue& result);
  [[nodiscard]] auto preview() -> std::vector<std::string>;
  void paint();
  [[nodiscard]] auto activate() -> bool;
  [[nodiscard]] auto switch_session(std::string_view id) -> bool;
  [[nodiscard]] auto mutation(std::string_view request) -> bool;
  [[nodiscard]] auto event(const JsonValue& value) -> bool;
  [[nodiscard]] auto key(std::string_view value) -> bool;
  [[nodiscard]] auto consume() -> bool;
  void edit(std::string_view value);
  [[nodiscard]] auto turn() -> std::optional<int>;
  [[nodiscard]] auto wait_ready() -> bool;
  [[nodiscard]] auto drain_input() -> bool;
  [[nodiscard]] auto drain_data() -> bool;
};

void SessionManager::resize(std::size_t columns, std::size_t rows) {
  if (columns == columns_ && rows == rows_) {
    return;
  }
  columns_ = columns;
  rows_ = rows;
  layout_ = layout(columns, rows);
  const auto& rect = layout_.surface;
  const auto placement = R"({"kind":"float","column":)" + std::to_string(rect.x) + R"(,"row":)" +
                         std::to_string(rect.y) + R"(,"columns":)" + std::to_string(rect.width) +
                         R"(,"rows":)" + std::to_string(rect.height) + '}';
  if (surface_.empty()) {
    const auto created =
        command(client_, R"({"command":"surface.create","placement":)" + placement + '}');
    surface_ = text(created, "surface");
  } else {
    static_cast<void>(command(client_, R"({"command":"surface.configure","surface":)" +
                                           selector(surface_) + R"(,"placement":)" + placement +
                                           '}'));
    refocus();
  }
  painted_.clear();
  dirty_ = true;
}

void SessionManager::reconcile(const JsonValue& list) {
  std::vector<Session> updated;
  for (const auto& value : list.array) {
    const auto id = text(value, "id");
    auto* previous = session(id);
    Session item = previous == nullptr ? Session{} : std::move(*previous);
    const auto revision = number(value, "revision");
    item.loaded = item.loaded && item.revision == revision;
    item.id = id;
    item.name = text(value, "name");
    item.revision = revision;
    item.tab_count = number(value, "tabs");
    item.active_tab = text(value, "active_tab");
    item.focused = text(value, "focused_pane");
    item.attached = enabled(value, "attached");
    updated.push_back(std::move(item));
  }
  sessions_ = std::move(updated);
  if (!location_.scope.session.empty() && session(location_.scope.session) == nullptr) {
    location_ = {};
    history_.clear();
    message_ = "Location closed";
  }
  rebuild();
}

void SessionManager::add_match(Target target, std::string label, std::string detail,
                               const std::string& search) {
  auto matched = fuzzy(search, location_.query);
  if (!matched.has_value()) {
    return;
  }
  auto highlights = fuzzy(label, location_.query);
  matches_.push_back({.target = std::move(target),
                      .label = std::move(label),
                      .detail = std::move(detail),
                      .highlights = highlights.has_value() ? std::move(highlights->positions)
                                                           : std::vector<std::size_t>{},
                      .score = matched->score});
}

// A deleted browsing scope returns to its surviving parent without activating a replacement.
void SessionManager::validate_location() {
  const auto* item = session(location_.scope.session);
  if (item == nullptr || !item->loaded || location_.scope.tab.empty() ||
      std::ranges::find(item->tabs, location_.scope.tab, &Tab::id) != item->tabs.end()) {
    return;
  }
  location_ = {.scope = {.session = item->id, .tab = {}, .pane = {}},
               .query = {},
               .cursor = 0,
               .selected = std::nullopt};
  if (!history_.empty() && history_.back().scope == location_.scope) {
    history_.pop_back();
  }
  lost_selection_ = true;
  message_ = "Tab closed; choose another result";
}

// Builds a bounded search projection from cached metadata, with stable ties and ID-based selection.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void SessionManager::rebuild(bool choose_first) {
  validate_location();
  const auto previous = location_.selected;
  const auto searching = location_.query.find_first_not_of(' ') != std::string::npos;
  matches_.clear();
  for (const auto& item : sessions_) {
    if (!location_.scope.session.empty() && item.id != location_.scope.session) {
      continue;
    }
    if (location_.scope.session.empty()) {
      const std::string_view availability = item.attached ? " [attached]" : "";
      const std::string suffix(item.id == current_ ? " *" : availability);
      add_match({.session = item.id, .tab = {}, .pane = {}}, item.name + suffix,
                std::to_string(item.tab_count) + (item.tab_count == 1 ? " tab" : " tabs"),
                item.name);
    }
    for (const auto& tab : item.tabs) {
      if (!location_.scope.tab.empty() && tab.id != location_.scope.tab) {
        continue;
      }
      const auto name = tab.title.empty() ? "tab " + std::to_string(tab.position) : tab.title;
      const auto path = item.name + " / " + name;
      if ((searching || !location_.scope.session.empty()) && location_.scope.tab.empty()) {
        add_match({.session = item.id, .tab = tab.id, .pane = {}},
                  searching ? path : std::to_string(tab.position) + " " + name,
                  std::to_string(tab.panes.size()) + (tab.panes.size() == 1 ? " pane" : " panes"),
                  path);
      }
      if (!searching && location_.scope.tab.empty()) {
        continue;
      }
      for (std::size_t index = 0; index < tab.panes.size(); ++index) {
        const auto& pane = tab.panes.at(index);
        const auto label = std::to_string(index + 1) + " " + pane.command;
        auto full = path;
        full += " / ";
        full += label;
        const auto directory = pane.cwd + (pane.launch_cwd ? " (launch)" : "");
        add_match({.session = item.id, .tab = tab.id, .pane = pane.id}, searching ? full : label,
                  directory, full + ' ' + pane.cwd);
      }
    }
  }
  if (searching) {
    std::ranges::stable_sort(
        matches_, [](const Match& left, const Match& right) { return left.score > right.score; });
  }
  if (choose_first) {
    lost_selection_ = false;
    location_.selected.reset();
  } else if (previous.has_value() && selected() == nullptr) {
    location_.selected.reset();
    lost_selection_ = true;
    message_ = "Selection disappeared; choose another result";
  }
  if (!location_.selected.has_value() && !lost_selection_ && !matches_.empty()) {
    location_.selected = matches_.front().target;
  }
  dirty_ = true;
}

void SessionManager::move(int step) {
  if (matches_.empty()) {
    return;
  }
  const auto current = selected() == nullptr ? -1 : static_cast<std::int64_t>(selected_index());
  const auto index =
      std::clamp(current + step, std::int64_t{0}, static_cast<std::int64_t>(matches_.size() - 1));
  location_.selected = matches_.at(static_cast<std::size_t>(index)).target;
  lost_selection_ = false;
  message_.clear();
  dirty_ = true;
}
void SessionManager::browse() {
  const auto* chosen = selected();
  if (chosen == nullptr || !chosen->target.pane.empty()) {
    return;
  }
  const auto target = chosen->target;
  history_.push_back(location_);
  location_ = {.scope = target, .query = {}, .cursor = 0, .selected = std::nullopt};
  message_.clear();
  rebuild(true);
}
void SessionManager::back() {
  if (history_.empty()) {
    return;
  }
  location_ = std::move(history_.back());
  history_.pop_back();
  lost_selection_ = false;
  message_.clear();
  rebuild();
}
void SessionManager::refresh() {
  for (auto& item : sessions_) {
    item.loaded = false;
  }
  captured_.reset();
  message_.clear();
  dirty_ = true;
}

// One outstanding data Proc; it never waits on the focused input connection. Selection previews
// take priority over background discovery and replies are checked against stable IDs/revisions.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void SessionManager::fetch() {
  if (job_.has_value()) {
    return;
  }
  const auto* choice = selected();
  if (choice != nullptr && !choice->target.pane.empty() && layout_.preview.height > 2 &&
      (captured_ != choice->target || captured_lines_ != layout_.preview.height - 2)) {
    Job job{.kind = JobKind::preview,
            .sequence = 0,
            .session = choice->target.session,
            .revision = 0,
            .panes = {},
            .target = choice->target,
            .lines = layout_.preview.height - 2,
            .deadline = Clock::now() + std::chrono::seconds(3)};
    job.sequence =
        observer_.submit_proc(R"([{"command":"pane.capture","session":)" + selector(job.session) +
                              R"(,"pane":)" + selector(job.target.pane) +
                              R"(,"source":"visible","lines":)" + std::to_string(job.lines) + "}]");
    job_ = std::move(job);
    return;
  }
  std::vector<Session*> order;
  if (choice != nullptr) {
    if (auto* item = session(choice->target.session); item != nullptr) {
      order.push_back(item);
    }
  }
  for (auto& item : sessions_) {
    if (order.empty() || order.front() != &item) {
      order.push_back(&item);
    }
  }
  for (auto* item : order) {
    Job job{.kind = JobKind::outline,
            .sequence = 0,
            .session = item->id,
            .revision = item->revision,
            .panes = {},
            .target = {},
            .lines = 0,
            .deadline = Clock::now() + std::chrono::seconds(3)};
    const auto suffix = R"(,"session":)" + selector(item->id) + R"(,"if_session_revision":)" +
                        std::to_string(item->revision) + '}';
    std::string commands;
    if (!item->loaded) {
      commands = R"([{"command":"tab.list")" + suffix;
      commands += R"(,{"command":"pane.list")" + suffix + ']';
    } else {
      job.kind = JobKind::metadata;
      for (const auto& tab : item->tabs) {
        for (const auto& pane : tab.panes) {
          if (pane.inspected || job.panes.size() == 16) {
            continue;
          }
          job.panes.push_back(pane.id);
          commands += commands.empty() ? "[" : ",";
          commands += R"({"command":"pane.inspect","pane":)";
          commands += selector(pane.id) + suffix;
        }
      }
      if (!commands.empty()) {
        commands += ']';
      }
    }
    if (!commands.empty()) {
      job.sequence = observer_.submit_proc(commands);
      job_ = std::move(job);
      return;
    }
  }
}

void SessionManager::outline(Session& target, const JsonValue& result) {
  const auto& values = member(result, "results").array;
  std::vector<Tab> tabs;
  for (const auto& value : member(member(values.at(0), "result"), "tabs").array) {
    tabs.push_back({.id = text(value, "id"),
                    .title = plain(text(value, "title")),
                    .focused = text(value, "focused_pane"),
                    .position = number(value, "position"),
                    .panes = {}});
  }
  for (const auto& value : member(member(values.at(1), "result"), "panes").array) {
    const auto found = std::ranges::find(tabs, text(value, "tab"), &Tab::id);
    if (found != tabs.end()) {
      auto name = plain(text(value, "observed_title"));
      found->panes.push_back({.id = text(value, "id"),
                              .command = name.empty() ? "process" : std::move(name),
                              .cwd = {}});
    }
  }
  target.tabs = std::move(tabs);
  target.loaded = true;
}

void SessionManager::metadata(Session& target, const JsonValue& result) {
  for (const auto& value : member(result, "results").array) {
    const auto& info = member(member(value, "result"), "pane_state");
    const auto id = text(member(info, "pane"), "id");
    for (auto& tab : target.tabs) {
      const auto found = std::ranges::find(tab.panes, id, &Pane::id);
      if (found == tab.panes.end()) {
        continue;
      }
      const auto& process = member(info, "process");
      found->cwd = plain(text(member(member(info, "terminal"), "pwd"), "value"));
      found->launch_cwd = found->cwd.empty();
      if (found->launch_cwd) {
        found->cwd = plain(text(member(process, "launch"), "cwd"));
      }
      found->command = process_label(process);
      found->inspected = true;
    }
  }
}

void SessionManager::reply(const ext::ClientRecord& record) {
  if (!job_.has_value() || record.sequence != job_->sequence) {
    throw std::runtime_error("unexpected picker data reply");
  }
  const auto job = std::move(*job_);
  job_.reset();
  if (job.kind == JobKind::preview) {
    captured_ = job.target;
    captured_lines_ = job.lines;
    capture_ = enabled(record.document, "ok")
                   ? text(member(member(member(record.document, "results").array.front(), "result"),
                                 "capture"),
                          "text")
                   : "Preview unavailable";
    dirty_ = true;
    return;
  }
  auto* item = session(job.session);
  if (item == nullptr || item->revision != job.revision) {
    return;
  }
  if (!enabled(record.document, "ok")) {
    // Do not spin on a failed or racing observation. A new revision or Ctrl-R retries discovery.
    item->loaded = true;
    for (auto& tab : item->tabs) {
      for (auto& pane : tab.panes) {
        pane.inspected = true;
      }
    }
    return;
  }
  if (job.kind == JobKind::outline) {
    outline(*item, record.document);
  } else {
    metadata(*item, record.document);
  }
  rebuild();
}

[[nodiscard]] auto lines(std::string_view value) -> std::vector<std::string> {
  std::vector<std::string> result;
  while (!value.empty()) {
    const auto end = value.find('\n');
    result.push_back(plain(value.substr(0, end)));
    if (end == std::string_view::npos) {
      break;
    }
    value.remove_prefix(end + 1);
  }
  return result;
}

// Traverse only the selected hierarchy, bounded by the catalogue.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto SessionManager::preview() -> std::vector<std::string> {
  const auto* choice = selected();
  if (choice == nullptr) {
    return {"No destination selected"};
  }
  if (!choice->target.pane.empty()) {
    return captured_ == choice->target ? lines(capture_)
                                       : std::vector<std::string>{"Loading preview..."};
  }
  const auto* item = session(choice->target.session);
  if (item == nullptr || !item->loaded) {
    return {"Loading..."};
  }
  std::vector<std::string> output;
  for (const auto& tab : item->tabs) {
    if (!choice->target.tab.empty() && choice->target.tab != tab.id) {
      continue;
    }
    output.push_back(std::to_string(tab.position) + ' ' + (tab.title.empty() ? "tab" : tab.title));
    for (std::size_t index = 0; index < tab.panes.size(); ++index) {
      const auto& pane = tab.panes.at(index);
      output.push_back("  " + std::to_string(index + 1) + ' ' + pane.command + "  " + pane.cwd +
                       (pane.launch_cwd ? " (launch)" : ""));
    }
    output.emplace_back();
  }
  return output;
}

// Native composition retains these bounded row patches. Default backgrounds on the fill and
// border labels inherit the terminal theme; only selection supplies a contrasting background.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void SessionManager::paint() {
  Grid grid(layout_.surface.width, layout_.surface.height);
  const auto& list = layout_.list;
  const auto& pane = layout_.preview;
  std::string title = "Sessions";
  if (const auto* item = session(location_.scope.session); item != nullptr) {
    title = item->name;
    for (const auto& tab : item->tabs) {
      if (tab.id == location_.scope.tab) {
        title += " / " + (tab.title.empty() ? "tab " + std::to_string(tab.position) : tab.title);
      }
    }
  }
  grid.box(list, title, std::to_string(matches_.size()));
  if (list.width >= 7 && list.height >= 5) {
    for (std::size_t x = 1; x + 1 < list.width; ++x) {
      grid.glyph(x, 2, "─", 1);
    }
    grid.glyph(0, 2, "├", 1);
    grid.glyph(list.width - 1, 2, "┤", 1);
    grid.put(2, 1, creating_ ? "+" : ">", 1, 2);
    const auto& query = creating_ ? new_name_ : location_.query;
    const auto cursor = creating_ ? new_cursor_ : location_.cursor;
    const auto capacity = list.width - 5;
    const auto offset = cursor >= capacity ? cursor - capacity + 1 : 0;
    const std::string placeholder = creating_ ? "New session" : "Search...";
    grid.put(4, 1, query.empty() ? placeholder : query.substr(offset), capacity,
             query.empty() ? 1U : 0U);
    const auto visible = list.height - 4;
    const auto selected_row = selected_index();
    const auto start = selected_row >= visible ? selected_row - visible + 1 : 0;
    for (std::size_t row = 0; row < visible && start + row < matches_.size(); ++row) {
      const auto& match = matches_.at(start + row);
      const bool active = location_.selected == match.target;
      const auto style = active ? 3U : 0U;
      grid.put(1, row + 3, std::string(list.width - 2, ' '), list.width - 2, style);
      grid.put(2, row + 3, active ? ">" : " ", 1, style);
      const auto available = list.width - 6;
      const auto detail_width =
          match.detail.empty() ? 0 : std::min(available / 3, match.detail.size());
      grid.put(4, row + 3, match.label, available - (detail_width == 0 ? 0 : detail_width + 1),
               style, match.highlights);
      if (detail_width != 0) {
        grid.put(list.width - detail_width - 2, row + 3, match.detail, detail_width,
                 active ? 3U : 1U);
      }
    }
    if (matches_.empty()) {
      grid.put(3, 3, "No matches", list.width - 5, 1);
    }
  } else {
    grid.put(0, 0, "Esc close", list.width, 1);
  }
  if (pane.width != 0) {
    const auto* choice = selected();
    grid.box(pane, choice == nullptr ? "Preview" : choice->label);
    const auto content = preview();
    for (std::size_t row = 0; row < content.size() && row + 2 < pane.height; ++row) {
      grid.put(pane.x + 2, pane.y + row + 1, content.at(row), pane.width - 4);
    }
  }
  if (layout_.surface.height > 1 && !message_.empty()) {
    grid.put(0, layout_.surface.height - 1, message_, layout_.surface.width, 1);
  }
  const std::string header =
      R"({"schema":"lemma.surface-update/v1","surface":)" + ext::json_quote(surface_) +
      R"(,"styles":[{},{"faint":true},{"foreground":"#a7bbdf"},{"background":"#303847","foreground":"#e1e6ef"},{"bold":true,"underline":true},{"background":"#303847","foreground":"#a7bbdf","bold":true,"underline":true}],"rows":[)";
  std::string update = header;
  std::size_t nodes = 0;
  for (std::size_t row = 0; row < layout_.surface.height; ++row) {
    auto encoded = grid.row(row);
    if (row < painted_.size() && painted_.at(row) == encoded.text) {
      continue;
    }
    // Tall terminals and heavily highlighted lists must still respect the public parser budget.
    if (nodes + encoded.nodes > api::json_nodes_max - 64) {
      client_.update(update + "]}");
      update = header;
      nodes = 0;
    }
    if (nodes != 0) {
      update += ',';
    }
    nodes += encoded.nodes;
    update += encoded.text;
    if (row >= painted_.size()) {
      painted_.push_back(std::move(encoded.text));
    } else {
      painted_.at(row) = std::move(encoded.text);
    }
  }
  const auto cursor = creating_ ? new_cursor_ : location_.cursor;
  const auto cursor_column = list.width >= 7 ? std::min(list.width - 2, 4 + cursor) : 0;
  update += R"(],"cursor":{"row":)" + std::to_string(list.height >= 5 ? 1 : 0) + R"(,"column":)" +
            std::to_string(cursor_column) + R"(,"visible":)" +
            (list.width >= 7 && list.height >= 5 ? "true}}" : "false}}");
  client_.update(update);
  dirty_ = false;
}

[[nodiscard]] auto failure_reason(const JsonValue& result) -> std::string {
  const auto& values = member(result, "results").array;
  const auto& failure = values.empty() ? result : member(values.back(), "result");
  const auto* error = api::json_member(failure, "error");
  return error == nullptr ? text(failure, "status") : text(*error, "reason");
}

auto SessionManager::mutation(std::string_view request) -> bool {
  const auto result = client_.proc('[' + std::string(request) + ']');
  if (enabled(result, "ok")) {
    return true;
  }
  message_ = "Cannot switch: " + failure_reason(result);
  dirty_ = true;
  refocus();
  return false;
}

auto SessionManager::switch_session(std::string_view id) -> bool {
  if (id == current_) {
    return false;
  }
  const auto request = R"([{"command":"attachment.switch","connection":)" +
                       ext::json_quote(connection_) + R"(,"session":)" + selector(id) + "}]";
  // Only retry the uncommitted transfer, never a preceding tab/pane mutation.
  for (unsigned attempt = 0; attempt < 50; ++attempt) {
    const auto result = client_.proc(request);
    if (enabled(result, "ok")) {
      return false;
    }
    const auto reason = failure_reason(result);
    if (reason != "output_pending") {
      message_ = "Cannot switch: " + reason;
      refocus();
      dirty_ = true;
      return true;
    }
    static_cast<void>(::poll(nullptr, 0, 10));
  }
  message_ = "Output is busy; try again";
  refocus();
  dirty_ = true;
  return true;
}

auto SessionManager::activate() -> bool {
  const auto* choice = selected();
  if (choice == nullptr) {
    return true;
  }
  const auto target = choice->target;
  // Check availability before any selection mutation, including results found below a Session.
  const auto inspected =
      client_.proc(R"([{"command":"session.inspect","session":)" + selector(target.session) + "}]");
  if (!enabled(inspected, "ok")) {
    refresh();
    message_ = "Cannot switch: target disappeared";
    return true;
  }
  const auto& state =
      member(member(member(inspected, "results").array.front(), "result"), "session_state");
  if (target.session != current_ && number(member(state, "attachments"), "connected") != 0) {
    message_ = "Cannot switch: target_attached";
    dirty_ = true;
    return true;
  }
  if (!target.tab.empty()) {
    const auto suffix = R"(,"session":)" + selector(target.session);
    std::string commands = R"({"command":"tab.select","tab":)" + selector(target.tab) + suffix +
                           R"(,"if_session_revision":)" +
                           std::to_string(number(state, "revision")) + '}';
    if (!target.pane.empty()) {
      // Validate the pane first so an already stale pane cannot select its surviving parent tab.
      const auto pane = client_.proc(R"([{"command":"pane.inspect","pane":)" +
                                     selector(target.pane) + suffix + "}]");
      if (!enabled(pane, "ok")) {
        message_ = "Cannot switch: pane disappeared";
        dirty_ = true;
        return true;
      }
      commands += R"(,{"command":"pane.focus","pane":)" + selector(target.pane) + suffix + '}';
    }
    if (!mutation(commands)) {
      return true;
    }
  }
  return switch_session(target.session);
}

// Query editing operates only on bounded, printable display text; transport chunks are not keys.
void SessionManager::edit(std::string_view value) {
  auto& query = creating_ ? new_name_ : location_.query;
  auto& cursor = creating_ ? new_cursor_ : location_.cursor;
  const auto limit = creating_ ? limits::session_name_bytes_max : limits::search_query_bytes_max;
  for (const char character : value) {
    const auto byte = static_cast<unsigned char>(character);
    if (query.size() == limit) {
      break;
    }
    if (byte >= 32 && byte < 127) {
      query.insert(cursor++, 1, static_cast<char>(byte));
    }
  }
  if (!creating_) {
    rebuild(true);
  }
  message_.clear();
  dirty_ = true;
}

// Explicit editor/navigation actions keep printable j/k/n/q available to fuzzy queries.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto SessionManager::key(std::string_view value) -> bool {
  auto& query = creating_ ? new_name_ : location_.query;
  auto& cursor = creating_ ? new_cursor_ : location_.cursor;
  if (value == "escape" || value == "\x03" || value == "\x07") {
    if (!creating_) {
      return false;
    }
    creating_ = false;
    new_name_.clear();
    new_cursor_ = 0;
  } else if (value == "enter" || value == "\r" || value == "\n") {
    if (!creating_) {
      return activate();
    }
    const auto result =
        client_.proc(R"([{"command":"session.start","name":)" + ext::json_quote(new_name_) + "}]");
    if (enabled(result, "ok")) {
      return switch_session(
          text(member(member(member(result, "results").array.front(), "result"), "session"), "id"));
    }
    message_ = "Session name unavailable or invalid";
  } else if (value == "down" || value == "\x0e") {
    if (!creating_) {
      move(1);
    }
  } else if (value == "up" || value == "\x10") {
    if (!creating_) {
      move(-1);
    }
  } else if (value == "tab" || value == "\t") {
    if (!creating_) {
      browse();
    }
  } else if (value == "backtab") {
    if (!creating_) {
      back();
    }
  } else if (value == "\x12") {
    refresh();
  } else if (value == "\x0f") {
    creating_ = true;
    new_name_.clear();
    new_cursor_ = 0;
  } else if (value == "left") {
    cursor = cursor > 0 ? cursor - 1 : 0;
  } else if (value == "right") {
    cursor = std::min(cursor + 1, query.size());
  } else if (value == "home" || value == "\x01") {
    cursor = 0;
  } else if (value == "end" || value == "\x05") {
    cursor = query.size();
  } else if (value == "backspace" || value == "\x7f" || value == "\b") {
    if (cursor > 0) {
      query.erase(--cursor, 1);
      if (!creating_) {
        rebuild(true);
      }
    }
  } else if (value == "delete") {
    if (cursor < query.size()) {
      query.erase(cursor, 1);
      if (!creating_) {
        rebuild(true);
      }
    }
  } else if (value == "\x15") {
    query.erase(0, cursor);
    cursor = 0;
    if (!creating_) {
      rebuild(true);
    }
  } else if (value == "\x17") {
    const auto end = cursor;
    while (cursor > 0 && query.at(cursor - 1) == ' ') {
      --cursor;
    }
    while (cursor > 0 && query.at(cursor - 1) != ' ') {
      --cursor;
    }
    query.erase(cursor, end - cursor);
    if (!creating_) {
      rebuild(true);
    }
  } else {
    edit(value);
  }
  dirty_ = true;
  return true;
}

[[nodiscard]] auto bytes(const JsonValue& event) -> std::string {
  if (api::json_member(event, "text") != nullptr) {
    return text(event, "text");
  }
  const auto hex = text(event, "bytes_hex");
  std::string result;
  for (std::size_t index = 0; index + 1 < hex.size(); index += 2) {
    unsigned byte = 0;
    const auto digits = std::string_view(hex).substr(index, 2);
    // from_chars consumes a bounded iterator pair, not a C string.
    // NOLINTNEXTLINE(bugprone-suspicious-stringview-data-usage)
    if (std::from_chars(digits.data(), std::to_address(digits.end()), byte, 16).ec != std::errc{}) {
      throw std::runtime_error("invalid picker input");
    }
    result += static_cast<char>(byte);
  }
  return result;
}

// Decode a bounded transport chunk, retaining partial escape sequences.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto SessionManager::consume() -> bool {
  while (!pending_.empty()) {
    if (pending_.front() != '\x1b') {
      const auto value = pending_.substr(0, 1);
      pending_.erase(0, 1);
      if (!key(value)) {
        return false;
      }
      continue;
    }
    if (pending_.size() < 2) {
      break;
    }
    const auto end = pending_.find_first_of("ABCDEFGHIJKLMNOPQRSTUVWXYZ~", 2);
    if (end == std::string::npos) {
      break;
    }
    const auto sequence = pending_.substr(0, end + 1);
    pending_.erase(0, end + 1);
    constexpr std::array sequences{std::pair{"\x1b[A", "up"},      std::pair{"\x1b[B", "down"},
                                   std::pair{"\x1b[C", "right"},   std::pair{"\x1b[D", "left"},
                                   std::pair{"\x1b[Z", "backtab"}, std::pair{"\x1b[H", "home"},
                                   std::pair{"\x1b[F", "end"},     std::pair{"\x1b[3~", "delete"},
                                   std::pair{"\x1bOA", "up"},      std::pair{"\x1bOB", "down"}};
    for (const auto& [encoded, logical] : sequences) {
      if (sequence == encoded && !key(logical)) {
        return false;
      }
    }
  }
  if (!pending_.empty()) {
    escape_deadline_ = Clock::now() + std::chrono::milliseconds(50);
  }
  return true;
}

// Physical keys and legacy byte input are two representations of the same user actions.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto SessionManager::event(const JsonValue& value) -> bool {
  if (const auto* presentation = api::json_member(value, "presentation"); presentation != nullptr) {
    if (text(*presentation, "connection") != connection_) {
      return false;
    }
    resize(number(*presentation, "columns"), number(*presentation, "rows"));
  }
  if (text(value, "surface") != surface_) {
    return true;
  }
  const auto type = text(value, "event");
  if (type == "surface.closed") {
    return false;
  }
  if (type == "surface.focused") {
    repairing_ = false;
  }
  if (type == "surface.blurred" && !repairing_) {
    // A shrinking viewport suspends an oversized float before publishing its new presentation.
    // Repair that suspension, but honor an ordinary focus loss/native recovery immediately.
    const auto inspected =
        command(client_, R"({"command":"session.inspect","session":)" + selector(current_) + '}');
    const auto& geometry = member(member(inspected, "session_state"), "geometry");
    if (number(geometry, "columns") == columns_ && number(geometry, "rows") == rows_) {
      return false;
    }
    resize(number(geometry, "columns"), number(geometry, "rows"));
  }
  if (type == "surface.paste") {
    edit(bytes(value));
    return true;
  }
  if (type == "surface.mouse" && number(value, "action") == 0 && number(value, "button") == 1) {
    const auto row = api::json_unsigned(value, "row");
    const auto column = api::json_unsigned(value, "column");
    const auto& list = layout_.list;
    if (row && column && *row >= 3 && *row < list.height - 1 && *column > 0 &&
        *column < list.width - 1) {
      const auto visible = list.height - 4;
      const auto start = selected_index() >= visible ? selected_index() - visible + 1 : 0;
      const auto index = start + static_cast<std::size_t>(*row) - 3;
      if (index < matches_.size()) {
        location_.selected = matches_.at(index).target;
        lost_selection_ = false;
        message_.clear();
        dirty_ = true;
      }
    }
  }
  if (type != "surface.key" || number(value, "action") == 0) {
    return true;
  }
  const auto physical = number(value, "key");
  const auto modifiers = number(value, "modifiers");
  if ((modifiers & 2U) != 0 && physical >= 1 && physical <= 26) {
    pending_.clear();
    return key(std::string(1, static_cast<char>(physical)));
  }
  constexpr std::array keys{
      std::pair{27U, "enter"},  std::pair{28U, "tab"},   std::pair{29U, "backspace"},
      std::pair{30U, "escape"}, std::pair{32U, "up"},    std::pair{33U, "down"},
      std::pair{34U, "left"},   std::pair{35U, "right"}, std::pair{36U, "home"},
      std::pair{37U, "end"},    std::pair{39U, "delete"}};
  for (const auto& [code, logical] : keys) {
    if (physical == code) {
      pending_.clear();
      return key(physical == 28 && (modifiers & 1U) != 0 ? "backtab" : logical);
    }
  }
  pending_ += bytes(value);
  if (pending_.size() > limits::extension_input_bytes_max) {
    return false;
  }
  return consume();
}

// No polling timer while idle. Data work and partial legacy escapes have finite deadlines.
auto SessionManager::turn() -> std::optional<int> {
  if (dirty_) {
    paint();
  }
  fetch();
  if (!wait_ready()) {
    return 1;
  }
  if (!pending_.empty() && Clock::now() >= escape_deadline_) {
    pending_.clear();
    if (!key("escape")) {
      return 0;
    }
  }
  if (job_.has_value() && Clock::now() >= job_->deadline) {
    throw std::runtime_error("picker data request timed out");
  }
  if (!drain_input()) {
    return 0;
  }
  if (!drain_data()) {
    return 1;
  }
  return std::nullopt;
}

auto SessionManager::wait_ready() -> bool {
  auto deadline = job_.has_value() ? job_->deadline : Clock::time_point::max();
  if (!pending_.empty()) {
    deadline = std::min(deadline, escape_deadline_);
  }
  int timeout =
      deadline == Clock::time_point::max()
          ? -1
          : static_cast<int>(std::max<std::int64_t>(
                0, std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now())
                       .count()));
  if (client_.ready() || observer_.ready()) {
    timeout = 0;
  }
  std::array<pollfd, 2> descriptors{
      {{.fd = client_.descriptor(), .events = POLLIN, .revents = 0},
       {.fd = observer_.descriptor(), .events = POLLIN, .revents = 0}}};
  return ::poll(descriptors.data(), static_cast<nfds_t>(descriptors.size()), timeout) >= 0 ||
         errno == EINTR;
}

auto SessionManager::drain_input() -> bool {
  for (unsigned count = 0; count < 32; ++count) {
    auto record = client_.next(0);
    if (!record.has_value()) {
      break;
    }
    if (record->kind == ext::RecordKind::error || !event(record->document)) {
      return false;
    }
  }
  return true;
}

auto SessionManager::drain_data() -> bool {
  for (unsigned count = 0; count < 32; ++count) {
    auto record = observer_.next(0);
    if (!record.has_value()) {
      break;
    }
    if (record->kind == ext::RecordKind::proc_result) {
      reply(*record);
    } else if (const auto* list = api::json_member(record->document, "sessions"); list != nullptr) {
      reconcile(*list);
    } else if (record->kind == ext::RecordKind::error) {
      return false;
    }
  }
  return true;
}

auto SessionManager::run() -> int {
  while (true) {
    if (const auto result = turn(); result.has_value()) {
      return *result;
    }
  }
}

} // namespace

auto run_session_manager(const api::JsonValue& context) -> int {
  return SessionManager(context).run();
}
} // namespace lemma::user
