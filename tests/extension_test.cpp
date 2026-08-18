#include "core/extension_runtime.hpp"
#include "extension/host.hpp"
#include "platform/io.hpp"
#include "protocol/extension.hpp"

#include <gtest/gtest.h>

#include <array>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>

#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

namespace lemma {
namespace {

using protocol::extension::MessageKind;

class EnvironmentGuard final {
public:
  explicit EnvironmentGuard(const char* const name) : name_(name) {
    if (const char* const value = std::getenv(name_); value != nullptr) {
      original_ = value;
    }
  }

  EnvironmentGuard(const EnvironmentGuard&) = delete;
  auto operator=(const EnvironmentGuard&) -> EnvironmentGuard& = delete;
  EnvironmentGuard(EnvironmentGuard&&) = delete;
  auto operator=(EnvironmentGuard&&) -> EnvironmentGuard& = delete;
  ~EnvironmentGuard() {
    if (original_.has_value()) {
      static_cast<void>(::setenv(name_, original_->c_str(), 1));
    } else {
      static_cast<void>(::unsetenv(name_));
    }
  }

private:
  const char* name_;
  std::optional<std::string> original_;
};

struct ConnectionContext final {
  core::ExtensionConnection connection{};
};

[[nodiscard]] auto acquire_once(void* const context) noexcept -> core::ExtensionConnection {
  auto& value = *static_cast<ConnectionContext*>(context);
  const auto result = value.connection;
  value.connection = {};
  return result;
}

struct SpawnContext final {
  const char* path{nullptr};
  int last_process{-1};
  std::size_t starts{0};
};

[[nodiscard]] auto spawn_host(void* const context) noexcept -> core::ExtensionConnection {
  auto& value = *static_cast<SpawnContext*>(context);
  const auto previous = ::signal(SIGCHLD, SIG_IGN);
  if (previous == SIG_ERR) {
    return {};
  }
  auto host = extension::spawn_host(value.path, {});
  if (::signal(SIGCHLD, previous) == SIG_ERR) {
    platform::close_descriptor(host.descriptor);
    if (host.process > 0) {
      static_cast<void>(::kill(host.process, SIGKILL));
    }
    return {};
  }
  value.last_process = host.process;
  ++value.starts;
  return {.descriptor = host.descriptor};
}

struct ErrorContext final {
  std::array<char, protocol::extension::error_bytes_max> bytes{};
  std::size_t size{0};
  std::size_t reports{0};

  [[nodiscard]] auto error() const noexcept -> std::string_view { return {bytes.data(), size}; }
};

void report_error(void* const context, const std::string_view error) noexcept {
  auto& value = *static_cast<ErrorContext*>(context);
  std::ranges::copy(error, value.bytes.begin());
  value.size = error.size();
  ++value.reports;
}

[[nodiscard]] auto wait_for_generation(core::ExtensionRuntime& runtime,
                                       const std::uint64_t target = 1) -> bool {
  for (std::size_t attempt = 0; attempt < 100 && runtime.generation() < target; ++attempt) {
    runtime.connect_if_due(std::chrono::steady_clock::now());
    pollfd descriptor{.fd = runtime.descriptor(), .events = POLLIN, .revents = 0};
    if (descriptor.fd < 0 || ::poll(&descriptor, 1, 50) < 0) {
      return false;
    }
    runtime.process(descriptor.revents);
  }
  return runtime.generation() >= target;
}

[[nodiscard]] auto wait_for_error(core::ExtensionRuntime& runtime) -> bool {
  for (std::size_t attempt = 0; attempt < 100 && runtime.last_error().empty(); ++attempt) {
    runtime.connect_if_due(std::chrono::steady_clock::now());
    pollfd descriptor{.fd = runtime.descriptor(), .events = POLLIN, .revents = 0};
    if (descriptor.fd < 0 || ::poll(&descriptor, 1, 50) < 0) {
      return false;
    }
    runtime.process(descriptor.revents);
  }
  return !runtime.last_error().empty();
}

template <typename Encode>
[[nodiscard]] auto send_message(const int descriptor, const Encode& encode) -> bool {
  std::array<std::byte,
             protocol::extension::frame_header_bytes + protocol::extension::payload_bytes_max>
      output{};
  const auto encoded = encode(output);
  return encoded.has_value() && platform::send_all(descriptor, std::span(output).first(*encoded));
}

TEST(ExtensionRuntimeTest, MakesAcquiredSocketNonblocking) {
  std::array<int, 2> sockets{-1, -1};
  ASSERT_EQ(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets.data()), 0);
  auto& runtime_socket = sockets.front();
  auto& peer_socket = sockets.back();
  ConnectionContext context{.connection = {.descriptor = runtime_socket}};
  core::ExtensionRuntime runtime(&acquire_once, &context);

