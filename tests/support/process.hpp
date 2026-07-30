#ifndef FIBER_TESTS_SUPPORT_PROCESS_HPP
#define FIBER_TESTS_SUPPORT_PROCESS_HPP

#include "fiber/terminal/terminal.hpp"

#include <chrono>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <sys/types.h>
#include <termios.h>

namespace fiber::test {

using Deadline = std::chrono::steady_clock::time_point;

class TemporaryRuntime final {
public:
  TemporaryRuntime();
  TemporaryRuntime(const TemporaryRuntime&) = delete;
  auto operator=(const TemporaryRuntime&) -> TemporaryRuntime& = delete;
  TemporaryRuntime(TemporaryRuntime&&) = delete;
  auto operator=(TemporaryRuntime&&) -> TemporaryRuntime& = delete;
  ~TemporaryRuntime();

  [[nodiscard]] auto valid() const noexcept -> bool { return !directory_.empty(); }
  [[nodiscard]] auto directory() const noexcept -> const std::string& { return directory_; }
  [[nodiscard]] auto socket_path() const noexcept -> const std::string& { return socket_path_; }
  [[nodiscard]] auto environment() const -> std::vector<std::string>;

private:
  std::string directory_;
  std::string socket_path_;
  std::string lock_path_;
  std::string home_path_;
  std::string config_path_;
  std::string zdot_path_;
};

class ChildProcess final {
public:
  ChildProcess() = default;
  ChildProcess(const ChildProcess&) = delete;
  auto operator=(const ChildProcess&) -> ChildProcess& = delete;
  ChildProcess(ChildProcess&&) = delete;
  auto operator=(ChildProcess&&) -> ChildProcess& = delete;
  ~ChildProcess();

  [[nodiscard]] auto spawn(const std::vector<std::string>& arguments,
                           const std::vector<std::string>& environment) -> bool;
  [[nodiscard]] auto wait(Deadline deadline) -> bool;
  void terminate() noexcept;
  [[nodiscard]] auto running() const noexcept -> bool { return process_ > 0; }
  [[nodiscard]] auto status() const noexcept -> int { return status_; }
  [[nodiscard]] auto output() -> std::string;

private:
  void drain_output() noexcept;
  void signal_group(int signal_number) const noexcept;

  pid_t process_{-1};
  int output_descriptor_{-1};
  int status_{-1};
  std::string output_tail_;
};

class PtyClient final {
public:
  PtyClient();
  PtyClient(const PtyClient&) = delete;
  auto operator=(const PtyClient&) -> PtyClient& = delete;
  PtyClient(PtyClient&&) = delete;
  auto operator=(PtyClient&&) -> PtyClient& = delete;
  ~PtyClient();

  [[nodiscard]] auto spawn(const std::vector<std::string>& arguments,
                           const std::vector<std::string>& environment, std::uint16_t columns = 80,
                           std::uint16_t rows = 24) -> bool;
  [[nodiscard]] auto send(std::span<const std::byte> bytes, Deadline deadline) noexcept -> bool;
  [[nodiscard]] auto send(std::string_view text, Deadline deadline) noexcept -> bool;
  [[nodiscard]] auto resize(std::uint16_t columns, std::uint16_t rows) noexcept -> bool;
  [[nodiscard]] auto wait_for_screen(std::string_view text, Deadline deadline) -> bool;
  [[nodiscard]] auto wait_for_raw(std::string_view text, Deadline deadline) -> bool;
  void drain(Deadline deadline) noexcept;
  [[nodiscard]] auto wait(Deadline deadline) -> bool;
  void terminate() noexcept;
  [[nodiscard]] auto screen() -> std::string;
  [[nodiscard]] auto terminal_state_restored() const noexcept -> bool;
  [[nodiscard]] auto raw_tail() const noexcept -> const std::string& { return raw_tail_; }

private:
  void pump(Deadline deadline) noexcept;
  void signal_group(int signal_number) const noexcept;

  pid_t process_{-1};
  int master_{-1};
  int status_{-1};
  termios initial_terminal_state_{};
  bool initial_terminal_state_valid_{false};
  std::optional<vt::Terminal> terminal_;
  std::string raw_tail_;
};

[[nodiscard]] auto deadline_after(std::chrono::milliseconds duration) noexcept -> Deadline;
[[nodiscard]] auto wait_for_endpoint(std::string_view socket_path, Deadline deadline) noexcept
    -> bool;

} // namespace fiber::test

#endif // FIBER_TESTS_SUPPORT_PROCESS_HPP
