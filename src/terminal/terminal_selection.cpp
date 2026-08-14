#include "terminal/terminal_impl.hpp"

#include "lemma/assert.hpp"
#include "lemma/terminal/terminal.hpp"

#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

namespace lemma::vt {
namespace {

[[nodiscard]] auto formatter_format(const ScreenFormat format) noexcept -> GhosttyFormatterFormat {
  switch (format) {
  case ScreenFormat::plain:
    return GHOSTTY_FORMATTER_FORMAT_PLAIN;
  case ScreenFormat::vt:
  case ScreenFormat::vt_full:
    return GHOSTTY_FORMATTER_FORMAT_VT;
  }
  return GHOSTTY_FORMATTER_FORMAT_PLAIN;
}

} // namespace

auto Terminal::format_screen(const ScreenFormat format, const std::span<std::byte> output) noexcept
    -> std::expected<std::size_t, Error> {
  LEMMA_ASSERT(impl_ != nullptr);
  LEMMA_ASSERT(impl_->terminal != nullptr);

  GhosttyFormatterTerminalOptions options{};
  options.size = sizeof(options);
  options.emit = formatter_format(format);
  options.trim = format != ScreenFormat::vt_full;
  options.extra.size = sizeof(options.extra);
  options.extra.screen.size = sizeof(options.extra.screen);
  const bool styled = format != ScreenFormat::plain;
  options.extra.screen.cursor = styled;
  options.extra.screen.style = styled;
  options.extra.screen.hyperlink = styled;

  GhosttyFormatter formatter = nullptr;
  auto result = ghostty_formatter_terminal_new(impl_->allocator.native(), &formatter,
                                               impl_->terminal, options);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }

  // std::byte and uint8_t are both byte views; Ghostty's C ABI uses the latter.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  auto* output_data = reinterpret_cast<std::uint8_t*>(output.data());
  std::size_t bytes_written = 0;
  result = ghostty_formatter_format_buf(formatter, output_data, output.size(), &bytes_written);
  ghostty_formatter_free(formatter);
  if (result != GHOSTTY_SUCCESS) {
    return std::unexpected(detail::map_error(result));
  }
  LEMMA_ASSERT(bytes_written <= output.size());
  return bytes_written;
}

} // namespace lemma::vt
