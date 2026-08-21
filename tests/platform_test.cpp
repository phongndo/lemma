#include "platform/pty.hpp"

#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <span>
#include <string>
#include <string_view>
#include <thread>

#include <sys/ioctl.h>
#include <sys/wait.h>
#include <unistd.h>

#ifdef __APPLE__
#include <util.h>
#elifdef __linux__
#include <pty.h>
#else
#error "lemma PTY tests require forkpty support"
#endif

#include <gtest/gtest.h>

namespace lemma::platform {
namespace {

// GoogleTest assertions and explicit PTY child setup inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PlatformPtyTest, LaunchWorkingDirectoryOverridesStalePwdEnvironment) {
  std::string environment{"PWD=/stale"};
  environment.push_back('\0');
  std::string command{"/usr/bin/printenv"};
  command.push_back('\0');
  command += "PWD";
  command.push_back('\0');
  int descriptor = -1;

  const auto child = spawn_process(
      descriptor, "/", std::as_bytes(std::span(environment.data(), environment.size())),
      EnvironmentMode::replace, std::as_bytes(std::span(command.data(), command.size())));
  ASSERT_GT(child, 0);
  ASSERT_GE(descriptor, 0);

  std::string output;
  std::array<char, 64> buffer{};
  while (true) {
    const auto received = ::read(descriptor, buffer.data(), buffer.size());
    if (received > 0) {
      output.append(buffer.data(), static_cast<std::size_t>(received));
      continue;
    }
    if (received < 0 && errno == EINTR) {
      continue;
    }
    break;
  }
  int status = 0;
  ASSERT_EQ(::waitpid(child, &status, 0), child);
  static_cast<void>(::close(descriptor));

  ASSERT_TRUE(WIFEXITED(status));
  EXPECT_EQ(WEXITSTATUS(status), 0);
  EXPECT_TRUE(output.starts_with("/\r\n")) << output;
}

// GoogleTest assertions and explicit PTY child setup inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PlatformPtyTest, ReadsForegroundProcessName) {
  std::array<int, 2> descriptors{};
  ASSERT_EQ(::openpty(&descriptors.front(), &descriptors.back(), nullptr, nullptr, nullptr), 0);

  const auto child = ::fork();
  ASSERT_GE(child, 0);
  if (child == 0) {
    static_cast<void>(::close(descriptors.front()));
    // ioctl is variadic because its third argument depends on the request.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    if (::setsid() < 0 || ::ioctl(descriptors.back(), TIOCSCTTY, nullptr) < 0 ||
        ::tcsetpgrp(descriptors.back(), ::getpid()) < 0) {
      ::_exit(127);
    }
    static_cast<void>(::dup2(descriptors.back(), STDIN_FILENO));
    static_cast<void>(::dup2(descriptors.back(), STDOUT_FILENO));
    static_cast<void>(::dup2(descriptors.back(), STDERR_FILENO));
    if (descriptors.back() > STDERR_FILENO) {
      static_cast<void>(::close(descriptors.back()));
    }
    // execl is variadic and requires a null argument sentinel.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    ::execl("/bin/sleep", "sleep", "5", static_cast<char*>(nullptr));
    ::_exit(127);
  }

  static_cast<void>(::close(descriptors.back()));
  std::array<char, 64> name{};
  std::size_t size = 0;
  for (std::size_t attempt = 0; attempt < 100; ++attempt) {
    size = foreground_process_name(descriptors.front(), name);
    if (std::string_view(name.data(), size) == "sleep") {
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }

  static_cast<void>(::kill(child, SIGTERM));
  static_cast<void>(::waitpid(child, nullptr, 0));
  static_cast<void>(::close(descriptors.front()));

  ASSERT_GT(size, 0U);
  EXPECT_EQ(std::string_view(name.data(), size), "sleep");
}

} // namespace
} // namespace lemma::platform
