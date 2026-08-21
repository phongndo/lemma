#ifndef LEMMA_API_ACTION_HPP
#define LEMMA_API_ACTION_HPP

#include "api/json.hpp"
#include "lemma/id.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace lemma::api {

inline constexpr std::string_view action_schema = "lemma.action/v1";
inline constexpr std::string_view action_result_schema = "lemma.action-result/v1";
inline constexpr std::string_view events_schema = "lemma.events/v1";
inline constexpr std::string_view event_schema = "lemma.event/v1";

enum class ActionKind : std::uint8_t {
  session_list,
  session_inspect,
  session_start,
  session_rename,
  session_kill,
  tab_list,
  tab_new,
  tab_select,
  tab_move,
  tab_rename,
  tab_kill,
  pane_list,
  pane_split,
  pane_focus,
  pane_swap,
  pane_resize,
  pane_zoom,
  pane_send,
  pane_capture,
  pane_kill,
};

enum class Direction : std::uint8_t {
  none,
  left,
  right,
  up,
  down,
};

struct SessionSelector final {
  SessionId id;
  std::string name;

  [[nodiscard]] auto valid() const noexcept -> bool { return id.is_valid() || !name.empty(); }
};

struct TabSelector final {
  TabId id;
  std::uint16_t position{0};

  [[nodiscard]] auto valid() const noexcept -> bool { return id.is_valid() || position > 0; }
};

struct PaneSelector final {
  PaneId id;

  [[nodiscard]] auto valid() const noexcept -> bool { return id.is_valid(); }
};

// One concrete public Action. Action-specific decoding guarantees that only the fields belonging to
// kind are populated before this value crosses the daemon trust boundary.
struct Action final {
  ActionKind kind{ActionKind::session_list};
  SessionSelector session;
  TabSelector tab;
  PaneSelector pane;
  PaneSelector other;
  std::string name;
  std::string working_directory;
  std::string title;
  std::string text;
  std::vector<std::string> arguments;
  std::vector<std::string> environment;
  Direction direction{Direction::none};
  std::uint16_t amount{0};
  std::uint16_t lines{0};
  std::uint16_t to_position{0};
  bool hold{false};
  bool enabled{false};
  bool environment_set{false};
};

struct ActionDecodeError final {
  std::string_view reason;
  std::string_view field;
};

struct ActionDecodeResult final {
  std::optional<Action> action;
  ActionDecodeError error;
};

[[nodiscard]] auto decode_action(const JsonValue& document) -> ActionDecodeResult;
[[nodiscard]] auto encode_action(const Action& action) -> std::optional<std::string>;
[[nodiscard]] auto action_name(ActionKind kind) noexcept -> std::string_view;

struct EventSubscription final {
  std::optional<SessionSelector> session;
  std::optional<PaneSelector> pane;
  bool screen{false};
};

struct EventSubscriptionDecodeResult final {
  std::optional<EventSubscription> subscription;
  ActionDecodeError error;
};

[[nodiscard]] auto decode_event_subscription(const JsonValue& document)
    -> EventSubscriptionDecodeResult;

} // namespace lemma::api

#endif // LEMMA_API_ACTION_HPP
