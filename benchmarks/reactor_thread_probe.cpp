#include <charconv>
#include <condition_variable>
#include <cstddef>
#include <iostream>
#include <limits>
#include <mutex>
#include <span>
#include <stop_token>
#include <string>
#include <string_view>
#include <system_error>
#include <thread>
#include <vector>

namespace {

[[nodiscard]] auto parse_count(const std::string_view text) noexcept -> std::size_t {
  std::size_t value = 0;
  const auto input = std::span(text);
  const auto* const end = std::to_address(input.end());
  // from_chars consumes the explicit half-open range and does not require termination.
  // NOLINTNEXTLINE(bugprone-suspicious-stringview-data-usage)
  const auto parsed = std::from_chars(input.data(), end, value);
  return parsed.ec == std::errc{} && parsed.ptr == end && value <= 512U
             ? value
             : std::numeric_limits<std::size_t>::max();
}

} // namespace

int main(const int argc, char** const argv) {
  const auto arguments = std::span(argv, static_cast<std::size_t>(argc));
  if (arguments.size() != 2) {
    return 2;
  }
  const auto count = parse_count(arguments.subspan(1, 1).front());
  if (count == std::numeric_limits<std::size_t>::max()) {
    return 2;
  }

  std::mutex mutex;
  std::condition_variable ready_condition;
  std::condition_variable stop_condition;
  std::size_t ready = 0;
  bool stop = false;
  std::vector<std::jthread> threads;
  threads.reserve(count);
  try {
    for (std::size_t index = 0; index < count; ++index) {
      threads.emplace_back([&] {
        std::unique_lock lock(mutex);
        ++ready;
        ready_condition.notify_one();
        stop_condition.wait(lock, [&] { return stop; });
      });
    }
  } catch (const std::system_error&) {
    {
      const std::scoped_lock lock(mutex);
      stop = true;
    }
    stop_condition.notify_all();
    return 1;
  }

  {
    std::unique_lock lock(mutex);
    ready_condition.wait(lock, [&] { return ready == count; });
  }
  std::cout << R"({"stage":"idle","worker_threads":)" << count << "}\n" << std::flush;
  std::string command;
  if (!std::getline(std::cin, command) || command != "stop") {
    return 2;
  }
  {
    const std::scoped_lock lock(mutex);
    stop = true;
  }
  stop_condition.notify_all();
  threads.clear();
  std::cout << R"({"stage":"stopped"})" << '\n' << std::flush;
  return 0;
}
