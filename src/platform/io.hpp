#ifndef LEMMA_PLATFORM_IO_HPP
#define LEMMA_PLATFORM_IO_HPP

#include <cstddef>
#include <span>
#include <string_view>

namespace lemma::platform {

enum class ReceiveDescriptorStatus : unsigned char {
  received,
  would_block,
  closed,
  error,
};

// Blocking completion helpers. Use only at setup/control boundaries or with descriptors whose
// readiness has already been established. Hot-path output uses explicit partial-write state.
[[nodiscard]] auto write_all(int descriptor, std::span<const std::byte> bytes) noexcept -> bool;
[[nodiscard]] auto send_all(int socket, std::span<const std::byte> bytes) noexcept -> bool;
[[nodiscard]] auto read_exact(int socket, std::span<std::byte> output) noexcept -> bool;
[[nodiscard]] auto send_descriptor(int socket, int descriptor) noexcept -> bool;
[[nodiscard]] auto receive_descriptor(int socket, int& descriptor) noexcept
    -> ReceiveDescriptorStatus;
[[nodiscard]] auto write_text(int descriptor, std::string_view text) noexcept -> bool;
[[nodiscard]] auto send_text(int socket, std::string_view text) noexcept -> bool;

void close_descriptor(int& descriptor) noexcept;
[[nodiscard]] auto set_nonblocking(int descriptor) noexcept -> bool;

} // namespace lemma::platform

#endif // LEMMA_PLATFORM_IO_HPP