  runtime.connect_if_due(std::chrono::steady_clock::now());

  const auto flags = ::fcntl(runtime.descriptor(), F_GETFL, 0);
  ASSERT_GE(flags, 0);
  EXPECT_NE(flags & O_NONBLOCK, 0);
  platform::close_descriptor(peer_socket);
}

TEST(ExtensionRuntimeTest, ActivatesOnlyCommittedGenerationAndKeepsItOnConfigError) {
  std::array<int, 2> sockets{-1, -1};
  ASSERT_EQ(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets.data()), 0);
  auto& runtime_socket = sockets.front();
  auto& peer_socket = sockets.back();
  ASSERT_TRUE(platform::set_nonblocking(runtime_socket));
  ConnectionContext context{.connection = {.descriptor = runtime_socket}};
  ErrorContext errors;
  core::ExtensionRuntime runtime(&acquire_once, &context, &report_error, &errors);
  runtime.connect_if_due(std::chrono::steady_clock::now());

  ASSERT_TRUE(send_message(peer_socket, [](const std::span<std::byte> output) {
    return protocol::extension::encode_empty(MessageKind::begin_generation, 0, output);
  }));
  ASSERT_TRUE(send_message(peer_socket, [](const std::span<std::byte> output) {
    return protocol::extension::encode_command({.name = "first", .description = "first generation"},
                                               0, output);
  }));
  EXPECT_EQ(runtime.generation(), 0U);
  ASSERT_TRUE(send_message(peer_socket, [](const std::span<std::byte> output) {
    return protocol::extension::encode_empty(MessageKind::commit_generation, 0, output);
  }));

  pollfd ready{.fd = runtime.descriptor(), .events = POLLIN, .revents = 0};
  ASSERT_GT(::poll(&ready, 1, 100), 0);
  runtime.process(ready.revents);
  ASSERT_EQ(runtime.generation(), 1U);
  ASSERT_EQ(runtime.active().command_count, 1U);
  EXPECT_EQ(runtime.active().commands.front().name.view(), "first");

  ASSERT_TRUE(send_message(peer_socket, [](const std::span<std::byte> output) {
    return protocol::extension::encode_empty(MessageKind::begin_generation, 0, output);
  }));
  ASSERT_TRUE(send_message(peer_socket, [](const std::span<std::byte> output) {
    return protocol::extension::encode_config_error("bad init.lua", 0, output);
  }));
  ready.revents = 0;
  ASSERT_GT(::poll(&ready, 1, 100), 0);
  runtime.process(ready.revents);

  EXPECT_EQ(runtime.generation(), 1U);
  ASSERT_EQ(runtime.active().command_count, 1U);
  EXPECT_EQ(runtime.active().commands.front().name.view(), "first");
  EXPECT_EQ(runtime.last_error(), "bad init.lua");
  EXPECT_EQ(errors.reports, 1U);
  EXPECT_EQ(errors.error(), "bad init.lua");
  platform::close_descriptor(peer_socket);
}

