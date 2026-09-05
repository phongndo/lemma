#include "platform/io.hpp"
#include "platform/pty.hpp"

#include <array>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <span>
#include <string>
#include <string_view>

#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>

namespace {

[[nodiscard]] auto descriptor_count() noexcept -> int {
  int count = 0;
  for (int descriptor = 0; descriptor < 512; ++descriptor) {
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    count += ::fcntl(descriptor, F_GETFD) >= 0 ? 1 : 0;
  }
  return count;
}

// One diagnostic transaction keeps admission and completion timing boundaries together.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void probe_once(const std::string& command) {
  int descriptor = -1;
  const auto started = std::chrono::steady_clock::now();
  const auto child =
      lemma::platform::spawn_process(descriptor, {}, {}, lemma::platform::EnvironmentMode::inherit,
                                     std::as_bytes(std::span(command.data(), command.size())));
  const auto error = child < 0 ? errno : 0;
  const auto spawned = std::chrono::steady_clock::now();
  int status = -1;
  int io_error = 0;
  std::string output;
  if (child > 0) {
    if (command.empty() &&
        !lemma::platform::write_text(descriptor, "printf '__LOGIN_%s__\\n' READY; exit\r")) {
      io_error = errno;
      static_cast<void>(::kill(child, SIGKILL));
    }
    std::array<char, 4096> buffer{};
    while (true) {
      const auto count = ::read(descriptor, buffer.data(), buffer.size());
      if (count > 0) {
        output.append(buffer.data(), static_cast<std::size_t>(count));
      } else if (count < 0 && errno == EINTR) {
        continue;
      } else {
        if (count < 0 && errno != EIO) {
          io_error = errno;
        }
        break;
      }
    }
    auto waited = ::waitpid(child, &status, 0);
    while (waited < 0 && errno == EINTR) {
      waited = ::waitpid(child, &status, 0);
    }
    if (waited != child) {
      io_error = errno;
    }
    static_cast<void>(::close(descriptor));
  }
  const auto finished = std::chrono::steady_clock::now();
  const auto spawn_ns =
      std::chrono::duration_cast<std::chrono::nanoseconds>(spawned - started).count();
  const auto complete_ns =
      std::chrono::duration_cast<std::chrono::nanoseconds>(finished - started).count();
  static_cast<void>(std::fwrite(output.data(), 1, output.size(), stdout));
  // Diagnostic-only output, not a product command protocol. Timings exclude report formatting.
  // NOLINTBEGIN(cppcoreguidelines-pro-type-vararg)
  static_cast<void>(
      std::printf("\n{\"errno\":%d,\"io_errno\":%d,\"pid\":%ld,\"exit_code\":%d,\"signal\":%d,"
                  "\"spawn_ns\":%lld,\"completion_ns\":%lld}\n",
                  error, io_error, static_cast<long>(child),
                  child > 0 && WIFEXITED(status) ? WEXITSTATUS(status) : -1,
                  child > 0 && WIFSIGNALED(status) ? WTERMSIG(status) : 0,
                  static_cast<long long>(spawn_ns), static_cast<long long>(complete_ns)));
  // NOLINTEND(cppcoreguidelines-pro-type-vararg)
}

} // namespace

int main(const int argc, char** argv) {
  auto arguments = std::span(argv, static_cast<std::size_t>(argc)).subspan(1);
  unsigned int repeats = 1;
  if (arguments.size() >= 2 && std::string_view(arguments.front()) == "--repeat") {
    const std::string_view count(arguments.subspan(1, 1).front());
    const auto parsed = std::from_chars(count.begin(), count.end(), repeats);
    if (parsed.ec != std::errc{} || parsed.ptr != count.end() || repeats == 0 || repeats > 1000) {
      return 2;
    }
    arguments = arguments.subspan(2);
  }
  if (!arguments.empty() && std::string_view(arguments.front()) == "--close-stdin") {
    static_cast<void>(::close(STDIN_FILENO));
    arguments = arguments.subspan(1);
  }
  std::string command;
  for (const auto* const argument : arguments) {
    command.append(argument);
    command.push_back('\0');
  }
  const auto descriptors_before = descriptor_count();
  for (unsigned int index = 0; index < repeats; ++index) {
    probe_once(command);
  }
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  static_cast<void>(std::printf("{\"fd_before\":%d,\"fd_after\":%d,\"samples\":%u}\n",
                                descriptors_before, descriptor_count(), repeats));
  return 0;
}
