#include "lemma/terminal/terminal.hpp"

#include <gtest/gtest.h>

#include <string_view>

namespace lemma::vt {
namespace {

TEST(GhosttyDependencyIntegrityTest, PinnedBuildInfoMatchesProductionContract) {
  const auto info = library_build_info();
  ASSERT_TRUE(info.has_value());
  // Ghostty exposes UTF-8 as uint8_t while string_view uses char.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view version(reinterpret_cast<const char*>(info->version.data()),
                                 info->version.size());

  EXPECT_EQ(version, "0.1.0-dev");
  EXPECT_EQ(library_version().size(), info->version.size());
  EXPECT_TRUE(info->simd);
  EXPECT_TRUE(info->kitty_graphics);
  EXPECT_FALSE(info->tmux_control_mode);
  // Construction checks the exact PIN.json-derived optimization and capability contract. C++
  // NDEBUG is not an authority for the dependency profile (Debug and Dev use ReleaseSafe).
  EXPECT_TRUE(Terminal::create({}).has_value());
}

} // namespace
} // namespace lemma::vt
