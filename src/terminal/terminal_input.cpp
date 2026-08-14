#include "terminal/terminal_impl.hpp"

#include "lemma/assert.hpp"
#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

namespace lemma::vt {
namespace {

[[nodiscard]] constexpr auto ghostty_key_action(const KeyAction action) noexcept
    -> GhosttyKeyAction {
  switch (action) {
  case KeyAction::release:
    return GHOSTTY_KEY_ACTION_RELEASE;
  case KeyAction::press:
    return GHOSTTY_KEY_ACTION_PRESS;
  case KeyAction::repeat:
    return GHOSTTY_KEY_ACTION_REPEAT;
  }
  return GHOSTTY_KEY_ACTION_PRESS;
}

[[nodiscard]] auto ghostty_key(const Key key) noexcept -> GhosttyKey {
  constexpr std::array mapping{
      GHOSTTY_KEY_UNIDENTIFIED,
      GHOSTTY_KEY_A,
      GHOSTTY_KEY_B,
      GHOSTTY_KEY_C,
      GHOSTTY_KEY_D,
      GHOSTTY_KEY_E,
      GHOSTTY_KEY_F,
      GHOSTTY_KEY_G,
      GHOSTTY_KEY_H,
      GHOSTTY_KEY_I,
      GHOSTTY_KEY_J,
      GHOSTTY_KEY_K,
      GHOSTTY_KEY_L,
      GHOSTTY_KEY_M,
      GHOSTTY_KEY_N,
      GHOSTTY_KEY_O,
      GHOSTTY_KEY_P,
      GHOSTTY_KEY_Q,
      GHOSTTY_KEY_R,
      GHOSTTY_KEY_S,
      GHOSTTY_KEY_T,
      GHOSTTY_KEY_U,
      GHOSTTY_KEY_V,
      GHOSTTY_KEY_W,
      GHOSTTY_KEY_X,
      GHOSTTY_KEY_Y,
      GHOSTTY_KEY_Z,
      GHOSTTY_KEY_ENTER,
      GHOSTTY_KEY_TAB,
      GHOSTTY_KEY_BACKSPACE,
      GHOSTTY_KEY_ESCAPE,
      GHOSTTY_KEY_SPACE,
      GHOSTTY_KEY_ARROW_UP,
      GHOSTTY_KEY_ARROW_DOWN,
      GHOSTTY_KEY_ARROW_LEFT,
      GHOSTTY_KEY_ARROW_RIGHT,
      GHOSTTY_KEY_HOME,
      GHOSTTY_KEY_END,
      GHOSTTY_KEY_INSERT,
      GHOSTTY_KEY_DELETE,
      GHOSTTY_KEY_PAGE_UP,
      GHOSTTY_KEY_PAGE_DOWN,
      GHOSTTY_KEY_F1,
      GHOSTTY_KEY_F2,
      GHOSTTY_KEY_F3,
      GHOSTTY_KEY_F4,
      GHOSTTY_KEY_F5,
      GHOSTTY_KEY_F6,
      GHOSTTY_KEY_F7,
      GHOSTTY_KEY_F8,
      GHOSTTY_KEY_F9,
      GHOSTTY_KEY_F10,
      GHOSTTY_KEY_F11,
      GHOSTTY_KEY_F12,
  };
  static_assert(static_cast<std::size_t>(Key::f12) + 1U == mapping.size());
  const auto index = static_cast<std::size_t>(key);
  return index < mapping.size() ? std::span(mapping).subspan(index, 1).front()
                                : GHOSTTY_KEY_UNIDENTIFIED;
}

} // namespace

auto Terminal::encode_key(const KeyEvent& event, const std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  LEMMA_ASSERT(impl_->key_encoder != nullptr);
  LEMMA_ASSERT(impl_->key_event != nullptr);

  constexpr std::uint16_t modifiers_valid =
      key_modifier_shift | key_modifier_control | key_modifier_alt | key_modifier_super;
  if ((event.modifiers & ~modifiers_valid) != 0 ||
      (event.consumed_modifiers & ~modifiers_valid) != 0 || event.text.size() > 256) {
    return std::unexpected(Error::invalid_options);
  }

  ghostty_key_encoder_setopt_from_terminal(impl_->key_encoder, impl_->terminal);
  ghostty_key_event_set_action(impl_->key_event, ghostty_key_action(event.action));
  ghostty_key_event_set_key(impl_->key_event, ghostty_key(event.key));
  ghostty_key_event_set_mods(impl_->key_event, static_cast<GhosttyMods>(event.modifiers));
  ghostty_key_event_set_consumed_mods(impl_->key_event,
                                      static_cast<GhosttyMods>(event.consumed_modifiers));
  ghostty_key_event_set_composing(impl_->key_event, event.composing);
  ghostty_key_event_set_unshifted_codepoint(impl_->key_event, event.unshifted_codepoint);
  ghostty_key_event_set_utf8(impl_->key_event, event.text.data(), event.text.size());

  // std::byte and char are both byte views; Ghostty's C ABI uses the latter.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  auto* encoded = reinterpret_cast<char*>(output.data());
  std::size_t bytes_written = 0;
  const auto result = ghostty_key_encoder_encode(impl_->key_encoder, impl_->key_event, encoded,
                                                 output.size(), &bytes_written);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  LEMMA_ASSERT(bytes_written <= output.size());
  return bytes_written;
}

auto Terminal::encode_paste(const std::span<std::byte> input,
                            const std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  if (input.size() > limits::paste_payload_bytes_max) {
    return std::unexpected(Error::limit_exceeded);
  }

  GhosttyTerminalModeConfig bracketed{
      .mode = GHOSTTY_MODE_BRACKETED_PASTE,
      .value = false,
  };
  auto result = ghostty_terminal_get(impl_->terminal, GHOSTTY_TERMINAL_DATA_MODE, &bracketed);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }

  // std::byte and char are both byte views; Ghostty's C ABI uses the latter.
  // NOLINTBEGIN(cppcoreguidelines-pro-type-reinterpret-cast)
  auto* const input_data = reinterpret_cast<char*>(input.data());
  auto* const output_data = reinterpret_cast<char*>(output.data());
  // NOLINTEND(cppcoreguidelines-pro-type-reinterpret-cast)
  std::size_t bytes_written = 0;
  result = ghostty_paste_encode(input_data, input.size(), bracketed.value, output_data,
                                output.size(), &bytes_written);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  LEMMA_ASSERT(bytes_written <= output.size());
  return bytes_written;
}

[[nodiscard]] auto Terminal::paste_is_safe(const std::span<const std::byte> input) const noexcept
    -> bool {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  if (input.size() > limits::paste_payload_bytes_max) {
    return false;
  }
  // std::byte and char are both byte views; Ghostty's C ABI uses the latter.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const auto* const data = reinterpret_cast<const char*>(input.data());
  return ghostty_paste_is_safe(data, input.size());
}

[[nodiscard]] auto Terminal::synchronized_output() const noexcept -> std::expected<bool, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  GhosttyTerminalModeConfig synchronized{
      .mode = GHOSTTY_MODE_SYNC_OUTPUT,
      .value = false,
  };
  const auto result =
      ghostty_terminal_get(impl_->terminal, GHOSTTY_TERMINAL_DATA_MODE, &synchronized);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  return synchronized.value;
}

} // namespace lemma::vt