// GoogleTest assertions and the deliberate 64-frame boundary dominate this test's branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(ExtensionRuntimeTest, ContinuesBufferedRegistrationAcrossBoundedTurns) {
  std::array<int, 2> sockets{-1, -1};
  ASSERT_EQ(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets.data()), 0);
  auto& runtime_socket = sockets.front();
  auto& peer_socket = sockets.back();
  ASSERT_TRUE(platform::set_nonblocking(runtime_socket));
  ConnectionContext context{.connection = {.descriptor = runtime_socket}};
  core::ExtensionRuntime runtime(&acquire_once, &context);
  runtime.connect_if_due(std::chrono::steady_clock::now());

  ASSERT_TRUE(send_message(peer_socket, [](const std::span<std::byte> output) {
    return protocol::extension::encode_empty(MessageKind::begin_generation, 0, output);
  }));
  for (std::size_t index = 0; index < 64; ++index) {
    ASSERT_TRUE(send_message(peer_socket, [](const std::span<std::byte> output) {
      return protocol::extension::encode_command({.name = "command", .description = {}}, 0, output);
    }));
  }
  ASSERT_TRUE(send_message(peer_socket, [](const std::span<std::byte> output) {
    return protocol::extension::encode_empty(MessageKind::commit_generation, 0, output);
  }));

  pollfd ready{.fd = runtime.descriptor(), .events = POLLIN, .revents = 0};
  ASSERT_GT(::poll(&ready, 1, 100), 0);
  runtime.process(ready.revents);
  EXPECT_EQ(runtime.generation(), 0U);
  EXPECT_EQ(runtime.poll_timeout(std::chrono::steady_clock::now()), 0);

  runtime.process(0);
  EXPECT_EQ(runtime.generation(), 1U);
  EXPECT_EQ(runtime.active().command_count, 64U);
  platform::close_descriptor(peer_socket);
}

TEST(ExtensionHostTest, IgnoresRelativeConfigRoots) {
  EnvironmentGuard xdg_guard("XDG_CONFIG_HOME");
  EnvironmentGuard home_guard("HOME");
  ASSERT_EQ(::setenv("XDG_CONFIG_HOME", ".", 1), 0);
  ASSERT_EQ(::setenv("HOME", "/tmp/lemma-home", 1), 0);

  EXPECT_EQ(extension::default_config_path(), "/tmp/lemma-home/.config/lemma/init.lua");

  ASSERT_EQ(::setenv("HOME", "relative-home", 1), 0);
  EXPECT_TRUE(extension::default_config_path().empty());
}

TEST(ExtensionHostTest, LoadsFullLuaAndRegistersBoundedGenerationOutOfProcess) {
  constexpr const char* probe_path = "lemma_untrusted_cwd_probe.lua";
  // open is variadic when O_CREAT supplies a mode.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  int probe = ::open(probe_path, O_CREAT | O_EXCL | O_WRONLY, 0600);
  ASSERT_GE(probe, 0);
  constexpr std::string_view probe_source = "return true";
  ASSERT_TRUE(platform::write_all(
      probe, std::as_bytes(std::span(probe_source.data(), probe_source.size()))));
  platform::close_descriptor(probe);

  std::array<char, 64> path_template{};
  constexpr std::string_view pattern = "/tmp/lemma-extension-test-XXXXXX";
  std::ranges::copy(pattern, path_template.begin());
  int config = ::mkstemp(path_template.data());
  ASSERT_GE(config, 0);
  constexpr std::string_view source = R"(
    local function assert_absolute_search_path(search_path)
      for entry in search_path:gmatch("[^;]+") do
        assert(entry:sub(1, 1) == "/", "relative module search path: " .. entry)
      end
    end
    assert_absolute_search_path(package.path)
    assert_absolute_search_path(package.cpath)
    local loaded_project_module = pcall(require, "lemma_untrusted_cwd_probe")
    assert(not loaded_project_module, "loaded a module from the daemon working directory")

    local lemma = require("lemma")
    local file = assert(io.open("/dev/null", "w"))
    file:write(os.getenv("HOME") or "")
    file:close()
    local executed, reason, status = os.execute("exit 0")
    assert(executed and reason == "exit" and status == 0)

    lemma.setup({ prefix = "C-b" })
    lemma.command.register("agents.toggle", {
      description = "Toggle agents",
      run = function() end,
    })
    for index = 2, 64 do
      lemma.command.register("test.command." .. index, {})
    end
    lemma.keymap.set("prefix", "g", "agents.toggle")
    lemma.on("pane.exited", function() end)
    lemma.ui.sidebar.set("agents", {
      side = "left",
      width = 24,
      lines = { "Agents", "pi", "codex" },
    })
  )";
  ASSERT_TRUE(platform::write_all(config, std::as_bytes(std::span(source.data(), source.size()))));
  platform::close_descriptor(config);

  SpawnContext context{.path = path_template.data()};
  {
    core::ExtensionRuntime runtime(&spawn_host, &context);
    ASSERT_TRUE(wait_for_generation(runtime));
    const auto& active = runtime.active();
    ASSERT_EQ(active.command_count, 64U);
    EXPECT_EQ(active.commands.front().name.view(), "agents.toggle");
    EXPECT_EQ(active.commands.front().description.view(), "Toggle agents");
    ASSERT_EQ(active.keymap_count, 1U);
    EXPECT_EQ(active.keymaps.front().mode.view(), "prefix");
    EXPECT_EQ(active.keymaps.front().key.view(), "g");
    EXPECT_EQ(active.keymaps.front().command.view(), "agents.toggle");
    ASSERT_EQ(active.subscription_count, 1U);
    EXPECT_EQ(active.subscriptions.front().event.view(), "pane.exited");
    ASSERT_EQ(active.sidebar_count, 1U);
    EXPECT_EQ(active.sidebars.front().id.view(), "agents");
    EXPECT_EQ(active.sidebars.front().width, 24U);
    ASSERT_EQ(active.sidebars.front().line_count, 3U);
    EXPECT_EQ(active.sidebars.front().lines.front().view(), "Agents");

    const auto first_process = context.last_process;
    ASSERT_GT(first_process, 0);
    ASSERT_EQ(::kill(first_process, SIGKILL), 0);
    pollfd closed{.fd = runtime.descriptor(), .events = POLLIN, .revents = 0};
    ASSERT_GT(::poll(&closed, 1, 500), 0);
    runtime.process(closed.revents);
    EXPECT_LT(runtime.descriptor(), 0);
    EXPECT_EQ(runtime.active().command_count, 0U);

    runtime.connect_if_due(std::chrono::steady_clock::now() + std::chrono::seconds(2));
    ASSERT_TRUE(wait_for_generation(runtime, 2));
    EXPECT_EQ(context.starts, 2U);
    EXPECT_NE(context.last_process, first_process);
    EXPECT_EQ(runtime.active().command_count, 64U);
  }
  EXPECT_EQ(::unlink(path_template.data()), 0);
  EXPECT_EQ(::unlink(probe_path), 0);
}

