#include "support/process.hpp"

#include "fiber/limits.hpp"
#include "protocol/single_pane.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <cstring>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#include <gtest/gtest.h>

#ifndef FIBER_TEST_SERVER_PATH
#error "FIBER_TEST_SERVER_PATH must name the foreground test server"
#endif
#ifndef FIBER_TEST_CLI_PATH
#error "FIBER_TEST_CLI_PATH must name the injected CLI driver"
#endif

namespace fiber::test {
namespace {

using namespace std::chrono_literals;

struct CommandResult final {
  int status{-1};
  std::string output;
};

class MuxProcessTest : public testing::Test {
protected:
  void SetUp() override {
    ASSERT_TRUE(runtime_.valid());
    ASSERT_TRUE(
        server_.spawn({FIBER_TEST_SERVER_PATH, runtime_.socket_path()}, runtime_.environment()));
    ASSERT_TRUE(wait_for_endpoint(runtime_.socket_path(), deadline_after(5s))) << server_.output();
  }

  [[nodiscard]] auto command(const std::vector<std::string>& arguments) -> CommandResult {
    std::vector<std::string> command_arguments{FIBER_TEST_CLI_PATH, runtime_.socket_path()};
    command_arguments.insert(command_arguments.end(), arguments.begin(), arguments.end());
    ChildProcess process;
    if (!process.spawn(command_arguments, runtime_.environment()) ||
        !process.wait(deadline_after(5s))) {
      return {.status = -1, .output = process.output()};
    }
    auto status = process.status();
    return {
        .status = WIFEXITED(status) ? WEXITSTATUS(status) : -1,
        .output = process.output(),
    };
  }

  [[nodiscard]] auto wait_for_listing(const std::string_view workspace,
                                      const std::string_view predicate, const Deadline deadline,
                                      PtyClient* const client = nullptr) -> bool {
    while (std::chrono::steady_clock::now() < deadline) {
      if (client != nullptr) {
        client->drain(std::min(deadline, deadline_after(5ms)));
      }
      const auto listing = command({"list", std::string(workspace)});
      if (listing.status == 0 && listing.output.contains(predicate)) {
        return true;
      }
      std::this_thread::sleep_for(10ms);
    }
    return false;
  }

  [[nodiscard]] auto client_arguments(const std::string_view command,
                                      const std::string_view workspace) const
      -> std::vector<std::string> {
    return {FIBER_TEST_CLI_PATH, runtime_.socket_path(), std::string(command),
            std::string(workspace)};
  }

