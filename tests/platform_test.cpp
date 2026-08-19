#include "platform/io.hpp"
#include "platform/pty.hpp"

#include <array>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <span>
#include <string_view>
#include <thread>

#include <fcntl.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
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

TEST(PlatformIoTest, PassesOneCloseOnExecDescriptorWithStreamSentinel) {
  std::array<int, 2> sockets{};
  std::array<int, 2> pipe{};
  ASSERT_EQ(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets.data()), 0);
  ASSERT_EQ(::pipe(pipe.data()), 0);

  ASSERT_TRUE(send_descriptor(sockets.front(), pipe.back()));
  int received = -1;
  ASSERT_EQ(receive_descriptor(sockets.back(), received), ReceiveDescriptorStatus::received);
  ASSERT_GE(received, 0);
  EXPECT_NE(::fcntl(received, F_GETFD, 0) & FD_CLOEXEC, 0);

  constexpr std::byte value{0x5A};
  ASSERT_EQ(::write(received, &value, 1), 1);
  std::byte observed{};
  ASSERT_EQ(::read(pipe.front(), &observed, 1), 1);
  EXPECT_EQ(observed, value);

  close_descriptor(received);
  close_descriptor(sockets.front());
  close_descriptor(sockets.back());
  close_descriptor(pipe.front());
  close_descriptor(pipe.back());
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
