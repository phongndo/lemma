#ifndef FIBER_CORE_EXTENSION_RUNTIME_HPP
#define FIBER_CORE_EXTENSION_RUNTIME_HPP

#include "core/engine.hpp"
#include "protocol/extension.hpp"

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <ranges>
#include <string_view>

namespace fiber::core {

inline constexpr std::size_t extension_commands_max = 64;
inline constexpr std::size_t extension_keymaps_max = 128;
inline constexpr std::size_t extension_subscriptions_max = 64;
inline constexpr std::size_t extension_sidebars_max = 4;

template <std::size_t Capacity> struct ExtensionText final {
  std::array<char, Capacity> bytes{};
  std::size_t size{0};

  [[nodiscard]] auto assign(const std::string_view value, const bool allow_empty = false) noexcept
      -> bool {
    if ((!allow_empty && value.empty()) || value.size() > bytes.size()) {
      return false;
    }
    std::ranges::copy(value, bytes.begin());
    size = value.size();
    return true;
  }

  [[nodiscard]] auto view() const noexcept -> std::string_view { return {bytes.data(), size}; }
};

struct ExtensionCommand final {
  ExtensionText<protocol::extension::command_name_bytes_max> name;
  ExtensionText<protocol::extension::command_description_bytes_max> description;
};

struct ExtensionKeymap final {
  ExtensionText<protocol::extension::key_mode_bytes_max> mode;
  ExtensionText<protocol::extension::key_bytes_max> key;
  ExtensionText<protocol::extension::command_name_bytes_max> command;
};

struct ExtensionSubscription final {
  ExtensionText<protocol::extension::event_name_bytes_max> event;
};

struct ExtensionSidebar final {
  ExtensionText<protocol::extension::sidebar_id_bytes_max> id;
  protocol::extension::SidebarSide side{protocol::extension::SidebarSide::left};
  std::uint16_t width{0};
  std::array<ExtensionText<protocol::extension::sidebar_line_bytes_max>,
             protocol::extension::sidebar_lines_max>
      lines{};
  std::size_t line_count{0};
};

struct ExtensionGeneration final {
  std::array<ExtensionCommand, extension_commands_max> commands{};
  std::size_t command_count{0};
  std::array<ExtensionKeymap, extension_keymaps_max> keymaps{};
  std::size_t keymap_count{0};
  std::array<ExtensionSubscription, extension_subscriptions_max> subscriptions{};
  std::size_t subscription_count{0};
  std::array<ExtensionSidebar, extension_sidebars_max> sidebars{};
  std::size_t sidebar_count{0};
};

class ExtensionRuntime final {
public:
  ExtensionRuntime(ExtensionAcquire acquire, void* context,
                   ExtensionErrorReporter report_error = nullptr,
                   void* error_context = nullptr) noexcept;
  ExtensionRuntime(const ExtensionRuntime&) = delete;
  auto operator=(const ExtensionRuntime&) -> ExtensionRuntime& = delete;
  ExtensionRuntime(ExtensionRuntime&&) = delete;
  auto operator=(ExtensionRuntime&&) -> ExtensionRuntime& = delete;
  ~ExtensionRuntime();

  void connect_if_due(std::chrono::steady_clock::time_point now) noexcept;
  [[nodiscard]] auto descriptor() const noexcept -> int { return connection_.descriptor; }
  [[nodiscard]] auto poll_timeout(std::chrono::steady_clock::time_point now) const noexcept -> int;
  void process(short events) noexcept;

  [[nodiscard]] auto generation() const noexcept -> std::uint64_t { return generation_; }
  [[nodiscard]] auto active() const noexcept -> const ExtensionGeneration& { return active_; }
  [[nodiscard]] auto last_error() const noexcept -> std::string_view { return last_error_.view(); }

private:
  enum class ReadStatus : std::uint8_t {
    progress,
    retry,
    blocked,
    closed,
    failed,
  };

  [[nodiscard]] auto read_once(std::size_t& message_budget) noexcept -> ReadStatus;
  [[nodiscard]] auto drain_messages(std::size_t& message_budget) noexcept -> bool;
  [[nodiscard]] auto apply(const protocol::extension::Message& message) noexcept -> bool;
  void disconnect() noexcept;

  ExtensionAcquire acquire_{nullptr};
  void* context_{nullptr};
  ExtensionErrorReporter report_error_{nullptr};
  void* error_context_{nullptr};
  ExtensionConnection connection_{};
  protocol::extension::Decoder decoder_;
  ExtensionGeneration active_{};
  ExtensionGeneration candidate_{};
  ExtensionText<protocol::extension::error_bytes_max> last_error_;
  std::uint64_t generation_{0};
  std::uint8_t reconnect_failures_{0};
  bool building_generation_{false};
  bool continuation_pending_{false};
  std::chrono::steady_clock::time_point reconnect_at_;
};

} // namespace fiber::core

#endif // FIBER_CORE_EXTENSION_RUNTIME_HPP
