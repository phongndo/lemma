#ifndef LEMMA_PROTOCOL_SINGLE_PANE_HPP
#define LEMMA_PROTOCOL_SINGLE_PANE_HPP

#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <optional>
#include <span>
#include <string_view>

namespace lemma::protocol {

inline constexpr std::size_t input_bytes_max = std::size_t{4} * 1'024U;
inline constexpr std::size_t parser_bytes_max = std::size_t{16} * 1'024U;
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
};

enum class ControlCommand : std::uint8_t {
  attach = 'A',
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
  busy = 'B',
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

enum class ClientMessageKind : std::uint8_t {
  input,
  resize,
  detach,
  pane_command,
};

enum class DecodeError : std::uint8_t {
  invalid_type,
  input_too_large,
  buffer_full,
};

struct ClientMessage final {
  ClientMessageKind kind{ClientMessageKind::detach};
  Dimensions dimensions{};
  PaneCommand pane_command{PaneCommand::none};
  std::span<const std::byte> input;
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
[[nodiscard]] auto encode_resize(Dimensions dimensions) noexcept -> std::array<std::byte, 5>;
[[nodiscard]] auto encode_input_header(std::size_t bytes) noexcept -> std::array<std::byte, 3>;
[[nodiscard]] auto encode_detach() noexcept -> std::array<std::byte, 1>;
[[nodiscard]] auto encode_pane_command(PaneCommand command) noexcept -> std::array<std::byte, 2>;
[[nodiscard]] auto decode_dimensions(std::span<const std::byte, 4> bytes) noexcept -> Dimensions;
[[nodiscard]] auto decode_bounded_size(std::span<const std::byte, 2> bytes) noexcept -> std::size_t;
[[nodiscard]] constexpr auto decode_session_name_size(const std::byte value) noexcept
    -> std::size_t {
  return std::to_integer<std::size_t>(value);
}

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

// Incremental decoder for the attached-client stream. A returned message borrows decoder storage
// and remains valid until consume() or reset().
class ClientDecoder final {
public:
  [[nodiscard]] auto writable_bytes() noexcept -> std::span<std::byte>;
  [[nodiscard]] auto commit(std::size_t bytes) noexcept -> std::expected<void, DecodeError>;
  [[nodiscard]] auto next() noexcept -> std::expected<std::optional<ClientMessage>, DecodeError>;
  void consume() noexcept;
  void reset() noexcept;

private:
  std::array<std::byte, parser_bytes_max> storage_{};
  std::size_t used_{0};
  std::size_t pending_size_{0};
};

} // namespace lemma::protocol

#endif // LEMMA_PROTOCOL_SINGLE_PANE_HPP
