#ifndef LEMMA_API_OP_HPP
#define LEMMA_API_OP_HPP

#include "api/json.hpp"
#include "lemma/id.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace lemma::api {

inline constexpr std::string_view op_result_schema = "lemma.op-result/v1";
inline constexpr std::string_view events_schema = "lemma.events/v1";
inline constexpr std::string_view event_schema = "lemma.event/v1";

enum class OpKind : std::uint8_t {
  daemon_inspect,
  session_list,
  session_inspect,
  session_start,
  session_rename,
  session_kill,
  tab_list,
  tab_inspect,
  tab_new,
  tab_select,
  tab_move,
  tab_rename,
  tab_kill,
  pane_list,
  pane_inspect,
  pane_split,
  pane_focus,
  pane_swap,
  pane_resize,
  pane_zoom,
  pane_send,
  pane_input,
  pane_capture,
  pane_wait,
  pane_kill,
};

enum class Direction : std::uint8_t {
  none,
  left,
  right,
  up,
  down,
};

enum class FocusPolicy : std::uint8_t {
  created,
  preserve,
};

enum class CaptureSource : std::uint8_t {
  visible,
  recent,
  last_command,
};

enum class CaptureFormat : std::uint8_t {
  plain,
  ansi,
};

enum class CaptureWrap : std::uint8_t {
  rendered,
  logical,
};

enum class WaitCondition : std::uint8_t {
  process_exit,
  exit_code,
  signal,
  contains,
  prompt,
};

inline constexpr std::uint32_t wait_timeout_default_milliseconds = 30'000;
inline constexpr std::uint32_t wait_timeout_max_milliseconds = 600'000;

[[nodiscard]] auto wait_condition_name(WaitCondition condition) noexcept -> std::string_view;

enum class InputEventKind : std::uint8_t {
  text,
  paste,
  key,
};

enum class InputKeyAction : std::uint8_t {
  press,
  repeat,
  release,
};

enum class InputKey : std::uint8_t {
  a,
  b,
  c,
  d,
  e,
  f,
  g,
  h,
  i,
  j,
  k,
  l,
  m,
  n,
  o,
  p,
  q,
  r,
  s,
  t,
  u,
  v,
  w,
  x,
  y,
  z,
  enter,
  tab,
  backspace,
  escape,
  space,
  arrow_up,
  arrow_down,
  arrow_left,
  arrow_right,
  home,
  end,
  insert,
  delete_key,
  page_up,
  page_down,
  f1,
  f2,
  f3,
  f4,
  f5,
  f6,
  f7,
  f8,
  f9,
  f10,
  f11,
  f12,
};

inline constexpr std::size_t input_events_max = 64;
inline constexpr std::uint16_t input_modifier_shift = 1U << 0U;
inline constexpr std::uint16_t input_modifier_control = 1U << 1U;
inline constexpr std::uint16_t input_modifier_alt = 1U << 2U;
inline constexpr std::uint16_t input_modifier_super = 1U << 3U;

struct InputEvent final {
  InputEventKind kind{InputEventKind::text};
  std::string text;
  InputKey key{InputKey::a};
  std::uint16_t modifiers{0};
  InputKeyAction action{InputKeyAction::press};
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

// One concrete public Op. Op-specific decoding guarantees that only the fields belonging to
// kind are populated before this value crosses the daemon trust boundary.
struct Op final {
  OpKind kind{OpKind::session_list};
  SessionSelector session;
  TabSelector tab;
  PaneSelector pane;
  PaneSelector other;
  std::string name;
  std::string working_directory;
  std::string title;
  std::string text;
  std::string contains;
  std::vector<std::string> arguments;
  std::vector<std::string> environment;
  std::vector<InputEvent> input_events;
  Direction direction{Direction::none};
  FocusPolicy focus{FocusPolicy::created};
  CaptureSource capture_source{CaptureSource::visible};
  CaptureFormat capture_format{CaptureFormat::plain};
  CaptureWrap capture_wrap{CaptureWrap::rendered};
  WaitCondition wait_condition{WaitCondition::process_exit};
  std::uint64_t after_terminal_generation{0};
  std::uint32_t wait_value{0};
  std::uint32_t wait_timeout_milliseconds{wait_timeout_default_milliseconds};
  std::uint16_t amount{0};
  std::uint16_t lines{0};
  std::uint16_t to_position{0};
  std::optional<std::uint64_t> expected_session_revision;
  bool hold{false};
  bool enabled{false};
  bool environment_set{false};
};

[[nodiscard]] auto parse_input_key_name(std::string_view value) noexcept -> std::optional<InputKey>;
[[nodiscard]] auto input_key_name(InputKey key) noexcept -> std::string_view;
[[nodiscard]] auto append_capture(std::string& output, CaptureSource source, CaptureFormat format,
                                  CaptureWrap wrap, std::uint64_t terminal_generation,
                                  bool truncated, std::string_view text) -> bool;

struct OpDecodeError final {
  std::string_view reason;
  std::string_view field;
};

struct OpDecodeResult final {
  std::optional<Op> op;
  OpDecodeError error;
};

[[nodiscard]] auto decode_op(const JsonValue& document) -> OpDecodeResult;
[[nodiscard]] auto encode_op(const Op& op) -> std::optional<std::string>;
[[nodiscard]] auto op_name(OpKind kind) noexcept -> std::string_view;

inline constexpr std::size_t event_panes_max = 8;

struct EventSubscription final {
  std::optional<SessionSelector> session;
  std::vector<PaneSelector> panes;
  bool screen{false};
};

struct EventSubscriptionDecodeResult final {
  std::optional<EventSubscription> subscription;
  OpDecodeError error;
};

[[nodiscard]] auto decode_event_subscription(const JsonValue& document)
    -> EventSubscriptionDecodeResult;

} // namespace lemma::api

#endif // LEMMA_API_OP_HPP
