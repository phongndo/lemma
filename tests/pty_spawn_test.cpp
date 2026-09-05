#include "platform/pty.hpp"

#include "lemma/limits.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <csignal>
#include <cstdlib>
#include <initializer_list>
#include <span>
#include <string>
#include <string_view>
#include <thread>

#include <fcntl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include <gtest/gtest.h>

namespace lemma::platform {
namespace {

[[nodiscard]] auto packed(const std::initializer_list<std::string_view> values) -> std::string {
  std::string result;
  for (const auto value : values) {
    result.append(value);
    result.push_back('\0');
  }
  return result;
}

[[nodiscard]] auto bytes(const std::string& value) noexcept -> std::span<const std::byte> {
  return std::as_bytes(std::span(value.data(), value.size()));
}

[[nodiscard]] auto hex(const std::string_view value) -> std::string {
  constexpr std::string_view digits = "0123456789abcdef";
  std::string result;
  for (const auto character : value) {
    const auto octet = static_cast<unsigned char>(character);
    result += digits.substr(octet >> 4U, 1);
    result += digits.substr(octet & 15U, 1);
  }
  return result;
}

struct CapturedChild final {
  pid_t pid{-1};
  int error{0};
  int status{-1};
  std::string output;
};

[[nodiscard]] auto capture(const std::string& command, const std::string& environment = {},
                           const std::string_view directory = {},
                           const std::span<const EnvironmentVariable> overlay = {},
                           const EnvironmentMode mode = EnvironmentMode::replace) -> CapturedChild {
  CapturedChild result;
  int master = -1;
  result.pid = spawn_process(master, directory, bytes(environment), mode, bytes(command), overlay);
  if (result.pid < 0) {
    result.error = errno;
    return result;
  }
  std::array<char, 4096> buffer{};
  while (true) {
    const auto count = ::read(master, buffer.data(), buffer.size());
    if (count > 0) {
      result.output.append(buffer.data(), static_cast<std::size_t>(count));
    } else if (count < 0 && errno == EINTR) {
      continue;
    } else {
      if (count < 0 && errno != EIO) {
        result.error = errno;
      }
      break;
    }
  }
  auto waited = ::waitpid(result.pid, &result.status, 0);
  while (waited < 0 && errno == EINTR) {
    waited = ::waitpid(result.pid, &result.status, 0);
  }
  if (waited != result.pid) {
    result.error = errno;
  }
  static_cast<void>(::close(master));
  return result;
}

[[nodiscard]] auto child_program() -> std::string {
  const auto* const configured = std::getenv("LEMMA_TEST_SPAWN_CHILD");
  return configured != nullptr ? std::string(configured) : std::string{};
}

class IgnoredSignal final {
public:
  explicit IgnoredSignal(const int number) noexcept : number_(number) {
    struct sigaction action{};
    action.sa_handler = SIG_IGN;
    valid_ = sigemptyset(&action.sa_mask) == 0 && ::sigaction(number, &action, &previous_) == 0;
  }
  IgnoredSignal(const IgnoredSignal&) = delete;
  auto operator=(const IgnoredSignal&) -> IgnoredSignal& = delete;
  IgnoredSignal(IgnoredSignal&&) = delete;
  auto operator=(IgnoredSignal&&) -> IgnoredSignal& = delete;
  ~IgnoredSignal() {
    if (valid_) {
      static_cast<void>(::sigaction(number_, &previous_, nullptr));
    }
  }
  [[nodiscard]] auto valid() const noexcept -> bool { return valid_; }

private:
  int number_;
  struct sigaction previous_{};
  bool valid_{false};
};

class BlockedSignal final {
public:
  BlockedSignal() noexcept {
    sigset_t mask{};
    valid_ = sigemptyset(&mask) == 0 && sigaddset(&mask, SIGUSR1) == 0 &&
             ::sigprocmask(SIG_BLOCK, &mask, &previous_) == 0;
  }
  BlockedSignal(const BlockedSignal&) = delete;
  auto operator=(const BlockedSignal&) -> BlockedSignal& = delete;
  BlockedSignal(BlockedSignal&&) = delete;
  auto operator=(BlockedSignal&&) -> BlockedSignal& = delete;
  ~BlockedSignal() {
    if (valid_) {
      static_cast<void>(::sigprocmask(SIG_SETMASK, &previous_, nullptr));
    }
  }
  [[nodiscard]] auto valid() const noexcept -> bool { return valid_; }

private:
  sigset_t previous_{};
  bool valid_{false};
};

// Supported Apple libc++ SDKs do not yet provide jthread/stop_token. Keep this test thread's
// startup and unconditional join in one owner, including when a fatal GTest assertion returns.
class AllocatorActivity final {
public:
  AllocatorActivity() : thread_([this] { run(); }) {
    while (!entered_.load(std::memory_order_relaxed)) {
      std::this_thread::yield();
    }
  }
  AllocatorActivity(const AllocatorActivity&) = delete;
  auto operator=(const AllocatorActivity&) -> AllocatorActivity& = delete;
  AllocatorActivity(AllocatorActivity&&) = delete;
  auto operator=(AllocatorActivity&&) -> AllocatorActivity& = delete;
  ~AllocatorActivity() {
    stop_.store(true, std::memory_order_relaxed);
    thread_.join();
  }

private:
  void run() noexcept {
    // Volatile indirection prevents dead-allocation elimination in optimized builds.
    void* (*volatile allocate)(std::size_t) = &std::malloc;
    while (!stop_.load(std::memory_order_relaxed)) {
      // This fixture intentionally exercises libc allocation concurrently with process spawning.
      // NOLINTNEXTLINE(cppcoreguidelines-no-malloc)
      std::free(allocate(131072U));
      entered_.store(true, std::memory_order_relaxed);
    }
  }

