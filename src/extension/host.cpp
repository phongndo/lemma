#include "extension/host.hpp"

#include "platform/io.hpp"
#include "protocol/extension.hpp"

#include <lua.hpp>

#include <algorithm>
#include <array>
#include <cerrno>
#include <csignal>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <expected>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <utility>

#include <fcntl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#ifdef __linux__
#include <sys/syscall.h>
#endif
#include <unistd.h>

namespace lemma::extension {
namespace {

constexpr std::size_t config_source_bytes_max = std::size_t{1} * 1'024U * 1'024U;
constexpr std::size_t commands_max = 64;
constexpr std::size_t keymaps_max = 128;
constexpr std::size_t subscriptions_max = 64;
constexpr std::size_t sidebars_max = 4;

using platform::close_descriptor;

template <std::size_t Capacity> struct FixedText final {
  std::array<char, Capacity> bytes{};
  std::size_t size{0};

  [[nodiscard]] auto assign(const std::string_view value) noexcept -> bool {
    if (value.empty() || value.size() > bytes.size()) {
      return false;
    }
    std::ranges::copy(value, bytes.begin());
    size = value.size();
    return true;
  }

  [[nodiscard]] auto assign_optional(const std::string_view value) noexcept -> bool {
    if (value.size() > bytes.size()) {
      return false;
    }
    std::ranges::copy(value, bytes.begin());
    size = value.size();
    return true;
  }

  [[nodiscard]] auto view() const noexcept -> std::string_view { return {bytes.data(), size}; }
};

struct Command final {
  FixedText<protocol::extension::command_name_bytes_max> name;
  FixedText<protocol::extension::command_description_bytes_max> description;
  int callback_ref{LUA_NOREF};
};

struct Keymap final {
  FixedText<protocol::extension::key_mode_bytes_max> mode;
  FixedText<protocol::extension::key_bytes_max> key;
  FixedText<protocol::extension::command_name_bytes_max> command;
};

struct Subscription final {
  FixedText<protocol::extension::event_name_bytes_max> event;
  int callback_ref{LUA_NOREF};
};

struct Sidebar final {
  FixedText<protocol::extension::sidebar_id_bytes_max> id;
  protocol::extension::SidebarSide side{protocol::extension::SidebarSide::left};
  std::uint16_t width{0};
  std::array<FixedText<protocol::extension::sidebar_line_bytes_max>,
             protocol::extension::sidebar_lines_max>
      lines{};
  std::size_t line_count{0};
};

struct HostState final {
  int connection{-1};
  std::array<Command, commands_max> commands{};
  std::size_t command_count{0};
  std::array<Keymap, keymaps_max> keymaps{};
  std::size_t keymap_count{0};
  std::array<Subscription, subscriptions_max> subscriptions{};
  std::size_t subscription_count{0};
  std::array<Sidebar, sidebars_max> sidebars{};
  std::size_t sidebar_count{0};
};

[[nodiscard]] auto state_from_upvalue(lua_State* state) noexcept -> HostState& {
  return *static_cast<HostState*>(lua_touserdata(state, lua_upvalueindex(1)));
}

[[nodiscard]] auto checked_text(lua_State* state, const int index) noexcept -> std::string_view {
  std::size_t size = 0;
  const char* const value = luaL_checklstring(state, index, &size);
  return {value, size};
}

[[nodiscard]] auto is_nil(lua_State* state, const int index) noexcept -> bool {
  return lua_type(state, index) == LUA_TNIL;
}

[[nodiscard]] auto is_function(lua_State* state, const int index) noexcept -> bool {
  return lua_type(state, index) == LUA_TFUNCTION;
}

int lua_fail(lua_State* state, const char* message) {
  // luaL_error is variadic even when the message has no format arguments.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  return luaL_error(state, "%s", message);
}

[[nodiscard]] auto duplicate_command(const HostState& host, const std::string_view name) noexcept
    -> bool {
  return std::ranges::any_of(std::span(host.commands).first(host.command_count),
                             [&](const Command& command) { return command.name.view() == name; });
}

int setup(lua_State* state) {
  luaL_checktype(state, 1, LUA_TTABLE);
  return 0;
}

int register_command(lua_State* state) {
  auto& host = state_from_upvalue(state);
  const auto name = checked_text(state, 1);
  luaL_checktype(state, 2, LUA_TTABLE);
  if (host.command_count == host.commands.size() || duplicate_command(host, name)) {
    return lua_fail(state, "lemma command capacity reached or duplicate command");
  }

  auto& command = std::span(host.commands).subspan(host.command_count, 1).front();
  if (!command.name.assign(name)) {
    return lua_fail(state, "invalid lemma command name");
  }
  static_cast<void>(lua_getfield(state, 2, "description"));
  if (is_nil(state, -1)) {
    if (!command.description.assign_optional({})) {
      return lua_fail(state, "invalid lemma command description");
    }
  } else {
    const auto description = checked_text(state, -1);
    if (!command.description.assign_optional(description)) {
      return lua_fail(state, "lemma command description is too long");
    }
  }
  lua_pop(state, 1);

  static_cast<void>(lua_getfield(state, 2, "run"));
  if (!is_nil(state, -1) && !is_function(state, -1)) {
    return lua_fail(state, "lemma command run must be a function");
  }
  if (is_function(state, -1)) {
    command.callback_ref = luaL_ref(state, LUA_REGISTRYINDEX);
  } else {
    lua_pop(state, 1);
    command.callback_ref = LUA_NOREF;
  }
  ++host.command_count;
  return 0;
}

int set_keymap(lua_State* state) {
  auto& host = state_from_upvalue(state);
  if (host.keymap_count == host.keymaps.size()) {
    return lua_fail(state, "lemma keymap capacity reached");
  }
  auto& keymap = std::span(host.keymaps).subspan(host.keymap_count, 1).front();
  if (!keymap.mode.assign(checked_text(state, 1)) || !keymap.key.assign(checked_text(state, 2)) ||
      !keymap.command.assign(checked_text(state, 3))) {
    return lua_fail(state, "invalid lemma keymap");
  }
  ++host.keymap_count;
  return 0;
}

int subscribe(lua_State* state) {
  auto& host = state_from_upvalue(state);
  if (host.subscription_count == host.subscriptions.size()) {
    return lua_fail(state, "lemma subscription capacity reached");
  }
  luaL_checktype(state, 2, LUA_TFUNCTION);
  auto& subscription = std::span(host.subscriptions).subspan(host.subscription_count, 1).front();
  if (!subscription.event.assign(checked_text(state, 1))) {
    return lua_fail(state, "invalid lemma event name");
  }
  lua_pushvalue(state, 2);
  subscription.callback_ref = luaL_ref(state, LUA_REGISTRYINDEX);
  ++host.subscription_count;
  return 0;
}

[[nodiscard]] auto parse_sidebar_side(lua_State* state, const int table_index)
    -> protocol::extension::SidebarSide {
  static_cast<void>(lua_getfield(state, table_index, "side"));
  auto result = protocol::extension::SidebarSide::left;
  if (!is_nil(state, -1)) {
    const auto side = checked_text(state, -1);
    if (side == "right") {
      result = protocol::extension::SidebarSide::right;
    } else if (side != "left") {
      static_cast<void>(lua_fail(state, "lemma sidebar side must be left or right"));
    }
  }
  lua_pop(state, 1);
  return result;
}

int set_sidebar(lua_State* state) {
  auto& host = state_from_upvalue(state);
  luaL_checktype(state, 2, LUA_TTABLE);
  if (host.sidebar_count == host.sidebars.size()) {
    return lua_fail(state, "lemma sidebar capacity reached");
  }
  auto& sidebar = std::span(host.sidebars).subspan(host.sidebar_count, 1).front();
  if (!sidebar.id.assign(checked_text(state, 1))) {
    return lua_fail(state, "invalid lemma sidebar id");
  }
  sidebar.side = parse_sidebar_side(state, 2);

  static_cast<void>(lua_getfield(state, 2, "width"));
  const auto width = luaL_checkinteger(state, -1);
  lua_pop(state, 1);
  if (width <= 0 || width > 500) {
    return lua_fail(state, "lemma sidebar width must be between 1 and 500");
  }
  sidebar.width = static_cast<std::uint16_t>(width);

  static_cast<void>(lua_getfield(state, 2, "lines"));
  luaL_checktype(state, -1, LUA_TTABLE);
  const auto line_count = lua_rawlen(state, -1);
  if (line_count > sidebar.lines.size()) {
    return lua_fail(state, "lemma sidebar has too many lines");
  }
  for (std::size_t index = 0; index < line_count; ++index) {
    static_cast<void>(lua_geti(state, -1, static_cast<lua_Integer>(index) + 1));
    auto& line = std::span(sidebar.lines).subspan(index, 1).front();
    if (!line.assign_optional(checked_text(state, -1))) {
      return lua_fail(state, "lemma sidebar line is too long");
    }
    lua_pop(state, 1);
  }
  lua_pop(state, 1);
  sidebar.line_count = line_count;
  ++host.sidebar_count;
  return 0;
}

void set_closure(lua_State* state, HostState& host, const char* name,
                 const lua_CFunction function) {
  lua_pushlightuserdata(state, &host);
  lua_pushcclosure(state, function, 1);
  lua_setfield(state, -2, name);
}

void retain_absolute_search_path(lua_State* state, const int package_index, const char* field) {
  static_cast<void>(lua_getfield(state, package_index, field));
  std::size_t size = 0;
  const char* const value = lua_tolstring(state, -1, &size);
  const std::string_view search_path =
      value == nullptr ? std::string_view{} : std::string_view{value, size};

  luaL_Buffer buffer{};
  luaL_buffinit(state, &buffer);
  bool first = true;
  const std::span search_bytes(search_path.data(), search_path.size());
  std::size_t begin = 0;
  while (begin < search_path.size()) {
    const auto separator = search_path.find(';', begin);
    const auto end = separator == std::string_view::npos ? search_path.size() : separator;
    const auto entry_bytes = search_bytes.subspan(begin, end - begin);
    const std::string_view entry(entry_bytes.data(), entry_bytes.size());
    if (!entry.empty() && entry.front() == '/') {
      if (!first) {
        luaL_addlstring(&buffer, ";", 1);
      }
      luaL_addlstring(&buffer, entry.data(), entry.size());
      first = false;
    }
    begin = end == search_path.size() ? end : end + 1;
  }
  luaL_pushresult(&buffer);
  lua_setfield(state, package_index, field);
  lua_pop(state, 1);
}

void restrict_module_search_paths(lua_State* state) {
  static_cast<void>(lua_getglobal(state, "package"));
  const auto package_index = lua_gettop(state);
  retain_absolute_search_path(state, package_index, "path");
  retain_absolute_search_path(state, package_index, "cpath");
  lua_pop(state, 1);
}

void install_lemma_module(lua_State* state, HostState& host) {
  lua_newtable(state);
  const auto root = lua_gettop(state);
  set_closure(state, host, "setup", &setup);

  lua_newtable(state);
  set_closure(state, host, "register", &register_command);
  lua_setfield(state, root, "command");

  lua_newtable(state);
  set_closure(state, host, "set", &set_keymap);
  lua_setfield(state, root, "keymap");

  set_closure(state, host, "on", &subscribe);

  lua_newtable(state);
  lua_newtable(state);
  set_closure(state, host, "set", &set_sidebar);
  lua_setfield(state, -2, "sidebar");
  lua_setfield(state, root, "ui");

  lua_getglobal(state, "package");
  static_cast<void>(lua_getfield(state, -1, "loaded"));
  lua_pushvalue(state, root);
  lua_setfield(state, -2, "lemma");
  lua_pop(state, 2);
  lua_pop(state, 1);
}

class Sender final {
public:
  explicit Sender(const int connection) noexcept : connection_(connection) {}

