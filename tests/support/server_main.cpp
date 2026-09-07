#include "daemon/server.hpp"

#include <atomic>
#include <charconv>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <thread>

#include <fcntl.h>
#include <unistd.h>

namespace {

static_assert(std::atomic<bool>::is_always_lock_free);
std::atomic<bool> stop_requested{false};

void request_stop([[maybe_unused]] const int signal_number) noexcept { stop_requested.store(true); }

[[nodiscard]] auto should_stop() noexcept -> bool { return stop_requested.load(); }

struct SnapshotGate final {
  std::string entered;
  std::string released;
  lemma::core::PaneSnapshotWorker::Stage stage{lemma::core::PaneSnapshotWorker::Stage::parking};

  [[nodiscard]] auto configure(lemma::daemon::ServeOptions& options) -> bool {
    const char* const configured = std::getenv("LEMMA_TEST_SNAPSHOT_GATE");
    if (configured == nullptr) {
      return true;
    }
    entered = std::string(configured) + ".entered";
    released = std::string(configured) + ".released";
    options.snapshot_worker_test_hook = {.context = this, .enter = enter};
    const char* const configured_stage = std::getenv("LEMMA_TEST_SNAPSHOT_GATE_STAGE");
    if (configured_stage != nullptr) {
      if (std::string_view(configured_stage) != "hydrating") {
        return false;
      }
      stage = lemma::core::PaneSnapshotWorker::Stage::hydrating;
    }
    return true;
  }

  static void enter(void* const context,
                    const lemma::core::PaneSnapshotWorker::Stage stage) noexcept {
    const auto& gate = *static_cast<SnapshotGate*>(context);
    if (stage != gate.stage) {
      return;
    }
    // POSIX open accepts creation permissions through its variadic ABI.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    const int marker = ::open(gate.entered.c_str(), O_WRONLY | O_CREAT | O_CLOEXEC, 0600);
    if (marker < 0) {
      return;
    }
    static_cast<void>(::close(marker));
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{10};
    while (!should_stop() && std::chrono::steady_clock::now() < deadline &&
           ::access(gate.released.c_str(), F_OK) != 0) {
      std::this_thread::sleep_for(std::chrono::milliseconds{1});
    }
  }
};

[[nodiscard]] auto test_flag(const char* const name) noexcept -> std::optional<bool> {
  const char* const configured = std::getenv(name);
  if (configured == nullptr) {
    return false;
  }
  return std::string_view(configured) == "1" ? std::optional{true} : std::nullopt;
}

} // namespace

int main(const int argc, char** argv) {
  const std::span arguments(argv, static_cast<std::size_t>(argc));
  if (arguments.size() != 2) {
    return 2;
  }
  const auto endpoint = lemma::daemon::RuntimeEndpoint::create(std::string_view(arguments.back()));
  if (!endpoint.has_value()) {
    return 2;
  }
  struct sigaction action{};
  action.sa_handler = &request_stop;
  if (sigemptyset(&action.sa_mask) != 0 || ::sigaction(SIGTERM, &action, nullptr) != 0) {
    return 2;
  }
  lemma::daemon::ServeOptions options{.stop_requested = &should_stop,
                                      .detached_pane_parking_delay = std::nullopt,
                                      .pause_pane_hydration_for_test = false,
                                      .snapshot_worker_test_hook = {},
                                      .snapshot_directory = "/tmp",
                                      .corrupt_parked_snapshots_for_test = false};
  if (const char* const configured = std::getenv("LEMMA_TEST_PARKING_DELAY_MS");
      configured != nullptr) {
    const std::string_view text(configured);
    std::uint32_t milliseconds = 0;
    const auto parsed = std::from_chars(text.begin(), text.end(), milliseconds);
    if (parsed.ec != std::errc{} || parsed.ptr != text.end() || milliseconds > 60'000U) {
      return 2;
    }
    options.detached_pane_parking_delay = std::chrono::milliseconds{milliseconds};
  }
  const auto pause = test_flag("LEMMA_TEST_PAUSE_HYDRATION");
  const auto corrupt = test_flag("LEMMA_TEST_CORRUPT_PARKED_SNAPSHOTS");
  if (!pause.has_value() || !corrupt.has_value()) {
    return 2;
  }
  options.pause_pane_hydration_for_test = *pause;
  options.corrupt_parked_snapshots_for_test = *corrupt;
  if (const char* const configured = std::getenv("LEMMA_TEST_SNAPSHOT_DIRECTORY");
      configured != nullptr) {
    options.snapshot_directory = configured;
  }
  SnapshotGate gate;
  if (!gate.configure(options)) {
    return 2;
  }
  return lemma::daemon::serve(*endpoint, options);
}
