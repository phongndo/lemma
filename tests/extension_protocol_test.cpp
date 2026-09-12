#include "api/command.hpp"
#include "api/json.hpp"
#include "extension/protocol.hpp"
#include "extension/runtime.hpp"
#include "lemma/geometry.hpp"
#include "lemma/id.hpp"
#include "lemma/limits.hpp"
#include "render/scene.hpp"

#include <gtest/gtest.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <sys/socket.h>
#include <unistd.h>

namespace lemma::extension {
namespace {

class SocketPair final {
public:
  SocketPair() { EXPECT_EQ(::socketpair(AF_UNIX, SOCK_STREAM, 0, descriptors_.data()), 0); }
  SocketPair(const SocketPair&) = delete;
  auto operator=(const SocketPair&) -> SocketPair& = delete;
  SocketPair(SocketPair&&) = delete;
  auto operator=(SocketPair&&) -> SocketPair& = delete;
  ~SocketPair() {
    for (const auto descriptor : descriptors_) {
      if (descriptor >= 0) {
        static_cast<void>(::close(descriptor));
      }
    }
  }

  [[nodiscard]] auto take_reader() noexcept -> int {
    auto descriptors = std::span(descriptors_);
    const auto descriptor = descriptors.front();
    descriptors.front() = -1;
    return descriptor;
  }
  [[nodiscard]] auto writer() const noexcept -> int { return descriptors_.back(); }

private:
  std::array<int, 2> descriptors_{-1, -1};
};

[[nodiscard]] auto decode_hello_text(const std::string_view json) -> std::optional<Hello> {
  const auto parsed = api::parse_json(json);
  return parsed.value.has_value() ? decode_hello(*parsed.value) : std::nullopt;
}

void set_header_byte(std::array<std::byte, protocol_header_bytes>& header, const std::size_t index,
                     const std::byte value) {
  std::span(header).subspan(index, 1).front() = value;
}

[[nodiscard]] auto record(const RecordKind kind, const std::uint32_t sequence,
                          const std::string_view payload) -> std::vector<std::byte> {
  const auto header = encode_header(kind, payload.size(), sequence);
  std::vector<std::byte> bytes(header.begin(), header.end());
  const auto payload_bytes = std::as_bytes(std::span(payload.data(), payload.size()));
  bytes.insert(bytes.end(), payload_bytes.begin(), payload_bytes.end());
  return bytes;
}

// GoogleTest assertion macros expand into deliberately branch-heavy control flow.
// NOLINTBEGIN(readability-function-cognitive-complexity)
TEST(ExtensionProtocolTest, RetainsMultipleBufferedRecordsAcrossConsumption) {
  SocketPair sockets;
  FramedPeer peer(sockets.take_reader());
  auto bytes = record(RecordKind::proc, 4, R"({"one":1})");
  const auto second = record(RecordKind::surface_update, 5, R"({"two":2})");
  bytes.insert(bytes.end(), second.begin(), second.end());
  ASSERT_EQ(::send(sockets.writer(), bytes.data(), bytes.size(), 0),
            static_cast<ssize_t>(bytes.size()));

  EXPECT_EQ(peer.read_ready(), bytes.size());
  const auto first = peer.receive();
  EXPECT_TRUE(first.has_value());
  if (first.has_value()) {
    EXPECT_EQ(first->kind, RecordKind::proc);
    EXPECT_EQ(first->sequence, 4U);
  }
  peer.consume();
  EXPECT_TRUE(peer.buffered_record());
  const auto next = peer.receive();
  EXPECT_TRUE(next.has_value());
  if (next.has_value()) {
    EXPECT_EQ(next->kind, RecordKind::surface_update);
    EXPECT_EQ(next->sequence, 5U);
  }
}

TEST(ExtensionProtocolTest, ReadinessDoesNotClaimBufferedRecordAfterServiceBudget) {
  SocketPair sockets;
  FramedPeer peer(sockets.take_reader());
  std::vector<std::byte> bytes;
  for (std::uint32_t sequence = 1; sequence <= 5; ++sequence) {
    const auto next = record(RecordKind::surface_update, sequence, "{}");
    bytes.insert(bytes.end(), next.begin(), next.end());
  }
  ASSERT_EQ(::send(sockets.writer(), bytes.data(), bytes.size(), 0),
            static_cast<ssize_t>(bytes.size()));
  ASSERT_EQ(peer.read_ready(), bytes.size());
  for (std::uint32_t sequence = 1; sequence <= 4; ++sequence) {
    const auto next = peer.receive();
    ASSERT_TRUE(next.has_value());
    EXPECT_EQ(next.value_or(Record{}).sequence, sequence);
    peer.consume();
  }
  const auto sixth = record(RecordKind::surface_update, 6, "{}");
  ASSERT_EQ(::send(sockets.writer(), sixth.data(), sixth.size(), 0),
            static_cast<ssize_t>(sixth.size()));
  EXPECT_EQ(peer.read_ready(), 0U);
  ASSERT_TRUE(peer.buffered_record());
  const auto fifth = peer.receive();
  ASSERT_TRUE(fifth.has_value());
  EXPECT_EQ(fifth.value_or(Record{}).sequence, 5U);
  peer.consume();
  EXPECT_FALSE(peer.buffered_record());
  EXPECT_EQ(peer.read_ready(), sixth.size());
  const auto last = peer.receive();
  ASSERT_TRUE(last.has_value());
  EXPECT_EQ(last.value_or(Record{}).sequence, 6U);
  peer.consume();
  EXPECT_FALSE(peer.buffered_record());
  EXPECT_FALSE(peer.receive().has_value());
  EXPECT_EQ(peer.read_ready(), 0U);
}

TEST(ExtensionProtocolTest, FragmentedHeaderDoesNotScheduleBufferedWork) {
  SocketPair sockets;
  FramedPeer peer(sockets.take_reader());
  const auto bytes = record(RecordKind::surface_update, 1, "{}");
  for (std::size_t index = 0; index < bytes.size(); ++index) {
    ASSERT_EQ(::send(sockets.writer(), std::span(bytes).subspan(index).data(), 1, 0), 1);
    ASSERT_EQ(peer.read_ready(), 1U);
    if (index + 1U < bytes.size()) {
      EXPECT_FALSE(peer.buffered_record());
      EXPECT_FALSE(peer.receive().has_value());
    }
  }
  EXPECT_TRUE(peer.buffered_record());
  ASSERT_TRUE(peer.receive().has_value());
  peer.consume();
  EXPECT_FALSE(peer.buffered_record());
}

// NOLINTEND(readability-function-cognitive-complexity)

TEST(ExtensionProtocolTest, RejectsInvalidBufferedHeaderWithoutWaitingForPayload) {
  SocketPair sockets;
  FramedPeer peer(sockets.take_reader());
  auto header = encode_header(RecordKind::proc, 100, 2);
  header.front() = std::byte{0};
  ASSERT_EQ(::send(sockets.writer(), header.data(), header.size(), 0),
            static_cast<ssize_t>(header.size()));

  EXPECT_EQ(peer.read_ready(), header.size());
  EXPECT_TRUE(peer.buffered_record());
  EXPECT_FALSE(peer.receive().has_value());
  EXPECT_FALSE(peer.connected());
}

TEST(ExtensionRuntimeTest, RollsBackStructuralSurfaceTransactions) {
  SocketPair sockets;
  Runtime runtime;
  const auto owner =
      runtime.admit(FramedPeer(sockets.take_reader()),
                    Hello{.name = "test", .subscription = {}, .capabilities = capability_surface},
                    SessionId::from_parts(0, 1), AttachmentId::from_parts(0, 1),
                    R"({"schema":"lemma.event/v1"})");
  ASSERT_TRUE(owner.has_value());
  const auto owner_id = owner.value_or(ExtensionGenerationId{});
  constexpr render::Viewport viewport{.columns = 10, .rows = 4};
  const api::SurfacePlacement placement{.kind = api::SurfacePlacementKind::dock_right,
                                        .columns = 2};

  ASSERT_TRUE(runtime.begin_surface_transaction(owner_id));
  const auto abandoned = runtime.create_surface(owner_id, placement, true, true, viewport);
  ASSERT_EQ(abandoned.status, SurfaceOperationStatus::applied);
  ASSERT_TRUE(runtime.rollback_surface_transaction(owner_id));
  EXPECT_FALSE(runtime.surface_owner(abandoned.surface).is_valid());
  constexpr PaneRectangle full_viewport{.columns = 10, .rows = 4};
  EXPECT_EQ(runtime.pane_viewport(AttachmentId::from_parts(0, 1), viewport), full_viewport);

  ASSERT_TRUE(runtime.begin_surface_transaction(owner_id));
  const auto created = runtime.create_surface(owner_id, placement, true, true, viewport);
  ASSERT_EQ(created.status, SurfaceOperationStatus::applied);
  runtime.commit_surface_transaction(owner_id);
  ASSERT_TRUE(runtime.begin_surface_transaction(owner_id));
  ASSERT_EQ(runtime.close_surface(owner_id, created.surface, viewport).status,
            SurfaceOperationStatus::applied);
  ASSERT_TRUE(runtime.rollback_surface_transaction(owner_id));
  EXPECT_EQ(runtime.surface_owner(created.surface), owner_id);
  constexpr PaneRectangle docked_viewport{.columns = 8, .rows = 4};
  EXPECT_EQ(runtime.pane_viewport(AttachmentId::from_parts(0, 1), viewport), docked_viewport);
}

// GoogleTest assertion macros expand into deliberately branch-heavy control flow.
// NOLINTBEGIN(readability-function-cognitive-complexity)
TEST(ExtensionProtocolTest, RejectsEveryInvalidHeaderFieldImmediately) {
  const auto valid = encode_header(RecordKind::proc, 0, 7);
  std::array invalid_headers{valid, valid, valid, valid, valid, valid};
  set_header_byte(invalid_headers.at(0), 4, std::byte{protocol_major + 1U});
  set_header_byte(invalid_headers.at(1), 5, std::byte{protocol_minor + 1U});
  set_header_byte(invalid_headers.at(2), 6, std::byte{0});
  set_header_byte(invalid_headers.at(3), 7, std::byte{1});
  for (std::size_t index = 8; index < 12; ++index) {
    set_header_byte(invalid_headers.at(4), index, std::byte{0xff});
  }
  for (std::size_t index = 12; index < 16; ++index) {
    set_header_byte(invalid_headers.at(5), index, std::byte{0});
  }

  for (const auto& header : invalid_headers) {
    SocketPair sockets;
    FramedPeer peer(sockets.take_reader());
    ASSERT_EQ(::send(sockets.writer(), header.data(), header.size(), 0),
              static_cast<ssize_t>(header.size()));
    EXPECT_EQ(peer.read_ready(), header.size());
    EXPECT_TRUE(peer.buffered_record());
    EXPECT_FALSE(peer.receive().has_value());
    EXPECT_FALSE(peer.connected());
  }
}

TEST(ExtensionProtocolTest, BoundsQueuedOutputWithoutDisconnectingThePeer) {
  SocketPair sockets;
  FramedPeer peer(sockets.take_reader());
  const std::string payload(limits::extension_record_bytes_max, 'x');
  EXPECT_TRUE(peer.send_json(RecordKind::error, 1, payload));
  EXPECT_FALSE(peer.send_json(RecordKind::error, 2, payload));
  EXPECT_LE(peer.output_bytes(), limits::extension_output_bytes_per_owner_max);
  EXPECT_TRUE(peer.connected());
}

TEST(ExtensionRuntimeTest, ValidatesHelloCapabilitiesAndObservationScope) {
  const auto valid = decode_hello_text(
      R"({"schema":"lemma.extension/v1","name":"worker","capabilities":["proc"]})");
  ASSERT_TRUE(valid.has_value());
  const auto hello = valid.value_or(Hello{});
  EXPECT_EQ(hello.name, "worker");
  EXPECT_EQ(hello.capabilities, capability_proc);
  EXPECT_FALSE(
      decode_hello_text(
          R"({"schema":"lemma.extension/v1","name":"worker","capabilities":["proc","proc"]})")
          .has_value());
  EXPECT_FALSE(decode_hello_text(
                   R"({"schema":"lemma.extension/v1","name":"worker","capabilities":["unknown"]})")
                   .has_value());
  EXPECT_FALSE(decode_hello_text(
                   R"({"schema":"lemma.extension/v1","name":"worker","capabilities":["observe"]})")
                   .has_value());
  EXPECT_FALSE(decode_hello_text(
                   R"({"schema":"lemma.extension/v1","name":"worker","capabilities":["surface"]})")
                   .has_value());
}

TEST(ExtensionRuntimeTest, BoundsProcAndInteractionQueues) {
  SocketPair sockets;
  Runtime runtime;
  const auto admitted =
      runtime.admit(FramedPeer(sockets.take_reader()),
                    Hello{.name = "bounded", .subscription = {}, .capabilities = capability_proc},
                    SessionId::from_parts(0, 1), AttachmentId::from_parts(0, 1), {});
  ASSERT_TRUE(admitted.has_value());
  const auto owner = admitted.value_or(ExtensionGenerationId{});

  EXPECT_TRUE(runtime.reserve_proc(owner, 10));
  EXPECT_FALSE(runtime.reserve_proc(owner, 10));
  EXPECT_FALSE(runtime.reserve_proc(owner, 11));
  runtime.complete_proc(owner, 10, R"({"status":"ok"})");
  EXPECT_TRUE(runtime.reserve_proc(owner, 11));
  runtime.complete_proc(owner, 11, R"({"status":"ok"})");

  for (std::size_t index = 0; index < limits::extension_interaction_events_max; ++index) {
    ASSERT_TRUE(runtime.send_event(owner, R"({"event":"surface.key"})"));
  }
  EXPECT_FALSE(runtime.send_event(owner, R"({"event":"surface.key"})"));
  EXPECT_FALSE(runtime.connected(owner));
}

TEST(ExtensionRuntimeTest, EnforcesSurfaceOwnershipCapacityAndGenerationCleanup) {
  SocketPair first_sockets;
  SocketPair second_sockets;
  Runtime runtime;
  constexpr auto session = SessionId::from_parts(0, 1);
  constexpr auto attachment = AttachmentId::from_parts(0, 1);
  const auto first =
      runtime.admit(FramedPeer(first_sockets.take_reader()),
                    Hello{.name = "first", .subscription = {}, .capabilities = capability_surface},
                    session, attachment, {});
  const auto second =
      runtime.admit(FramedPeer(second_sockets.take_reader()),
                    Hello{.name = "second", .subscription = {}, .capabilities = capability_surface},
                    session, attachment, {});
  ASSERT_TRUE(first.has_value());
  ASSERT_TRUE(second.has_value());
  const auto first_owner = first.value_or(ExtensionGenerationId{});
  const auto second_owner = second.value_or(ExtensionGenerationId{});
  constexpr render::Viewport viewport{.columns = 20, .rows = 10};
  constexpr api::SurfacePlacement overlay{
      .kind = api::SurfacePlacementKind::overlay, .columns = 2, .rows = 1};

  SurfaceId focused;
  for (std::size_t index = 0; index < limits::extension_surfaces_per_owner_max; ++index) {
    const auto created = runtime.create_surface(first_owner, overlay, true, true, viewport);
    ASSERT_EQ(created.status, SurfaceOperationStatus::applied);
    if (index == 0) {
      focused = created.surface;
    }
  }
  EXPECT_EQ(runtime.create_surface(first_owner, overlay, true, true, viewport).status,
            SurfaceOperationStatus::capacity);
  EXPECT_EQ(runtime.configure_surface(second_owner, focused, overlay, viewport).status,
            SurfaceOperationStatus::wrong_owner);
  constexpr api::SurfacePlacement dock{.kind = api::SurfacePlacementKind::dock_left, .columns = 1};
  EXPECT_EQ(runtime.create_surface(second_owner, dock, true, false, viewport).status,
            SurfaceOperationStatus::invalid);

  ASSERT_EQ(runtime.focus_surface(first_owner, focused, viewport).status,
            SurfaceOperationStatus::applied);
  runtime.capture_surface_pointer(attachment, focused);
  EXPECT_EQ(runtime.disconnect(first_owner), attachment);
  EXPECT_FALSE(runtime.surface_owner(focused).is_valid());
  EXPECT_FALSE(runtime.focused_surface(attachment).is_valid());
  EXPECT_FALSE(runtime.captured_surface_pointer(attachment).is_valid());
  constexpr PaneRectangle full_viewport{.columns = viewport.columns, .rows = viewport.rows};
  EXPECT_EQ(runtime.pane_viewport(attachment, viewport), full_viewport);

  SocketPair replacement_sockets;
  const auto replacement = runtime.admit(
      FramedPeer(replacement_sockets.take_reader()),
      Hello{.name = "replacement", .subscription = {}, .capabilities = capability_surface}, session,
      attachment, {});
  ASSERT_TRUE(replacement.has_value());
  const auto replacement_owner = replacement.value_or(ExtensionGenerationId{});
  EXPECT_EQ(replacement_owner.slot(), first_owner.slot());
  EXPECT_NE(replacement_owner.generation(), first_owner.generation());
  EXPECT_FALSE(runtime.connected(first_owner));
  EXPECT_EQ(runtime.configure_surface(replacement_owner, focused, overlay, viewport).status,
            SurfaceOperationStatus::stale);
}
// NOLINTEND(readability-function-cognitive-complexity)

} // namespace
} // namespace lemma::extension
