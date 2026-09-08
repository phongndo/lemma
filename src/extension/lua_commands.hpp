#ifndef LEMMA_EXTENSION_LUA_COMMANDS_HPP
#define LEMMA_EXTENSION_LUA_COMMANDS_HPP

#include "extension/commands.hpp"

#include <array>
#include <vector>

struct lua_State;

namespace lemma::extension {

struct LuaCommands final {
  std::vector<CommandDescriptor> descriptors;
  std::array<int, commands_max> callbacks{};
  int invocation_wrapper{0};
  bool published{false};
};

// Installs lemma.command into the module table at the top of the Lua stack.
void install_commands(lua_State* state, LuaCommands& commands);
[[nodiscard]] auto run_commands(lua_State* state, LuaCommands& commands, int descriptor) noexcept
    -> int;

} // namespace lemma::extension

#endif // LEMMA_EXTENSION_LUA_COMMANDS_HPP
