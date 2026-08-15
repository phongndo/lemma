#ifndef LEMMA_PROTOCOL_SINGLE_PANE_HPP
#define LEMMA_PROTOCOL_SINGLE_PANE_HPP

#include "lemma/limits.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <memory>
#include <optional>
#include <span>
#include <string_view>

namespace lemma::protocol {

inline constexpr std::size_t input_bytes_max = std::size_t{4} * 1'024U;
inline constexpr std::size_t input_message_bytes_max = input_bytes_max * 2U;
inline constexpr std::uint16_t columns_max = 500;
inline constexpr std::uint16_t rows_max = 200;
inline constexpr std::size_t session_name_bytes_max = 32;
inline constexpr std::size_t working_directory_bytes_max = std::size_t{4} * 1'024U;
// create_with_context uses this sentinel to reuse an existing session without creating one when
// the caller cannot capture a fresh launch context.
inline constexpr std::size_t unavailable_working_directory_size = 0;
inline constexpr std::size_t environment_bytes_max = 65'535;
inline constexpr std::size_t environment_entries_max = 256;
inline constexpr std::size_t prefix_actions_max = 64;
inline constexpr std::string_view shutdown_response = "lemma daemon stopped\n";

struct Dimensions final {
  std::uint16_t columns{80};
  std::uint16_t rows{24};

  [[nodiscard]] constexpr auto operator==(const Dimensions&) const noexcept -> bool = default;
};

struct RgbColor final {
  std::uint8_t red{0};
  std::uint8_t green{0};
  std::uint8_t blue{0};

  [[nodiscard]] constexpr auto operator==(const RgbColor&) const noexcept -> bool = default;
};

// Bounded client observation of the outer terminal. Missing values remain unspecified rather than
// being confused with black; palette presence is represented independently from RGB storage.
struct HostTerminalTheme final {
  [[nodiscard]] constexpr auto has_palette_color(const std::size_t index) const noexcept -> bool {
    return index < palette.size() &&
           (palette_mask & (std::uint16_t{1} << static_cast<unsigned>(index))) != 0;
  }
  constexpr void set_palette_color(const std::size_t index, const RgbColor color) noexcept {
    if (index >= palette.size()) {
      return;
    }
    std::span(palette).subspan(index, 1).front() = color;
    palette_mask |= std::uint16_t{1} << static_cast<unsigned>(index);
  }
  [[nodiscard]] constexpr auto empty() const noexcept -> bool {
    return !foreground.has_value() && !background.has_value() && palette_mask == 0;
  }

  std::optional<RgbColor> foreground;
  std::optional<RgbColor> background;
  std::array<RgbColor, 16> palette{};
  std::uint16_t palette_mask{0};

  [[nodiscard]] constexpr auto operator==(const HostTerminalTheme&) const noexcept
      -> bool = default;
};

enum class ControlCommand : std::uint8_t {
  create = 'N',
  create_with_context = 'C',
  list = 'L',
  list_session = 'Q',
  list_tabs = 'W',
  kill = 'K',
  kill_all = 'X',
  shutdown = 'S',
};

enum class ControlResponse : std::uint8_t {
  ready = 'Y',
  missing = 'M',
  capacity = 'C',
  failed = 'F',
};

enum class PaneCommand : std::uint8_t {
  none = 0,
  split_left_right = '%',
  split_top_bottom = '"',
  focus_left = 'L',
  focus_right = 'R',
  focus_up = 'U',
  focus_down = 'D',
  focus_next = 'o',
  focus_previous = ';',
  close = 'x',
  zoom = 'z',
  enter_copy_mode = '[',
  create_tab = 'c',
  next_tab = 'n',
  previous_tab = 'p',
  kill_tab = '&',
  select_tab_0 = '0',
  select_tab_1 = '1',
  select_tab_2 = '2',
  select_tab_3 = '3',
  select_tab_4 = '4',
  select_tab_5 = '5',
  select_tab_6 = '6',
  select_tab_7 = '7',
  select_tab_8 = '8',
  select_tab_9 = '9',
};

// Private attach protocol v2.0. Every envelope is exactly 16 bytes:
// magic[4], major, minor, kind, flags, payload_length:u32be, sequence:u32be.
struct ProtocolVersion final {
  std::uint8_t major{2};
  std::uint8_t minor{0};

