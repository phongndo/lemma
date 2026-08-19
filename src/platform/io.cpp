#include "platform/io.hpp"

#include <array>
#include <cerrno>
#include <cstddef>
#include <cstring>
#include <span>
#include <string_view>

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

[[nodiscard]] auto send_descriptor(const int socket, const int descriptor) noexcept -> bool {
  if (socket < 0 || descriptor < 0) {
    return false;
  }
  std::byte sentinel{0xD7};
  iovec vector{.iov_base = &sentinel, .iov_len = 1};
  std::array<char, CMSG_SPACE(sizeof(int))> control{};
  msghdr message{
      .msg_iov = &vector,
      .msg_iovlen = 1,
      .msg_control = control.data(),
      .msg_controllen = control.size(),
  };
  auto* const header = CMSG_FIRSTHDR(&message);
  if (header == nullptr) {
    return false;
  }
  header->cmsg_level = SOL_SOCKET;
  header->cmsg_type = SCM_RIGHTS;
  header->cmsg_len = CMSG_LEN(sizeof(int));
  std::memcpy(CMSG_DATA(header), &descriptor, sizeof(descriptor));
  message.msg_controllen = header->cmsg_len;
  while (true) {
    const auto sent = ::sendmsg(socket, &message, MSG_NOSIGNAL);
    if (sent == 1) {
      return true;
    }
    if (sent < 0 && errno == EINTR) {
      continue;
    }
    return false;
  }
}

[[nodiscard]] auto receive_descriptor(const int socket, int& descriptor) noexcept
    -> ReceiveDescriptorStatus {
  descriptor = -1;
  std::byte sentinel{};
  iovec vector{.iov_base = &sentinel, .iov_len = 1};
  std::array<char, CMSG_SPACE(sizeof(int))> control{};
  msghdr message{
      .msg_iov = &vector,
      .msg_iovlen = 1,
      .msg_control = control.data(),
      .msg_controllen = control.size(),
  };
  ssize_t received = 0;
  do {
    received = ::recvmsg(socket, &message, 0);
  } while (received < 0 && errno == EINTR);
  if (received < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
    return ReceiveDescriptorStatus::would_block;
  }
  if (received == 0) {
    return ReceiveDescriptorStatus::closed;
  }
  if (received != 1 || sentinel != std::byte{0xD7} || (message.msg_flags & MSG_CTRUNC) != 0) {
    return ReceiveDescriptorStatus::error;
  }
  const auto* const header = CMSG_FIRSTHDR(&message);
  if (header == nullptr || CMSG_NXTHDR(&message, header) != nullptr ||
      header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS ||
      header->cmsg_len != CMSG_LEN(sizeof(int))) {
    return ReceiveDescriptorStatus::error;
  }
  std::memcpy(&descriptor, CMSG_DATA(header), sizeof(descriptor));
  if (descriptor < 0 || ::fcntl(descriptor, F_SETFD, FD_CLOEXEC) != 0) {
    close_descriptor(descriptor);
    return ReceiveDescriptorStatus::error;
  }
  return ReceiveDescriptorStatus::received;
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
