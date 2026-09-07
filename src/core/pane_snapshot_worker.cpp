#include "core/pane_snapshot_worker.hpp"

#include "core/pane_snapshot_work.hpp"
#include "lemma/assert.hpp"
#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <limits>
#include <memory>
#include <new>
#include <optional>
#include <span>
#include <string_view>
#include <utility>

#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
// POSIX signal-set operations are not the C++ standard-library signal facility.
// NOLINTNEXTLINE(modernize-deprecated-headers)
#include <signal.h>
#include <unistd.h>

namespace lemma::core {
namespace {

[[nodiscard]] auto notification_pipe(std::array<int, 2>& descriptors) noexcept -> bool {
  if (::pipe(descriptors.data()) != 0) {
    return false;
  }
  return std::ranges::all_of(descriptors, [](const int descriptor) {
    // POSIX exposes descriptor flags through the variadic fcntl ABI.
    // NOLINTBEGIN(cppcoreguidelines-pro-type-vararg)
    return ::fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0 &&
           ::fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0;
    // NOLINTEND(cppcoreguidelines-pro-type-vararg)
  });
}

void notify(const int descriptor) noexcept {
  const char byte = 0;
  auto result = ::write(descriptor, &byte, 1);
  while (result < 0 && errno == EINTR) {
    result = ::write(descriptor, &byte, 1);
  }
  // EAGAIN means the other side already has a level-triggered notification. Neither endpoint is
  // closed until after join; there is no SIGPIPE or descriptor-reuse race.
  LEMMA_ASSERT(result == 1 || (result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)));
}

void drain(const int descriptor) noexcept {
  std::array<char, 64> bytes{};
  auto result = ::read(descriptor, bytes.data(), bytes.size());
  while (result < 0 && errno == EINTR) {
    result = ::read(descriptor, bytes.data(), bytes.size());
  }
}

} // namespace

PaneSnapshotWorker::PaneSnapshotWorker(const TestHook hook) noexcept : hook_(hook) {}

auto PaneSnapshotWorker::create(const TestHook hook) noexcept
    -> std::expected<std::unique_ptr<PaneSnapshotWorker>, vt::Error> {
  std::unique_ptr<PaneSnapshotWorker> worker(new (std::nothrow) PaneSnapshotWorker(hook));
  if (worker == nullptr) {
    return std::unexpected(vt::Error::out_of_memory);
  }
  if (!notification_pipe(worker->requests_) || !notification_pipe(worker->completions_)) {
    return std::unexpected(vt::Error::io_error);
  }
  pthread_attr_t attributes{};
  if (::pthread_attr_init(&attributes) != 0) {
    return std::unexpected(vt::Error::io_error);
  }
  const auto configured = ::pthread_attr_setstacksize(&attributes, stack_bytes);
  // Process-directed signals must keep reaching the reactor, including its single-owner child
  // reaper. Block before pthread_create so the worker inherits this mask without a startup race.
  sigset_t blocked{};
  sigset_t previous{};
  const bool masked = configured == 0 && sigfillset(&blocked) == 0 &&
                      ::pthread_sigmask(SIG_BLOCK, &blocked, &previous) == 0;
  const auto started =
      masked ? ::pthread_create(&worker->thread_, &attributes, thread_main, worker.get()) : EINVAL;
  if (masked) {
    const auto restored = ::pthread_sigmask(SIG_SETMASK, &previous, nullptr);
    LEMMA_ASSERT(restored == 0);
  }
  static_cast<void>(::pthread_attr_destroy(&attributes));
  if (started != 0) {
    return std::unexpected(vt::Error::io_error);
  }
  worker->started_ = true;
  return worker;
}

PaneSnapshotWorker::~PaneSnapshotWorker() {
  // Called only after reactor service has stopped. The worker frees every in-flight terminal and
  // decoder before we release its reactor-owned reservations or close either notification pipe.
  if (started_) {
    stopping_.store(true, std::memory_order_release);
    notify(requests_.back());
    static_cast<void>(::pthread_join(thread_, nullptr));
  }
  for (const auto descriptor : requests_) {
    if (descriptor >= 0) {
      static_cast<void>(::close(descriptor));
    }
  }
  for (const auto descriptor : completions_) {
    if (descriptor >= 0) {
      static_cast<void>(::close(descriptor));
    }
  }
}