  [[nodiscard]] auto empty(const protocol::extension::MessageKind kind) noexcept -> bool {
    return send(protocol::extension::encode_empty(kind, 0, frame_));
  }

  [[nodiscard]] auto command(const protocol::extension::CommandRegistration& value) noexcept
      -> bool {
    return send(protocol::extension::encode_command(value, 0, frame_));
  }

  [[nodiscard]] auto keymap(const protocol::extension::KeymapRegistration& value) noexcept -> bool {
    return send(protocol::extension::encode_keymap(value, 0, frame_));
  }

  [[nodiscard]] auto subscription(const protocol::extension::EventSubscription& value) noexcept
      -> bool {
    return send(protocol::extension::encode_subscription(value, 0, frame_));
  }

  [[nodiscard]] auto sidebar(const protocol::extension::SidebarRegistration& value) noexcept
      -> bool {
    return send(protocol::extension::encode_sidebar(value, 0, frame_));
  }

  [[nodiscard]] auto error(const std::string_view value) noexcept -> bool {
    return send(protocol::extension::encode_config_error(value, 0, frame_));
  }

private:
  [[nodiscard]] auto
  send(const std::expected<std::size_t, protocol::extension::EncodeError>& size) noexcept -> bool {
    return size.has_value() && platform::send_all(connection_, std::span(frame_).first(*size));
  }

