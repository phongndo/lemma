#include "lemma/command.hpp"

namespace lemma {
namespace {

[[nodiscard]] constexpr auto valid_kind(const CommandKind kind) noexcept -> bool {
  switch (kind) {
  case CommandKind::none:
    return false;
  case CommandKind::detach_client:
  case CommandKind::split_left_right:
  case CommandKind::split_top_bottom:
  case CommandKind::focus_left:
  case CommandKind::focus_right:
  case CommandKind::focus_up:
  case CommandKind::focus_down:
  case CommandKind::focus_next:
  case CommandKind::focus_previous:
  case CommandKind::close_pane:
  case CommandKind::toggle_zoom:
  case CommandKind::create_tab:
  case CommandKind::next_tab:
  case CommandKind::previous_tab:
  case CommandKind::close_tab:
  case CommandKind::select_tab:
  case CommandKind::stop_session:
    return true;
  }
  return false;
}

[[nodiscard]] constexpr auto valid_origin(const CommandOrigin origin) noexcept -> bool {
  switch (origin) {
  case CommandOrigin::none:
    return false;
  case CommandOrigin::client:
  case CommandOrigin::cli:
  case CommandOrigin::keymap:
  case CommandOrigin::extension:
  case CommandOrigin::internal:
    return true;
  }
  return false;
}

[[nodiscard]] constexpr auto valid_argument(const Command& command) noexcept -> bool {
  return command.kind == CommandKind::select_tab ? command.argument < command_tab_slots_max
                                                 : command.argument == 0;
}

[[nodiscard]] constexpr auto valid_target(const Command& command) noexcept -> bool {
  if (command.target.pane.is_valid() && !command.target.tab.is_valid()) {
    return false;
  }
  if ((command.kind == CommandKind::detach_client || command.kind == CommandKind::stop_session) &&
      (command.target.tab.is_valid() || command.target.pane.is_valid())) {
    return false;
  }
  return true;
}

} // namespace

auto CommandDispatcher::dispatch(const Command& command) const noexcept -> CommandResult {
  if (!valid_kind(command.kind) || !valid_origin(command.origin) || !valid_argument(command)) {
    return {.status = CommandStatus::invalid_command};
  }
  if (!valid_target(command)) {
    return {.status = CommandStatus::invalid_target};
  }
  if (executor_ == nullptr) {
    return {.status = CommandStatus::failed};
  }
  return executor_(context_, command);
}

} // namespace lemma