  // GoogleTest's generated fixture subclass requires direct protected access.
  // NOLINTNEXTLINE(cppcoreguidelines-non-private-member-variables-in-classes)
  TemporaryRuntime runtime_;
  // NOLINTNEXTLINE(cppcoreguidelines-non-private-member-variables-in-classes)
  ChildProcess server_;
};

[[nodiscard]] auto open_raw_connection(const std::string& path) -> int {
  int connection = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (connection < 0) {
    return -1;
  }
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  if (path.size() >= sizeof(address.sun_path)) {
    static_cast<void>(::close(connection));
    return -1;
  }
  std::memcpy(std::span(address.sun_path).data(), path.c_str(), path.size() + 1U);
  // The socket ABI intentionally erases the concrete address type.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const auto* generic = reinterpret_cast<const sockaddr*>(&address);
  if (::connect(connection, generic, sizeof(address)) != 0) {
    static_cast<void>(::close(connection));
    return -1;
  }
  return connection;
}

[[nodiscard]] auto open_raw_connection_until(const std::string& path, const Deadline deadline)
    -> int {
  while (std::chrono::steady_clock::now() < deadline) {
    const int connection = open_raw_connection(path);
    if (connection >= 0) {
      return connection;
    }
    std::this_thread::sleep_for(1ms);
  }
  return -1;
}

[[nodiscard]] auto send_bytes(const int connection, const std::span<const std::byte> bytes) noexcept
    -> bool {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const auto sent =
        ::send(connection, bytes.subspan(offset).data(), bytes.size() - offset, MSG_NOSIGNAL);
    if (sent <= 0) {
      return false;
    }
    offset += static_cast<std::size_t>(sent);
  }
  return true;
}

TEST_F(MuxProcessTest, CreatesAttachesRendersAndDetaches) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "basic"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(client.send("printf '__FIBER_BASIC__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__FIBER_BASIC__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail() << "\nserver:\n"
      << server_.output();
  const auto attached_listing = command({"list", "basic"});
  ASSERT_EQ(attached_listing.status, 0) << attached_listing.output;
  ASSERT_NE(attached_listing.output.find("1 window(s), 1 pane(s)"), std::string::npos)
      << attached_listing.output;

  const std::array detach{std::byte{0x02}, std::byte{'d'}};
  ASSERT_TRUE(client.send(detach, deadline_after(2s)));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
  ASSERT_TRUE(wait_for_listing("basic", "detached", deadline_after(3s)));
}

TEST_F(MuxProcessTest, PreservesTopologyAcrossResizeAbruptExitAndReattach) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "topology"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(client.send("printf '__TOPOLOGY__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__TOPOLOGY__", deadline_after(5s)));

  const std::array commands{std::byte{0x02}, std::byte{'%'}, std::byte{0x02}, std::byte{'"'},
                            std::byte{0x02}, std::byte{'c'}, std::byte{0x02}, std::byte{'p'},
                            std::byte{0x02}, std::byte{'z'}, std::byte{0x02}, std::byte{'z'}};
  ASSERT_TRUE(client.send(commands, deadline_after(2s)));
  ASSERT_TRUE(wait_for_listing("topology", "2 window(s), 4 pane(s)", deadline_after(5s), &client))
      << command({"list", "topology"}).output << "\nraw:\n"
      << client.raw_tail();
  ASSERT_TRUE(client.resize(100, 30));
  ASSERT_TRUE(client.send("\r", deadline_after(2s)));
  ASSERT_TRUE(wait_for_listing("topology", "100x30", deadline_after(5s), &client))
      << command({"list", "topology"}).output;
  ASSERT_TRUE(client.resize(2, 2));
  ASSERT_TRUE(client.send("\r", deadline_after(2s)));
  ASSERT_TRUE(client.resize(80, 24));
  ASSERT_TRUE(client.send("\r", deadline_after(2s)));

  client.terminate();
  ASSERT_TRUE(wait_for_listing("topology", "detached", deadline_after(5s)));

  PtyClient reattached;
  ASSERT_TRUE(
      reattached.spawn(client_arguments("attach", "topology"), runtime_.environment(), 80, 24));
  ASSERT_TRUE(reattached.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(reattached.send("printf '__REATTACHED__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(reattached.wait_for_screen("__REATTACHED__", deadline_after(5s)))
      << reattached.screen() << "\nraw:\n"
      << reattached.raw_tail();
  ASSERT_TRUE(reattached.send(std::array{std::byte{0x02}, std::byte{'d'}}, deadline_after(2s)));
  ASSERT_TRUE(reattached.wait(deadline_after(5s)));
}

TEST_F(MuxProcessTest, LastShellExitReclaimsWorkspaceAndRestoresTerminal) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "exitcase"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(client.send("exit\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait(deadline_after(5s))) << client.raw_tail();
  EXPECT_TRUE(client.terminal_state_restored());
  EXPECT_NE(client.raw_tail().find("\x1B[?1049l"), std::string::npos) << client.raw_tail();

  const auto listing = command({"list"});
  ASSERT_EQ(listing.status, 0) << listing.output;
  EXPECT_NE(listing.output.find("no fiber workspaces"), std::string::npos) << listing.output;
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, IdleAndNonreadingPeersCannotBlockAnotherWorkspace) {
  ASSERT_EQ(command({"start", "blocked"}).status, 0);
  ASSERT_EQ(command({"start", "responsive"}).status, 0);

  int idle = open_raw_connection(runtime_.socket_path());
  ASSERT_GE(idle, 0);

  int nonreader = open_raw_connection(runtime_.socket_path());
  ASSERT_GE(nonreader, 0);
  int receive_buffer = 1'024;
  ASSERT_EQ(::setsockopt(nonreader, SOL_SOCKET, SO_RCVBUF, &receive_buffer,
                         static_cast<socklen_t>(sizeof(receive_buffer))),
            0);
  constexpr std::string_view blocked = "blocked";
  const auto header = protocol::encode_workspace_header(protocol::ControlCommand::attach, blocked);
  const auto dimensions = protocol::encode_dimensions({.columns = 500, .rows = 200});
  ASSERT_TRUE(send_bytes(nonreader, header));
  ASSERT_TRUE(send_bytes(nonreader, std::as_bytes(std::span(blocked.data(), blocked.size()))));
  ASSERT_TRUE(send_bytes(nonreader, dimensions));

  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("attach", "responsive"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(client.send("printf '__STILL_RESPONSIVE__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__STILL_RESPONSIVE__", deadline_after(5s)))
      << client.screen() << "\nserver:\n"
      << server_.output();

  int fragmented = open_raw_connection(runtime_.socket_path());
  ASSERT_GE(fragmented, 0);
  const std::array list_workspace{protocol::wire_byte(protocol::ControlCommand::list_workspace)};
  ASSERT_TRUE(send_bytes(fragmented, list_workspace));
  ASSERT_TRUE(client.send("printf '__FRAGMENTED_SETUP__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__FRAGMENTED_SETUP__", deadline_after(5s)));
  const std::array name_size{static_cast<std::byte>(std::string_view("responsive").size())};
  ASSERT_TRUE(send_bytes(fragmented, name_size));
  for (const char character : std::string_view("responsive")) {
    const std::array byte{static_cast<std::byte>(character)};
    ASSERT_TRUE(send_bytes(fragmented, byte));
  }

  static_cast<void>(::close(fragmented));

  std::vector<int> capacity_peers;
  capacity_peers.reserve(limits::pending_connections_hard_max);
  for (std::size_t index = 0; index < limits::pending_connections_hard_max; ++index) {
    const int peer = open_raw_connection_until(runtime_.socket_path(), deadline_after(2s));
    ASSERT_GE(peer, 0);
    capacity_peers.push_back(peer);
  }
  std::vector<pollfd> capacity_events;
  capacity_events.reserve(capacity_peers.size());
  for (const int peer : capacity_peers) {
    capacity_events.push_back({.fd = peer, .events = POLLIN, .revents = 0});
  }
  ASSERT_GT(::poll(capacity_events.data(), static_cast<nfds_t>(capacity_events.size()), 2'000), 0);
  bool capacity_observed = false;
  for (const auto& events : capacity_events) {
    if ((events.revents & POLLIN) == 0) {
      continue;
    }
    std::byte response{};
    if (::recv(events.fd, &response, 1, 0) == 1 &&
        response == protocol::wire_byte(protocol::ControlResponse::capacity)) {
      capacity_observed = true;
      break;
    }
  }
  EXPECT_TRUE(capacity_observed);
  ASSERT_TRUE(client.send("printf '__CAPACITY_ISOLATED__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__CAPACITY_ISOLATED__", deadline_after(5s)));
  for (const int peer : capacity_peers) {
    static_cast<void>(::close(peer));
  }

  static_cast<void>(::close(idle));
  static_cast<void>(::close(nonreader));
  ASSERT_TRUE(client.send(std::array{std::byte{0x02}, std::byte{'d'}}, deadline_after(2s)));
  if (!client.wait(deadline_after(5s))) {
    // Teardown remains bounded even if a stressed client needs longer to observe the close.
    client.terminate();
  }
}

} // namespace
} // namespace fiber::test
