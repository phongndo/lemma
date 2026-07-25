#include "platform/pty.hpp"

#include <array>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <span>
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
#error "fiber PTY tests require forkpty support"
#endif

#include <gtest/gtest.h>

namespace fiber::platform {
namespace {

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
} // namespace fiber::platform
