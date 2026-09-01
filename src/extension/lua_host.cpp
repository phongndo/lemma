#include "extension/lua_host.hpp"

#include "config/config.hpp"
#include "input/input_router.hpp"
#include "lemma/limits.hpp"
#include "platform/io.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <utility>

#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

extern "C" {
#include <lauxlib.h>
#include <lua.h>
#include <lualib.h>
}

namespace lemma::extension {
namespace {

using platform::close_descriptor;

inline constexpr std::array<std::byte, 4> host_magic{std::byte{'L'}, std::byte{'M'}, std::byte{'C'},
                                                     std::byte{'F'}};
inline constexpr std::size_t host_header_bytes = 12;
inline constexpr std::size_t diagnostic_bytes_max = 4'096;
inline constexpr std::size_t lua_memory_bytes_max = std::size_t{64} * 1'024U * 1'024U;
inline constexpr auto startup_timeout = std::chrono::seconds(2);

enum class HostMessageStatus : std::uint8_t {
  configured = 1,
  failed = 2,
};

struct LuaAllocator final {
  std::size_t used{0};
};

struct LuaConfiguration final {
  config::Configuration configuration;
};

[[nodiscard]] auto host_configuration(lua_State* const state) noexcept -> LuaConfiguration& {
  return *static_cast<LuaConfiguration*>(lua_touserdata(state, lua_upvalueindex(1)));
}

[[nodiscard]] auto lua_allocate(void* const context, void* const pointer,
                                const std::size_t old_size, const std::size_t new_size) noexcept
    -> void* {
  auto& allocator = *static_cast<LuaAllocator*>(context);
  const auto accounted_old_size = pointer == nullptr ? 0U : old_size;
  if (new_size == 0U) {
    // Lua's allocator contract requires realloc-compatible storage.
    // NOLINTNEXTLINE(cppcoreguidelines-no-malloc)
    std::free(pointer);
    allocator.used =
        accounted_old_size <= allocator.used ? allocator.used - accounted_old_size : 0U;
    return nullptr;
  }
  const auto retained =
      accounted_old_size <= allocator.used ? allocator.used - accounted_old_size : 0U;
  if (new_size > lua_memory_bytes_max - retained) {
    return nullptr;
  }
  // Lua's allocator contract requires realloc-compatible storage.
  // NOLINTNEXTLINE(cppcoreguidelines-no-malloc)
  void* const resized = std::realloc(pointer, new_size);
  if (resized != nullptr) {
    allocator.used = retained + new_size;
  }
  return resized;
}

[[nodiscard]] auto raise_lua_error(lua_State* const state, const std::string_view message) noexcept
    -> int {
  lua_pushlstring(state, message.data(), message.size());
  return lua_error(state);
}

[[nodiscard]] auto lua_table_key(lua_State* const state) noexcept
    -> std::optional<std::string_view> {
  if (lua_type(state, -2) != LUA_TSTRING) {
    return std::nullopt;
  }
  std::size_t size = 0;
  const char* const data = lua_tolstring(state, -2, &size);
  return data == nullptr ? std::nullopt : std::optional<std::string_view>{{data, size}};
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto read_input_options(lua_State* const state, const int table,
                                      input::InputMapConfiguration& target) -> int {
  const auto absolute = lua_absindex(state, table);
  std::optional<input::InputMapPreset> preset;
  std::optional<input::InputChord> prefix;
  bool prefix_seen = false;
  lua_pushnil(state);
  while (lua_next(state, absolute) != 0) {
    const auto key = lua_table_key(state);
    if (!key.has_value()) {
      return raise_lua_error(state, "lemma.setup.input keys must be strings");
    }
    if (*key == "preset") {
      std::size_t size = 0;
      const char* const value = luaL_checklstring(state, -1, &size);
      if (std::string_view(value, size) == "default") {
        preset = input::InputMapPreset::defaults;
      } else if (std::string_view(value, size) == "none") {
        preset = input::InputMapPreset::none;
      } else {
        return raise_lua_error(state, "input.preset must be 'default' or 'none'");
      }
    } else if (*key == "prefix") {
      prefix_seen = true;
      if (lua_type(state, -1) == LUA_TBOOLEAN && lua_toboolean(state, -1) == 0) {
        prefix = std::nullopt;
      } else {
        std::size_t size = 0;
        const char* const value = luaL_checklstring(state, -1, &size);
        prefix = config::parse_key({value, size});
        if (!prefix.has_value()) {
          return raise_lua_error(state, "invalid input.prefix key");
        }
      }
    } else {
      return raise_lua_error(state, "unknown lemma.setup.input option");
    }
    lua_pop(state, 1);
  }
  if (preset.has_value()) {
    target.reset(*preset);
  }
  if (prefix_seen && !target.set_prefix(prefix)) {
    return raise_lua_error(state, "Lemma keymap capacity reached while setting input.prefix");
  }
  return 0;
}

[[nodiscard]] auto read_terminal_options(lua_State* const state, const int table,
                                         config::TerminalConfiguration& target) -> int {
  const auto absolute = lua_absindex(state, table);
  lua_pushnil(state);
  while (lua_next(state, absolute) != 0) {
    const auto key = lua_table_key(state);
    if (key != std::optional<std::string_view>{"scrollback_lines"}) {
      return raise_lua_error(state, "unknown lemma.setup.terminal option");
    }
    if (lua_type(state, -1) == LUA_TBOOLEAN && lua_toboolean(state, -1) == 0) {
      target.scrollback_lines = std::nullopt;
    } else if (lua_isinteger(state, -1) == 0) {
      return raise_lua_error(state, "terminal.scrollback_lines must be an integer or false");
    } else {
      const auto lines = lua_tointeger(state, -1);
      if (lines < 0 || std::cmp_greater(lines, limits::terminal_scrollback_lines_hard_max)) {
        return raise_lua_error(state, "terminal.scrollback_lines is out of range");
      }
      target.scrollback_lines = static_cast<std::size_t>(lines);
    }
    lua_pop(state, 1);
  }
  return 0;
}

[[nodiscard]] auto read_ui_options(lua_State* const state, const int table,
                                   config::UiConfiguration& target) -> int {
  const auto absolute = lua_absindex(state, table);
  lua_pushnil(state);
  while (lua_next(state, absolute) != 0) {
    const auto key = lua_table_key(state);
    if (key != std::optional<std::string_view>{"status_line"} ||
        lua_type(state, -1) != LUA_TBOOLEAN) {
      return raise_lua_error(state, "ui.status_line must be a boolean");
    }
    target.status_line = lua_toboolean(state, -1) != 0;
    lua_pop(state, 1);
  }
  return 0;
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto read_default_program(lua_State* const state, const int table,
                                        config::LaunchConfiguration& target) -> int {
  const auto absolute = lua_absindex(state, table);
  const auto count = lua_rawlen(state, absolute);
  if (count > config::default_program_arguments_max) {
    return raise_lua_error(state, "launch.default_program has too many arguments");
  }
  try {
    target.default_program.clear();
    target.default_program.reserve(count);
  } catch (...) {
    return raise_lua_error(state, "launch.default_program allocation failed");
  }
  std::size_t bytes = 0;
  for (std::size_t index = 1; index <= count; ++index) {
    lua_rawgeti(state, absolute, static_cast<lua_Integer>(index));
    if (lua_type(state, -1) != LUA_TSTRING) {
      return raise_lua_error(state, "launch.default_program must be an array of strings");
    }
    std::size_t size = 0;
    const char* const value = lua_tolstring(state, -1, &size);
    if ((index == 1U && size == 0U) || value == nullptr ||
        size + 1U > config::default_program_bytes_max - bytes) {
      return raise_lua_error(state, "launch.default_program is invalid or too large");
    }
    try {
      target.default_program.emplace_back(value, size);
    } catch (...) {
      return raise_lua_error(state, "launch.default_program allocation failed");
    }
    bytes += size + 1U;
    lua_pop(state, 1);
  }
  std::size_t members = 0;
  lua_pushnil(state);
  while (lua_next(state, absolute) != 0) {
    const auto index = lua_isinteger(state, -2) != 0 ? lua_tointeger(state, -2) : lua_Integer{0};
    if (index <= 0 || static_cast<std::size_t>(index) > count) {
      return raise_lua_error(state, "launch.default_program must be a dense array");
    }
    ++members;
    lua_pop(state, 1);
  }
  return members == count ? 0
                          : raise_lua_error(state, "launch.default_program must be a dense array");
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto read_launch_options(lua_State* const state, const int table,
                                       config::LaunchConfiguration& target) -> int {
  const auto absolute = lua_absindex(state, table);
  lua_pushnil(state);
  while (lua_next(state, absolute) != 0) {
    const auto key = lua_table_key(state);
    if (!key.has_value()) {
      return raise_lua_error(state, "lemma.setup.launch keys must be strings");
    }
    if (*key == "default_cwd") {
      std::size_t size = 0;
      const char* const value = luaL_checklstring(state, -1, &size);
      if (size > limits::working_directory_bytes_max || value == nullptr ||
          std::string_view(value, size).contains('\0') || (size > 0U && *value != '/')) {
        return raise_lua_error(state, "launch.default_cwd must be empty or absolute");
      }
      try {
        target.default_cwd.assign(value, size);
      } catch (...) {
        return raise_lua_error(state, "launch.default_cwd allocation failed");
      }
    } else if (*key == "default_program") {
      luaL_checktype(state, -1, LUA_TTABLE);
      if (read_default_program(state, -1, target) != 0) {
        return 0;
      }
    } else {
      return raise_lua_error(state, "unknown lemma.setup.launch option");
    }
    lua_pop(state, 1);
  }
  return 0;
}

[[nodiscard]] auto config_setup(lua_State* const state) -> int {
  luaL_checktype(state, 1, LUA_TTABLE);
  auto& target = host_configuration(state).configuration;
  lua_pushnil(state);
  while (lua_next(state, 1) != 0) {
    const auto key = lua_table_key(state);
    if (!key.has_value()) {
      return raise_lua_error(state, "lemma.setup keys must be strings");
    }
    luaL_checktype(state, -1, LUA_TTABLE);
    if ((*key == "input" && read_input_options(state, -1, target.input) != 0) ||
        (*key == "terminal" && read_terminal_options(state, -1, target.terminal) != 0) ||
        (*key == "ui" && read_ui_options(state, -1, target.ui) != 0) ||
        (*key == "launch" && read_launch_options(state, -1, target.launch) != 0)) {
      return 0;
    }
    if (*key != "input" && *key != "terminal" && *key != "ui" && *key != "launch") {
      return raise_lua_error(state, "unknown lemma.setup option");
    }
    lua_pop(state, 1);
  }
  return 0;
}

[[nodiscard]] auto
command_binding_action(lua_State* const state, const int index,
                       const input::CommandContextDisposition disposition) noexcept
    -> std::optional<input::ConfiguredBindingAction> {
  std::size_t size = 0;
  const char* const value = lua_tolstring(state, index, &size);
  const auto command = value == nullptr ? std::optional<input::InputCommand>{}
                                        : config::parse_command({value, size});
  return command.has_value() ? std::optional{input::ConfiguredBindingAction{
                                   .kind = input::ConfiguredBindingKind::command,
                                   .command = *command,
                                   .disposition = disposition}}
                             : std::nullopt;
}

[[nodiscard]] auto table_string_field(lua_State* const state, const int table,
                                      const char* const field) noexcept -> std::string_view {
  lua_getfield(state, table, field);
  std::size_t size = 0;
  const char* const data = lua_tolstring(state, -1, &size);
  const auto value = data == nullptr ? std::string_view{} : std::string_view(data, size);
  lua_pop(state, 1);
  return value;
}

[[nodiscard]] auto push_binding_action(lua_State* const state, const int table) noexcept
    -> std::optional<input::ConfiguredBindingAction> {
  const auto context = config::parse_context(table_string_field(state, table, "context"));
  lua_getfield(state, table, "defer");
  const bool defer = lua_type(state, -1) == LUA_TBOOLEAN && lua_toboolean(state, -1) != 0;
  lua_pop(state, 1);
  if (!context.has_value()) {
    return std::nullopt;
  }
  return input::ConfiguredBindingAction{
      .kind = input::ConfiguredBindingKind::push_context, .target = *context, .defer_chord = defer};
}

[[nodiscard]] constexpr auto send_physical_key(const input::InputChord chord) noexcept
    -> std::optional<input::PhysicalKey> {
  if (chord.kind == input::ChordKind::key &&
      chord.code < static_cast<std::uint16_t>(input::PhysicalKey::count)) {
    return static_cast<input::PhysicalKey>(chord.code);
  }
  if (chord.kind != input::ChordKind::byte) {
    return std::nullopt;
  }
  switch (chord.code) {
  case 0x0DU:
    return input::PhysicalKey::enter;
  case 0x09U:
    return input::PhysicalKey::tab;
  case 0x7FU:
    return input::PhysicalKey::backspace;
  case 0x1BU:
    return input::PhysicalKey::escape;
  case 0x20U:
    return input::PhysicalKey::space;
  default:
    return std::nullopt;
  }
}

[[nodiscard]] auto send_binding_action(lua_State* const state, const int table) noexcept
    -> std::optional<input::ConfiguredBindingAction> {
  const auto key = config::parse_key(table_string_field(state, table, "key"));
  const auto physical = key.has_value() ? send_physical_key(*key) : std::nullopt;
  if (!physical.has_value()) {
    return std::nullopt;
  }
  return input::ConfiguredBindingAction{.kind = input::ConfiguredBindingKind::send_key,
                                        .encoded_key = *physical,
                                        .encoded_modifiers = key->modifiers};
}

[[nodiscard]] auto binding_action(lua_State* const state, const int index,
                                  const input::CommandContextDisposition disposition) noexcept
    -> std::optional<input::ConfiguredBindingAction> {
  if (lua_type(state, index) == LUA_TSTRING) {
    return command_binding_action(state, index, disposition);
  }
  if (lua_type(state, index) != LUA_TTABLE) {
    return std::nullopt;
  }
  const auto table = lua_absindex(state, index);
  const auto kind = table_string_field(state, table, "kind");
  if (kind == "push") {
    return push_binding_action(state, table);
  }
  if (kind == "pop" || kind == "replay") {
    return input::ConfiguredBindingAction{
        .kind = kind == "pop" ? input::ConfiguredBindingKind::pop_context
                              : input::ConfiguredBindingKind::replay_deferred};
  }
  if (kind == "send") {
    return send_binding_action(state, table);
  }
  return std::nullopt;
}

[[nodiscard]] auto keymap_set(lua_State* const state) -> int {
  std::size_t context_size = 0;
  std::size_t key_size = 0;
  const char* const context_data = luaL_checklstring(state, 1, &context_size);
  const char* const key_data = luaL_checklstring(state, 2, &key_size);
  const auto context = config::parse_context({context_data, context_size});
  const auto chord = config::parse_key({key_data, key_size});
  if (!context.has_value()) {
    return raise_lua_error(state, "invalid Lemma keymap context");
  }
  if (!chord.has_value()) {
    return raise_lua_error(state, "invalid Lemma key");
  }
  auto disposition = input::CommandContextDisposition::retain;
  if (!lua_isnoneornil(state, 4)) {
    std::size_t disposition_size = 0;
    const char* const disposition_data = luaL_checklstring(state, 4, &disposition_size);
    const std::string_view value(disposition_data, disposition_size);
    if (value == "base") {
      disposition = input::CommandContextDisposition::base;
    } else if (value != "retain") {
      return raise_lua_error(state, "keymap disposition must be 'retain' or 'base'");
    }
  }
  const auto action = binding_action(state, 3, disposition);
  if (!action.has_value()) {
    return raise_lua_error(state, "invalid Lemma keymap action");
  }
  if (!host_configuration(state).configuration.input.set_action(*context, *chord, *action)) {
    return raise_lua_error(state, "Lemma keymap capacity reached");
  }
  return 0;
}

[[nodiscard]] auto push_action(lua_State* const state, const std::string_view kind) -> int {
  lua_createtable(state, 0, 3);
  lua_pushlstring(state, kind.data(), kind.size());
  lua_setfield(state, -2, "kind");
  return 1;
}

[[nodiscard]] auto context_push(lua_State* const state) -> int {
  std::size_t size = 0;
  const char* const value = luaL_checklstring(state, 1, &size);
  if (!config::parse_context({value, size}).has_value()) {
    return raise_lua_error(state, "invalid Lemma input context");
  }
  static_cast<void>(push_action(state, "push"));
  lua_pushlstring(state, value, size);
  lua_setfield(state, -2, "context");
  bool defer = false;
  if (!lua_isnoneornil(state, 2)) {
    luaL_checktype(state, 2, LUA_TTABLE);
    lua_getfield(state, 2, "defer");
    if (!lua_isnil(state, -1) && lua_type(state, -1) != LUA_TBOOLEAN) {
      return raise_lua_error(state, "context.push defer must be a boolean");
    }
    defer = lua_toboolean(state, -1) != 0;
    lua_pop(state, 1);
  }
  lua_pushboolean(state, defer ? 1 : 0);
  lua_setfield(state, -2, "defer");
  return 1;
}

[[nodiscard]] auto context_pop(lua_State* const state) -> int { return push_action(state, "pop"); }

[[nodiscard]] auto keymap_replay(lua_State* const state) -> int {
  return push_action(state, "replay");
}

[[nodiscard]] auto keymap_send(lua_State* const state) -> int {
  std::size_t size = 0;
  const char* const value = luaL_checklstring(state, 1, &size);
  const auto key = config::parse_key({value, size});
  if (!key.has_value() || !send_physical_key(*key).has_value()) {
    return raise_lua_error(state, "keymap.send requires a named physical key");
  }
  static_cast<void>(push_action(state, "send"));
  lua_pushlstring(state, value, size);
  lua_setfield(state, -2, "key");
  return 1;
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto context_set(lua_State* const state) -> int {
  std::size_t size = 0;
  const char* const value = luaL_checklstring(state, 1, &size);
  const auto context = config::parse_context({value, size});
  luaL_checktype(state, 2, LUA_TTABLE);
  if (!context.has_value()) {
    return raise_lua_error(state, "invalid Lemma input context");
  }
  auto& input = host_configuration(state).configuration.input;
  const auto& current = input.contexts.at(static_cast<std::size_t>(*context));
  std::array<char, input::input_context_label_bytes_max> label = current.label;
  std::size_t label_size = current.label_size;
  auto lifetime = current.lifetime;
  auto unbound = current.unbound;
  bool preempts = current.preempts_interaction;
  lua_pushnil(state);
  while (lua_next(state, 2) != 0) {
    const auto key = lua_table_key(state);
    if (!key.has_value()) {
      return raise_lua_error(state, "lemma.context.set keys must be strings");
    }
    if (*key == "label") {
      std::size_t configured_size = 0;
      const char* const configured = luaL_checklstring(state, -1, &configured_size);
      if (configured_size > label.size() ||
          std::string_view(configured, configured_size).contains('\0')) {
        return raise_lua_error(state, "context label is too large or invalid");
      }
      label = {};
      std::ranges::copy(std::string_view(configured, configured_size), label.begin());
      label_size = configured_size;
    } else if (*key == "lifetime") {
      std::size_t configured_size = 0;
      const char* const configured = luaL_checklstring(state, -1, &configured_size);
      const std::string_view selected(configured, configured_size);
      if (selected == "persistent") {
        lifetime = input::ContextLifetime::persistent;
      } else if (selected == "one_shot") {
        lifetime = input::ContextLifetime::one_shot;
      } else {
        return raise_lua_error(state, "context lifetime must be 'persistent' or 'one_shot'");
      }
    } else if (*key == "unbound") {
      std::size_t configured_size = 0;
      const char* const configured = luaL_checklstring(state, -1, &configured_size);
      const std::string_view selected(configured, configured_size);
      if (selected == "forward") {
        unbound = input::UnboundBehavior::forward;
      } else if (selected == "replay") {
        unbound = input::UnboundBehavior::replay_deferred;
      } else if (selected == "consume") {
        unbound = input::UnboundBehavior::consume;
      } else if (selected == "retry") {
        unbound = input::UnboundBehavior::retry_base;
      } else {
        return raise_lua_error(state, "invalid context unbound behavior");
      }
    } else if (*key == "preempts") {
      if (lua_type(state, -1) != LUA_TBOOLEAN) {
        return raise_lua_error(state, "context preempts must be a boolean");
      }
      preempts = lua_toboolean(state, -1) != 0;
    } else {
      return raise_lua_error(state, "unknown lemma.context.set option");
    }
    lua_pop(state, 1);
  }
  if (!input.set_context(*context, {.label = std::string_view(label.data(), label_size),
                                    .lifetime = lifetime,
                                    .unbound = unbound,
                                    .preempts_interaction = preempts})) {
    return raise_lua_error(state, "invalid Lemma context options");
  }
  return 0;
}

[[nodiscard]] auto keymap_del(lua_State* const state) -> int {
  std::size_t context_size = 0;
  std::size_t key_size = 0;
  const char* const context_data = luaL_checklstring(state, 1, &context_size);
  const char* const key_data = luaL_checklstring(state, 2, &key_size);
  const auto context = config::parse_context({context_data, context_size});
  const auto chord = config::parse_key({key_data, key_size});
  if (!context.has_value()) {
    return raise_lua_error(state, "invalid Lemma keymap context");
  }
  if (!chord.has_value()) {
    return raise_lua_error(state, "invalid Lemma key");
  }
  if (!host_configuration(state).configuration.input.unbind(*context, *chord)) {
    return raise_lua_error(state, "Lemma keymap override capacity reached");
  }
  return 0;
}

void set_host_function(lua_State* const state, LuaConfiguration& configuration, const char* name,
                       lua_CFunction function) {
  lua_pushlightuserdata(state, &configuration);
  lua_pushcclosure(state, function, 1);
  lua_setfield(state, -2, name);
}

void install_lemma_module(lua_State* const state, LuaConfiguration& configuration) {
  lua_createtable(state, 0, 3);
  set_host_function(state, configuration, "setup", &config_setup);
  lua_createtable(state, 0, 4);
  set_host_function(state, configuration, "set", &keymap_set);
  set_host_function(state, configuration, "del", &keymap_del);
  set_host_function(state, configuration, "replay", &keymap_replay);
  set_host_function(state, configuration, "send", &keymap_send);
  lua_setfield(state, -2, "keymap");
  lua_createtable(state, 0, 3);
  set_host_function(state, configuration, "set", &context_set);
  set_host_function(state, configuration, "push", &context_push);
  set_host_function(state, configuration, "pop", &context_pop);
  lua_setfield(state, -2, "context");
  lua_getfield(state, LUA_REGISTRYINDEX, LUA_LOADED_TABLE);
  lua_pushvalue(state, -2);
  lua_setfield(state, -2, "lemma");
  lua_pop(state, 2);
}

[[nodiscard]] auto install_config_search_path(lua_State* const state,
                                              const std::string& path) noexcept -> bool {
  try {
    const auto separator = path.find_last_of('/');
    const auto directory =
        separator == std::string::npos ? std::string{"."} : path.substr(0, separator);
    lua_getglobal(state, "package");
    if (!lua_istable(state, -1)) {
      lua_pop(state, 1);
      return false;
    }
    lua_getfield(state, -1, "path");
    std::size_t existing_size = 0;
    const char* const existing = lua_tolstring(state, -1, &existing_size);
    std::string search = directory + "/?.lua;" + directory + "/?/init.lua;";
    if (existing != nullptr) {
      search.append(existing, existing_size);
    }
    lua_pop(state, 1);
    lua_pushlstring(state, search.data(), search.size());
    lua_setfield(state, -2, "path");
    lua_pop(state, 1);
    return true;
  } catch (...) {
    return false;
  }
}

[[nodiscard]] auto append_diagnostic(const std::string_view prefix,
                                     const std::string_view detail) noexcept -> std::string {
  try {
    std::string result(prefix);
    const auto available =
        diagnostic_bytes_max > result.size() ? diagnostic_bytes_max - result.size() : 0U;
    result.append(detail.substr(0, available));
    return result;
  } catch (...) {
    return {};
  }
}

[[nodiscard]] auto encode_header(const HostMessageStatus status, const std::size_t size) noexcept
    -> std::array<std::byte, host_header_bytes> {
  const auto bounded = static_cast<std::uint32_t>(size);
  return {host_magic.at(0),
          host_magic.at(1),
          host_magic.at(2),
          host_magic.at(3),
          std::byte{1},
          std::byte{0},
          static_cast<std::byte>(status),
          std::byte{0},
          static_cast<std::byte>((bounded >> 24U) & 0xFFU),
          static_cast<std::byte>((bounded >> 16U) & 0xFFU),
          static_cast<std::byte>((bounded >> 8U) & 0xFFU),
          static_cast<std::byte>(bounded & 0xFFU)};
}

[[nodiscard]] auto send_host_message(const int descriptor, const HostMessageStatus status,
                                     const std::string_view payload) noexcept -> bool {
  const auto header = encode_header(status, payload.size());
  return platform::write_all(descriptor, header) &&
         platform::write_all(descriptor, std::as_bytes(std::span(payload.data(), payload.size())));
}

[[nodiscard]] auto run_host(const int descriptor, const std::string& path) noexcept -> int {
  LuaAllocator allocator;
  lua_State* const state = lua_newstate(&lua_allocate, &allocator);
  if (state == nullptr) {
    static_cast<void>(send_host_message(descriptor, HostMessageStatus::failed,
                                        "failed to allocate Lua configuration runtime"));
    return 1;
  }
  luaL_openlibs(state);
  LuaConfiguration configuration;
  install_lemma_module(state, configuration);
  if (!install_config_search_path(state, path)) {
    static_cast<void>(send_host_message(descriptor, HostMessageStatus::failed,
                                        "failed to configure Lua module search path"));
    lua_close(state);
    return 1;
  }
  int status = luaL_loadfilex(state, path.c_str(), "t");
  if (status == LUA_OK) {
    status = lua_pcall(state, 0, 0, 0);
  }
  if (status != LUA_OK) {
    const char* const message = lua_tostring(state, -1);
    const auto diagnostic = append_diagnostic("Lua configuration failed: ",
                                              message == nullptr ? "unknown error" : message);
    static_cast<void>(send_host_message(descriptor, HostMessageStatus::failed, diagnostic));
    lua_close(state);
    return 1;
  }
  const auto compiled = config::compile(configuration.configuration);
  if (!compiled.has_value()) {
    static_cast<void>(send_host_message(descriptor, HostMessageStatus::failed,
                                        "Lua configuration produced an invalid input map"));
    lua_close(state);
    return 1;
  }
  const auto encoded = config::encode(configuration.configuration);
  if (!encoded.has_value() ||
      !send_host_message(descriptor, HostMessageStatus::configured, *encoded)) {
    lua_close(state);
    return 1;
  }

  // The loaded VM is the first extension-runtime generation. It remains isolated and resident for
  // the daemon lifetime; later slices attach commands, events, and jobs to this same lease.
  std::array<std::byte, 64> ignored{};
  while (true) {
    const auto received = ::read(descriptor, ignored.data(), ignored.size());
    if (received > 0 || (received < 0 && errno == EINTR)) {
      continue;
    }
    break;
  }
  lua_close(state);
  return 0;
}

[[nodiscard]] auto set_close_on_exec(const int descriptor) noexcept -> bool {
  // fcntl is variadic because its final argument depends on the command.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const auto flags = ::fcntl(descriptor, F_GETFD, 0);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  return flags >= 0 && ::fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) == 0;
}

[[nodiscard]] auto read_before(const int descriptor, const std::span<std::byte> output,
                               const std::chrono::steady_clock::time_point deadline) noexcept
    -> bool {
  std::size_t used = 0;
  while (used < output.size()) {
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) {
      return false;
    }
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
    const auto timeout = static_cast<int>(std::max<std::int64_t>(1, remaining.count()));
    pollfd ready{.fd = descriptor, .events = POLLIN, .revents = 0};
    const auto polled = ::poll(&ready, 1, timeout);
    if (polled < 0 && errno == EINTR) {
      continue;
    }
    if (polled <= 0 || (ready.revents & (POLLERR | POLLNVAL)) != 0) {
      return false;
    }
    const auto received = ::read(descriptor, output.subspan(used).data(), output.size() - used);
    if (received > 0) {
      used += static_cast<std::size_t>(received);
      continue;
    }
    if (received < 0 && errno == EINTR) {
      continue;
    }
    return false;
  }
  return true;
}

struct HostFrame final {
  HostMessageStatus status{HostMessageStatus::failed};
  std::string payload;
};

[[nodiscard]] auto receive_host_frame(const int descriptor) noexcept -> std::optional<HostFrame> {
  const auto deadline = std::chrono::steady_clock::now() + startup_timeout;
  std::array<std::byte, host_header_bytes> header{};
  if (!read_before(descriptor, header, deadline) ||
      !std::ranges::equal(std::span(header).first(host_magic.size()), host_magic) ||
      header.at(4) != std::byte{1} || header.at(5) != std::byte{0} ||
      header.at(7) != std::byte{0}) {
    return std::nullopt;
  }
  const auto status = static_cast<HostMessageStatus>(std::to_integer<std::uint8_t>(header.at(6)));
  const auto size = (std::to_integer<std::uint32_t>(header.at(8)) << 24U) |
                    (std::to_integer<std::uint32_t>(header.at(9)) << 16U) |
                    (std::to_integer<std::uint32_t>(header.at(10)) << 8U) |
                    std::to_integer<std::uint32_t>(header.at(11));
  const auto maximum = status == HostMessageStatus::configured
                           ? config::configuration_document_bytes_max
                           : diagnostic_bytes_max;
  if ((status != HostMessageStatus::configured && status != HostMessageStatus::failed) ||
      size > maximum) {
    return std::nullopt;
  }
  HostFrame result{.status = status, .payload = {}};
  try {
    result.payload.resize(size);
  } catch (...) {
    return std::nullopt;
  }
  if (!result.payload.empty() &&
      !read_before(descriptor,
                   std::as_writable_bytes(std::span(result.payload.data(), result.payload.size())),
                   deadline)) {
    return std::nullopt;
  }
  return result;
}

[[nodiscard]] auto candidate_configuration_path() -> std::string {
  const char* const configured = std::getenv("LEMMA_CONFIG");
  if (configured != nullptr && *configured != '\0') {
    return {configured};
  }
  const char* const xdg = std::getenv("XDG_CONFIG_HOME");
  if (xdg != nullptr && *xdg == '/') {
    return std::string(xdg) + "/lemma/init.lua";
  }
  const char* const home = std::getenv("HOME");
  return home != nullptr && *home == '/' ? std::string(home) + "/.config/lemma/init.lua"
                                         : std::string{};
}

[[nodiscard]] auto regular_readable_file(const std::string& path) noexcept -> bool {
  struct stat status{};
  return !path.empty() && ::stat(path.c_str(), &status) == 0 && S_ISREG(status.st_mode) &&
         ::access(path.c_str(), R_OK) == 0;
}

[[nodiscard]] auto spawn_host(const std::string& path) noexcept
    -> std::pair<HostProcess, std::optional<HostFrame>> {
  std::array<int, 2> sockets{-1, -1};
  if (::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets.data()) != 0 ||
      !set_close_on_exec(sockets.front()) || !set_close_on_exec(sockets.back())) {
    close_descriptor(sockets.front());
    close_descriptor(sockets.back());
    return {};
  }
  const auto child = ::fork();
  if (child < 0) {
    close_descriptor(sockets.front());
    close_descriptor(sockets.back());
    return {};
  }
  if (child == 0) {
    close_descriptor(sockets.front());
    if (::setpgid(0, 0) != 0) {
      close_descriptor(sockets.back());
      ::_exit(1);
    }
    const auto result = run_host(sockets.back(), path);
    close_descriptor(sockets.back());
    ::_exit(result);
  }
  close_descriptor(sockets.back());
  // Either side may win the setpgid race. EACCES means the child already executed the matching
  // transition; an exited child is handled by startup framing and HostProcess cleanup.
  static_cast<void>(::setpgid(child, child));
  HostProcess host(sockets.front(), static_cast<int>(child));
  auto frame = receive_host_frame(sockets.front());
  return {std::move(host), std::move(frame)};
}

enum class ProcessWait : std::uint8_t {
  exited,
  running,
  unavailable,
};

[[nodiscard]] auto wait_for_process_exit(const int process) noexcept -> ProcessWait {
  for (std::size_t attempt = 0; attempt < 50U; ++attempt) {
    const auto waited = ::waitpid(process, nullptr, WNOHANG);
    if (waited == process) {
      return ProcessWait::exited;
    }
    if (waited < 0 && errno == ECHILD) {
      return ProcessWait::unavailable;
    }
    if (waited < 0 && errno != EINTR) {
      return ProcessWait::running;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  return ProcessWait::running;
}

} // namespace

HostProcess::HostProcess(HostProcess&& other) noexcept
    : descriptor_(std::exchange(other.descriptor_, -1)),
      process_(std::exchange(other.process_, -1)) {}

auto HostProcess::operator=(HostProcess&& other) noexcept -> HostProcess& {
  if (this != &other) {
    reset();
    descriptor_ = std::exchange(other.descriptor_, -1);
    process_ = std::exchange(other.process_, -1);
  }
  return *this;
}

HostProcess::~HostProcess() { reset(); }

void HostProcess::reset() noexcept {
  close_descriptor(descriptor_);
  if (process_ <= 0) {
    return;
  }
  const auto initial_wait = wait_for_process_exit(process_);
  if (initial_wait != ProcessWait::running) {
    if (initial_wait == ProcessWait::exited) {
      static_cast<void>(::kill(-process_, SIGTERM));
    }
    process_ = -1;
    return;
  }
  static_cast<void>(::kill(-process_, SIGTERM));
  if (wait_for_process_exit(process_) != ProcessWait::running) {
    process_ = -1;
    return;
  }
  static_cast<void>(::kill(-process_, SIGKILL));
  while (::waitpid(process_, nullptr, 0) < 0 && errno == EINTR) {
  }
  process_ = -1;
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto load_configuration(const std::optional<std::string_view> requested_path) noexcept
    -> ConfigurationLoad {
  ConfigurationLoad result;
  const char* const configured_environment = std::getenv("LEMMA_CONFIG");
  const bool path_required = requested_path.has_value() ||
                             (configured_environment != nullptr && *configured_environment != '\0');
  try {
    result.path =
        requested_path.has_value() ? std::string(*requested_path) : candidate_configuration_path();
  } catch (...) {
    result.status = ConfigurationStatus::invalid;
    result.diagnostic = "configuration path allocation failed";
    return result;
  }
  if (result.path.empty() || result.path.size() > config::configuration_path_bytes_max ||
      result.path.contains('\0')) {
    result.status = path_required ? ConfigurationStatus::invalid : ConfigurationStatus::absent;
    result.diagnostic = path_required ? "invalid configuration path" : std::string{};
    return result;
  }
  if (!regular_readable_file(result.path)) {
    result.status = path_required ? ConfigurationStatus::invalid : ConfigurationStatus::absent;
    result.diagnostic = path_required ? "configuration file is not readable" : std::string{};
    return result;
  }

  auto [host, frame] = spawn_host(result.path);
  if (!frame.has_value()) {
    result.status = ConfigurationStatus::invalid;
    result.diagnostic = "configuration runtime timed out or exited without a valid result";
    return result;
  }
  if (frame->status == HostMessageStatus::failed) {
    result.status = ConfigurationStatus::invalid;
    result.diagnostic = std::move(frame->payload);
    return result;
  }
  const auto decoded = config::decode(frame->payload);
  if (!decoded.configuration.has_value()) {
    result.status = ConfigurationStatus::invalid;
    result.diagnostic = "configuration runtime returned an invalid document";
    return result;
  }
  auto compiled = config::compile(*decoded.configuration);
  if (!compiled.has_value()) {
    result.status = ConfigurationStatus::invalid;
    result.diagnostic = "configuration input map failed validation";
    return result;
  }
  try {
    result.generation = std::make_unique<config::Generation>(std::move(*compiled));
  } catch (...) {
    result.status = ConfigurationStatus::invalid;
    result.diagnostic = "configuration publication allocation failed";
    return result;
  }
  result.host = std::move(host);
  result.status = ConfigurationStatus::loaded;
  return result;
}

} // namespace lemma::extension
