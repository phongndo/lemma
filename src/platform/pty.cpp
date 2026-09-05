#include "platform/pty.hpp"

#include "lemma/limits.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <iterator>
#include <limits>
#include <optional>
#include <span>
#include <string_view>

#include <pwd.h>
#include <sys/ioctl.h>
#include <unistd.h>

#ifdef __APPLE__
#include <crt_externs.h>
#include <libproc.h>
#elifdef __linux__
#include <charconv>
#include <system_error>

#include <fcntl.h>
#else
#error "lemma requires Linux or macOS PTYs"
#endif

namespace lemma::platform {
namespace {

[[nodiscard]] auto copy_process_name(const std::span<const char> source,
                                     const std::span<char> output) noexcept -> std::size_t {
  const auto terminator = std::ranges::find_if(source, [](const char character) {
    return character == '\0' || character == '\n' || character == '\r';
  });
  const auto available = static_cast<std::size_t>(std::distance(source.begin(), terminator));
  const auto size = std::min(available, output.size());
  std::ranges::copy(source.first(size), output.begin());
  return size;
}

[[nodiscard]] auto process_environment() noexcept -> char** {
#ifdef __APPLE__
  return *_NSGetEnviron();
#elifdef __linux__
  return ::environ;
#endif
}

} // namespace

auto account_home_directory(const std::span<char> output) noexcept -> std::size_t {
  std::array<char, std::size_t{16} * 1'024U> account_buffer{};
  struct passwd account{};
  struct passwd* result = nullptr;
  if (::getpwuid_r(::getuid(), &account, account_buffer.data(), account_buffer.size(), &result) !=
          0 ||
      result == nullptr || account.pw_dir == nullptr) {
    return 0;
  }
  const std::string_view home(account.pw_dir);
  if (home.empty() || home.front() != '/' || home.size() >= output.size() || home.contains('\0')) {
    return 0;
  }
  std::ranges::copy(home, output.begin());
  return home.size();
}

auto capture_process_environment(const std::span<std::byte> output) noexcept
    -> std::optional<std::size_t> {
  std::size_t size = 0;
  std::size_t entries = 0;
  // POSIX exposes the process environment as a null-terminated pointer vector.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  for (char** entry = process_environment(); entry != nullptr && *entry != nullptr; ++entry) {
    const std::string_view value(*entry);
    if (value.size() + 1U > output.size() - size || entries == limits::environment_entries_max) {
      return std::nullopt;
    }
    std::ranges::copy(std::as_bytes(std::span(value.data(), value.size())),
                      output.subspan(size).begin());
    size += value.size();
    output.subspan(size, 1).front() = std::byte{0};
    ++size;
    ++entries;
  }
  return size;
}

[[nodiscard]] auto foreground_process_name(const int pty_descriptor,
                                           const std::span<char> output) noexcept -> std::size_t {
  if (output.empty()) {
    return 0;
  }
  const auto foreground_group = ::tcgetpgrp(pty_descriptor);
  if (foreground_group <= 0) {
    return 0;
  }

#ifdef __APPLE__
  proc_bsdshortinfo information{};
  const auto bytes = ::proc_pidinfo(foreground_group, PROC_PIDT_SHORTBSDINFO, 0, &information,
                                    static_cast<int>(sizeof(information)));
  if (bytes < 0 || static_cast<std::size_t>(bytes) != sizeof(information)) {
    return 0;
  }
  return copy_process_name(information.pbsi_comm, output);
#elifdef __linux__
  std::array<char, 64> path{};
  constexpr std::string_view prefix = "/proc/";
  constexpr std::string_view suffix = "/comm";
  std::ranges::copy(prefix, path.begin());
  auto remaining = std::span(path).subspan(prefix.size());
  const auto encoded = std::to_chars(remaining.data(), path.end(), foreground_group);
  const auto digits = static_cast<std::size_t>(std::distance(remaining.data(), encoded.ptr));
  if (encoded.ec != std::errc{} || remaining.size() - digits <= suffix.size()) {
    return 0;
  }
  std::ranges::copy(suffix, remaining.subspan(digits).begin());
  // open is variadic only to accept a mode when creation flags require one.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const auto descriptor = ::open(path.data(), O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) {
    return 0;
  }
  std::array<char, 64> name{};
  const auto bytes = ::read(descriptor, name.data(), name.size());
  static_cast<void>(::close(descriptor));
  return bytes > 0
             ? copy_process_name(std::span(name).first(static_cast<std::size_t>(bytes)), output)
             : 0;
#endif
}

[[nodiscard]] constexpr auto window_pixels(const std::uint32_t cell_px,
                                           const std::uint16_t cells) noexcept -> unsigned short {
  if (cell_px == 0 || cells == 0) {
    return 0;
  }
  constexpr auto pixel_max = std::numeric_limits<unsigned short>::max();
  if (cell_px > static_cast<std::uint32_t>(pixel_max) / cells) {
    return pixel_max;
  }
  return static_cast<unsigned short>(cell_px * cells);
}

[[nodiscard]] auto resize_pty(const int pty_descriptor, const std::uint16_t columns,
                              const std::uint16_t rows, const std::uint32_t cell_width_px,
                              const std::uint32_t cell_height_px) noexcept -> bool {
  winsize native_size{
      .ws_row = rows,
      .ws_col = columns,
      .ws_xpixel = window_pixels(cell_width_px, columns),
      .ws_ypixel = window_pixels(cell_height_px, rows),
  };
  // ioctl is variadic because its third argument depends on the request.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  return ::ioctl(pty_descriptor, TIOCSWINSZ, &native_size) == 0;
}

} // namespace lemma::platform
