#include "support/process.hpp"

#include "lemma/limits.hpp"
#include "protocol/attachment.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>

#include <gtest/gtest.h>

#ifndef LEMMA_TEST_SERVER_PATH
#error "LEMMA_TEST_SERVER_PATH must name the foreground test server"
#endif
#ifndef LEMMA_TEST_CLI_PATH
#error "LEMMA_TEST_CLI_PATH must name the injected CLI driver"
#endif
#ifndef LEMMA_TEST_PTY_PEER_PATH
#error "LEMMA_TEST_PTY_PEER_PATH must name the deterministic PTY peer"
#endif

namespace lemma::test {
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
    auto server_environment = runtime_.environment();
    server_environment.emplace_back("LEMMA_DAEMON_SECRET=daemon-only");
    ASSERT_TRUE(
        server_.spawn({LEMMA_TEST_SERVER_PATH, runtime_.socket_path()}, server_environment));
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
    std::vector<std::string> command_arguments{LEMMA_TEST_CLI_PATH, runtime_.socket_path()};
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

  [[nodiscard]] auto wait_for_listing(const std::string_view session,
                                      const std::string_view predicate, const Deadline deadline,
                                      PtyClient* const client = nullptr) -> bool {
    while (std::chrono::steady_clock::now() < deadline) {
      if (client != nullptr) {
        client->drain(std::min(deadline, deadline_after(5ms)));
      }
      const auto listing = command({"list", std::string(session)});
      if (listing.status == 0 && listing.output.contains(predicate)) {
        return true;
      }
      std::this_thread::sleep_for(10ms);
    }
    return false;
  }

  template <typename Predicate>
  [[nodiscard]] auto wait_for_session(const std::string_view session, Predicate predicate,
                                      const Deadline deadline, PtyClient* const client = nullptr)
      -> std::optional<SessionListing> {
    while (std::chrono::steady_clock::now() < deadline) {
      if (client != nullptr) {
        client->drain(std::min(deadline, deadline_after(5ms)));
      }
      const auto result = command({"list", std::string(session)});
      if (result.status == 0) {
        auto listing = parse_session_listing(result.output);
        if (listing.has_value() && predicate(*listing)) {
          return listing;
        }
      }
      std::this_thread::sleep_for(10ms);
    }
    return std::nullopt;
  }