TEST(ExtensionHostTest, ReportsDeterministicLuaQuotaFailureWithoutRestarting) {
  std::array<char, 64> path_template{};
  constexpr std::string_view pattern = "/tmp/lemma-extension-quota-test-XXXXXX";
  std::ranges::copy(pattern, path_template.begin());
  int config = ::mkstemp(path_template.data());
  ASSERT_GE(config, 0);
  constexpr std::string_view source = "local value = string.rep('x', 32 * 1024 * 1024)";
  ASSERT_TRUE(platform::write_all(config, std::as_bytes(std::span(source.data(), source.size()))));
  platform::close_descriptor(config);

  SpawnContext context{.path = path_template.data()};
  ErrorContext errors;
  {
    core::ExtensionRuntime runtime(&spawn_host, &context, &report_error, &errors);
    ASSERT_TRUE(wait_for_error(runtime));
    EXPECT_TRUE(runtime.last_error().contains("memory"));
    EXPECT_EQ(errors.reports, 1U);
    EXPECT_EQ(context.starts, 1U);
    EXPECT_GE(runtime.descriptor(), 0);
  }
  EXPECT_EQ(::unlink(path_template.data()), 0);
}

TEST(ExtensionHostTest, ReportsEmptyLuaErrorWithoutRestarting) {
  std::array<char, 64> path_template{};
  constexpr std::string_view pattern = "/tmp/lemma-extension-error-test-XXXXXX";
  std::ranges::copy(pattern, path_template.begin());
  int config = ::mkstemp(path_template.data());
  ASSERT_GE(config, 0);
  constexpr std::string_view source = "error('', 0)";
  ASSERT_TRUE(platform::write_all(config, std::as_bytes(std::span(source.data(), source.size()))));
  platform::close_descriptor(config);

  SpawnContext context{.path = path_template.data()};
  ErrorContext errors;
  {
    core::ExtensionRuntime runtime(&spawn_host, &context, &report_error, &errors);
    ASSERT_TRUE(wait_for_error(runtime));
    EXPECT_EQ(runtime.last_error(), "unknown Lua configuration error");
    EXPECT_EQ(errors.reports, 1U);
    EXPECT_EQ(errors.error(), "unknown Lua configuration error");
    EXPECT_EQ(context.starts, 1U);
    EXPECT_GE(runtime.descriptor(), 0);
  }
  EXPECT_EQ(::unlink(path_template.data()), 0);
}

} // namespace
} // namespace lemma
