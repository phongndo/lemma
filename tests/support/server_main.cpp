#include "daemon/server.hpp"

#include <charconv>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <span>
#include <string_view>

namespace {

volatile sig_atomic_t stop_requested = 0;

void request_stop([[maybe_unused]] const int signal_number) noexcept { stop_requested = 1; }

[[nodiscard]] auto should_stop() noexcept -> bool { return stop_requested != 0; }

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
                                      .pane_hydration_steps_per_turn = std::nullopt,
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
  if (const char* const configured = std::getenv("LEMMA_TEST_HYDRATION_STEPS_PER_TURN");
      configured != nullptr) {
    const std::string_view text(configured);
    std::uint32_t steps = 0;
    const auto parsed = std::from_chars(text.begin(), text.end(), steps);
    if (parsed.ec != std::errc{} || parsed.ptr != text.end() || steps > 8U) {
      return 2;
    }
    options.pane_hydration_steps_per_turn = steps;
  }
  if (const char* const configured = std::getenv("LEMMA_TEST_CORRUPT_PARKED_SNAPSHOTS");
      configured != nullptr) {
    if (std::string_view(configured) != "1") {
      return 2;
    }
    options.corrupt_parked_snapshots_for_test = true;
  }
  return lemma::daemon::serve(*endpoint, options);
}