auto PaneSnapshotWorker::has_capacity() const noexcept -> bool {
  return std::ranges::any_of(slots_, [](const Slot& slot) {
    return slot.state.load(std::memory_order_acquire) == State::free &&
           slot.generation != std::numeric_limits<std::uint64_t>::max();
  });
}

auto PaneSnapshotWorker::submit(Result& result, const vt::TerminalOptions& options,
                                const std::string_view directory,
                                const SnapshotTestCorruption corruption,
                                const bool hydrate) noexcept -> std::expected<Ticket, vt::Error> {
  LEMMA_ASSERT(result.work != nullptr && result.reservation.has_value());
  if (directory.size() > limits::working_directory_bytes_max) {
    return std::unexpected(vt::Error::limit_exceeded);
  }
  for (std::size_t index = 0; index < slots_.size(); ++index) {
    auto& slot = std::span(slots_).subspan(index, 1).front();
    if (slot.state.load(std::memory_order_acquire) != State::free ||
        slot.generation == std::numeric_limits<std::uint64_t>::max()) {
      continue;
    }
    try {
      slot.directory.assign(directory);
    } catch (const std::bad_alloc&) {
      return std::unexpected(vt::Error::out_of_memory);
    }
    slot.options = options;
    slot.corruption = corruption;
    slot.error.reset();
    slot.work = std::move(result.work);
    slot.reservation = std::move(result.reservation);
    result.reservation.reset();
    slot.cancel.store(false, std::memory_order_relaxed);
    slot.wake.store(hydrate, std::memory_order_relaxed);
    slot.abandoned = false;
    ++slot.generation;
    slot.state.store(hydrate ? State::hydrating : State::parking, std::memory_order_release);
    notify(requests_.back());
    return Ticket{.generation = slot.generation, .slot = index};
  }
  return std::unexpected(vt::Error::limit_exceeded);
}

auto PaneSnapshotWorker::matching(const Ticket ticket) noexcept -> Slot* {
  if (ticket.slot >= slots_.size() || ticket.generation == 0) {
    return nullptr;
  }
  auto& slot = std::span(slots_).subspan(ticket.slot, 1).front();
  return slot.generation == ticket.generation &&
                 slot.state.load(std::memory_order_acquire) != State::free
             ? &slot
             : nullptr;
}

void PaneSnapshotWorker::request_wake(const Ticket ticket) noexcept {
  if (auto* const slot = matching(ticket); slot != nullptr && !slot->abandoned) {
    slot->wake.store(true, std::memory_order_release);
  }
}

void PaneSnapshotWorker::abandon(const Ticket ticket) noexcept {
  if (auto* const slot = matching(ticket)) {
    slot->abandoned = true;
    slot->cancel.store(true, std::memory_order_release);
    // If publication races cancellation, collect() hands the completed owner back for destruction.
    collect();
  }
}

auto PaneSnapshotWorker::take(const Ticket ticket) noexcept -> std::optional<Result> {
  auto* const slot = matching(ticket);
  if (slot == nullptr || slot->abandoned ||
      slot->state.load(std::memory_order_acquire) != State::complete) {
    return std::nullopt;
  }
  LEMMA_ASSERT(slot->work != nullptr);
  Result result{.work = std::move(slot->work),
                .reservation = std::move(slot->reservation),
                .error = slot->error};
  slot->reservation.reset();
  slot->state.store(State::free, std::memory_order_release);
  return result;
}

void PaneSnapshotWorker::collect() noexcept {
  for (auto& slot : slots_) {
    if (!slot.abandoned || slot.state.load(std::memory_order_acquire) != State::complete) {
      continue;
    }
    if (slot.work != nullptr) {
      slot.state.store(State::destroying, std::memory_order_release);
      notify(requests_.back());
    } else {
      slot.reservation.reset();
      slot.state.store(State::free, std::memory_order_release);
    }
  }
}

