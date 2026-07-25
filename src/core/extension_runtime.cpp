#include "core/extension_runtime.hpp"

#include "platform/io.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstddef>
#include <span>

#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

namespace fiber::core {
namespace {

constexpr std::uint8_t reconnect_failures_max = 5;
constexpr std::size_t messages_per_turn_max = 64;
constexpr std::size_t reads_per_turn_max = 8;

using platform::close_descriptor;

[[nodiscard]] auto empty_payload(const protocol::extension::Message& message) noexcept -> bool {
  return message.payload.empty() && message.request_id == 0;
}

[[nodiscard]] auto reconnect_delay(const std::uint8_t failures) noexcept -> std::chrono::seconds {
  const auto exponent = std::min(failures, reconnect_failures_max);
  return std::chrono::seconds(std::uint32_t{1} << exponent);
}

[[nodiscard]] auto append_command(ExtensionGeneration& generation,
                                  const protocol::extension::CommandRegistration& value) noexcept
    -> bool {
  if (generation.command_count == generation.commands.size()) {
    return false;
  }
  auto& command = std::span(generation.commands).subspan(generation.command_count, 1).front();
  if (!command.name.assign(value.name) || !command.description.assign(value.description, true)) {
    return false;
  }
  ++generation.command_count;
  return true;
}

[[nodiscard]] auto append_keymap(ExtensionGeneration& generation,
                                 const protocol::extension::KeymapRegistration& value) noexcept
    -> bool {
  if (generation.keymap_count == generation.keymaps.size()) {
    return false;
  }
  auto& keymap = std::span(generation.keymaps).subspan(generation.keymap_count, 1).front();
  if (!keymap.mode.assign(value.mode) || !keymap.key.assign(value.key) ||
      !keymap.command.assign(value.command)) {
    return false;
  }
  ++generation.keymap_count;
  return true;
}

[[nodiscard]] auto append_subscription(ExtensionGeneration& generation,
                                       const protocol::extension::EventSubscription& value) noexcept
    -> bool {
  if (generation.subscription_count == generation.subscriptions.size()) {
    return false;
  }
  auto& subscription =
      std::span(generation.subscriptions).subspan(generation.subscription_count, 1).front();
  if (!subscription.event.assign(value.event)) {
    return false;
  }
  ++generation.subscription_count;
  return true;
}

[[nodiscard]] auto append_sidebar(ExtensionGeneration& generation,
                                  const protocol::extension::SidebarRegistration& value) noexcept
    -> bool {
  if (generation.sidebar_count == generation.sidebars.size()) {
    return false;
  }
  auto& sidebar = std::span(generation.sidebars).subspan(generation.sidebar_count, 1).front();
  if (!sidebar.id.assign(value.id) || value.line_count > sidebar.lines.size()) {
    return false;
  }
  sidebar.side = value.side;
  sidebar.width = value.width;
  sidebar.line_count = value.line_count;
  for (std::size_t index = 0; index < value.line_count; ++index) {
    auto& target = std::span(sidebar.lines).subspan(index, 1).front();
    const auto source = std::span(value.lines).subspan(index, 1).front();
    if (!target.assign(source, true)) {
      return false;
    }
  }
  ++generation.sidebar_count;
  return true;
}

} // namespace

ExtensionRuntime::ExtensionRuntime(const ExtensionAcquire acquire, void* const context,
                                   const ExtensionErrorReporter report_error,
                                   void* const error_context) noexcept
    : acquire_(acquire), context_(context), report_error_(report_error),
      error_context_(error_context) {}

ExtensionRuntime::~ExtensionRuntime() { close_descriptor(connection_.descriptor); }

void ExtensionRuntime::connect_if_due(const std::chrono::steady_clock::time_point now) noexcept {
  if (connection_.descriptor >= 0 || acquire_ == nullptr || now < reconnect_at_) {
    return;
  }
  connection_ = acquire_(context_);
  if (connection_.descriptor >= 0 && !platform::set_nonblocking(connection_.descriptor)) {
    close_descriptor(connection_.descriptor);
    connection_ = {};
  }
  if (connection_.descriptor < 0) {
    reconnect_at_ = now + reconnect_delay(reconnect_failures_);
    reconnect_failures_ = static_cast<std::uint8_t>(std::min<std::uint16_t>(
        static_cast<std::uint16_t>(reconnect_failures_) + 1U, reconnect_failures_max));
  }
}

auto ExtensionRuntime::poll_timeout(const std::chrono::steady_clock::time_point now) const noexcept
    -> int {
  if (connection_.descriptor >= 0) {
    return continuation_pending_ ? 0 : -1;
  }
  if (acquire_ == nullptr) {
    return -1;
  }
  if (now >= reconnect_at_) {
    return 0;
  }
  const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(reconnect_at_ - now);
  return static_cast<int>(std::max(remaining.count(), std::int64_t{1}));
}

// This bounded reader handles every nonblocking socket result explicitly.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void ExtensionRuntime::process(const short events) noexcept {
  if (connection_.descriptor < 0) {
    return;
  }
  const bool descriptor_ready = (events & (POLLIN | POLLHUP | POLLERR)) != 0;
  if (!descriptor_ready && !continuation_pending_) {
    return;
  }

