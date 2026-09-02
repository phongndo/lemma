#include "config/config.hpp"
#include "extension/lua_host.hpp"
#include "input/input_router.hpp"
#include "platform/io.hpp"

#include <gtest/gtest.h>

#include <array>
#include <cstddef>
#include <span>
#include <string>
#include <string_view>
#include <variant>

#include <unistd.h>

namespace lemma::config {
namespace {

class TemporaryConfig final {
public:
  explicit TemporaryConfig(const std::string_view contents)
      : path_("/tmp/lemma-config-test-XXXXXX") {
    const auto descriptor = ::mkstemp(path_.data());
    if (descriptor >= 0) {
      valid_ = platform::write_text(descriptor, contents);
      static_cast<void>(::close(descriptor));
    }
  }

  TemporaryConfig(const TemporaryConfig&) = delete;
  auto operator=(const TemporaryConfig&) -> TemporaryConfig& = delete;
  TemporaryConfig(TemporaryConfig&&) = delete;
  auto operator=(TemporaryConfig&&) -> TemporaryConfig& = delete;
  ~TemporaryConfig() {
    if (!path_.empty()) {
      static_cast<void>(::unlink(path_.c_str()));
    }
  }

  [[nodiscard]] auto valid() const noexcept -> bool { return valid_; }
  [[nodiscard]] auto path() const noexcept -> std::string_view { return path_; }

private:
  std::string path_;
  bool valid_{false};
};

TEST(ConfigurationTest, ParsesCanonicalCommandChords) {
  EXPECT_EQ(parse_key("C-a"), input::InputChord::byte('a', input::key_modifier_control));
  EXPECT_EQ(parse_key("C-S-a"),
            input::InputChord::byte('a', input::key_modifier_control | input::key_modifier_shift));
  EXPECT_EQ(parse_key("S-a"), input::InputChord::byte('A'));
  EXPECT_EQ(parse_key("M-Left"),
            input::InputChord::key(input::PhysicalKey::arrow_left, input::key_modifier_alt));
  EXPECT_EQ(parse_key("Enter"), input::InputChord::byte(0x0DU));
  EXPECT_EQ(parse_key("Cmd-b"), input::InputChord::byte('b', input::key_modifier_super));
  EXPECT_FALSE(parse_key("C-").has_value());
  EXPECT_FALSE(parse_key("mouse-1").has_value());
}

TEST(ConfigurationTest, RoundTripsAndCompilesOneCompleteGeneration) {
  const auto prefix_chord = parse_key("C-a");
  const auto split_chord = parse_key("s");
  const auto removed_chord = parse_key("%");
  ASSERT_TRUE(prefix_chord.has_value());
  ASSERT_TRUE(split_chord.has_value());
  ASSERT_TRUE(removed_chord.has_value());
  Configuration source;
  ASSERT_TRUE(source.input.set_prefix(prefix_chord));
  source.terminal.scrollback_lines = 12'345;
  source.ui.status_line = false;
  source.launch.default_cwd = "/tmp";
  source.launch.default_program = {"/bin/sh", "-l"};
  source.history.file = "/tmp/lemma-history";
  ASSERT_TRUE(source.input.set(input::ConfiguredInputContext::prefix,
                               split_chord.value_or(input::InputChord{}),
                               input::InputCommand::split_left_right));
  ASSERT_TRUE(source.input.unbind(input::ConfiguredInputContext::prefix,
                                  removed_chord.value_or(input::InputChord{})));

  const auto document = encode(source);
  ASSERT_TRUE(document.has_value());
  const auto encoded = document.value_or(std::string{});
  EXPECT_NE(encoded.find(R"("contexts")"), std::string::npos);
  EXPECT_NE(encoded.find(R"("kind":"push")"), std::string::npos);
  EXPECT_EQ(encoded.find(R"("modes")"), std::string::npos);
  const auto decoded = decode(encoded);
  ASSERT_TRUE(decoded.configuration.has_value());
  const auto compiled = compile(decoded.configuration.value_or(Configuration{}));
  ASSERT_TRUE(compiled.has_value());
  EXPECT_EQ(compiled->scrollback_lines(), 12'345U);
  EXPECT_FALSE(compiled->status_line());
  EXPECT_EQ(compiled->default_cwd(), "/tmp");
  EXPECT_FALSE(compiled->default_program().empty());
  EXPECT_EQ(compiled->history_file(), "/tmp/lemma-history");

  input::InputRouter router(compiled->input_map());
  constexpr std::array prefix{std::byte{0x01}};
  constexpr std::array split{std::byte{'s'}};
  EXPECT_TRUE(std::holds_alternative<input::ConsumedInput>(
      router.route_legacy(prefix, prefix.size()).effect));
  const auto routed = router.route_legacy(split, split.size());
  ASSERT_NE(std::get_if<input::RoutedCommand>(&routed.effect), nullptr);
  EXPECT_EQ(std::get<input::RoutedCommand>(routed.effect).command,
            input::InputCommand::split_left_right);
}

TEST(ConfigurationTest, RejectsMalformedOrUnpublishableDocuments) {
  const auto malformed = decode(R"({"schema":"lemma.config/v1"})");
  EXPECT_FALSE(malformed.configuration.has_value());

  Configuration invalid_prefix;
  ASSERT_TRUE(invalid_prefix.input.set_prefix(
      input::InputChord{.code = 300, .modifiers = 0, .kind = input::ChordKind::byte}));
  const auto compiled = compile(invalid_prefix);
  ASSERT_FALSE(compiled.has_value());
  EXPECT_EQ(compiled.error(), Error::input_map);

  Configuration relative_history;
  relative_history.history.file = "relative/history";
  const auto invalid_history = compile(relative_history);
  ASSERT_FALSE(invalid_history.has_value());
  EXPECT_EQ(invalid_history.error(), Error::invalid_field);
}

TEST(ConfigurationHostTest, LoadsLuaInASeparateResidentProcess) {
  TemporaryConfig file(R"(
local lemma = require("lemma")
assert(lemma.mode == nil)
for _, key in ipairs({ "Space", "Enter", "Tab", "Backspace", "Escape" }) do
  assert(lemma.keymap.send(key))
end
lemma.setup({
  input = { prefix = "C-a" },
  terminal = { scrollback_lines = 12345 },
  ui = { status_line = false },
  launch = { default_cwd = "/tmp", default_program = { "/bin/sh", "-l" } },
  history = { file = "/tmp/lemma-history" },
})
lemma.context.set("resize", { label = " RESIZE ", lifetime = "persistent", unbound = "consume" })
lemma.keymap.set("prefix", "m", lemma.context.push("resize"))
lemma.keymap.set("resize", "q", lemma.context.pop())
lemma.keymap.set("normal", "Cmd-Left", lemma.keymap.send("Enter"))
lemma.keymap.set("prefix", "C-a", lemma.keymap.replay())
lemma.keymap.set("prefix", "s", "split_left_right")
lemma.keymap.del("prefix", "%")
)");
  ASSERT_TRUE(file.valid());

  auto loaded = extension::load_configuration(file.path());

  ASSERT_EQ(loaded.status, extension::ConfigurationStatus::loaded) << loaded.diagnostic;
  ASSERT_NE(loaded.generation, nullptr);
  EXPECT_TRUE(loaded.host.active());
  EXPECT_EQ(loaded.generation->scrollback_lines(), 12'345U);
  EXPECT_FALSE(loaded.generation->status_line());
  EXPECT_EQ(loaded.generation->default_cwd(), "/tmp");
  EXPECT_EQ(loaded.generation->history_file(), "/tmp/lemma-history");
  input::InputRouter router(loaded.generation->input_map());
  constexpr std::array input_bytes{std::byte{0x01}, std::byte{'s'}};
  EXPECT_TRUE(std::holds_alternative<input::ConsumedInput>(
      router.route_legacy(input_bytes, input_bytes.size()).effect));
  const auto command = router.route_legacy(std::span(input_bytes).subspan(1), 1);
  ASSERT_NE(std::get_if<input::RoutedCommand>(&command.effect), nullptr);
  EXPECT_EQ(std::get<input::RoutedCommand>(command.effect).command,
            input::InputCommand::split_left_right);

  router.reset();
  const input::KeyEvent command_left{.action = input::KeyAction::press,
                                     .key = input::PhysicalKey::arrow_left,
                                     .modifiers = input::key_modifier_super,
                                     .unshifted_codepoint = 0,
                                     .text = {}};
  const auto rewritten = router.route_key(command_left);
  ASSERT_NE(std::get_if<input::EncodeAsKey>(&rewritten.effect), nullptr);
  EXPECT_EQ(std::get<input::EncodeAsKey>(rewritten.effect).key, input::PhysicalKey::enter);
}

TEST(ConfigurationHostTest, RejectsTheWholeGenerationAfterALuaError) {
  TemporaryConfig file(R"(
local lemma = require("lemma")
lemma.setup({ unknown = {} })
)");
  ASSERT_TRUE(file.valid());

  auto loaded = extension::load_configuration(file.path());

  EXPECT_EQ(loaded.status, extension::ConfigurationStatus::invalid);
  EXPECT_EQ(loaded.generation, nullptr);
  EXPECT_FALSE(loaded.host.active());
  EXPECT_NE(loaded.diagnostic.find("unknown lemma.setup option"), std::string::npos);
}

} // namespace
} // namespace lemma::config
