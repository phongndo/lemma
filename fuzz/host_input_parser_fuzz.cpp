#include "client/host_input_parser.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>

// libFuzzer owns this ABI name.
// NOLINTNEXTLINE(readability-identifier-naming)
extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size);

// NOLINTNEXTLINE(readability-identifier-naming)
extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* const data, const std::size_t size) {
  if (data == nullptr || size < 3 || size > lemma::protocol::input_message_bytes_max) {
    return 0;
  }
  lemma::client::HostInputParser parser;
  if (!parser.prepare().has_value()) {
    return 0;
  }
  // Runtime-sized bounded fuzz output cannot use std::array.
  // NOLINTBEGIN(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
  auto output =
      std::make_unique_for_overwrite<std::byte[]>(lemma::client::host_input_output_bytes_max);
  // NOLINTEND(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
  const auto source = std::span(data, size);
  const auto input = std::as_bytes(source);
  const auto chunk_max = 1U + (static_cast<std::size_t>(source.front()) % 128U);
  const lemma::protocol::Dimensions geometry{
      .columns = static_cast<std::uint16_t>(1U + (source.subspan(1, 1).front() % 250U)),
      .rows = static_cast<std::uint16_t>(1U + (source.subspan(2, 1).front() % 100U)),
  };
  std::size_t offset = 3;
  while (offset < input.size()) {
    const auto copied = std::min(chunk_max, input.size() - offset);
    const auto parsed =
        parser.parse(input.subspan(offset, copied),
                     std::span(output.get(), lemma::client::host_input_output_bytes_max), geometry);
    if (!parsed.has_value()) {
      return 0;
    }
    offset += copied;
  }
  [[maybe_unused]] const auto flushed =
      parser.flush_pending(std::span(output.get(), lemma::client::host_input_output_bytes_max));
  return 0;
}