  int connection_;
  std::array<std::byte,
             protocol::extension::frame_header_bytes + protocol::extension::payload_bytes_max>
      frame_{};
};

[[nodiscard]] auto send_generation(const HostState& host) noexcept -> bool {
  using namespace protocol::extension;
  Sender sender(host.connection);
  if (!sender.empty(MessageKind::begin_generation)) {
    return false;
  }
  for (const auto& command : std::span(host.commands).first(host.command_count)) {
    if (!sender.command({.name = command.name.view(), .description = command.description.view()})) {
      return false;
    }
  }
  for (const auto& keymap : std::span(host.keymaps).first(host.keymap_count)) {
    if (!sender.keymap({.mode = keymap.mode.view(),
                        .key = keymap.key.view(),
                        .command = keymap.command.view()})) {
      return false;
    }
  }
  for (const auto& subscription : std::span(host.subscriptions).first(host.subscription_count)) {
    if (!sender.subscription({.event = subscription.event.view()})) {
      return false;
    }
  }
  for (const auto& sidebar : std::span(host.sidebars).first(host.sidebar_count)) {
    SidebarRegistration registration{
        .id = sidebar.id.view(),
        .side = sidebar.side,
        .width = sidebar.width,
        .line_count = sidebar.line_count,
    };
    for (std::size_t index = 0; index < sidebar.line_count; ++index) {
      std::span(registration.lines).subspan(index, 1).front() =
          std::span(sidebar.lines).subspan(index, 1).front().view();
    }
    if (!sender.sidebar(registration)) {
      return false;
    }
  }
  return sender.empty(MessageKind::commit_generation);
}

[[nodiscard]] auto send_lua_error(const int connection, lua_State* state) noexcept -> bool {
  std::size_t size = 0;
  const char* const message = lua_tolstring(state, -1, &size);
  const auto error =
      message == nullptr || size == 0
          ? std::string_view{"unknown Lua configuration error"}
          : std::string_view(message, std::min(size, protocol::extension::error_bytes_max));
  Sender sender(connection);
  return sender.error(error);
}

[[nodiscard]] auto load_config(lua_State* state, const char* path) noexcept -> bool {
  struct stat info{};
  if (::stat(path, &info) != 0) {
    if (errno == ENOENT) {
      return true;
    }
    lua_pushstring(state, std::strerror(errno));
    return false;
  }
  if (info.st_size < 0 || std::cmp_greater(info.st_size, config_source_bytes_max)) {
    lua_pushliteral(state, "lemma init.lua exceeds the 1 MiB source limit");
    return false;
  }
  if (luaL_loadfilex(state, path, "t") != LUA_OK) {
    return false;
  }
  return lua_pcall(state, 0, 0, 0) == LUA_OK;
}

void wait_for_disconnect(const int connection) noexcept {
  std::array<std::byte, 256> input{};
  auto result = ::recv(connection, input.data(), input.size(), 0);
  while (result > 0 || (result < 0 && errno == EINTR)) {
    result = ::recv(connection, input.data(), input.size(), 0);
  }
}

[[nodiscard]] auto run_host(const int connection, const char* config_path) noexcept -> int {
  lua_State* const state = luaL_newstate();
  if (state == nullptr) {
    return 1;
  }
  luaL_openlibs(state);
  restrict_module_search_paths(state);
  HostState host{.connection = connection};
  install_lemma_module(state, host);

  const bool loaded = load_config(state, config_path);
  const bool sent = loaded ? send_generation(host) : send_lua_error(connection, state);
  if (sent) {
    wait_for_disconnect(connection);
  }
  lua_close(state);
  return sent ? 0 : 1;
}

[[nodiscard]] auto set_close_on_exec(const int descriptor) noexcept -> bool {
  // fcntl is variadic even for operations that do not consume a third argument.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const auto flags = ::fcntl(descriptor, F_GETFD);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  return flags >= 0 && ::fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) == 0;
}

void close_inherited_descriptors(const int first) noexcept {
#ifdef __linux__
  // syscall is variadic; old Linux kernels may reject close_range and use the fallback below.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  if (::syscall(SYS_close_range, static_cast<unsigned>(first), ~0U, 0U) == 0) {
    return;
  }
#endif
  const auto maximum = ::sysconf(_SC_OPEN_MAX);
  for (int descriptor = first; descriptor < maximum; ++descriptor) {
    static_cast<void>(::close(descriptor));
  }
}

} // namespace