  std::atomic<bool> stop_{false};
  std::atomic<bool> entered_{false};
  std::thread thread_;
};

class TemporaryScript final {
public:
  explicit TemporaryScript(const std::string_view source) noexcept {
    std::ranges::copy(std::string_view{"/tmp/lemma-spawn-XXXXXX"}, path_.begin());
    const auto descriptor = ::mkstemp(path_.data());
    if (descriptor >= 0) {
      valid_ = ::write(descriptor, source.data(), source.size()) ==
                   static_cast<ssize_t>(source.size()) &&
               ::fchmod(descriptor, S_IRUSR | S_IWUSR | S_IXUSR) == 0;
      static_cast<void>(::close(descriptor));
    }
  }
  TemporaryScript(const TemporaryScript&) = delete;
  auto operator=(const TemporaryScript&) -> TemporaryScript& = delete;
  TemporaryScript(TemporaryScript&&) = delete;
  auto operator=(TemporaryScript&&) -> TemporaryScript& = delete;
  ~TemporaryScript() { static_cast<void>(::unlink(path_.data())); }
  [[nodiscard]] auto valid() const noexcept -> bool { return valid_; }
  [[nodiscard]] auto path() const noexcept -> std::string_view { return path_.data(); }

private:
  std::array<char, 64> path_{};
  bool valid_{false};
};

// GTest's assertion macro branches are not control-flow complexity of this helper.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void expect_success(const CapturedChild& child) {
  ASSERT_GT(child.pid, 0) << child.error;
  ASSERT_EQ(child.error, 0);
  // Darwin's wait macros inspect through a non-const pointer: pass a local scalar copy.
  auto status = child.status;
  ASSERT_TRUE(WIFEXITED(status)) << child.output;
  EXPECT_EQ(WEXITSTATUS(status), 0) << child.output;
}

// Assertions describe separate inherited process properties.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PtySpawnTest, PreservesPtyIdentityCredentialsSignalsCwdEnvironmentAndArguments) {
  const auto program = child_program();
  ASSERT_FALSE(program.empty());
  // Do not ignore SIGCHLD in the parent: that would make its child auto-reaped. A caught handler
  // is reset by exec; SIGPIPE is the ignored disposition that must be explicitly reset.
  const IgnoredSignal pipe(SIGPIPE);
  const BlockedSignal blocked;
  ASSERT_TRUE(pipe.valid());
  ASSERT_TRUE(blocked.valid());
  const auto environment = packed(
      {"VALUE=old", "VALUE=new", "EMPTY=", "PWD=/stale", "PATH=/no-launcher-or-program-here"});
  const std::array overlay{EnvironmentVariable{.name = "VALUE", .value = "overlay"},
                           EnvironmentVariable{.name = "TERM", .value = "not-the-final-term"}};
  const auto result =
      capture(packed({program, "with spaces", "", "utf8-\xc3\xa9"}), environment, "/", overlay);
  expect_success(result);
  const auto identity = std::to_string(result.pid);
  EXPECT_TRUE(result.output.contains("pid=" + identity + " sid=" + identity + " pgid=" + identity +
                                     " foreground=" + identity));
  EXPECT_TRUE(result.output.contains(
      "uid=" + std::to_string(::getuid()) + " euid=" + std::to_string(::geteuid()) +
      " gid=" + std::to_string(::getgid()) + " egid=" + std::to_string(::getegid())));
  EXPECT_TRUE(result.output.contains("tty=1,1,1 size=80,24 chld=1 pipe=1 usr1_blocked=1"));
  EXPECT_TRUE(result.output.contains("cwd=" + hex("/") + "\r\n"));
  EXPECT_TRUE(result.output.contains("env=" + hex("PWD=/") + "\r\n"));
  EXPECT_TRUE(result.output.contains("env=" + hex("VALUE=overlay") + "\r\n"));
  EXPECT_TRUE(result.output.contains("env=" + hex("EMPTY=") + "\r\n"));
  EXPECT_TRUE(result.output.contains("env=" + hex("TERM=xterm-256color") + "\r\n"));
  EXPECT_FALSE(result.output.contains(hex("VALUE=old")));
  EXPECT_FALSE(result.output.contains(hex("VALUE=new")));
  EXPECT_TRUE(result.output.contains("arg=" + hex("with spaces") +
                                     "\r\narg=\r\narg=" + hex("utf8-\xc3\xa9") + "\r\n"));
  EXPECT_FALSE(result.output.contains("unexpected_fd=")) << result.output;
}

