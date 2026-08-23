#include "api/action.hpp"
#include "api/json.hpp"

#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>

// libFuzzer owns this ABI name.
// NOLINTNEXTLINE(readability-identifier-naming)
extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size);

// NOLINTNEXTLINE(readability-identifier-naming)
extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* const data, const std::size_t size) {
  if (data == nullptr || size > lemma::api::json_bytes_max) {
    return 0;
  }
  // JSON is text but may contain arbitrary bytes; string_view retains embedded NULs for the parser.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::string_view input(reinterpret_cast<const char*>(data), size);
  auto parsed = lemma::api::parse_json(input);
  if (!parsed.value.has_value()) {
    return 0;
  }

  static_cast<void>(lemma::api::decode_action(*parsed.value));
  static_cast<void>(lemma::api::decode_event_subscription(*parsed.value));
  std::string encoded;
  if (!lemma::api::append_json_value(encoded, *parsed.value)) {
    return 0;
  }
  const auto round_trip = lemma::api::parse_json(encoded);
  if (!round_trip.value.has_value()) {
    __builtin_trap();
  }
  return 0;
}