  std::size_t message_budget = messages_per_turn_max;
  if (continuation_pending_) {
    continuation_pending_ = false;
    if (!drain_messages(message_budget)) {
      disconnect();
      return;
    }
    if (message_budget == 0) {
      continuation_pending_ = true;
      return;
    }
  }
  if (!descriptor_ready) {
    return;
  }

  std::size_t read_count = 0;
  bool reading = true;
  bool peer_closed = false;
  while (read_count < reads_per_turn_max && message_budget > 0 && reading) {
    const auto status = read_once(message_budget);
    if (status == ReadStatus::failed) {
      disconnect();
      return;
    }
    peer_closed = status == ReadStatus::closed;
    reading = status == ReadStatus::progress || status == ReadStatus::retry;
    if (status != ReadStatus::retry) {
      ++read_count;
    }
  }

  continuation_pending_ = message_budget == 0;
  if (peer_closed || ((events & (POLLHUP | POLLERR)) != 0 && !continuation_pending_)) {
    disconnect();
  }
}

auto ExtensionRuntime::read_once(std::size_t& message_budget) noexcept -> ReadStatus {
  auto writable = decoder_.writable_bytes();
  if (writable.empty()) {
    return ReadStatus::failed;
  }
  const auto received = ::recv(connection_.descriptor, writable.data(), writable.size(), 0);
  if (received > 0) {
    return decoder_.commit(static_cast<std::size_t>(received)).has_value() &&
                   drain_messages(message_budget)
               ? ReadStatus::progress
               : ReadStatus::failed;
  }
  if (received == 0) {
    return ReadStatus::closed;
  }
  if (errno == EINTR) {
    return ReadStatus::retry;
  }
  if (errno == EAGAIN || errno == EWOULDBLOCK) {
    return ReadStatus::blocked;
  }
  return ReadStatus::failed;
}

auto ExtensionRuntime::drain_messages(std::size_t& message_budget) noexcept -> bool {
  while (message_budget > 0) {
    const auto next = decoder_.next();
    if (!next.has_value()) {
      return false;
    }
    if (!next->has_value()) {
      return true;
    }
    if (!apply(**next)) {
      return false;
    }
    decoder_.consume();
    --message_budget;
  }
  return true;
}

// Registration kinds are an exhaustive protocol state machine.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
auto ExtensionRuntime::apply(const protocol::extension::Message& message) noexcept -> bool {
  using protocol::extension::MessageKind;
  if (message.request_id != 0) {
    return false;
  }
  switch (message.kind) {
  case MessageKind::begin_generation:
    if (!empty_payload(message)) {
      return false;
    }
    candidate_ = {};
    building_generation_ = true;
    return true;
  case MessageKind::register_command: {
    if (!building_generation_) {
      return false;
    }
    const auto registration = protocol::extension::decode_command(message);
    return registration.has_value() && append_command(candidate_, *registration);
  }
  case MessageKind::register_keymap: {
    if (!building_generation_) {
      return false;
    }
    const auto registration = protocol::extension::decode_keymap(message);
    return registration.has_value() && append_keymap(candidate_, *registration);
  }
  case MessageKind::subscribe_event: {
    if (!building_generation_) {
      return false;
    }
    const auto subscription = protocol::extension::decode_subscription(message);
    return subscription.has_value() && append_subscription(candidate_, *subscription);
  }
  case MessageKind::set_sidebar: {
    if (!building_generation_) {
      return false;
    }
    const auto sidebar = protocol::extension::decode_sidebar(message);
    return sidebar.has_value() && append_sidebar(candidate_, *sidebar);
  }
  case MessageKind::commit_generation:
    if (!building_generation_ || !empty_payload(message)) {
      return false;
    }
    active_ = candidate_;
    candidate_ = {};
    building_generation_ = false;
    last_error_ = {};
    reconnect_failures_ = 0;
    ++generation_;
    return true;
  case MessageKind::config_error: {
    const auto error = protocol::extension::decode_config_error(message);
    if (!error.has_value()) {
      return false;
    }
    candidate_ = {};
    building_generation_ = false;
    if (!last_error_.assign(*error)) {
      return false;
    }
    if (report_error_ != nullptr) {
      report_error_(error_context_, last_error_.view());
    }
    return true;
  }
  }
  return false;
}

void ExtensionRuntime::disconnect() noexcept {
  // Closing the socket is the host's shutdown signal. Never signal its numeric PID here: SIGCHLD
  // is ignored by the daemon, so a crashed host may already have been reaped and its PID reused.
  close_descriptor(connection_.descriptor);
  connection_ = {};
  decoder_.reset();
  active_ = {};
  candidate_ = {};
  building_generation_ = false;
  continuation_pending_ = false;
  reconnect_at_ = std::chrono::steady_clock::now() + reconnect_delay(reconnect_failures_);
  reconnect_failures_ = static_cast<std::uint8_t>(std::min<std::uint16_t>(
      static_cast<std::uint16_t>(reconnect_failures_) + 1U, reconnect_failures_max));
}

} // namespace fiber::core
