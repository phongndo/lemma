#include "lemma/lemma.hpp"

#include <gmock/gmock.h>
#include <gtest/gtest.h>

namespace lemma {
namespace {

TEST(LemmaTest, HasGreeting) { EXPECT_THAT(greeting(), testing::StrEq("Hello, world!")); }

TEST(LemmaTest, LinksThirdPartyGhosttyVt) { EXPECT_FALSE(ghostty_version().empty()); }

TEST(LemmaTest, LinksLuaConfigRuntime) { EXPECT_THAT(lua_version(), testing::HasSubstr("5.5")); }

TEST(LemmaTest, LinksZstd) { EXPECT_THAT(zstd_version(), testing::StrEq("1.5.7")); }

} // namespace
} // namespace lemma
