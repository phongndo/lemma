#ifndef LEMMA_PROTOCOL_EXTENSION_HPP
#define LEMMA_PROTOCOL_EXTENSION_HPP

#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <optional>
#include <span>
#include <string_view>

namespace lemma::protocol::extension {

inline constexpr std::uint16_t version = 1;
inline constexpr std::size_t frame_header_bytes = 20;
inline constexpr std::size_t payload_bytes_max = std::size_t{16} * 1'024U;
inline constexpr std::size_t decoder_bytes_max = std::size_t{32} * 1'024U;
inline constexpr std::size_t command_name_bytes_max = 64;
inline constexpr std::size_t command_description_bytes_max = 256;
inline constexpr std::size_t key_mode_bytes_max = 16;
inline constexpr std::size_t key_bytes_max = 32;
inline constexpr std::size_t event_name_bytes_max = 64;
inline constexpr std::size_t sidebar_id_bytes_max = 64;
inline constexpr std::size_t sidebar_lines_max = 32;
inline constexpr std::size_t sidebar_line_bytes_max = 256;
inline constexpr std::size_t error_bytes_max = 1'024;

inline constexpr std::array<std::byte, 4> magic{std::byte{'F'}, std::byte{'E'}, std::byte{'X'},
                                                std::byte{'1'}};

enum class MessageKind : std::uint8_t {
  begin_generation = 1,
  register_command = 2,
  register_keymap = 3,
  subscribe_event = 4,
  set_sidebar = 5,
  commit_generation = 6,
  config_error = 7,
};

enum class SidebarSide : std::uint8_t {
  none = 0,
  left = 1,
  right = 2,
};

enum class EncodeError : std::uint8_t {
  invalid_value,
  output_too_small,
};

enum class DecodeError : std::uint8_t {
  invalid_magic,
  unsupported_version,
  invalid_kind,
  payload_too_large,
  invalid_payload,
  buffer_full,
};

struct Message final {
  MessageKind kind{MessageKind::begin_generation};
  std::uint64_t request_id{0};
  std::span<const std::byte> payload;
};

struct CommandRegistration final {
  std::string_view name;
  std::string_view description;
};

struct KeymapRegistration final {
  std::string_view mode;
  std::string_view key;
  std::string_view command;
};

struct EventSubscription final {
  std::string_view event;
};

struct SidebarRegistration final {
  std::string_view id;
  SidebarSide side{SidebarSide::left};
  std::uint16_t width{0};
  std::array<std::string_view, sidebar_lines_max> lines{};
  std::size_t line_count{0};
};

[[nodiscard]] auto encode_empty(MessageKind kind, std::uint64_t request_id,
                                std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, EncodeError>;
[[nodiscard]] auto encode_command(const CommandRegistration& registration, std::uint64_t request_id,
                                  std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, EncodeError>;
[[nodiscard]] auto encode_keymap(const KeymapRegistration& registration, std::uint64_t request_id,
                                 std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, EncodeError>;
[[nodiscard]] auto encode_subscription(const EventSubscription& subscription,
                                       std::uint64_t request_id,
                                       std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, EncodeError>;
[[nodiscard]] auto encode_sidebar(const SidebarRegistration& registration, std::uint64_t request_id,
                                  std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, EncodeError>;
[[nodiscard]] auto encode_config_error(std::string_view error, std::uint64_t request_id,
                                       std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, EncodeError>;

[[nodiscard]] auto decode_command(const Message& message) noexcept
    -> std::expected<CommandRegistration, DecodeError>;
[[nodiscard]] auto decode_keymap(const Message& message) noexcept
    -> std::expected<KeymapRegistration, DecodeError>;
[[nodiscard]] auto decode_subscription(const Message& message) noexcept
    -> std::expected<EventSubscription, DecodeError>;
[[nodiscard]] auto decode_sidebar(const Message& message) noexcept
    -> std::expected<SidebarRegistration, DecodeError>;
[[nodiscard]] auto decode_config_error(const Message& message) noexcept
    -> std::expected<std::string_view, DecodeError>;

// Incremental decoder. Message payloads borrow decoder storage until consume() or reset().
class Decoder final {
public:
  [[nodiscard]] auto writable_bytes() noexcept -> std::span<std::byte>;
  [[nodiscard]] auto commit(std::size_t bytes) noexcept -> std::expected<void, DecodeError>;
  [[nodiscard]] auto next() noexcept -> std::expected<std::optional<Message>, DecodeError>;
  void consume() noexcept;
  void reset() noexcept;

private:
  std::array<std::byte, decoder_bytes_max> storage_{};
  std::size_t used_{0};
  std::size_t pending_size_{0};
};

} // namespace lemma::protocol::extension

#endif // LEMMA_PROTOCOL_EXTENSION_HPP