auto default_config_path() -> std::string {
  if (const char* const xdg = std::getenv("XDG_CONFIG_HOME"); xdg != nullptr && *xdg == '/') {
    return std::string(xdg) + "/lemma/init.lua";
  }
  if (const char* const home = std::getenv("HOME"); home != nullptr && *home == '/') {
    return std::string(home) + "/.config/lemma/init.lua";
  }
  return {};
}

// Process creation handles all failure paths and descriptor ownership explicitly.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto spawn_host(const std::string_view config_path,
                const std::span<const int> close_in_child) noexcept -> HostConnection {
  std::array<char, 4'096> path{};
  if (config_path.size() >= path.size()) {
    return {};
  }
  std::ranges::copy(config_path, path.begin());

  std::array<int, 2> sockets{-1, -1};
  auto& parent_socket = sockets.front();
  auto& child_socket = sockets.back();
  if (::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets.data()) != 0 ||
      !set_close_on_exec(parent_socket) || !set_close_on_exec(child_socket) ||
      !platform::set_nonblocking(parent_socket)) {
    close_descriptor(parent_socket);
    close_descriptor(child_socket);
    return {};
  }

  const auto process = ::fork();
  if (process < 0) {
    close_descriptor(parent_socket);
    close_descriptor(child_socket);
    return {};
  }
  if (process == 0) {
    // The daemon ignores these signals for child-reaping and socket I/O. Ignored dispositions
    // survive exec, so restore normal semantics for commands started by Lua's standard library.
    if (::signal(SIGCHLD, SIG_DFL) == SIG_ERR || ::signal(SIGPIPE, SIG_DFL) == SIG_ERR) {
      ::_exit(1);
    }
    close_descriptor(parent_socket);
    constexpr int host_connection = 3;
    if (child_socket != host_connection) {
      if (::dup2(child_socket, host_connection) < 0) {
        ::_exit(1);
      }
      close_descriptor(child_socket);
    }
    // dup2 clears FD_CLOEXEC, but commands launched by Lua must not keep the host connection alive.
    if (!set_close_on_exec(host_connection)) {
      ::_exit(1);
    }
    for (const auto descriptor : close_in_child) {
      if (descriptor >= 0 && descriptor != host_connection) {
        static_cast<void>(::close(descriptor));
      }
    }
    close_inherited_descriptors(host_connection + 1);
    const auto result = run_host(host_connection, path.data());
    static_cast<void>(::close(host_connection));
    ::_exit(result);
  }

  close_descriptor(child_socket);
  return {.descriptor = parent_socket, .process = static_cast<int>(process)};
}

} // namespace lemma::extension
