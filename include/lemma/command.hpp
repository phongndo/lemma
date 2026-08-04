#ifndef LEMMA_COMMAND_HPP
#define LEMMA_COMMAND_HPP

#include "lemma/id.hpp"

#include <cstdint>

namespace lemma {

inline constexpr std::uint16_t command_tab_slots_max = 16;

enum class CommandKind : std::uint8_t {
  none = 0,
  detach_client,
  split_left_right,
  split_top_bottom,
  focus_left,
  focus_right,
  focus_up,
  focus_down,
  focus_next,
  focus_previous,
  close_pane,
  toggle_zoom,
  create_tab,
  next_tab,
  previous_tab,
  close_tab,
  select_tab,
  stop_session,
};

enum class CommandOrigin : std::uint8_t {
  none = 0,
  client,
  cli,
  keymap,
  extension,
  internal,
};

// Invalid IDs mean "the current object". Explicit IDs are retained in the command value so future
// CLI, remote, and extension transports can use the same dispatcher without exposing core pointers.
struct CommandTarget final {
  SessionId session;
  TabId tab;
  PaneId pane;
};

struct Command final {
  CommandKind kind{CommandKind::none};
  CommandOrigin origin{CommandOrigin::none};
  CommandTarget target{};
  // select_tab uses a zero-based bounded slot. Other current commands require zero.
  std::uint16_t argument{0};
};

enum class CommandStatus : std::uint8_t {
  applied,
  no_effect,
  detach_requested,
  invalid_command,
  invalid_target,
  unavailable,
  failed,
};

struct CommandResult final {
  CommandStatus status{CommandStatus::failed};

  [[nodiscard]] constexpr auto succeeded() const noexcept -> bool {
    return status == CommandStatus::applied || status == CommandStatus::no_effect ||
           status == CommandStatus::detach_requested;
  }
};

using CommandExecutor = CommandResult (*)(void* context, const Command& command) noexcept;

// Validates bounded command values before invoking the reactor-owned state transition function.
// The dispatcher itself performs no allocation or I/O.
class CommandDispatcher final {
public:
  constexpr CommandDispatcher(const CommandExecutor executor, void* const context) noexcept
      : executor_(executor), context_(context) {}

  [[nodiscard]] auto dispatch(const Command& command) const noexcept -> CommandResult;

private:
  CommandExecutor executor_{nullptr};
  void* context_{nullptr};
};

} // namespace lemma

#endif // LEMMA_COMMAND_HPP