auto PaneSnapshotWorker::completion_descriptor() const noexcept -> int {
  return completions_.front();
}
void PaneSnapshotWorker::drain_notification() noexcept { drain(completions_.front()); }

auto PaneSnapshotWorker::cancelled(const Slot& slot) const noexcept -> bool {
  return stopping_.load(std::memory_order_acquire) || slot.cancel.load(std::memory_order_acquire);
}
void PaneSnapshotWorker::enter(const Stage stage) const noexcept {
  if (hook_.enter != nullptr) {
    hook_.enter(hook_.context, stage);
  }
}

void PaneSnapshotWorker::park(Slot& slot) noexcept {
  if (cancelled(slot) || slot.wake.load(std::memory_order_acquire)) {
    return;
  }
  enter(Stage::parking);
  if (cancelled(slot) || slot.wake.load(std::memory_order_acquire)) {
    return;
  }
  const auto started = slot.work->begin_parking(slot.options, slot.directory);
  if (!started.has_value()) {
    slot.error = started.error();
    return;
  }
  if (cancelled(slot) || slot.wake.load(std::memory_order_acquire)) {
    slot.work->cancel_parking();
    return;
  }
  const auto finished = slot.work->finish_parking(slot.corruption);
  if (!finished.has_value()) {
    slot.error = finished.error();
  }
}

void PaneSnapshotWorker::hydrate(Slot& slot) noexcept {
  if (cancelled(slot)) {
    return;
  }
  enter(Stage::hydrating);
  if (cancelled(slot)) {
    return;
  }
  const auto started = slot.work->begin_unparking();
  if (!started.has_value()) {
    slot.error = started.error();
    return;
  }
  enter(Stage::history);
  while (!cancelled(slot) && slot.work->phase() == PaneResidencyPhase::unparking) {
    const auto restored = slot.work->restore_one_history_page();
    if (!restored.has_value()) {
      slot.error = restored.error();
      // Tear down a partially restored terminal and its plaintext here, never on the reactor.
      slot.work->cancel_unparking();
      return;
    }
  }
}

auto PaneSnapshotWorker::next_job() noexcept -> Slot* {
  Slot* selected = nullptr;
  // Hydration, wake cancellation and destruction outrank queued parking. An executing bounded
  // dependency operation is not preempted; cancellation is observed at its next safe boundary.
  for (auto& slot : slots_) {
    const auto state = slot.state.load(std::memory_order_acquire);
    if (state == State::hydrating || state == State::destroying ||
        (state == State::parking && slot.wake.load(std::memory_order_acquire))) {
      return &slot;
    }
    if (state == State::parking && selected == nullptr) {
      selected = &slot;
    }
  }
  return selected;
}

void PaneSnapshotWorker::run() noexcept {
  while (!stopping_.load(std::memory_order_acquire)) {
    auto* const selected = next_job();
    if (selected == nullptr) {
      pollfd descriptor{.fd = requests_.front(), .events = POLLIN, .revents = 0};
      const auto result = ::poll(&descriptor, 1, -1);
      if (result > 0) {
        drain(requests_.front());
      }
      continue;
    }
    auto& slot = *selected;
    const auto operation = slot.state.load(std::memory_order_acquire);
    slot.state.store(State::running, std::memory_order_release);
    if (operation == State::parking) {
      park(slot);
    } else if (operation == State::hydrating) {
      hydrate(slot);
    }
    if (operation != State::destroying) {
      enter(Stage::completing);
    }
    if (operation == State::destroying || cancelled(slot)) {
      slot.work.reset();
    }
    slot.state.store(State::complete, std::memory_order_release);
    notify(completions_.back());
  }
  for (auto& slot : slots_) {
    slot.work.reset();
  }
}

auto PaneSnapshotWorker::thread_main(void* const context) noexcept -> void* {
  static_cast<PaneSnapshotWorker*>(context)->run();
  return nullptr;
}

} // namespace lemma::core
