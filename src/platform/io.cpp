#include "platform/io.hpp"

#include <cerrno>

#include <fcntl.h>
#include <sys/socket.h>
#include <unistd.h>

namespace lemma::platform {

[[nodiscard]] auto write_all(const int descriptor, const std::span<const std::byte> bytes) noexcept
    -> bool {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const auto result = ::write(descriptor, bytes.subspan(offset).data(), bytes.size() - offset);
    if (result > 0) {
      offset += static_cast<std::size_t>(result);
      continue;
    }
    if (result < 0 && errno == EINTR) {
      continue;
    }
    return false;
  }
  return true;
}

[[nodiscard]] auto send_all(const int socket, const std::span<const std::byte> bytes) noexcept
    -> bool {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const auto result =
        ::send(socket, bytes.subspan(offset).data(), bytes.size() - offset, MSG_NOSIGNAL);
    if (result > 0) {
      offset += static_cast<std::size_t>(result);
      continue;
    }
    if (result < 0 && errno == EINTR) {
      continue;
    }
    return false;
  }
  return true;
}

[[nodiscard]] auto read_exact(const int socket, const std::span<std::byte> output) noexcept
    -> bool {
  std::size_t offset = 0;
  while (offset < output.size()) {
    const auto result = ::recv(socket, output.subspan(offset).data(), output.size() - offset, 0);
    if (result > 0) {
      offset += static_cast<std::size_t>(result);
      continue;
    }
    if (result < 0 && errno == EINTR) {
      continue;
    }
    return false;
  }
  return true;
}

[[nodiscard]] auto write_text(const int descriptor, const std::string_view text) noexcept -> bool {
  return write_all(descriptor, std::as_bytes(std::span(text.data(), text.size())));
}

[[nodiscard]] auto send_text(const int socket, const std::string_view text) noexcept -> bool {
  return send_all(socket, std::as_bytes(std::span(text.data(), text.size())));
}

void close_descriptor(int& descriptor) noexcept {
  if (descriptor >= 0) {
    static_cast<void>(::close(descriptor));
    descriptor = -1;
  }
}

[[nodiscard]] auto set_nonblocking(const int descriptor) noexcept -> bool {
  // fcntl is variadic because its third argument depends on the command.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const auto flags = ::fcntl(descriptor, F_GETFL, 0);
  if (flags < 0) {
    return false;
  }
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  return ::fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0;
}

} // namespace lemma::platform
