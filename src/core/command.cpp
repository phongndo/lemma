#include "fiber/command.hpp"

namespace fiber {
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
  case CommandKind::create_window:
  case CommandKind::next_window:
  case CommandKind::previous_window:
  case CommandKind::close_window:
  case CommandKind::select_window:
  case CommandKind::stop_workspace:
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
  return command.kind == CommandKind::select_window ? command.argument < command_window_slots_max
                                                    : command.argument == 0;
}

[[nodiscard]] constexpr auto valid_target(const Command& command) noexcept -> bool {
  if (command.target.pane.is_valid() && !command.target.window.is_valid()) {
    return false;
  }
  if ((command.kind == CommandKind::detach_client || command.kind == CommandKind::stop_workspace) &&
      (command.target.window.is_valid() || command.target.pane.is_valid())) {
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

} // namespace fiber
