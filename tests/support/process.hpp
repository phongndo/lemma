#ifndef FIBER_TESTS_SUPPORT_PROCESS_HPP
#define FIBER_TESTS_SUPPORT_PROCESS_HPP

#include "fiber/terminal/terminal.hpp"

#include <chrono>
#include <cstddef>
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
  [[nodiscard]] auto owned_path(std::string_view name) -> std::string;

private:
  std::string directory_;
  std::string socket_path_;
  std::string lock_path_;
  std::string home_path_;
  std::string config_path_;
  std::string zdot_path_;
  std::vector<std::string> owned_paths_;
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

class RawPeer final {
public:
  RawPeer() = default;
  RawPeer(const RawPeer&) = delete;
  auto operator=(const RawPeer&) -> RawPeer& = delete;
  RawPeer(RawPeer&&) = delete;
  auto operator=(RawPeer&&) -> RawPeer& = delete;
  ~RawPeer();

  [[nodiscard]] auto connect(std::string_view socket_path, Deadline deadline) noexcept -> bool;
  [[nodiscard]] auto set_receive_buffer(int bytes) noexcept -> bool;
  [[nodiscard]] auto send(std::span<const std::byte> bytes, Deadline deadline) noexcept -> bool;
  [[nodiscard]] auto send(std::string_view text, Deadline deadline) noexcept -> bool;
  [[nodiscard]] auto send_fragments(std::span<const std::byte> bytes, std::size_t fragment_bytes,
                                    Deadline deadline) noexcept -> bool;
  [[nodiscard]] auto send_available(std::span<const std::byte> bytes,
                                    std::size_t& consumed) noexcept -> bool;
  [[nodiscard]] auto read_some(std::span<std::byte> output, Deadline deadline) noexcept
      -> std::ptrdiff_t;
  [[nodiscard]] auto read_until_close(std::size_t maximum, Deadline deadline)
      -> std::optional<std::string>;
  [[nodiscard]] auto wait_for_byte(std::byte expected, Deadline deadline) noexcept -> bool;
  [[nodiscard]] auto wait_for_close(Deadline deadline) noexcept -> bool;
  void close() noexcept;
  [[nodiscard]] auto connected() const noexcept -> bool { return descriptor_ >= 0; }
  [[nodiscard]] auto native_handle() const noexcept -> int { return descriptor_; }
  [[nodiscard]] auto last_error() const noexcept -> int { return last_error_; }
  [[nodiscard]] auto received_tail() const noexcept -> const std::string& { return received_tail_; }

private:
  void retain_received(std::span<const std::byte> bytes) noexcept;

  int descriptor_{-1};
  int last_error_{0};
  std::string received_tail_;
};

struct WorkspaceListing final {
  std::size_t windows{0};
  std::size_t panes{0};
  pid_t focused_pid{-1};
  std::uint16_t columns{0};
  std::uint16_t rows{0};
  bool attached{false};
};

struct WindowListing final {
  std::size_t number{0};
  std::size_t panes{0};
  bool active{false};
};

[[nodiscard]] auto parse_workspace_listing(std::string_view output)
    -> std::optional<WorkspaceListing>;
[[nodiscard]] auto parse_window_listings(std::string_view output) -> std::vector<WindowListing>;

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
  [[nodiscard]] auto send_available(std::span<const std::byte> bytes,
                                    std::size_t& consumed) const noexcept -> bool;
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
