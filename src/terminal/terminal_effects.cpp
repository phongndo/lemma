#include "terminal/terminal_impl.hpp"

#include "lemma/assert.hpp"
#include "lemma/terminal/terminal.hpp"

#include <cstddef>
#include <cstdint>
#include <expected>
#include <limits>
#include <span>
#include <string_view>

namespace lemma::vt {

void Terminal::Impl::write_pty([[maybe_unused]] GhosttyTerminal terminal_handle, void* userdata,
                               const std::uint8_t* data, const std::size_t length) noexcept {
  auto& impl = *static_cast<Impl*>(userdata);
  const auto bytes = std::as_bytes(std::span(data, length));
  if (!impl.pty_responses.append(bytes)) {
    impl.effects.pty_response_overflowed = true;
    impl.pty_response_integrity_failed = true;
  }
}

void Terminal::Impl::bell([[maybe_unused]] GhosttyTerminal terminal_handle,
                          void* userdata) noexcept {
  auto& impl = *static_cast<Impl*>(userdata);
  if (impl.effects.bells < std::numeric_limits<std::uint64_t>::max()) {
    ++impl.effects.bells;
  }
}

void Terminal::Impl::title_changed([[maybe_unused]] GhosttyTerminal terminal_handle,
                                   void* userdata) noexcept {
  auto& impl = *static_cast<Impl*>(userdata);
  if (impl.effects.title_changes < std::numeric_limits<std::uint64_t>::max()) {
    ++impl.effects.title_changes;
  }
}

auto Terminal::title() const noexcept -> std::expected<std::string_view, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  GhosttyString title{};
  const auto result = ghostty_terminal_get(impl_->terminal, GHOSTTY_TERMINAL_DATA_TITLE, &title);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  // Ghostty exposes UTF-8 as uint8_t while string_view uses char.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  return std::string_view(reinterpret_cast<const char*>(title.ptr), title.len);
}

auto Terminal::take_effects() noexcept -> EffectBatch {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  const auto effects = impl_->effects;
  impl_->effects = {};
  return effects;
}

auto Terminal::pending_pty_response_bytes() const noexcept -> std::size_t {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  return impl_->pty_responses.size();
}

auto Terminal::pty_response_overflowed() const noexcept -> bool {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  return impl_->pty_response_integrity_failed;
}

auto Terminal::read_pty_responses(const std::span<std::byte> output) noexcept -> std::size_t {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);
  return impl_->pty_responses.read(output);
}

} // namespace lemma::vt
