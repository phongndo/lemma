#ifndef LEMMA_PLATFORM_PTY_LAUNCH_HPP
#define LEMMA_PLATFORM_PTY_LAUNCH_HPP

#include <cstdint>
#include <string_view>
#include <type_traits>

namespace lemma::platform::pty_launch {

// A single-use setup record on an inherited socket, consumed before user code runs. There is no
// listener, request dispatcher, privilege boundary, or persistent helper process.
inline constexpr std::string_view executable = "lemma-pty-launcher";
inline constexpr int setup_descriptor = 3;
inline constexpr std::uint32_t signature = 0x4C505431; // LPT1
inline constexpr std::uint32_t inherited_environment = 1;
inline constexpr std::uint32_t invalid_setup = 2;

struct Header final {
  std::uint32_t magic{signature};
  std::uint32_t flags{0};
  std::uint32_t directory_bytes{0};
  std::uint32_t environment_bytes{0};
  std::uint32_t command_bytes{0};
  std::uint32_t overlay_bytes{0};
};

static_assert(sizeof(Header) == 24);
static_assert(std::is_trivially_copyable_v<Header>);

} // namespace lemma::platform::pty_launch

#endif // LEMMA_PLATFORM_PTY_LAUNCH_HPP