  template <typename Predicate>
  [[nodiscard]] auto wait_for_tabs(const std::string_view session, Predicate predicate,
                                   const Deadline deadline, PtyClient* const client = nullptr)
      -> std::vector<TabListing> {
    while (std::chrono::steady_clock::now() < deadline) {
      if (client != nullptr) {
        client->drain(std::min(deadline, deadline_after(5ms)));
      }
      const auto result = command({"tabs", std::string(session)});
      if (result.status == 0) {
        auto listings = parse_tab_listings(result.output);
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

  [[nodiscard]] static auto send_kitty_direction(PtyClient& client, const char final) -> bool {
    std::string bytes = "\x1B[98;5:1u\x1B[98;5:3u\x1B[1;1:1X\x1B[1;1:3X";
    std::ranges::replace(bytes, 'X', final);
    return client.send(bytes, deadline_after(2s));
  }

  [[nodiscard]] auto client_arguments(const std::string_view command,
                                      const std::string_view session) const
      -> std::vector<std::string> {
    return {LEMMA_TEST_CLI_PATH, runtime_.socket_path(), std::string(command),
            std::string(session)};
  }

  // GoogleTest's generated fixture subclass requires direct protected access.
  // NOLINTNEXTLINE(cppcoreguidelines-non-private-member-variables-in-classes)
  TemporaryRuntime runtime_;
  // NOLINTNEXTLINE(cppcoreguidelines-non-private-member-variables-in-classes)
  ChildProcess server_;
};

[[nodiscard]] auto named_request(const protocol::ControlCommand command,
                                 const std::string_view session) -> std::vector<std::byte> {
  const auto header = protocol::encode_session_header(command, session);
  std::vector<std::byte> request(header.begin(), header.end());
  const auto name = std::as_bytes(std::span(session.data(), session.size()));
  request.insert(request.end(), name.begin(), name.end());
  return request;
}

[[nodiscard]] auto
attach_request(const std::string_view session, const protocol::Dimensions dimensions,
               const protocol::ProtocolVersion version = protocol::current_version)
    -> std::vector<std::byte> {
  const auto encoded = protocol::encode_client_hello(session, dimensions, 1, version);
  return {encoded.bytes().begin(), encoded.bytes().end()};
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

[[nodiscard]] auto process_exists(const pid_t process) noexcept -> bool {
  if (process <= 0) {
    return false;
  }
  if (::kill(process, 0) == 0) {
    return true;
  }
  return errno != ESRCH;
}

[[nodiscard]] auto wait_for_process_exit(const pid_t process, const Deadline deadline) -> bool {
  while (std::chrono::steady_clock::now() < deadline) {
    if (!process_exists(process)) {
      return true;
    }
    std::this_thread::sleep_for(10ms);
  }
  return !process_exists(process);
}

[[nodiscard]] auto input_request(const std::string_view input, const std::uint32_t sequence = 2)
    -> std::vector<std::byte> {
  const auto header = protocol::encode_input_header(input.size(), sequence);
  std::vector<std::byte> request(header.begin(), header.end());
  const auto bytes = std::as_bytes(std::span(input.data(), input.size()));
  request.insert(request.end(), bytes.begin(), bytes.end());
  return request;
}

[[nodiscard]] auto fill_server_decoder(RawPeer& peer, protocol::ServerDecoder& decoder,
                                       const Deadline deadline) -> bool {
  auto available = decoder.writable_bytes();
  if (available.empty()) {
    return false;
  }
  constexpr std::size_t read_bytes_max = std::size_t{64} * 1'024U;
  const auto count =
      peer.read_some(available.first(std::min(available.size(), read_bytes_max)), deadline);
  return count > 0 && decoder.commit(static_cast<std::size_t>(count)).has_value();
}

[[nodiscard]] auto wait_for_server_hello(RawPeer& peer, protocol::ServerDecoder& decoder,
                                         const Deadline deadline) -> bool {
  if (!decoder.prepare().has_value()) {
    return false;
  }
  while (std::chrono::steady_clock::now() < deadline) {
    const auto decoded = decoder.next();
    if (!decoded.has_value()) {
      return false;
    }
    if (decoded->has_value()) {
      const bool hello = (**decoded).kind == protocol::ServerMessageKind::hello;
      decoder.consume();
      return hello;
    }
    if (!fill_server_decoder(peer, decoder, deadline)) {
      return false;
    }
  }
  return false;
}

[[nodiscard]] auto wait_for_disconnect(RawPeer& peer, protocol::ServerDecoder& decoder,
                                       const protocol::DisconnectReason expected,
                                       const Deadline deadline) -> bool {
  while (std::chrono::steady_clock::now() < deadline) {
    const auto decoded = decoder.next();
    if (!decoded.has_value()) {
      return false;
    }
    if (decoded->has_value()) {
      return (**decoded).kind == protocol::ServerMessageKind::disconnect &&
             (**decoded).reason == expected && !(**decoded).diagnostic.empty();
    }
    if (!fill_server_decoder(peer, decoder, deadline)) {
      return false;
    }
  }
  return false;
}

[[nodiscard]] auto wait_for_disconnect(RawPeer& peer, const protocol::DisconnectReason expected,
                                       const Deadline deadline) -> bool {
  protocol::ServerDecoder decoder;
  return decoder.prepare().has_value() && wait_for_disconnect(peer, decoder, expected, deadline);
}

[[nodiscard]] auto wait_for_full_generation(RawPeer& peer, protocol::ServerDecoder& decoder,
                                            const std::uint32_t generation, const Deadline deadline)
    -> bool {
  while (std::chrono::steady_clock::now() < deadline) {
    const auto decoded = decoder.next();
    if (!decoded.has_value()) {
      return false;
    }
    if (decoded->has_value()) {
      const auto& message = **decoded;
      const bool matched = message.kind == protocol::ServerMessageKind::render_frame &&
                           message.full_redraw && message.full_redraw_generation == generation &&
                           !message.ansi.empty();
      decoder.consume();
      if (matched) {
        return true;
      }
      continue;
    }
    if (!fill_server_decoder(peer, decoder, deadline)) {
      return false;
    }
  }
  return false;
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
[[nodiscard]] auto read_until_contains(RawPeer& peer, protocol::ServerDecoder& decoder,
                                       const std::string_view marker, const Deadline deadline)
    -> bool {
  std::string received;
  constexpr std::size_t received_bytes_max = std::size_t{8} * 1'024U * 1'024U;
  constexpr std::size_t retained_bytes = std::size_t{64} * 1'024U;
  while (std::chrono::steady_clock::now() < deadline && received.size() < received_bytes_max) {
    const auto decoded = decoder.next();
    if (!decoded.has_value()) {
      return false;
    }
    if (!decoded->has_value()) {
      if (!fill_server_decoder(peer, decoder, deadline)) {
        return false;
      }
      continue;
    }
    const auto& message = **decoded;
    if (message.kind != protocol::ServerMessageKind::render_frame) {
      return false;
    }
    // Byte and character storage have the same object representation.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    received.append(reinterpret_cast<const char*>(message.ansi.data()), message.ansi.size());
    decoder.consume();
    if (received.contains(marker)) {
      return true;
    }
    if (!marker.empty() && received.size() > marker.size() + retained_bytes) {
      received.erase(0, received.size() - (marker.size() + retained_bytes));
    }
  }
  return false;
}

TEST_F(MuxProcessTest, ProvidesDefaultInvocationHelpVersionErrorsAndShutdown) {
  const auto help = command({"--help"});
  EXPECT_EQ(help.status, 0) << help.output;
  EXPECT_TRUE(help.output.contains("Usage: lemma")) << help.output;
  EXPECT_TRUE(help.output.contains("shutdown --confirm")) << help.output;
  const auto version = command({"--version"});
  EXPECT_EQ(version.status, 0) << version.output;
  EXPECT_TRUE(version.output.contains("lemma 0.1.0")) << version.output;
  EXPECT_TRUE(version.output.contains("private protocol lemma-private-2.2")) << version.output;
  const auto invalid = command({"not-a-command"});
  EXPECT_EQ(invalid.status, 2) << invalid.output;
  EXPECT_TRUE(invalid.output.contains("invalid lemma command")) << invalid.output;

  PtyClient client;
  ASSERT_TRUE(client.spawn({LEMMA_TEST_CLI_PATH, runtime_.socket_path()}, runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(client.send(std::array{std::byte{0x02}, std::byte{'d'}}, deadline_after(2s)));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
  ASSERT_TRUE(wait_for_listing("default", "detached", deadline_after(3s)));

  const auto unconfirmed_shutdown = command({"shutdown"});
  EXPECT_NE(unconfirmed_shutdown.status, 0) << unconfirmed_shutdown.output;
  EXPECT_TRUE(unconfirmed_shutdown.output.contains("WARNING")) << unconfirmed_shutdown.output;
  EXPECT_TRUE(unconfirmed_shutdown.output.contains("shutdown --confirm"))
      << unconfirmed_shutdown.output;
  EXPECT_FALSE(server_.wait(deadline_after(100ms))) << server_.output();

  const auto shutdown = command({"shutdown", "--confirm"});
  EXPECT_EQ(shutdown.status, 0) << shutdown.output;
  EXPECT_TRUE(shutdown.output.contains("WARNING")) << shutdown.output;
  EXPECT_TRUE(shutdown.output.contains("lemma daemon stopped")) << shutdown.output;
  EXPECT_TRUE(server_.wait(deadline_after(5s))) << server_.output();
}

TEST_F(MuxProcessTest, CommitsShutdownWhenControlPeerDisconnectsBeforeAcknowledgement) {
  RawPeer requester;
  ASSERT_TRUE(requester.connect(runtime_.socket_path(), deadline_after(2s)));
  const std::array request{protocol::wire_byte(protocol::ControlCommand::shutdown)};
  ASSERT_TRUE(requester.send(request, deadline_after(2s)));
  requester.close();

  EXPECT_TRUE(server_.wait(deadline_after(5s))) << server_.output();
}

TEST_F(MuxProcessTest, PreservesExplicitlyEmptyLaunchEnvironment) {
  constexpr std::string_view session = "empty_context";
  auto request = named_request(protocol::ControlCommand::create_with_context, session);
  const auto directory_size = protocol::encode_bounded_size(runtime_.directory().size());
  request.insert(request.end(), directory_size.begin(), directory_size.end());
  const auto directory =
      std::as_bytes(std::span(runtime_.directory().data(), runtime_.directory().size()));
  request.insert(request.end(), directory.begin(), directory.end());
  const auto environment_size = protocol::encode_bounded_size(0);
  request.insert(request.end(), environment_size.begin(), environment_size.end());

  RawPeer creator;
  ASSERT_TRUE(creator.connect(runtime_.socket_path(), deadline_after(2s)));
  ASSERT_TRUE(creator.send(request, deadline_after(2s)));
  ASSERT_TRUE(creator.wait_for_byte(protocol::wire_byte(protocol::ControlResponse::ready),
                                    deadline_after(2s)));
  creator.close();

  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("attach", session), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(
      client.send("printf '__EMPTY_CONTEXT__%s__EMPTY_CONTEXT__\\n' \"$LEMMA_DAEMON_SECRET\"\r",
                  deadline_after(2s)));
  EXPECT_TRUE(client.wait_for_screen("__EMPTY_CONTEXT____EMPTY_CONTEXT__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();
  ASSERT_TRUE(client.send(std::array{std::byte{0x02}, std::byte{'d'}}, deadline_after(2s)));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
}

TEST_F(MuxProcessTest, CapturesInvokingWorkingDirectoryForSessionPanes) {
  const auto launch = "cd " + shell_quote(runtime_.directory()) + " && " +
                      shell_quote(LEMMA_TEST_CLI_PATH) + " " + shell_quote(runtime_.socket_path()) +
                      " start cwd";
  ChildProcess creator;
  auto creator_environment = runtime_.environment();
  creator_environment.emplace_back("LEMMA_SESSION_TEST=invoking-client");
  ASSERT_TRUE(creator.spawn({"/bin/sh", "-c", launch}, creator_environment));
  ASSERT_TRUE(creator.wait(deadline_after(5s))) << creator.output();
  auto creator_status = creator.status();
  ASSERT_TRUE(WIFEXITED(creator_status));
  ASSERT_EQ(WEXITSTATUS(creator_status), 0) << creator.output();

  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("attach", "cwd"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(client.send(
      "printf '__CWD__%s__CWD__\\n__ENV__%s__ENV__\\n' \"$PWD\" \"$LEMMA_SESSION_TEST\"\r",
      deadline_after(2s)));
  const auto directory_name =
      runtime_.directory().substr(runtime_.directory().find_last_of('/') + 1U);
  ASSERT_TRUE(client.wait_for_screen(directory_name + "__CWD__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();
  ASSERT_TRUE(client.wait_for_screen("__ENV__invoking-client__ENV__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();
  ASSERT_TRUE(client.send(std::array{std::byte{0x02}, std::byte{'d'}}, deadline_after(2s)));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
}

TEST_F(MuxProcessTest, ReusesExistingSessionAndFallsBackForFreshSessionWithoutCwd) {
  ASSERT_EQ(command({"start", "existing"}).status, 0);
  const auto deleted_directory = runtime_.owned_path("deleted-cwd");
  const auto launch = "mkdir " + shell_quote(deleted_directory) + " && cd " +
                      shell_quote(deleted_directory) + " && rmdir " +
                      shell_quote(deleted_directory) + " && exec " +
                      shell_quote(LEMMA_TEST_CLI_PATH) + " " + shell_quote(runtime_.socket_path()) +
                      " start existing";
  ChildProcess invoker;
  ASSERT_TRUE(invoker.spawn({"/bin/sh", "-c", launch}, runtime_.environment()));
  ASSERT_TRUE(invoker.wait(deadline_after(5s))) << invoker.output();
  auto status = invoker.status();
  ASSERT_TRUE(WIFEXITED(status)) << invoker.output();
  EXPECT_EQ(WEXITSTATUS(status), 0) << invoker.output();
  EXPECT_TRUE(invoker.output().contains("warning: current directory unavailable"))
      << invoker.output();
  EXPECT_TRUE(invoker.output().contains("existing")) << invoker.output();

  const auto fresh_deleted_directory = runtime_.owned_path("fresh-deleted-cwd");
  const auto fresh_launch = "mkdir " + shell_quote(fresh_deleted_directory) + " && cd " +
                            shell_quote(fresh_deleted_directory) + " && rmdir " +
                            shell_quote(fresh_deleted_directory) + " && exec " +
                            shell_quote(LEMMA_TEST_CLI_PATH) + " " +
                            shell_quote(runtime_.socket_path()) + " start fresh";
  ChildProcess creator;
  ASSERT_TRUE(creator.spawn({"/bin/sh", "-c", fresh_launch}, runtime_.environment()));
  ASSERT_TRUE(creator.wait(deadline_after(5s))) << creator.output();
  auto creator_status = creator.status();
  ASSERT_TRUE(WIFEXITED(creator_status)) << creator.output();
  EXPECT_EQ(WEXITSTATUS(creator_status), 0) << creator.output();
  EXPECT_TRUE(creator.output().contains("warning: current directory unavailable"))
      << creator.output();
  EXPECT_TRUE(creator.output().contains("fresh")) << creator.output();
}

TEST_F(MuxProcessTest, CreatesAttachesRendersAndDetaches) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "basic"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(client.send("printf '__LEMMA_BASIC__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__LEMMA_BASIC__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail() << "\nserver:\n"
      << server_.output();
  const auto attached_listing = command({"list", "basic"});
  ASSERT_EQ(attached_listing.status, 0) << attached_listing.output;
  ASSERT_NE(attached_listing.output.find("1 tab(s), 1 pane(s)"), std::string::npos)
      << attached_listing.output;

  const std::array detach{std::byte{0x02}, std::byte{'d'}};
  ASSERT_TRUE(client.send(detach, deadline_after(2s)));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
  ASSERT_TRUE(wait_for_listing("basic", "detached", deadline_after(3s)));
}

TEST_F(MuxProcessTest, RoutesKittyKeyMetadataThroughMuxAndGhostty) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "typed_keys"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[>23u", deadline_after(5s)));

  // A conforming outer terminal may encode the disambiguated C-b while leaving the printable
  // command as ordinary text when "report all keys" is disabled.
  constexpr std::string_view create_tab = "\x1B[98;5:1u\x1B[98;5:3u"
                                          "c";
  ASSERT_TRUE(client.send(create_tab, deadline_after(2s)));
  ASSERT_TRUE(wait_for_session(
                  "typed_keys",
                  [](const SessionListing& value) { return value.tabs == 2 && value.panes == 2; },
                  deadline_after(5s), &client)
                  .has_value());

  ASSERT_TRUE(client.send("stty -echo -icanon min 1 time 0; v=$(dd bs=1 count=1 2>/dev/null | od "
                          "-An -tu1 | tr -d ' '); "
                          "stty sane; printf '__TYPED_KEY_%s__\\n' \"$v\"\r",
                          deadline_after(2s)));
  // Ghostty omits the default modifier/event field before associated text on a key press.
  constexpr std::string_view typed_x = "\x1B[120;;120u\x1B[120;1:3u";
  ASSERT_TRUE(client.send(typed_x, deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__TYPED_KEY_120__", deadline_after(5s))) << client.screen();

  constexpr std::string_view typed_detach = "\x1B[98;5:1u\x1B[98;5:3u"
                                            "d";
  ASSERT_TRUE(client.send(typed_detach, deadline_after(2s)));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
}

TEST_F(MuxProcessTest, RoutesPasteFocusAndMouseBoundariesToGhostty) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "structured_input"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?2004h", deadline_after(5s)));

  ASSERT_TRUE(client.send("stty -echo -icanon min 1 time 0; "
                          "printf '\\033[?2004h\\033[?1004h\\033[?1000h\\033[?1006h"
                          "__STRUCTURED_%s__\\r\\n' READY; "
                          "v=$(dd bs=1 count=46 2>/dev/null | od -An -tx1 | tr -d ' \\n'); "
                          "stty sane; expected="
                          "1b5b3230307e5002641b5b3230317e1b5b491b5b3c303b353b324d"
                          "1b5b3c36343b353b324d1b5b3c303b353b316d; "
                          "if [ \"$v\" = \"$expected\" ]; then printf '__STRUCTURED_OK__\\n'; "
                          "else printf '__STRUCTURED_BAD_%s__\\n' \"$v\"; fi\r",
                          deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__STRUCTURED_READY__", deadline_after(5s)))
      << client.screen();

  constexpr std::string_view host_input = "\x1B[200~P\x02"
                                          "d\x1B[201~\x1B[I\x1B[<0;5;3M\x1B[<64;5;3M"
                                          "\x1B[<0;5;1m";
  ASSERT_TRUE(client.send(host_input, deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__STRUCTURED_OK__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail() << "\nserver:\n"
      << server_.output();

  ASSERT_TRUE(send_prefix(client, std::byte{'d'}));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
}

TEST_F(MuxProcessTest, ClickFocusesTheHitPaneThroughTheCommandPath) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "mouse_focus"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(send_prefix(client, std::byte{'%'}));
  ASSERT_TRUE(wait_for_listing("mouse_focus", "2 pane(s)", deadline_after(5s), &client));
  ASSERT_TRUE(wait_for_listing("mouse_focus", "pane=1:1", deadline_after(5s), &client));

  constexpr std::string_view click_left = "\x1B[<0;1;2M\x1B[<0;1;2m";
  ASSERT_TRUE(client.send(click_left, deadline_after(2s)));
  ASSERT_TRUE(wait_for_listing("mouse_focus", "pane=0:1", deadline_after(5s), &client))
      << command({"list", "mouse_focus"}).output << "\nraw:\n"
      << client.raw_tail();

  ASSERT_TRUE(send_prefix(client, std::byte{'d'}));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, HandlesMouseEdgesCopyTransitionsAndDeletedCaptureTargets) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "mouse_edges"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(send_prefix(client, std::byte{'%'}));
  ASSERT_TRUE(wait_for_listing("mouse_edges", "pane=1:1", deadline_after(5s), &client));

  // Status and the vertical separator are outside pane content and cannot change focus.
  constexpr std::string_view outside_clicks = "\x1B[<0;1;1M\x1B[<0;1;1m"
                                              "\x1B[<0;41;2M\x1B[<0;41;2m";
  ASSERT_TRUE(client.send(outside_clicks, deadline_after(2s)));
  ASSERT_TRUE(client.send("printf '__OUTSIDE_IGNORED__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__OUTSIDE_IGNORED__", deadline_after(5s))) << client.screen();
  ASSERT_TRUE(wait_for_listing("mouse_edges", "pane=1:1", deadline_after(5s), &client));

  // Clicking another pane while copy mode owns the old pane exits copy mode instead of treating
  // the target change as a protocol failure.
  ASSERT_TRUE(send_prefix(client, std::byte{'['}));
  ASSERT_TRUE(client.wait_for_screen("[0/0]", deadline_after(5s))) << client.screen();
  constexpr std::string_view click_left = "\x1B[<0;1;2M\x1B[<0;1;2m";
  ASSERT_TRUE(client.send(click_left, deadline_after(2s)));
  ASSERT_TRUE(client.send("printf '__COPY_MOUSE_SWITCH__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__COPY_MOUSE_SWITCH__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();
  ASSERT_TRUE(wait_for_listing("mouse_edges", "pane=0:1", deadline_after(5s), &client));

  // A captured drag/release clamps to the owner even over status or another pane, then releases
  // ownership so the next press can target normally.
  constexpr std::string_view drag_through_status = "\x1B[<0;1;2M"
                                                   "\x1B[<32;1;1M"
                                                   "\x1B[<0;1;1m";
  ASSERT_TRUE(client.send(drag_through_status, deadline_after(2s)));
  constexpr std::string_view click_right = "\x1B[<0;80;2M\x1B[<0;80;2m";
  ASSERT_TRUE(client.send(click_right, deadline_after(2s)));
  ASSERT_TRUE(wait_for_listing("mouse_edges", "pane=1:1", deadline_after(5s), &client));

  constexpr std::string_view drag_across_panes = "\x1B[<0;1;2M"
                                                 "\x1B[<32;80;2M"
                                                 "\x1B[<0;80;2m";
  ASSERT_TRUE(client.send(drag_across_panes, deadline_after(2s)));
  ASSERT_TRUE(wait_for_listing("mouse_edges", "pane=0:1", deadline_after(5s), &client));
  ASSERT_TRUE(client.send(click_right, deadline_after(2s)));
  ASSERT_TRUE(wait_for_listing("mouse_edges", "pane=1:1", deadline_after(5s), &client));

  // A fresh press replaces an abandoned capture rather than inheriting its old pane target.
  ASSERT_TRUE(client.send("\x1B[<0;1;2M\x1B[<0;80;2M\x1B[<0;80;2m", deadline_after(2s)));
  ASSERT_TRUE(client.send("printf '__FRESH_PRESS_REPLACED_CAPTURE__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__FRESH_PRESS_REPLACED_CAPTURE__", deadline_after(5s)))
      << client.screen();
  ASSERT_TRUE(wait_for_listing("mouse_edges", "pane=1:1", deadline_after(5s), &client));

  // Deleting a pane with an active capture invalidates the generational target. Its later release
  // is dropped rather than retargeted to the surviving pane.
  ASSERT_TRUE(client.send("\x1B[<0;80;2M", deadline_after(2s)));
  ASSERT_TRUE(send_prefix(client, std::byte{'x'}));
  ASSERT_TRUE(wait_for_listing("mouse_edges", "1 pane(s)", deadline_after(5s), &client));
  ASSERT_TRUE(client.send("\x1B[<0;80;2m", deadline_after(2s)));
  ASSERT_TRUE(client.send("printf '__STALE_CAPTURE_SURVIVED__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__STALE_CAPTURE_SURVIVED__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();

  ASSERT_TRUE(send_prefix(client, std::byte{'d'}));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
}

TEST_F(MuxProcessTest, SelectsShellTextInsideItsPaneWithoutEnteringCopyMode) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "mouse_selection"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(client.send("printf '\\033[2J\\033[H__MOUSE_SELECTION__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__MOUSE_SELECTION__", deadline_after(5s))) << client.screen();

  constexpr std::string_view drag = "\x1B[<0;1;2M"
                                    "\x1B[<32;9;2M"
                                    "\x1B[<0;9;2m";
  ASSERT_TRUE(client.send(drag, deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_raw("\x1B[0;7m", deadline_after(5s))) << client.screen() << "\nraw:\n"
                                                                    << client.raw_tail();

  ASSERT_TRUE(client.send("printf '__MOUSE_SELECTION_INPUT__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__MOUSE_SELECTION_INPUT__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();
  ASSERT_TRUE(send_prefix(client, std::byte{'d'}));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, WheelScrollsWithoutCopyModeAndApplicationInputFollowsOutput) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "mouse_wheel"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  const auto gate = runtime_.owned_path("nonmodal-scroll.gate");
  const auto acknowledged = runtime_.owned_path("nonmodal-scroll.ack");
  const auto launch =
      "printf '__WHEEL_%s__\\n' TOP; "
      "i=0; while [ $i -lt 45 ]; do printf "
      "'wheel-%02d-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\\n' "
      "\"$i\"; i=$((i+1)); done; "
      "printf '__WHEEL_%s__\\n' BOTTOM; while [ ! -e " +
      shell_quote(gate) + " ]; do sleep 0.01; done; printf '__WHEEL_%s__\\n' MUTATION; : > " +
      shell_quote(acknowledged) + "; sleep 30\r";
  ASSERT_TRUE(client.send(launch, deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__WHEEL_BOTTOM__", deadline_after(5s))) << client.screen();

  constexpr std::string_view one_wheel_up = "\x1B[<64;1;2M";
  constexpr std::string_view one_wheel_down = "\x1B[<65;1;2M";
  std::string wheel_up;
  std::string wheel_down;
  for (std::size_t index = 0; index < 80; ++index) {
    wheel_up.append(one_wheel_up);
    wheel_down.append(one_wheel_down);
  }
  ASSERT_TRUE(client.send(wheel_up, deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__WHEEL_TOP__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail() << "\nserver:\n"
      << server_.output();
  EXPECT_FALSE(client.screen().contains("COPY")) << client.screen();

  const auto settle_output = [&client]() {
    const auto deadline = deadline_after(100ms);
    while (std::chrono::steady_clock::now() < deadline) {
      client.drain(std::min(deadline, deadline_after(20ms)));
    }
  };
  settle_output();
  const auto screen_at_top = client.screen();
  ASSERT_TRUE(client.send("\x1B[<66;1;2M\x1B[<67;1;2M", deadline_after(2s)));
  settle_output();
  EXPECT_EQ(client.screen(), screen_at_top)
      << "horizontal trackpad reports must not become vertical wheel-down input";

  ASSERT_TRUE(create_gate(gate));
  const auto acknowledgement_deadline = deadline_after(5s);
  while (::access(acknowledged.c_str(), F_OK) != 0 &&
         std::chrono::steady_clock::now() < acknowledgement_deadline) {
    client.drain(std::min(acknowledgement_deadline, deadline_after(20ms)));
  }
  ASSERT_EQ(::access(acknowledged.c_str(), F_OK), 0);
  client.drain(deadline_after(100ms));
  EXPECT_TRUE(client.screen().contains("__WHEEL_TOP__")) << client.screen();
  EXPECT_FALSE(client.screen().contains("__WHEEL_MUTATION__")) << client.screen();

  ASSERT_TRUE(client.send(wheel_down, deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__WHEEL_MUTATION__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();
  EXPECT_FALSE(client.screen().contains("COPY")) << client.screen();

  ASSERT_TRUE(client.send(wheel_up, deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__WHEEL_TOP__", deadline_after(5s))) << client.screen();
  ASSERT_TRUE(client.send(std::array{std::byte{0x03}}, deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__WHEEL_BOTTOM__", deadline_after(5s))) << client.screen();
  ASSERT_TRUE(client.send("printf '__WHEEL_INPUT_%s__\\n' native\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__WHEEL_INPUT_native__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();
  EXPECT_FALSE(client.screen().contains("COPY")) << client.screen();
  ASSERT_TRUE(send_prefix(client, std::byte{'d'}));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
}

TEST_F(MuxProcessTest, WheelUsesGhosttyAlternateScrollInAlternateScreen) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "alternate_wheel"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(client.send("stty raw -echo; printf '\\033[?1049h__ALT_SCROLL_%s__' READY; "
                          "code=$(dd bs=1 count=3 2>/dev/null | od -An -tx1 | tr -d ' \\n'); "
                          "printf '\\033[?1049l'; stty sane; "
                          "printf '__ALT_SCROLL_%s__\\n' \"$code\"\r",
                          deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__ALT_SCROLL_READY__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();
  ASSERT_TRUE(client.send("\x1B[<64;1;2M", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__ALT_SCROLL_1b5b41__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail() << "\nserver:\n"
      << server_.output();
  ASSERT_TRUE(send_prefix(client, std::byte{'d'}));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
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
  ASSERT_TRUE(wait_for_listing("topology", "2 tab(s), 4 pane(s)", deadline_after(5s), &client))
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
TEST_F(MuxProcessTest, FullRedrawGenerationsRecoverTabResizeAndReconnect) {
  ASSERT_EQ(command({"start", "framed_recovery"}).status, 0);
  RawPeer attached;
  ASSERT_TRUE(attached.connect(runtime_.socket_path(), deadline_after(2s)));
  const auto hello = attach_request("framed_recovery", {.columns = 80, .rows = 24});
  ASSERT_TRUE(attached.send(hello, deadline_after(2s)));
  protocol::ServerDecoder decoder;
  ASSERT_TRUE(wait_for_server_hello(attached, decoder, deadline_after(5s)));
  ASSERT_TRUE(wait_for_full_generation(attached, decoder, 1, deadline_after(5s)));

  const auto create_tab = protocol::encode_pane_command(protocol::PaneCommand::create_tab, 2);
  ASSERT_TRUE(attached.send(create_tab.bytes(), deadline_after(2s)));
  ASSERT_TRUE(wait_for_full_generation(attached, decoder, 2, deadline_after(5s)));

  const auto resize = protocol::encode_resize({.columns = 100, .rows = 30}, 3);
  ASSERT_TRUE(attached.send(resize.bytes(), deadline_after(2s)));
  ASSERT_TRUE(wait_for_full_generation(attached, decoder, 3, deadline_after(5s)));

  const auto detach = protocol::encode_detach(4);
  ASSERT_TRUE(attached.send(detach.bytes(), deadline_after(2s)));
  attached.close();
  ASSERT_TRUE(wait_for_listing("framed_recovery", "detached", deadline_after(3s)));

  RawPeer reattached;
  ASSERT_TRUE(reattached.connect(runtime_.socket_path(), deadline_after(2s)));
  const auto reconnect = attach_request("framed_recovery", {.columns = 80, .rows = 24});
  ASSERT_TRUE(reattached.send(reconnect, deadline_after(2s)));
  protocol::ServerDecoder reconnect_decoder;
  ASSERT_TRUE(wait_for_server_hello(reattached, reconnect_decoder, deadline_after(5s)));
  ASSERT_TRUE(wait_for_full_generation(reattached, reconnect_decoder, 1, deadline_after(5s)));
  const auto reconnect_detach = protocol::encode_detach(2);
  ASSERT_TRUE(reattached.send(reconnect_detach.bytes(), deadline_after(2s)));
  ASSERT_TRUE(reattached.wait_for_close(deadline_after(5s)));
  ASSERT_TRUE(wait_for_listing("framed_recovery", "detached", deadline_after(3s)));
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, RoutesDirectionalNextAndPreviousFocus) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "focus"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));

  const auto first = wait_for_session(
      "focus", [](const SessionListing& value) { return value.panes == 1; }, deadline_after(5s),
      &client);
  ASSERT_TRUE(first.has_value());
  const auto pane_a = first.value_or(SessionListing{}).focused_pid;

  ASSERT_TRUE(send_prefix(client, std::byte{'%'}));
  const auto second = wait_for_session(
      "focus",
      [pane_a](const SessionListing& value) {
        return value.panes == 2 && value.focused_pid != pane_a;
      },
      deadline_after(5s), &client);
  ASSERT_TRUE(second.has_value());
  const auto pane_b = second.value_or(SessionListing{}).focused_pid;

  ASSERT_TRUE(send_prefix(client, std::byte{'"'}));
  const auto third = wait_for_session(
      "focus",
      [pane_a, pane_b](const SessionListing& value) {
        return value.panes == 3 && value.focused_pid != pane_a && value.focused_pid != pane_b;
      },
      deadline_after(5s), &client);
  ASSERT_TRUE(third.has_value());
  const auto pane_c = third.value_or(SessionListing{}).focused_pid;

  const auto expect_focus = [&](const pid_t expected) {
    return wait_for_session(
               "focus",
               [expected](const SessionListing& value) { return value.focused_pid == expected; },
               deadline_after(5s), &client)
        .has_value();
  };
  ASSERT_TRUE(send_direction(client, 'A'));
  ASSERT_TRUE(expect_focus(pane_b));
  // Ghostty reports arrows with Kitty event metadata as CSI 1;mod:event final. Exercise the real
  // C-b + left-arrow path rather than only the legacy byte sequence.
  ASSERT_TRUE(send_kitty_direction(client, 'D'));
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
TEST_F(MuxProcessTest, CopyModePreservesReflowedViewportAcrossPtyOutput) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "copy_resize"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));

  const auto gate = runtime_.owned_path("copy-resize.gate");
  const auto acknowledged = runtime_.owned_path("copy-resize.ack");
  const auto launch =
      "i=0; while [ $i -lt 20 ]; do printf "
      "'__COPY_REFLOW_ROW_%02d__abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\\n' "
      "\"$i\"; i=$((i + 1)); done; "
      "printf "
      "'__COPY_RESIZE_%s__abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\\n' "
      "TRACKED; "
      "i=20; while [ $i -lt 45 ]; do printf "
      "'__COPY_REFLOW_ROW_%02d__abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\\n' "
      "\"$i\"; i=$((i + 1)); done; printf '__COPY_RESIZE_READY__\\n'; "
      "while [ ! -e " +
      shell_quote(gate) + " ]; do sleep 0.01; done; printf '__COPY_RESIZE_MUTATION__\\n'; : > " +
      shell_quote(acknowledged) + "\r";
  ASSERT_TRUE(client.send(launch, deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__COPY_RESIZE_READY__", deadline_after(5s)))
      << client.screen();

  ASSERT_TRUE(send_prefix(client, std::byte{'['}));
  ASSERT_TRUE(client.send("?__COPY_RESIZE_TRACKED__\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__COPY_RESIZE_TRACKED__", deadline_after(5s)))
      << client.screen();
  const auto centered_screen = client.screen();
  const auto tracked_position = centered_screen.find("__COPY_RESIZE_TRACKED__");
  ASSERT_NE(tracked_position, std::string::npos);
  const auto tracked_row = static_cast<std::size_t>(
      std::ranges::count(std::string_view(centered_screen).substr(0, tracked_position), '\n'));
  EXPECT_GE(tracked_row, 6U) << centered_screen;
  EXPECT_LE(tracked_row, 17U) << centered_screen;

  ASSERT_TRUE(client.resize(40, 24));
  // Wake the attached client's poll loop after SIGWINCH; this byte is intentionally ignored by
  // copy mode, while the queued protocol resize is sent first.
  ASSERT_TRUE(client.send("z", deadline_after(2s)));
  ASSERT_TRUE(wait_for_listing("copy_resize", "40x24", deadline_after(5s), &client));
  ASSERT_TRUE(client.wait_for_screen("__COPY_RESIZE_TRACKED__", deadline_after(5s)))
      << client.screen();

  ASSERT_TRUE(create_gate(gate));
  const auto acknowledgement_deadline = deadline_after(5s);
  while (::access(acknowledged.c_str(), F_OK) != 0 &&
         std::chrono::steady_clock::now() < acknowledgement_deadline) {
    client.drain(std::min(acknowledgement_deadline, deadline_after(20ms)));
  }
  ASSERT_EQ(::access(acknowledged.c_str(), F_OK), 0);
  std::this_thread::sleep_for(100ms);
  client.drain(deadline_after(100ms));
  EXPECT_NE(client.screen().find("__COPY_RESIZE_TRACKED__"), std::string::npos)
      << client.screen() << "\nraw:\n"
      << client.raw_tail();

  ASSERT_TRUE(client.send("q", deadline_after(2s)));
  ASSERT_TRUE(send_prefix(client, std::byte{'d'}));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
}

TEST_F(MuxProcessTest, CopyModeHighlightsSelectsCopiesAndIsolatesInput) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "copy_mode"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(client.send("printf '__COPY_NEEDLE__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__COPY_NEEDLE__", deadline_after(5s)));
  const auto live_screen = client.screen();
  const auto live_status_begin = live_screen.find("[1:");
  ASSERT_NE(live_status_begin, std::string::npos) << live_screen;
  const auto live_status_end = live_screen.find(']', live_status_begin);
  ASSERT_NE(live_status_end, std::string::npos) << live_screen;
  const auto live_status =
      live_screen.substr(live_status_begin, live_status_end - live_status_begin + 1U);

  ASSERT_TRUE(send_prefix(client, std::byte{'['}));
  ASSERT_TRUE(client.wait_for_screen("[0/0]", deadline_after(5s))) << client.screen() << "\nraw:\n"
                                                                   << client.raw_tail();
  EXPECT_NE(client.screen().find(live_status), std::string::npos);
  EXPECT_EQ(client.screen().find("[1:COPY"), std::string::npos);
  ASSERT_TRUE(client.wait_for_raw("\x1B[0;7m", deadline_after(5s))) << client.raw_tail();

  // Vi keys and physical arrow sequences move only the daemon-owned copy cursor, including an
  // escape sequence fragmented across separate client input messages.
  ASSERT_TRUE(client.send("h\x1B", deadline_after(2s)));
  std::this_thread::sleep_for(10ms);
  ASSERT_TRUE(client.send("[D", deadline_after(2s)));
  ASSERT_TRUE(client.send(" ", deadline_after(2s)));
  ASSERT_TRUE(client.send("hh\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_raw("\x1B]52;c;", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();

  ASSERT_TRUE(send_prefix(client, std::byte{'/'}));
  // Unsupported modifier sequences are consumed as one copy-mode key and never leak a suffix to
  // the child or leave copy mode. Search previews incrementally before Enter commits the query.
  ASSERT_TRUE(client.send("\x1B[1;2A", deadline_after(2s)));
  ASSERT_TRUE(client.send("missing@copy-search", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("/missing@copy-search", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();
  ASSERT_TRUE(client.send("\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("no match", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();
  ASSERT_TRUE(client.send("q", deadline_after(2s)));

  ASSERT_TRUE(client.send("printf '__COPY_INPUT_ISOLATED__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__COPY_INPUT_ISOLATED__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();
  ASSERT_TRUE(send_prefix(client, std::byte{'d'}));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
}

TEST_F(MuxProcessTest, IncrementalSearchKeepsPreviousPreviewWhileRefiningQuery) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "copy_search_preview"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  constexpr std::string_view launch =
      "printf '__STABLE_%s_CONTEXT__ __STABLE@%s_TARGET__\\n' PREVIEW PREVIEW; "
      "i=0; while [ $i -lt 500 ]; do printf '__STABLE_FILLER_%04d__\\n' \"$i\"; "
      "i=$((i + 1)); done; printf '__STABLE_%s_READY__\\n' PREVIEW\r";
  ASSERT_TRUE(client.send(launch, deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__STABLE_PREVIEW_READY__", deadline_after(5s)))
      << client.screen();

  ASSERT_TRUE(send_prefix(client, std::byte{'?'}));
  ASSERT_TRUE(client.send("__STABLE@PREVIEW_TARGET__", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__STABLE_PREVIEW_CONTEXT__", deadline_after(5s)))
      << client.screen();

  ASSERT_TRUE(client.send("x", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("?__STABLE@PREVIEW_TARGET__x", deadline_after(2s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();
  EXPECT_NE(client.screen().find("__STABLE_PREVIEW_CONTEXT__"), std::string::npos)
      << client.screen();
  ASSERT_TRUE(client.wait_for_screen("__STABLE_PREVIEW_READY__", deadline_after(5s)))
      << client.screen();
  EXPECT_NE(client.screen().find("?__STABLE@PREVIEW_TARGET__x"), std::string::npos)
      << client.screen();
  EXPECT_EQ(client.screen().find("no match"), std::string::npos) << client.screen();
  ASSERT_TRUE(client.send("\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("no match", deadline_after(5s))) << client.screen();

  ASSERT_TRUE(client.send("q", deadline_after(2s)));
  ASSERT_TRUE(send_prefix(client, std::byte{'d'}));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, CancelledSearchPreservesCommittedDirectionForRepeat) {
  PtyClient client;
  ASSERT_TRUE(
      client.spawn(client_arguments("new", "copy_search_direction"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  constexpr std::string_view launch =
      "printf '__SEARCH_%s_CONTEXT__\\n' A; printf '__SEARCH_%s__\\n' MATCH; "
      "i=0; while [ $i -lt 40 ]; do printf '__SEARCH_FILLER_A_%02d__\\n' \"$i\"; "
      "i=$((i + 1)); done; "
      "printf '__SEARCH_%s_CONTEXT__\\n' B; printf '__SEARCH_%s__\\n' MATCH; "
      "i=0; while [ $i -lt 40 ]; do printf '__SEARCH_FILLER_B_%02d__\\n' \"$i\"; "
      "i=$((i + 1)); done; printf '__SEARCH_DIRECTION_%s__\\n' READY\r";
  ASSERT_TRUE(client.send(launch, deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__SEARCH_DIRECTION_READY__", deadline_after(5s)))
      << client.screen();

  ASSERT_TRUE(send_prefix(client, std::byte{'?'}));
  ASSERT_TRUE(client.send("__SEARCH_MATCH__\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__SEARCH_B_CONTEXT__", deadline_after(5s)))
      << client.screen();

  ASSERT_TRUE(send_prefix(client, std::byte{'/'}));
  ASSERT_TRUE(client.send("definitely-missing", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("/definitely-missing", deadline_after(5s))) << client.screen();
  ASSERT_TRUE(client.send("\x1B", deadline_after(2s)));
  std::this_thread::sleep_for(20ms);
  ASSERT_TRUE(client.send("n", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__SEARCH_A_CONTEXT__", deadline_after(5s)))
      << client.screen();
  ASSERT_TRUE(client.send("n", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__SEARCH_B_CONTEXT__", deadline_after(5s)))
      << client.screen();

  ASSERT_TRUE(client.send("q", deadline_after(2s)));
  ASSERT_TRUE(send_prefix(client, std::byte{'d'}));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, ClientLossClearsAttachmentCopyStateBeforeReconnect) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "copy_reconnect"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(client.send("printf '__COPY_RECONNECT_HISTORY__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__COPY_RECONNECT_HISTORY__", deadline_after(5s)));
  ASSERT_TRUE(send_prefix(client, std::byte{'['}));
  ASSERT_TRUE(client.wait_for_screen("[0/0]", deadline_after(5s)));

  client.terminate();
  ASSERT_TRUE(wait_for_listing("copy_reconnect", "detached", deadline_after(5s)));

  PtyClient reattached;
  ASSERT_TRUE(
      reattached.spawn(client_arguments("attach", "copy_reconnect"), runtime_.environment()));
  ASSERT_TRUE(reattached.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(reattached.send("printf '__COPY_RECONNECT_LIVE__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(reattached.wait_for_screen("__COPY_RECONNECT_LIVE__", deadline_after(5s)))
      << reattached.screen() << "\nraw:\n"
      << reattached.raw_tail();
  EXPECT_FALSE(reattached.screen().contains("[0/0]"));
  ASSERT_TRUE(send_prefix(reattached, std::byte{'d'}));
  ASSERT_TRUE(reattached.wait(deadline_after(5s)));
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, ClosesPanesAndTogglesZoom) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "zoomclose"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  const auto first = wait_for_session(
      "zoomclose", [](const SessionListing& value) { return value.panes == 1; }, deadline_after(5s),
      &client);
  ASSERT_TRUE(first.has_value());
  const auto surviving_pid = first.value_or(SessionListing{}).focused_pid;
  ASSERT_GT(surviving_pid, 0);

  ASSERT_TRUE(send_prefix(client, std::byte{'%'}));
  const auto split = wait_for_session(
      "zoomclose",
      [surviving_pid](const SessionListing& value) {
        return value.panes == 2 && value.focused_pid != surviving_pid;
      },
      deadline_after(5s), &client);
  ASSERT_TRUE(split.has_value());
  const auto closed_pid = split.value_or(SessionListing{}).focused_pid;
  ASSERT_GT(closed_pid, 0);
  ASSERT_TRUE(process_exists(surviving_pid));
  ASSERT_TRUE(process_exists(closed_pid));

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
  const auto closed = wait_for_session(
      "zoomclose",
      [surviving_pid](const SessionListing& value) {
        return value.panes == 1 && value.focused_pid == surviving_pid;
      },
      deadline_after(5s), &client);
  ASSERT_TRUE(closed.has_value());
  ASSERT_TRUE(wait_for_process_exit(closed_pid, deadline_after(5s)));
  ASSERT_TRUE(process_exists(surviving_pid));
  ASSERT_TRUE(client.send("printf '__SURVIVOR__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__SURVIVOR__", deadline_after(5s)));

  ASSERT_TRUE(send_prefix(client, std::byte{'x'}));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
  ASSERT_TRUE(wait_for_process_exit(surviving_pid, deadline_after(5s)));
  const auto removed = command({"list", "zoomclose"});
  EXPECT_NE(removed.status, 0);
  EXPECT_TRUE(client.terminal_state_restored());
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, CreatesCyclesSelectsAndClosesTabs) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "tabs"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(send_prefix(client, std::byte{'c'}));
  ASSERT_TRUE(send_prefix(client, std::byte{'c'}));

  const auto active_tab = [](const std::vector<TabListing>& values, const std::size_t expected) {
    return values.size() == 3 && std::ranges::any_of(values, [expected](const TabListing& value) {
             return value.number == expected && value.active;
           });
  };
  ASSERT_FALSE(wait_for_tabs(
                   "tabs", [&](const auto& values) { return active_tab(values, 3); },
                   deadline_after(5s), &client)
                   .empty());
  ASSERT_TRUE(send_prefix(client, std::byte{'p'}));
  ASSERT_FALSE(wait_for_tabs(
                   "tabs", [&](const auto& values) { return active_tab(values, 2); },
                   deadline_after(5s), &client)
                   .empty());
  ASSERT_TRUE(send_prefix(client, std::byte{'n'}));
  ASSERT_FALSE(wait_for_tabs(
                   "tabs", [&](const auto& values) { return active_tab(values, 3); },
                   deadline_after(5s), &client)
                   .empty());
  ASSERT_TRUE(send_prefix(client, std::byte{'1'}));
  ASSERT_FALSE(wait_for_tabs(
                   "tabs", [&](const auto& values) { return active_tab(values, 1); },
                   deadline_after(5s), &client)
                   .empty());

  ASSERT_TRUE(send_prefix(client, std::byte{'9'}));
  ASSERT_FALSE(wait_for_tabs(
                   "tabs", [&](const auto& values) { return active_tab(values, 1); },
                   deadline_after(2s), &client)
                   .empty());
  ASSERT_TRUE(send_prefix(client, std::byte{'3'}));
  ASSERT_FALSE(wait_for_tabs(
                   "tabs", [&](const auto& values) { return active_tab(values, 3); },
                   deadline_after(5s), &client)
                   .empty());

  ASSERT_TRUE(send_prefix(client, std::byte{'1'}));
  ASSERT_TRUE(send_prefix(client, std::byte{'&'}));
  const auto after_close = wait_for_tabs(
      "tabs",
      [](const std::vector<TabListing>& values) {
        return values.size() == 2 && values.front().number == 1 && values.front().active &&
               values.back().number == 2 && !values.back().active;
      },
      deadline_after(5s), &client);
  ASSERT_EQ(after_close.size(), 2U);

  ASSERT_TRUE(send_prefix(client, std::byte{'2'}));
  ASSERT_FALSE(wait_for_tabs(
                   "tabs",
                   [](const auto& values) {
                     return values.size() == 2 && values.back().number == 2 && values.back().active;
                   },
                   deadline_after(5s), &client)
                   .empty());
  ASSERT_TRUE(client.send("printf '__REINDEXED_TAB_TWO_ALIVE__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__REINDEXED_TAB_TWO_ALIVE__", deadline_after(5s)));
  ASSERT_TRUE(send_prefix(client, std::byte{'&'}));
  const auto one_tab = wait_for_tabs(
      "tabs",
      [](const std::vector<TabListing>& values) {
        return values.size() == 1 && values.front().number == 1 && values.front().active;
      },
      deadline_after(5s), &client);
  ASSERT_EQ(one_tab.size(), 1U);
  ASSERT_TRUE(send_prefix(client, std::byte{'d'}));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, RestoresTerminalOnStartupRejectionAndHandledSignals) {
  ASSERT_EQ(command({"start", "busy_restore"}).status, 0);
  PtyClient owner;
  ASSERT_TRUE(owner.spawn(client_arguments("attach", "busy_restore"), runtime_.environment()));
  ASSERT_TRUE(owner.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(owner.wait_for_raw("\x1B[?2004h", deadline_after(5s)));
  ASSERT_TRUE(owner.wait_for_raw("\x1B[?1004h", deadline_after(5s)));
  ASSERT_TRUE(owner.wait_for_raw("\x1B[?1002h\x1B[?1006h", deadline_after(5s)));
  ASSERT_TRUE(owner.wait_for_raw("\x1B[>23u", deadline_after(5s)));
  ASSERT_TRUE(owner.wait_for_raw("\x1B]10;?", deadline_after(5s)));
  PtyClient rejected;
  ASSERT_TRUE(rejected.spawn(client_arguments("attach", "busy_restore"), runtime_.environment()));
  ASSERT_TRUE(rejected.wait(deadline_after(5s)));
  EXPECT_TRUE(rejected.terminal_state_restored());
  EXPECT_FALSE(rejected.raw_tail().contains("\x1B[?1049h"));
  EXPECT_FALSE(rejected.raw_tail().contains("\x1B[?2004h"));
  EXPECT_FALSE(rejected.raw_tail().contains("\x1B[?1004h"));
  EXPECT_FALSE(rejected.raw_tail().contains("\x1B[?1002h"));
  EXPECT_FALSE(rejected.raw_tail().contains("\x1B[?1006h"));
  EXPECT_FALSE(rejected.raw_tail().contains("\x1B[>23u"));
  EXPECT_FALSE(rejected.raw_tail().contains("\x1B]10;?"));
  ASSERT_TRUE(send_prefix(owner, std::byte{'d'}));
  ASSERT_TRUE(owner.wait(deadline_after(5s)));
  EXPECT_TRUE(owner.terminal_state_restored());
  EXPECT_TRUE(owner.raw_tail().contains("\x1B[?2004l"));
  EXPECT_TRUE(owner.raw_tail().contains("\x1B[?1004l"));
  EXPECT_TRUE(owner.raw_tail().contains("\x1B[?1002l"));
  EXPECT_TRUE(owner.raw_tail().contains("\x1B[?1006l"));
  EXPECT_TRUE(owner.raw_tail().contains("\x1B[<u"));

  const std::array signals{SIGINT, SIGTERM, SIGHUP, SIGQUIT};
  for (std::size_t index = 0; index < signals.size(); ++index) {
    const auto session = "signal_" + std::to_string(index);
    ASSERT_EQ(command({"start", session}).status, 0);
    PtyClient client;
    ASSERT_TRUE(client.spawn(client_arguments("attach", session), runtime_.environment()));
    ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
    const auto signal_number = std::span(signals).subspan(index, 1).front();
    ASSERT_TRUE(client.send_signal(signal_number));
    ASSERT_TRUE(client.wait(deadline_after(5s)));
    auto status = client.status();
    ASSERT_TRUE(WIFEXITED(status));
    EXPECT_EQ(WEXITSTATUS(status), 128 + signal_number);
    EXPECT_TRUE(client.terminal_state_restored());
    EXPECT_TRUE(client.raw_tail().contains("\x1B[?1049l"));
    EXPECT_TRUE(client.raw_tail().contains("lemma attach interrupted by signal"));
    EXPECT_TRUE(wait_for_listing(session, "detached", deadline_after(3s)));
  }

  constexpr std::string_view blocked_session = "signal_blocked_output";
  ASSERT_EQ(command({"start", std::string(blocked_session)}).status, 0);
  PtyClient blocked;
  ASSERT_TRUE(blocked.spawn(client_arguments("attach", blocked_session), runtime_.environment()));
  ASSERT_TRUE(blocked.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(blocked.send("yes __LEMMA_BLOCKED_SIGNAL__\r", deadline_after(2s)));
  // Stop consuming the outer PTY until its output queue fills and the attached client blocks in a
  // render write. A handled signal must unwind without the test making that descriptor writable.
  std::this_thread::sleep_for(500ms);
  ASSERT_TRUE(blocked.send_signal(SIGTERM));
  const auto restore_deadline = deadline_after(3s);
  while (!blocked.terminal_state_restored() &&
         std::chrono::steady_clock::now() < restore_deadline) {
    std::this_thread::sleep_for(5ms);
  }
  ASSERT_TRUE(blocked.terminal_state_restored());
  ASSERT_TRUE(blocked.wait(deadline_after(5s)));
  auto blocked_status = blocked.status();
  ASSERT_TRUE(WIFEXITED(blocked_status));
  EXPECT_EQ(WEXITSTATUS(blocked_status), 128 + SIGTERM);
  EXPECT_TRUE(blocked.terminal_state_restored());
  ASSERT_TRUE(blocked.wait_for_raw("lemma attach interrupted by signal", deadline_after(5s)))
      << blocked.raw_tail();
  EXPECT_TRUE(blocked.raw_tail().contains("\x1B[?1049l"));
  const auto stopped = command({"kill", std::string(blocked_session)});
  EXPECT_EQ(stopped.status, 0) << stopped.output;
}

TEST_F(MuxProcessTest, RestoresTerminalWhenDaemonConnectionIsLost) {
  ASSERT_EQ(command({"start", "daemon_loss"}).status, 0);
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("attach", "daemon_loss"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));

  server_.terminate();

  ASSERT_TRUE(client.wait(deadline_after(5s)));
  EXPECT_TRUE(client.terminal_state_restored());
  EXPECT_TRUE(client.raw_tail().contains("\x1B[?1049l"));
  EXPECT_TRUE(client.raw_tail().contains("connection was lost"));
}

TEST_F(MuxProcessTest, LastShellExitReclaimsSessionAndRestoresTerminal) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "exitcase"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(client.send("exit\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait(deadline_after(5s))) << client.raw_tail();
  auto client_status = client.status();
  ASSERT_TRUE(WIFEXITED(client_status));
  EXPECT_EQ(WEXITSTATUS(client_status), 1);
  EXPECT_TRUE(client.terminal_state_restored());
  EXPECT_NE(client.raw_tail().find("\x1B[?1049l"), std::string::npos) << client.raw_tail();
  EXPECT_TRUE(client.raw_tail().contains("lemma session ended")) << client.raw_tail();

  const auto listing = command({"list"});
  ASSERT_EQ(listing.status, 0) << listing.output;
  EXPECT_NE(listing.output.find("no lemma sessions"), std::string::npos) << listing.output;
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
      named_request(protocol::ControlCommand::list_session, "responsive_setup");
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
  constexpr std::string_view marker_command = "printf '__RAW_ATTACHED__\\n'\r";
  const auto marker_input = input_request(marker_command);
  auto attach = attach_request("rawattach", protocol::Dimensions{.columns = 80, .rows = 24});
  attach.insert(attach.end(), marker_input.begin(), marker_input.end());
  ASSERT_TRUE(attached.send(attach, deadline_after(2s)));
  protocol::ServerDecoder attached_decoder;
  ASSERT_TRUE(wait_for_server_hello(attached, attached_decoder, deadline_after(5s)));
  ASSERT_TRUE(
      read_until_contains(attached, attached_decoder, "__RAW_ATTACHED__", deadline_after(5s)))
      << attached.received_tail();
  const auto detach = protocol::encode_detach(3);
  ASSERT_TRUE(attached.send(detach.bytes(), deadline_after(2s)));
  ASSERT_TRUE(attached.wait_for_close(deadline_after(5s)));

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
                                  std::byte{protocol::session_name_bytes_max + 1U}};
  EXPECT_TRUE(expect_close(oversized_name));
  const auto invalid_name = named_request(protocol::ControlCommand::create, "bad.name");
  EXPECT_TRUE(expect_close(invalid_name));

  auto unavailable_context =
      named_request(protocol::ControlCommand::create_with_context, "missingcontext");
  const auto unavailable_size =
      protocol::encode_bounded_size(protocol::unavailable_working_directory_size);
  unavailable_context.insert(unavailable_context.end(), unavailable_size.begin(),
                             unavailable_size.end());
  EXPECT_TRUE(expect_close(unavailable_context));
  EXPECT_NE(command({"list", "missingcontext"}).status, 0);

  auto invalid_environment = named_request(protocol::ControlCommand::create_with_context, "badenv");
  const auto cwd_size = protocol::encode_bounded_size(1);
  invalid_environment.insert(invalid_environment.end(), cwd_size.begin(), cwd_size.end());
  invalid_environment.push_back(std::byte{'/'});
  const std::array malformed_environment{std::byte{'A'}, std::byte{0}};
  const auto environment_size = protocol::encode_bounded_size(malformed_environment.size());
  invalid_environment.insert(invalid_environment.end(), environment_size.begin(),
                             environment_size.end());
  invalid_environment.insert(invalid_environment.end(), malformed_environment.begin(),
                             malformed_environment.end());
  EXPECT_TRUE(expect_close(invalid_environment));

  const auto disconnecting_attach =
      attach_request("healthy", protocol::Dimensions{.columns = 80, .rows = 24});
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
    const auto request = attach_request("healthy", dimensions);
    ASSERT_TRUE(invalid.send(request, deadline_after(2s)));
    ASSERT_TRUE(wait_for_disconnect(invalid, protocol::DisconnectReason::protocol_error,
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
TEST_F(MuxProcessTest, RejectsVersionMismatchAndLiveMalformedPeerWithTypedReasons) {
  ASSERT_EQ(command({"start", "mismatch"}).status, 0);
  RawPeer mismatch;
  ASSERT_TRUE(mismatch.connect(runtime_.socket_path(), deadline_after(2s)));
  const auto incompatible =
      attach_request("mismatch", {.columns = 200, .rows = 80}, {.major = 1, .minor = 0});
  ASSERT_TRUE(mismatch.send(incompatible, deadline_after(2s)));
  ASSERT_TRUE(wait_for_disconnect(mismatch, protocol::DisconnectReason::version_mismatch,
                                  deadline_after(2s)));
  ASSERT_TRUE(mismatch.wait_for_close(deadline_after(2s)));
  const auto unchanged = wait_for_session(
      "mismatch",
      [](const SessionListing& value) {
        return !value.attached && value.columns == 80 && value.rows == 24;
      },
      deadline_after(3s));
  ASSERT_TRUE(unchanged.has_value());

  RawPeer malformed;
  ASSERT_TRUE(malformed.connect(runtime_.socket_path(), deadline_after(2s)));
  const auto valid = attach_request("mismatch", {.columns = 80, .rows = 24});
  ASSERT_TRUE(malformed.send(valid, deadline_after(2s)));
  protocol::ServerDecoder decoder;
  ASSERT_TRUE(wait_for_server_hello(malformed, decoder, deadline_after(5s)));
  ASSERT_TRUE(wait_for_full_generation(malformed, decoder, 1, deadline_after(5s)));
  const auto wrong_sequence = protocol::encode_header(protocol::MessageKind::input, 0, 1, 4);
  std::vector<std::byte> invalid(wrong_sequence.begin(), wrong_sequence.end());
  invalid.push_back(std::byte{'x'});
  ASSERT_TRUE(malformed.send(invalid, deadline_after(2s)));
  ASSERT_TRUE(wait_for_disconnect(malformed, decoder, protocol::DisconnectReason::protocol_error,
                                  deadline_after(2s)));
  ASSERT_TRUE(malformed.wait_for_close(deadline_after(2s)));
  ASSERT_TRUE(wait_for_listing("mismatch", "detached", deadline_after(3s)));

  PtyClient recovered;
  ASSERT_TRUE(recovered.spawn(client_arguments("attach", "mismatch"), runtime_.environment()));
  ASSERT_TRUE(recovered.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(recovered.send("printf '__MALFORMED_RECOVERED__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(recovered.wait_for_screen("__MALFORMED_RECOVERED__", deadline_after(5s)));
  ASSERT_TRUE(send_prefix(recovered, std::byte{'d'}));
  ASSERT_TRUE(recovered.wait(deadline_after(5s)));
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, SlowControlAndInitialAttachReadersRecoverWithoutBlockingPtys) {
  ASSERT_EQ(command({"start", "responsive_slow"}).status, 0);
  ASSERT_EQ(command({"start", "slow_attach"}).status, 0);
  for (std::size_t index = 0; index < 60; ++index) {
    const auto suffix = std::to_string(index);
    auto name = std::string(protocol::session_name_bytes_max - suffix.size(), 'f') + suffix;
    ASSERT_EQ(command({"start", name}).status, 0) << name;
  }

  PtyClient responsive;
  ASSERT_TRUE(
      responsive.spawn(client_arguments("attach", "responsive_slow"), runtime_.environment()));
  ASSERT_TRUE(responsive.wait_for_raw("\x1B[?1049h", deadline_after(5s)));

  RawPeer slow_attach;
  ASSERT_TRUE(slow_attach.connect(runtime_.socket_path(), deadline_after(2s)));
  ASSERT_TRUE(slow_attach.set_receive_buffer(4'096));
  const auto slow_attach_request =
      attach_request("slow_attach", protocol::Dimensions{.columns = 200, .rows = 80});
  ASSERT_TRUE(slow_attach.send(slow_attach_request, deadline_after(2s)));
  protocol::ServerDecoder slow_attach_decoder;
  ASSERT_TRUE(wait_for_server_hello(slow_attach, slow_attach_decoder, deadline_after(5s)))
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
  ASSERT_TRUE(read_until_contains(slow_attach, slow_attach_decoder, "__SLOW_ATTACH_RECOVERED__",
                                  deadline_after(10s)))
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
  const auto launch = "exec " + shell_quote(LEMMA_TEST_PTY_PEER_PATH) + " block " +
                      shell_quote(gate) + " " + std::to_string(payload_size) + "\r";
  ASSERT_TRUE(blocked.send(launch, deadline_after(2s)));
  ASSERT_TRUE(blocked.wait_for_screen("__LEMMA_PTY_READY__", deadline_after(5s)))
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
    }
    responsive.drain(std::min(fill_deadline, deadline_after(1ms)));
  }
  ASSERT_GT(sent, 0U);
  ASSERT_LT(sent, payload.size()) << "the unread PTY never applied client backpressure";
  const auto still_alive = wait_for_session(
      "blocked_pty", [](const SessionListing& value) { return value.attached && value.panes == 1; },
      deadline_after(2s), &responsive);
  ASSERT_TRUE(still_alive.has_value());

  const auto responsiveness_started = std::chrono::steady_clock::now();
  ASSERT_TRUE(responsive.send("printf '__BLOCKED_PTY_ISOLATED__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(responsive.wait_for_screen("__BLOCKED_PTY_ISOLATED__", deadline_after(5s)))
      << responsive.screen() << "\nserver:\n"
      << server_.output();
  EXPECT_LT(std::chrono::steady_clock::now() - responsiveness_started, 2s);

  ASSERT_TRUE(create_gate(gate));
  ASSERT_TRUE(blocked.send(std::span(payload).subspan(sent), deadline_after(15s)));
  ASSERT_TRUE(blocked.wait_for_screen("__LEMMA_PTY_DONE__ bytes=2097152 digest=d939b04ca2c22325",
                                      deadline_after(20s)))
      << blocked.screen() << "\nraw:\n"
      << blocked.raw_tail() << "\nserver:\n"
      << server_.output();
  ASSERT_TRUE(blocked.wait(deadline_after(5s)));
  EXPECT_TRUE(blocked.terminal_state_restored());

  ASSERT_TRUE(send_prefix(responsive, std::byte{'d'}));
  ASSERT_TRUE(responsive.wait(deadline_after(5s)));
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, SurvivesRapidResizeOutputFloodAndFocusedChildExit) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "resize_flood_exit"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  const auto flood = shell_quote(LEMMA_TEST_PTY_PEER_PATH) + " resize-flood\r";
  ASSERT_TRUE(client.send(flood, deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__LEMMA_RESIZE_FLOOD__", deadline_after(5s)));

  constexpr std::size_t resize_count = 500;
  for (std::size_t index = 0; index < resize_count; ++index) {
    const auto columns = static_cast<std::uint16_t>(20U + ((index * 37U) % 141U));
    const auto rows = static_cast<std::uint16_t>(5U + ((index * 17U) % 56U));
    ASSERT_TRUE(client.resize(columns, rows)) << "resize " << index;
    client.drain(deadline_after(1ms));
  }
  ASSERT_TRUE(client.resize(111, 37));
  ASSERT_TRUE(client.send("q", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__LEMMA_RESIZE_FINAL__ 36 111", deadline_after(10s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail() << "\nserver:\n"
      << server_.output();

  ASSERT_TRUE(send_prefix(client, std::byte{'%'}));
  ASSERT_TRUE(wait_for_listing("resize_flood_exit", "2 pane(s)", deadline_after(5s), &client));
  ASSERT_TRUE(
      client.send("printf '__LEMMA_CHILD_EXIT__\\n'; read ignored; exit\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__LEMMA_CHILD_EXIT__", deadline_after(5s)));
  ASSERT_TRUE(client.send("\r", deadline_after(2s)));
  const auto reclaimed = wait_for_session(
      "resize_flood_exit", [](const SessionListing& value) { return value.panes == 1; },
      deadline_after(5s), &client);
  ASSERT_TRUE(reclaimed.has_value()) << command({"list", "resize_flood_exit"}).output;
  ASSERT_TRUE(client.send("printf '__LEMMA_SURVIVED_STRESS__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__LEMMA_SURVIVED_STRESS__", deadline_after(5s)));
  ASSERT_TRUE(send_prefix(client, std::byte{'d'}));
  ASSERT_TRUE(client.wait(deadline_after(5s)));
  EXPECT_TRUE(client.terminal_state_restored());
}

// Queue contention is covered deterministically by PtyWriterTest; this process case verifies the
// terminal-adapter response round trip through the daemon and a real PTY.
TEST_F(MuxProcessTest, RoutesTerminalResponsesAndClientInputToPtyPeers) {
  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("new", "response_order"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));

  const auto gate = runtime_.owned_path("response-order.gate");
  constexpr std::string_view user_input = "USER_AFTER_RESPONSE";
  const auto launch = "exec " + shell_quote(LEMMA_TEST_PTY_PEER_PATH) + " order " +
                      shell_quote(gate) + " " + shell_quote(user_input) + "\r";
  ASSERT_TRUE(client.send(launch, deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__LEMMA_ORDER_READY__", deadline_after(5s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail();
  ASSERT_TRUE(client.send(user_input, deadline_after(2s)));
  ASSERT_TRUE(create_gate(gate));
  ASSERT_TRUE(client.wait_for_screen("__LEMMA_ORDER_OK__", deadline_after(10s)))
      << client.screen() << "\nraw:\n"
      << client.raw_tail() << "\nserver:\n"
      << server_.output();
  ASSERT_TRUE(client.wait(deadline_after(5s)));
}

// GoogleTest assertion macros inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST_F(MuxProcessTest, IdleAndNonreadingPeersCannotBlockAnotherSession) {
  ASSERT_EQ(command({"start", "blocked"}).status, 0);
  ASSERT_EQ(command({"start", "responsive"}).status, 0);

  RawPeer idle;
  ASSERT_TRUE(idle.connect(runtime_.socket_path(), deadline_after(2s)));

  RawPeer nonreader;
  ASSERT_TRUE(nonreader.connect(runtime_.socket_path(), deadline_after(2s)));
  const auto blocked_attach =
      attach_request("blocked", protocol::Dimensions{.columns = 500, .rows = 200});
  ASSERT_TRUE(nonreader.send(blocked_attach, deadline_after(2s)));
  protocol::ServerDecoder nonreader_decoder;
  ASSERT_TRUE(wait_for_server_hello(nonreader, nonreader_decoder, deadline_after(5s)));

  PtyClient client;
  ASSERT_TRUE(client.spawn(client_arguments("attach", "responsive"), runtime_.environment()));
  ASSERT_TRUE(client.wait_for_raw("\x1B[?1049h", deadline_after(5s)));
  ASSERT_TRUE(client.send("printf '__STILL_RESPONSIVE__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__STILL_RESPONSIVE__", deadline_after(5s)))
      << client.screen() << "\nserver:\n"
      << server_.output();

  RawPeer fragmented;
  ASSERT_TRUE(fragmented.connect(runtime_.socket_path(), deadline_after(2s)));
  const std::array list_session{protocol::wire_byte(protocol::ControlCommand::list_session)};
  ASSERT_TRUE(fragmented.send(list_session, deadline_after(2s)));
  ASSERT_TRUE(client.send("printf '__FRAGMENTED_SETUP__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__FRAGMENTED_SETUP__", deadline_after(5s)));
  const std::array name_size{static_cast<std::byte>(std::string_view("responsive").size())};
  ASSERT_TRUE(fragmented.send(name_size, deadline_after(2s)));
  for (const char character : std::string_view("responsive")) {
    const std::array byte{static_cast<std::byte>(character)};
    ASSERT_TRUE(fragmented.send(byte, deadline_after(2s)));
  }
  fragmented.close();
  // Observe a later daemon round trip so the closed fragmented setup cannot still own a slot.
  ASSERT_TRUE(client.send("printf '__FRAGMENTED_RELEASED__\\n'\r", deadline_after(2s)));
  ASSERT_TRUE(client.wait_for_screen("__FRAGMENTED_RELEASED__", deadline_after(5s)));

  // The idle peer above owns one setup slot; fill exactly the remainder without consuming the
  // separate bounded pool reserved for typed capacity responses.
  static_assert(limits::pending_connections_hard_max > 1U);
  constexpr auto capacity_peer_count = limits::pending_connections_hard_max - 1U;
  std::array<RawPeer, capacity_peer_count> capacity_peers;
  for (auto& peer : capacity_peers) {
    ASSERT_TRUE(peer.connect(runtime_.socket_path(), deadline_after(2s)));
  }

  RawPeer rejected_control;
  ASSERT_TRUE(rejected_control.connect(runtime_.socket_path(), deadline_after(2s)));
  const std::array list_command{protocol::wire_byte(protocol::ControlCommand::list)};
  ASSERT_TRUE(rejected_control.send(list_command, deadline_after(2s)));
  ASSERT_TRUE(rejected_control.wait_for_byte(
      protocol::wire_byte(protocol::ControlResponse::capacity), deadline_after(2s)));

  RawPeer rejected_attach;
  ASSERT_TRUE(rejected_attach.connect(runtime_.socket_path(), deadline_after(2s)));
  const auto rejected_hello =
      attach_request("blocked", protocol::Dimensions{.columns = 80, .rows = 24});
  ASSERT_TRUE(rejected_attach.send(rejected_hello, deadline_after(2s)));
  ASSERT_TRUE(wait_for_disconnect(rejected_attach, protocol::DisconnectReason::capacity,
                                  deadline_after(2s)));
  ASSERT_TRUE(rejected_attach.wait_for_close(deadline_after(2s)));

  const auto rejected_shutdown = command({"shutdown", "--confirm"});
  EXPECT_NE(rejected_shutdown.status, 0) << rejected_shutdown.output;
  EXPECT_TRUE(rejected_shutdown.output.contains("capacity")) << rejected_shutdown.output;
  EXPECT_FALSE(server_.wait(deadline_after(100ms))) << server_.output();
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
} // namespace lemma::test