  [[nodiscard]] constexpr auto operator==(const ProtocolVersion&) const noexcept -> bool = default;
};

inline constexpr ProtocolVersion current_version{};
inline constexpr std::array<std::byte, 4> attach_magic{std::byte{0x89}, std::byte{'L'},
                                                       std::byte{'M'}, std::byte{'A'}};
inline constexpr std::size_t attach_header_bytes = 16;
inline constexpr std::size_t render_generation_bytes = 4;
inline constexpr std::size_t render_ansi_bytes_max = limits::frame_chunk_bytes_max;
inline constexpr std::size_t render_payload_bytes_max =
    render_generation_bytes + render_ansi_bytes_max;
inline constexpr std::size_t diagnostic_bytes_max = 255;
inline constexpr std::size_t host_theme_palette_colors = 16;
inline constexpr std::size_t host_theme_palette_mask_bytes = 2;
inline constexpr std::size_t host_theme_wire_bytes =
    1U + host_theme_palette_mask_bytes + 6U + (host_theme_palette_colors * 3U);
inline constexpr std::size_t client_hello_payload_bytes_max =
    6U + host_theme_wire_bytes + session_name_bytes_max;
inline constexpr std::size_t small_message_bytes_max =
    attach_header_bytes + std::max(1U + diagnostic_bytes_max, client_hello_payload_bytes_max);
inline constexpr std::size_t client_decoder_bytes_max =
    attach_header_bytes + input_message_bytes_max;
inline constexpr std::size_t server_decoder_bytes_max =
    attach_header_bytes + render_payload_bytes_max;
inline constexpr std::uint8_t render_full_redraw_flag = 0x01;

static_assert(small_message_bytes_max >= attach_header_bytes + client_hello_payload_bytes_max);
static_assert(client_decoder_bytes_max < std::size_t{16} * 1'024U);
static_assert(server_decoder_bytes_max <= (std::size_t{4} * 1'024U * 1'024U) + 32U);

enum class MessageKind : std::uint8_t {
  hello = 1,
  input = 2,
  resize = 3,
  pane_command = 4,
  detach = 5,
  render_frame = 6,
  disconnect = 7,
  host_theme = 8,
};

enum class DisconnectReason : std::uint8_t {
  normal = 1,
  protocol_error = 2,
  version_mismatch = 3,
  session_busy = 4,
  session_missing = 5,
  capacity = 6,
  setup_failed = 7,
  frame_timeout = 8,
  daemon_shutdown = 9,
  internal_error = 10,
};

enum class ClientMessageKind : std::uint8_t {
  hello,
  input,
  resize,
  detach,
  pane_command,
  host_theme,
};

enum class ServerMessageKind : std::uint8_t {
  hello,
  render_frame,
  disconnect,
};

enum class DecodeError : std::uint8_t {
  invalid_magic,
  version_mismatch,
  invalid_kind,
  invalid_flags,
  invalid_length,
  oversized,
  invalid_sequence,
  invalid_enum,
  invalid_dimensions,
  invalid_session,
  invalid_generation,
  buffer_full,
  allocation_failed,
};

struct ClientMessage final {
  ClientMessageKind kind{ClientMessageKind::detach};
  Dimensions dimensions{};
  PaneCommand pane_command{PaneCommand::none};
  // Borrowed from ClientDecoder until consume() or reset().
  const HostTerminalTheme* host_theme{nullptr};
  std::string_view session;
  std::span<const std::byte> input;
  std::uint32_t sequence{0};
};

static_assert(sizeof(ClientMessage) <= 64U);

struct ServerMessage final {
  ServerMessageKind kind{ServerMessageKind::disconnect};
  Dimensions dimensions{};
  DisconnectReason reason{DisconnectReason::internal_error};
  std::string_view diagnostic;
  std::span<const std::byte> ansi;
  std::uint32_t sequence{0};
  std::uint32_t full_redraw_generation{0};
  bool full_redraw{false};
};

class SmallMessage final {
public:
  [[nodiscard]] auto bytes() const noexcept -> std::span<const std::byte> {
    return std::span(storage_).first(size_);
  }

private:
  friend auto encode_client_hello(std::string_view session, Dimensions dimensions,
                                  std::uint32_t sequence, ProtocolVersion version,
                                  const std::optional<HostTerminalTheme>& host_theme) noexcept
      -> SmallMessage;
  friend auto encode_daemon_hello(Dimensions dimensions, std::uint32_t sequence) noexcept
      -> SmallMessage;
  friend auto encode_resize(Dimensions dimensions, std::uint32_t sequence) noexcept -> SmallMessage;
  friend auto encode_detach(std::uint32_t sequence) noexcept -> SmallMessage;
  friend auto encode_pane_command(PaneCommand command, std::uint32_t sequence) noexcept
      -> SmallMessage;
  friend auto encode_host_theme_update(const HostTerminalTheme& theme,
                                       std::uint32_t sequence) noexcept -> SmallMessage;
  friend auto encode_disconnect(DisconnectReason reason, std::string_view diagnostic,
                                std::uint32_t sequence) noexcept -> SmallMessage;

  std::array<std::byte, small_message_bytes_max> storage_{};
  std::size_t size_{0};
};

[[nodiscard]] constexpr auto wire_byte(const ControlCommand command) noexcept -> std::byte {
  return static_cast<std::byte>(command);
}

[[nodiscard]] constexpr auto wire_byte(const ControlResponse response) noexcept -> std::byte {
  return static_cast<std::byte>(response);
}

[[nodiscard]] auto encode_session_header(ControlCommand command, std::string_view session) noexcept
    -> std::array<std::byte, 2>;
[[nodiscard]] auto encode_dimensions(Dimensions dimensions) noexcept -> std::array<std::byte, 4>;
[[nodiscard]] auto encode_bounded_size(std::size_t size) noexcept -> std::array<std::byte, 2>;
[[nodiscard]] auto decode_dimensions(std::span<const std::byte, 4> bytes) noexcept -> Dimensions;
[[nodiscard]] auto decode_bounded_size(std::span<const std::byte, 2> bytes) noexcept -> std::size_t;
[[nodiscard]] constexpr auto decode_session_name_size(const std::byte value) noexcept
    -> std::size_t {
  return std::to_integer<std::size_t>(value);
}

[[nodiscard]] auto encode_header(MessageKind kind, std::uint8_t flags, std::uint32_t payload_bytes,
                                 std::uint32_t sequence,
                                 ProtocolVersion version = current_version) noexcept
    -> std::array<std::byte, attach_header_bytes>;
[[nodiscard]] auto
encode_client_hello(std::string_view session, Dimensions dimensions, std::uint32_t sequence = 1,
                    ProtocolVersion version = current_version,
                    const std::optional<HostTerminalTheme>& host_theme = std::nullopt) noexcept
    -> SmallMessage;
[[nodiscard]] auto encode_daemon_hello(Dimensions dimensions, std::uint32_t sequence = 1) noexcept
    -> SmallMessage;
[[nodiscard]] auto encode_input_header(std::size_t bytes, std::uint32_t sequence) noexcept
    -> std::array<std::byte, attach_header_bytes>;
[[nodiscard]] auto encode_resize(Dimensions dimensions, std::uint32_t sequence) noexcept
    -> SmallMessage;
[[nodiscard]] auto encode_detach(std::uint32_t sequence) noexcept -> SmallMessage;
[[nodiscard]] auto encode_pane_command(PaneCommand command, std::uint32_t sequence) noexcept
    -> SmallMessage;
[[nodiscard]] auto encode_host_theme_update(const HostTerminalTheme& theme,
                                            std::uint32_t sequence) noexcept -> SmallMessage;
[[nodiscard]] auto encode_render_frame_header(std::size_t ansi_bytes, std::uint32_t sequence,
                                              std::uint32_t full_redraw_generation,
                                              bool full_redraw) noexcept
    -> std::array<std::byte, attach_header_bytes + render_generation_bytes>;
[[nodiscard]] auto encode_disconnect(DisconnectReason reason, std::string_view diagnostic,
                                     std::uint32_t sequence = 1) noexcept -> SmallMessage;
[[nodiscard]] auto decode_error_diagnostic(DecodeError error) noexcept -> std::string_view;

struct PrefixAction final {
  std::size_t input_bytes{0};
  PaneCommand command{PaneCommand::none};
};

struct PrefixResult final {
  std::array<PrefixAction, prefix_actions_max> actions{};
  std::size_t bytes{0};
  std::size_t action_count{0};
  bool detach{false};
};

class PrefixParser final {
public:
  [[nodiscard]] auto parse(std::span<const std::byte> input, std::span<std::byte> output) noexcept
      -> PrefixResult;
  [[nodiscard]] auto has_pending_input() const noexcept -> bool;
  [[nodiscard]] auto has_pending_escape_sequence() const noexcept -> bool;
  [[nodiscard]] auto flush_pending(std::span<std::byte> output) noexcept -> std::size_t;

private:
  enum class State : std::uint8_t {
    normal,
    prefix,
    escape,
    csi,
  };

  State state_{State::normal};
  std::byte escape_introducer_{'['};
};

// Daemon-side incremental decoder. Returned payload views borrow storage until consume() or
// reset().
class ClientDecoder final {
public:
  [[nodiscard]] auto writable_bytes() noexcept -> std::span<std::byte>;
  [[nodiscard]] auto commit(std::size_t bytes) noexcept -> std::expected<void, DecodeError>;
  [[nodiscard]] auto next() noexcept -> std::expected<std::optional<ClientMessage>, DecodeError>;
  void consume() noexcept;
  void reset(std::uint32_t expected_sequence = 1, bool expect_hello = true) noexcept;

private:
  std::array<std::byte, client_decoder_bytes_max> storage_{};
  HostTerminalTheme host_theme_{};
  std::size_t used_{0};
  std::size_t pending_size_{0};
  std::uint32_t expected_sequence_{1};
  bool expect_hello_{true};
};

// Attached-client incremental decoder. Its one bounded RAII allocation is prepared before terminal
// mutation; render payloads borrow it until consume() or reset().
class ServerDecoder final {
public:
  ServerDecoder() = default;
  ServerDecoder(const ServerDecoder&) = delete;
  auto operator=(const ServerDecoder&) -> ServerDecoder& = delete;
  ServerDecoder(ServerDecoder&&) = delete;
  auto operator=(ServerDecoder&&) -> ServerDecoder& = delete;
  ~ServerDecoder() = default;

  [[nodiscard]] auto prepare() noexcept -> std::expected<void, DecodeError>;
  [[nodiscard]] auto writable_bytes() noexcept -> std::span<std::byte>;
  [[nodiscard]] auto commit(std::size_t bytes) noexcept -> std::expected<void, DecodeError>;
  [[nodiscard]] auto next() noexcept -> std::expected<std::optional<ServerMessage>, DecodeError>;
  void consume() noexcept;
  void reset(std::uint32_t expected_sequence = 1, bool expect_hello = true) noexcept;

private:
  // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
  std::unique_ptr<std::byte[]> storage_;
  std::size_t used_{0};
  std::size_t pending_size_{0};
  std::uint32_t expected_sequence_{1};
  std::uint32_t full_redraw_generation_{0};
  std::uint32_t pending_generation_{0};
  bool pending_full_redraw_{false};
  bool expect_hello_{true};
};

} // namespace lemma::protocol

#endif // LEMMA_PROTOCOL_SINGLE_PANE_HPP
