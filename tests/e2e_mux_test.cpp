#include "support/process.hpp"

#include "fiber/limits.hpp"
#include "protocol/single_pane.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include <fcntl.h>
#include <poll.h>
#include <sys/wait.h>
#include <unistd.h>

#include <gtest/gtest.h>

#ifndef FIBER_TEST_SERVER_PATH
#error "FIBER_TEST_SERVER_PATH must name the foreground test server"
#endif
#ifndef FIBER_TEST_CLI_PATH
#error "FIBER_TEST_CLI_PATH must name the injected CLI driver"
#endif
#ifndef FIBER_TEST_PTY_PEER_PATH
#error "FIBER_TEST_PTY_PEER_PATH must name the deterministic PTY peer"
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

  void TearDown() override {
    server_.terminate();
    if (server_.status() < 0) {
      return;
    }
    auto status = server_.status();
    EXPECT_TRUE(WIFEXITED(status)) << server_.output();
    if (WIFEXITED(status)) {
      EXPECT_EQ(WEXITSTATUS(status), 0) << server_.output();
    }
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

  template <typename Predicate>
  [[nodiscard]] auto wait_for_workspace(const std::string_view workspace, Predicate predicate,
                                        const Deadline deadline, PtyClient* const client = nullptr)
      -> std::optional<WorkspaceListing> {
    while (std::chrono::steady_clock::now() < deadline) {
      if (client != nullptr) {
        client->drain(std::min(deadline, deadline_after(5ms)));
      }
      const auto result = command({"list", std::string(workspace)});
      if (result.status == 0) {
        auto listing = parse_workspace_listing(result.output);
        if (listing.has_value() && predicate(*listing)) {
          return listing;
        }
      }
      std::this_thread::sleep_for(10ms);
    }
    return std::nullopt;
  }

  template <typename Predicate>
  [[nodiscard]] auto wait_for_windows(const std::string_view workspace, Predicate predicate,
                                      const Deadline deadline, PtyClient* const client = nullptr)
      -> std::vector<WindowListing> {
    while (std::chrono::steady_clock::now() < deadline) {
      if (client != nullptr) {
        client->drain(std::min(deadline, deadline_after(5ms)));
      }
      const auto result = command({"windows", std::string(workspace)});
      if (result.status == 0) {
        auto listings = parse_window_listings(result.output);
        if (predicate(listings)) {
          return listings;
        }
      }
      std::this_thread::sleep_for(10ms);
    }
    return {};
  }

  [[nodiscard]] static auto send_prefix(PtyClient& client, const std::byte command) -> bool {
    const std::array bytes{std::byte{0x02}, command};
    return client.send(bytes, deadline_after(2s));
  }

  [[nodiscard]] static auto send_direction(PtyClient& client, const char final) -> bool {
    const std::array bytes{std::byte{0x02}, std::byte{0x1B}, std::byte{'['},
                           static_cast<std::byte>(final)};
    return client.send(bytes, deadline_after(2s));
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

[[nodiscard]] auto
named_request(const protocol::ControlCommand command, const std::string_view workspace,
              const std::optional<protocol::Dimensions> dimensions = std::nullopt)
    -> std::vector<std::byte> {
  const auto header = protocol::encode_workspace_header(command, workspace);
  std::vector<std::byte> request(header.begin(), header.end());
  const auto name = std::as_bytes(std::span(workspace.data(), workspace.size()));
  request.insert(request.end(), name.begin(), name.end());
  if (dimensions.has_value()) {
    const auto encoded = protocol::encode_dimensions(*dimensions);
    request.insert(request.end(), encoded.begin(), encoded.end());
  }
  return request;
}

[[nodiscard]] auto shell_quote(const std::string_view value) -> std::string {
  std::string quoted{"'"};
  for (const char character : value) {
    if (character == '\'') {
      quoted += "'\\''";
    } else {
      quoted.push_back(character);
    }
  }
  quoted.push_back('\'');
  return quoted;
}

[[nodiscard]] auto create_gate(const std::string& path) noexcept -> bool {
  // open is variadic because the mode argument is present only with O_CREAT.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const int descriptor = ::open(path.c_str(), O_CREAT | O_EXCL | O_WRONLY, 0600);
  if (descriptor < 0) {
    return false;
  }
  return ::close(descriptor) == 0;
}

[[nodiscard]] auto input_request(const std::string_view input) -> std::vector<std::byte> {
  const auto header = protocol::encode_input_header(input.size());
  std::vector<std::byte> request(header.begin(), header.end());
  const auto bytes = std::as_bytes(std::span(input.data(), input.size()));
  request.insert(request.end(), bytes.begin(), bytes.end());
  return request;
}

[[nodiscard]] auto read_until_contains(RawPeer& peer, const std::string_view marker,
                                       const Deadline deadline) -> bool {
  std::string received;
  constexpr std::size_t received_bytes_max = std::size_t{8} * 1'024U * 1'024U;
  constexpr std::size_t retained_bytes = std::size_t{64} * 1'024U;
  while (std::chrono::steady_clock::now() < deadline && received.size() < received_bytes_max) {
    std::array<std::byte, std::size_t{64} * 1'024U> bytes{};
    const auto count = peer.read_some(bytes, deadline);
    if (count <= 0) {
      return false;
    }
    const auto data = std::span(bytes).first(static_cast<std::size_t>(count));
    // Byte and character storage have the same object representation.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    received.append(reinterpret_cast<const char*>(data.data()), data.size());
    if (received.contains(marker)) {
      return true;
    }
    if (!marker.empty() && received.size() > marker.size() + retained_bytes) {
      received.erase(0, received.size() - (marker.size() + retained_bytes));
    }
  }
  return false;
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

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, RoutesDirectionalNextAndPreviousFocus) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "focus"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));

  const auto first = wait_for_workspace(
      "focus", [](const WorkspaceListing& value) { return value.panes == 1; }, deadline_after(5s),
      &client);
  ASSERT_TRUE(first.has_value());
  const auto pane_a = first.value_or(WorkspaceListing{}).focused_pid;

  ASSERT_TRUE(send_prefix(client, std::byte{'%'}));
  const auto second = wait_for_workspace(
      "focus",
      [pane_a](const WorkspaceListing& value) {
        return value.panes == 2 && value.focused_pid != pane_a;
      },
      deadline_after(5s), &client);
  ASSERT_TRUE(second.has_value());
  const auto pane_b = second.value_or(WorkspaceListing{}).focused_pid;

  ASSERT_TRUE(send_prefix(client, std::byte{'"'}));
  const auto third = wait_for_workspace(
      "focus",
      [pane_a, pane_b](const WorkspaceListing& value) {
        return value.panes == 3 && value.focused_pid != pane_a && value.focused_pid != pane_b;
      },
      deadline_after(5s), &client);
  ASSERT_TRUE(third.has_value());
  const auto pane_c = third.value_or(WorkspaceListing{}).focused_pid;

  const auto expect_focus = [&](const pid_t expected) {
    return wait_for_workspace(
               "focus",
               [expected](const WorkspaceListing& value) { return value.focused_pid == expected; },
               deadline_after(5s), &client)
        .has_value();
  };
  ASSERT_TRUE(send_direction(client, 'A'));
  ASSERT_TRUE(expect_focus(pane_b));
  ASSERT_TRUE(send_direction(client, 'D'));
  ASSERT_TRUE(expect_focus(pane_a));
  ASSERT_TRUE(send_direction(client, 'C'));
  ASSERT_TRUE(expect_focus(pane_b));
  ASSERT_TRUE(send_direction(client, 'B'));
  ASSERT_TRUE(expect_focus(pane_c));
  ASSERT_TRUE(send_prefix(client, std::byte{'o'}));
  ASSERT_TRUE(expect_focus(pane_a));
  ASSERT_TRUE(send_prefix(client, std::byte{';'}));
  ASSERT_TRUE(expect_focus(pane_c));

  ASSERT_TRUE(client.send("printf '__FOCUSED_C__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__FOCUSED_C__", deadline_after(5s)));
  ASSERT_TRUE(send_prefix(client, std::byte{'d'}));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, ClosesPanesAndTogglesZoom) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "zoomclose"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  const auto first = wait_for_workspace(
      "zoomclose", [](const WorkspaceListing& value) { return value.panes == 1; },
      deadline_after(5s), &client);
  ASSERT_TRUE(first.has_value());
  const auto surviving_pid = first.value_or(WorkspaceListing{}).focused_pid;

  ASSERT_TRUE(send_prefix(client, std::byte{'%'}));
  const auto split = wait_for_workspace(
      "zoomclose",
      [surviving_pid](const WorkspaceListing& value) {
        return value.panes == 2 && value.focused_pid != surviving_pid;
      },
      deadline_after(5s), &client);
  ASSERT_TRUE(split.has_value());

  ASSERT_TRUE(send_prefix(client, std::byte{'z'}));
  ASSERT_TRUE(client.send("printf '__ZOOMED__ '; stty size\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__ZOOMED__ 23 80", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();

  ASSERT_TRUE(send_prefix(client, std::byte{'z'}));
  ASSERT_TRUE(client.send("printf '__UNZOOMED__ '; stty size\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__UNZOOMED__ 23 39", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();

  ASSERT_TRUE(send_prefix(client, std::byte{'x'}));
  const auto closed = wait_for_workspace(
      "zoomclose",
      [surviving_pid](const WorkspaceListing& value) {
        return value.panes == 1 && value.focused_pid == surviving_pid;
      },
      deadline_after(5s), &client);
  ASSERT_TRUE(closed.has_value());
  ASSERT_TRUE(client.send("printf '__SURVIVOR__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__SURVIVOR__", deadline_after(5s)));

  ASSERT_TRUE(send_prefix(client, std::byte{'x'}));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
  const auto removed = command({"list", "zoomclose"});
  EXPECT_NE(removed.status, 0);
  EXPECT_TRUE(client.terminal_state_restored());
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, CreatesCyclesSelectsAndClosesWindows) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "windows"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(send_prefix(client, std::byte{'c'}));
  ASSERT_TRUE(send_prefix(client, std::byte{'c'}));

  const auto active_window = [](const std::vector<WindowListing>& values,
                                const std::size_t expected) {
    return values.size() == 3 &&
           std::ranges::any_of(values, [expected](const WindowListing& value) {
             return value.number == expected && value.active;
           });
  };
  ASSERT_FALSE(wait_for_windows(
                   "windows", [&](const auto& values) { return active_window(values, 3); },
                   deadline_after(5s), &client)
                   .empty());
  ASSERT_TRUE(send_prefix(client, std::byte{'p'}));
  ASSERT_FALSE(wait_for_windows(
                   "windows", [&](const auto& values) { return active_window(values, 2); },
                   deadline_after(5s), &client)
                   .empty());
  ASSERT_TRUE(send_prefix(client, std::byte{'n'}));
  ASSERT_FALSE(wait_for_windows(
                   "windows", [&](const auto& values) { return active_window(values, 3); },
                   deadline_after(5s), &client)
                   .empty());
  ASSERT_TRUE(send_prefix(client, std::byte{'1'}));
  ASSERT_FALSE(wait_for_windows(
                   "windows", [&](const auto& values) { return active_window(values, 1); },
                   deadline_after(5s), &client)
                   .empty());

  ASSERT_TRUE(send_prefix(client, std::byte{'9'}));
  ASSERT_FALSE(wait_for_windows(
                   "windows", [&](const auto& values) { return active_window(values, 1); },
                   deadline_after(2s), &client)
                   .empty());
  ASSERT_TRUE(send_prefix(client, std::byte{'3'}));
  ASSERT_FALSE(wait_for_windows(
                   "windows", [&](const auto& values) { return active_window(values, 3); },
                   deadline_after(5s), &client)
                   .empty());
  ASSERT_TRUE(send_prefix(client, std::byte{'&'}));
  const auto after_close = wait_for_windows(
      "windows",
      [](const std::vector<WindowListing>& values) {
        return values.size() == 2 && std::ranges::any_of(values, [](const WindowListing& value) {
                 return value.number == 1 && value.active;
               });
      },
      deadline_after(5s), &client);
  ASSERT_EQ(after_close.size(), 2U);

  ASSERT_TRUE(send_prefix(client, std::byte{'2'}));
  ASSERT_TRUE(client.send("printf '__WINDOW_TWO_ALIVE__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__WINDOW_TWO_ALIVE__", deadline_after(5s)));
  ASSERT_TRUE(send_prefix(client, std::byte{'&'}));
  const auto one_window = wait_for_windows(
      "windows",
      [](const std::vector<WindowListing>& values) {
        return values.size() == 1 && values.front().number == 1 && values.front().active;
      },
      deadline_after(5s), &client);
  ASSERT_EQ(one_window.size(), 1U);
  ASSERT_TRUE(send_prefix(client, std::byte{'d'}));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
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
TEST_F(MuxProcessTest, AcceptsCoalescedAndFragmentedSetupWithoutStallingPtys) {
  ASSERT_EQ(command({"start", "rawattach"}).status, 0);
  ASSERT_EQ(command({"start", "responsive_setup"}).status, 0);

  PtyClient responsive;
  ASSERT_TRUE(
      responsive.spawn(client_arguments("attach", "responsive_setup"), runtime_.environment()));
  ASSERT_TRUE(responsive.wait_for_raw("\x1B[?1049h", deadline_after(5s)));

  RawPeer coalesced;
  ASSERT_TRUE(coalesced.connect(runtime_.socket_path(), deadline_after(2s)));
  const auto list_request =
      named_request(protocol::ControlCommand::list_workspace, "responsive_setup");
  ASSERT_TRUE(coalesced.send(list_request, deadline_after(2s)));
  const auto list_output = coalesced.read_until_close(std::size_t{64} * 1'024U, deadline_after(5s));
  ASSERT_TRUE(list_output.has_value());
  EXPECT_TRUE(list_output.value_or(std::string{}).contains("responsive_setup"));

  RawPeer fragmented;
  ASSERT_TRUE(fragmented.connect(runtime_.socket_path(), deadline_after(2s)));
  ASSERT_TRUE(fragmented.send_fragments(std::span(list_request).first(1), 1, deadline_after(2s)));
  ASSERT_TRUE(responsive.send("printf '__SETUP_PROGRESS__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(responsive.wait_for_screen("__SETUP_PROGRESS__", deadline_after(5s)));
  ASSERT_TRUE(fragmented.send_fragments(std::span(list_request).subspan(1), 1, deadline_after(2s)));
  const auto fragmented_output =
      fragmented.read_until_close(std::size_t{64} * 1'024U, deadline_after(5s));
  ASSERT_TRUE(fragmented_output.has_value());
  EXPECT_TRUE(fragmented_output.value_or(std::string{}).contains("responsive_setup"));

  RawPeer attached;
  ASSERT_TRUE(attached.connect(runtime_.socket_path(), deadline_after(2s)));
  const auto attach_request = named_request(protocol::ControlCommand::attach, "rawattach",
                                            protocol::Dimensions{.columns = 80, .rows = 24});
  ASSERT_TRUE(attached.send(attach_request, deadline_after(2s)));
  ASSERT_TRUE(attached.wait_for_byte(protocol::wire_byte(protocol::ControlResponse::ready),
                                     deadline_after(5s)));
  constexpr std::string_view marker_command = "printf '__RAW_ATTACHED__\\n'\r";
  const auto marker_input = input_request(marker_command);
  ASSERT_TRUE(attached.send(marker_input, deadline_after(2s)));
  ASSERT_TRUE(read_until_contains(attached, "__RAW_ATTACHED__", deadline_after(5s)))
      << attached.received_tail();

  ASSERT_TRUE(send_prefix(responsive, std::byte{'d'}));
  ASSERT_TRUE(responsive.wait(deadline_after(5s)));
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, RejectsMalformedAndDisconnectingSetupAndReusesSlots) {
  ASSERT_EQ(command({"start", "healthy"}).status, 0);
  const auto expect_healthy = [&] {
    const auto listing = command({"list", "healthy"});
    return listing.status == 0 && listing.output.contains("healthy");
  };
  const auto expect_close = [&](const std::span<const std::byte> request) {
    RawPeer peer;
    if (!peer.connect(runtime_.socket_path(), deadline_after(2s)) ||
        !peer.send(request, deadline_after(2s)) || !peer.wait_for_close(deadline_after(2s))) {
      return false;
    }
    return expect_healthy();
  };

  const std::array unknown{std::byte{'?'}};
  EXPECT_TRUE(expect_close(unknown));
  const std::array zero_name{protocol::wire_byte(protocol::ControlCommand::create), std::byte{0}};
  EXPECT_TRUE(expect_close(zero_name));
  const std::array oversized_name{protocol::wire_byte(protocol::ControlCommand::create),
                                  std::byte{protocol::workspace_name_bytes_max + 1U}};
  EXPECT_TRUE(expect_close(oversized_name));
  const auto invalid_name = named_request(protocol::ControlCommand::create, "bad.name");
  EXPECT_TRUE(expect_close(invalid_name));

  const auto disconnecting_attach = named_request(protocol::ControlCommand::attach, "healthy",
                                                  protocol::Dimensions{.columns = 80, .rows = 24});
  for (std::size_t prefix = 0; prefix < disconnecting_attach.size(); ++prefix) {
    RawPeer disconnected;
    ASSERT_TRUE(disconnected.connect(runtime_.socket_path(), deadline_after(2s)));
    if (prefix > 0) {
      ASSERT_TRUE(
          disconnected.send(std::span(disconnecting_attach).first(prefix), deadline_after(2s)));
    }
    disconnected.close();
    ASSERT_TRUE(expect_healthy());
  }

  for (const auto dimensions :
       {protocol::Dimensions{.columns = 0, .rows = 24},
        protocol::Dimensions{.columns = 80, .rows = 0},
        protocol::Dimensions{.columns = protocol::columns_max + 1U, .rows = 24},
        protocol::Dimensions{.columns = 80, .rows = protocol::rows_max + 1U}}) {
    RawPeer invalid;
    ASSERT_TRUE(invalid.connect(runtime_.socket_path(), deadline_after(2s)));
    const auto request = named_request(protocol::ControlCommand::attach, "healthy", dimensions);
    ASSERT_TRUE(invalid.send(request, deadline_after(2s)));
    ASSERT_TRUE(invalid.wait_for_byte(protocol::wire_byte(protocol::ControlResponse::failed),
                                      deadline_after(2s)));
    ASSERT_TRUE(invalid.wait_for_close(deadline_after(2s)));
    ASSERT_TRUE(expect_healthy());
  }

  RawPeer idle;
  ASSERT_TRUE(idle.connect(runtime_.socket_path(), deadline_after(2s)));
  ASSERT_TRUE(idle.wait_for_close(deadline_after(7s)));
  EXPECT_TRUE(expect_healthy());
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, SlowControlAndInitialAttachReadersRecoverWithoutBlockingPtys) {
  ASSERT_EQ(command({"start", "responsive_slow"}).status, 0);
  ASSERT_EQ(command({"start", "slow_attach"}).status, 0);
  for (std::size_t index = 0; index < 60; ++index) {
    const auto suffix = std::to_string(index);
    auto name = std::string(protocol::workspace_name_bytes_max - suffix.size(), 'f') + suffix;
    ASSERT_EQ(command({"start", name}).status, 0) << name;
  }

  PtyClient responsive;
  ASSERT_TRUE(
      responsive.spawn(client_arguments("attach", "responsive_slow"), runtime_.environment()));
  ASSERT_TRUE(responsive.wait_for_raw("\x1B[?1049h", deadline_after(5s)));

  RawPeer slow_attach;
  ASSERT_TRUE(slow_attach.connect(runtime_.socket_path(), deadline_after(2s)));
  ASSERT_TRUE(slow_attach.set_receive_buffer(4'096));
  const auto attach_request = named_request(protocol::ControlCommand::attach, "slow_attach",
                                            protocol::Dimensions{.columns = 200, .rows = 80});
  ASSERT_TRUE(slow_attach.send(attach_request, deadline_after(2s)));
  ASSERT_TRUE(slow_attach.wait_for_byte(protocol::wire_byte(protocol::ControlResponse::ready),
                                        deadline_after(5s)))
      << "peer errno: " << slow_attach.last_error() << "\nserver:\n"
      << server_.output();

  // Kernel buffering is platform-dependent; ConnectionOutputTest deterministically forces partial
  // writes and EAGAIN. This process scenario retains end-to-end isolation and recovery coverage.
  RawPeer slow_control;
  ASSERT_TRUE(slow_control.connect(runtime_.socket_path(), deadline_after(2s)));
  const std::array list_command{protocol::wire_byte(protocol::ControlCommand::list)};
  ASSERT_TRUE(slow_control.send(list_command, deadline_after(2s)));

  ASSERT_TRUE(responsive.send("printf '__SLOW_READERS_ISOLATED__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(responsive.wait_for_screen("__SLOW_READERS_ISOLATED__", deadline_after(5s)))
      << responsive.screen() << "\nserver:\n"
      << server_.output();

  const auto control_output = slow_control.read_until_close(
      limits::pending_connection_output_bytes_max, deadline_after(5s));
  ASSERT_TRUE(control_output.has_value()) << slow_control.received_tail();
  const auto control_text = control_output.value_or(std::string{});
  EXPECT_TRUE(control_text.contains("responsive_slow"))
      << "bytes=" << control_text.size() << " output=" << control_text;
  EXPECT_TRUE(control_text.contains(std::string(30, 'f') + "59"))
      << "bytes=" << control_text.size() << " output=" << control_text;

  constexpr std::string_view marker_command = "printf '__SLOW_ATTACH_RECOVERED__\\n'\r";
  ASSERT_TRUE(slow_attach.send(input_request(marker_command), deadline_after(5s)));
  ASSERT_TRUE(read_until_contains(slow_attach, "__SLOW_ATTACH_RECOVERED__", deadline_after(10s)))
      << slow_attach.received_tail();

  ASSERT_TRUE(send_prefix(responsive, std::byte{'d'}));
  ASSERT_TRUE(responsive.wait(deadline_after(5s)));
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, BackpressuresBlockedPtyAndRecoversInOrderWithoutStarvingPeers) {
  ASSERT_EQ(command({"start", "blocked_pty"}).status, 0);
  ASSERT_EQ(command({"start", "responsive_pty"}).status, 0);

  PtyClient blocked;
  ASSERT_TRUE(blocked.spawn(client_arguments("attach", "blocked_pty"), runtime_.environment()));
  ASSERT_TRUE(blocked.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  PtyClient responsive;
  ASSERT_TRUE(
      responsive.spawn(client_arguments("attach", "responsive_pty"), runtime_.environment()));
  ASSERT_TRUE(responsive.wait_for_raw("\x1B[?1049h", deadline_after(5s)));

  constexpr std::size_t payload_size = std::size_t{2} * 1'024U * 1'024U;
  const auto gate = runtime_.owned_path("blocked-pty.gate");
  const auto launch = "exec " + shell_quote(FIBER_TEST_PTY_PEER_PATH) + " block " +
                      shell_quote(gate) + " " + std::to_string(payload_size) + "\r";
  ASSERT_TRUE(blocked.send(launch, deadline_after(2s)));
  ASSERT_TRUE(blocked.wait_for_screen("__FIBER_PTY_READY__", deadline_after(5s)))
      << blocked.screen() << "\nraw:\n"
      << blocked.raw_tail();

  const std::vector<std::byte> payload(payload_size, std::byte{'q'});
  std::size_t sent = 0;
  auto last_progress = std::chrono::steady_clock::now();
  const auto fill_deadline = deadline_after(5s);
  while (sent < payload.size() && std::chrono::steady_clock::now() < fill_deadline &&
         std::chrono::steady_clock::now() - last_progress < 250ms) {
    std::size_t consumed = 0;
    ASSERT_TRUE(blocked.send_available(std::span(payload).subspan(sent), consumed));
    if (consumed > 0) {
      sent += consumed;
      last_progress = std::chrono::steady_clock::now();
    } else {
      std::this_thread::sleep_for(1ms);
    }
  }
  ASSERT_GT(sent, 0U);
  ASSERT_LT(sent, payload.size()) << "the unread PTY never applied client backpressure";
  const auto still_alive = wait_for_workspace(
      "blocked_pty",
      [](const WorkspaceListing& value) { return value.attached && value.panes == 1; },
      deadline_after(2s));
  ASSERT_TRUE(still_alive.has_value());

  const auto responsiveness_started = std::chrono::steady_clock::now();
  ASSERT_TRUE(responsive.send("printf '__BLOCKED_PTY_ISOLATED__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(responsive.wait_for_screen("__BLOCKED_PTY_ISOLATED__", deadline_after(5s)))
      << responsive.screen() << "\nserver:\n"
      << server_.output();
  EXPECT_LT(std::chrono::steady_clock::now() - responsiveness_started, 2s);

  ASSERT_TRUE(create_gate(gate));
  ASSERT_TRUE(blocked.send(std::span(payload).subspan(sent), deadline_after(15s)));
  ASSERT_TRUE(blocked.wait_for_screen("__FIBER_PTY_DONE__ bytes=2097152 digest=d939b04ca2c22325",
                                      deadline_after(20s)))
      << blocked.screen() << "\nraw:\n"
      << blocked.raw_tail() << "\nserver:\n"
      << server_.output();
  ASSERT_TRUE(blocked.wait(deadline_after(5s)));
  EXPECT_TRUE(blocked.terminal_state_restored());

  ASSERT_TRUE(send_prefix(responsive, std::byte{'d'}));
  ASSERT_TRUE(responsive.wait(deadline_after(5s)));
}

// Queue contention is covered deterministically by PtyWriterTest; this process case verifies the
// terminal-adapter response round trip through the daemon and a real PTY.
TEST_F(MuxProcessTest, RoutesTerminalResponsesAndClientInputToPtyPeers) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "response_order"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));

  const auto gate = runtime_.owned_path("response-order.gate");
  constexpr std::string_view user_input = "USER_AFTER_RESPONSE";
  const auto launch = "exec " + shell_quote(FIBER_TEST_PTY_PEER_PATH) + " order " +
                      shell_quote(gate) + " " + shell_quote(user_input) + "\r";
  ASSERT_TRUE(client.send(launch, deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__FIBER_ORDER_READY__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();
  ASSERT_TRUE(client.send(user_input, deadline_after(2s)));
  ASSERT_TRUE(create_gate(gate));
  ASSERT_TRUE(client.wait_for_screen("__FIBER_ORDER_OK__", deadline_after(10s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail() << "\nserver:\n"
      << server_.output();
  ASSERT_TRUE(client.wait(deadline_after(5s)));
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, IdleAndNonreadingPeersCannotBlockAnotherWorkspace) {
  ASSERT_EQ(command({"start", "blocked"}).status, 0);
  ASSERT_EQ(command({"start", "responsive"}).status, 0);

  RawPeer idle;
  ASSERT_TRUE(idle.connect(runtime_.socket_path(), deadline_after(2s)));

  RawPeer nonreader;
  ASSERT_TRUE(nonreader.connect(runtime_.socket_path(), deadline_after(2s)));
  const auto blocked_attach = named_request(protocol::ControlCommand::attach, "blocked",
                                            protocol::Dimensions{.columns = 500, .rows = 200});
  ASSERT_TRUE(nonreader.send(blocked_attach, deadline_after(2s)));

  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("attach", "responsive"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(client.send("printf '__STILL_RESPONSIVE__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__STILL_RESPONSIVE__", deadline_after(5s)))
      << client.screen() << "\nserver:\n"
      << server_.output();

  RawPeer fragmented;
  ASSERT_TRUE(fragmented.connect(runtime_.socket_path(), deadline_after(2s)));
  const std::array list_workspace{protocol::wire_byte(protocol::ControlCommand::list_workspace)};
  ASSERT_TRUE(fragmented.send(list_workspace, deadline_after(2s)));
  ASSERT_TRUE(client.send("printf '__FRAGMENTED_SETUP__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__FRAGMENTED_SETUP__", deadline_after(5s)));
  const std::array name_size{static_cast<std::byte>(std::string_view("responsive").size())};
  ASSERT_TRUE(fragmented.send(name_size, deadline_after(2s)));
  for (const char character : std::string_view("responsive")) {
    const std::array byte{static_cast<std::byte>(character)};
    ASSERT_TRUE(fragmented.send(byte, deadline_after(2s)));
  }
  fragmented.close();

  // Exceed the hard limit directly; the earlier idle peer may expire independently.
  std::array<RawPeer, limits::pending_connections_hard_max + 1> capacity_peers;
  for (auto& peer : capacity_peers) {
    ASSERT_TRUE(peer.connect(runtime_.socket_path(), deadline_after(2s)));
  }
  std::array<pollfd, limits::pending_connections_hard_max + 1> capacity_events{};
  for (std::size_t index = 0; index < capacity_peers.size(); ++index) {
    std::span(capacity_events).subspan(index, 1).front() = {
        .fd = std::span(capacity_peers).subspan(index, 1).front().native_handle(),
        .events = POLLIN,
        .revents = 0,
    };
  }
  bool capacity_observed = false;
  for (std::size_t attempt = 0; attempt < 20 && !capacity_observed; ++attempt) {
    ASSERT_GE(::poll(capacity_events.data(), static_cast<nfds_t>(capacity_events.size()), 100), 0);
    for (std::size_t index = 0; index < capacity_events.size(); ++index) {
      auto& events = std::span(capacity_events).subspan(index, 1).front();
      if ((events.revents & POLLIN) != 0) {
        std::array<std::byte, 1> response{};
        auto& peer = std::span(capacity_peers).subspan(index, 1).front();
        if (peer.read_some(response, deadline_after(100ms)) == 1 &&
            response.front() == protocol::wire_byte(protocol::ControlResponse::capacity)) {
          capacity_observed = true;
          break;
        }
      }
      if ((events.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
        events.fd = -1;
      }
      events.revents = 0;
    }
  }
  EXPECT_TRUE(capacity_observed);
  ASSERT_TRUE(client.send("printf '__CAPACITY_ISOLATED__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__CAPACITY_ISOLATED__", deadline_after(5s)));
  for (auto& peer : capacity_peers) {
    peer.close();
  }

  idle.close();
  nonreader.close();
  ASSERT_TRUE(client.send(std::array{std::byte{0x02}, std::byte{'d'}}, deadline_after(2s)));
  if (!client.wait(deadline_after(5s))) {
    // Teardown remains bounded even if a stressed client needs longer to observe the close.
    client.terminate();
  }
}

} // namespace
} // namespace fiber::test