TEST(PtySpawnTest, DoesNotInheritAnUnrelatedNonCloexecDescriptor) {
  const auto program = child_program();
  ASSERT_FALSE(program.empty());
  // A different thread's not-yet-CLOEXEC descriptor must be excluded by the spawn file actions.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const auto descriptor = ::fcntl(STDOUT_FILENO, F_DUPFD, 257);
  ASSERT_GE(descriptor, 257);
  const auto result = capture(packed({program}));
  static_cast<void>(::close(descriptor));
  expect_success(result);
  EXPECT_FALSE(result.output.contains("unexpected_fd=")) << result.output;
}

TEST(PtySpawnTest, ReplacementWithAnEmptySnapshotDoesNotInheritParentVariables) {
  const auto program = child_program();
  ASSERT_FALSE(program.empty());
  const auto result = capture(packed({program}));
  expect_success(result);
  EXPECT_FALSE(result.output.contains(hex("LEMMA_TEST_SPAWN_CHILD=")));
  EXPECT_FALSE(result.output.contains(hex("PATH=")));
  EXPECT_TRUE(result.output.contains(hex("TERM_PROGRAM=lemma")));
}

TEST(PtySpawnTest, ExplicitInheritanceUsesTheParentEnvironment) {
  const auto program = child_program();
  ASSERT_FALSE(program.empty());
  const auto result =
      capture(packed({program, "--inherited"}), {}, {}, {}, EnvironmentMode::inherit);
  expect_success(result);
  EXPECT_EQ(result.output, "__INHERITED_MARKER__\r\n");
}

TEST(PtySpawnTest, KeepsLibcPathSearchAndEnoexecScriptFallback) {
  const TemporaryScript script("printf 'SCRIPT:%s|%s\\n' \"$1\" \"$2\"\n");
  ASSERT_TRUE(script.valid());
  const auto basename = script.path().substr(script.path().rfind('/') + 1U);
  const auto result = capture(packed({basename, "with spaces", ""}), packed({"PATH=/tmp"}), "/");
  expect_success(result);
  EXPECT_EQ(result.output, "SCRIPT:with spaces|\r\n");
}

TEST(PtySpawnTest, AdmitsMaximumEnvironmentAndCommandPayloadsWithoutAReader) {
  const auto program = child_program();
  ASSERT_FALSE(program.empty());
  const std::string argument(limits::command_bytes_hard_max - program.size() - 2U, 'a');
  const auto command = packed({program, argument});
  const std::string value(limits::environment_bytes_max - 7U, 'e');
  const auto environment = packed({"VALUE=" + value});
  const std::string overlay_name(300, 'n');
  const std::string overlay_value(limits::environment_bytes_max - overlay_name.size() - 2U, 'o');
  const std::array overlay{EnvironmentVariable{.name = overlay_name, .value = overlay_value}};
  ASSERT_EQ(command.size(), limits::command_bytes_hard_max);
  ASSERT_EQ(environment.size(), limits::environment_bytes_max);
  const auto result = capture(command, environment, {}, overlay);
  expect_success(result);
  EXPECT_TRUE(result.output.contains("arg=" + hex(argument) + "\r\n"));
  EXPECT_TRUE(result.output.contains("env=" + hex("VALUE=" + value) + "\r\n"));
  EXPECT_TRUE(result.output.contains("env=" + hex(overlay_name + "=" + overlay_value) + "\r\n"));
}

// The same independent assertions apply to each legacy child-failure case.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PtySpawnTest, KeepsChildSetupAndTargetExecFailuresAsExit127) {
  for (const auto& result : {
           capture(packed({"/no-such-lemma-program"})),
           capture(packed({"/bin/sh", "-c", "exit 0"}), {}, "/no-such-lemma-directory"),
           capture(packed({"/bin/sh", "-c", "exit 0"}), packed({"INVALID-ENVIRONMENT"})),
           capture(packed({"/bin/sh", "-c", "exit 127"})),
       }) {
    ASSERT_GT(result.pid, 0) << result.error;
    ASSERT_EQ(result.error, 0);
    auto status = result.status;
    ASSERT_TRUE(WIFEXITED(status));
    EXPECT_EQ(WEXITSTATUS(status), 127);
  }
}

TEST(PtySpawnTest, RejectsInvalidAdmissionWithoutOverwritingTheDescriptor) {
  int descriptor = 12345;
  const auto invalid = packed({""});
  EXPECT_EQ(spawn_process(descriptor, {}, {}, EnvironmentMode::replace, bytes(invalid)), -1);
  EXPECT_EQ(errno, EINVAL);
  EXPECT_EQ(descriptor, 12345);
  const std::string oversized(limits::environment_bytes_max + 1U, 'x');
  EXPECT_EQ(spawn_process(descriptor, {}, bytes(oversized), EnvironmentMode::replace), -1);
  EXPECT_EQ(errno, E2BIG);
  EXPECT_EQ(descriptor, 12345);
}

TEST(PtySpawnTest, SpawnsWhileAnotherThreadOwnsAllocatorActivity) {
  const auto program = child_program();
  ASSERT_FALSE(program.empty());
  const AllocatorActivity allocator;
  const auto command = packed({program, "--ready"});
  for (std::size_t index = 0; index < 50; ++index) {
    const auto result = capture(command);
    expect_success(result);
    ASSERT_EQ(result.output, "__SPAWN_READY__\r\n");
  }
}

} // namespace
} // namespace lemma::platform
