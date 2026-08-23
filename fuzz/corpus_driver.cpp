#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <span>
#include <string>
#include <vector>

// libFuzzer owns this ABI name.
// NOLINTNEXTLINE(readability-identifier-naming)
extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size);

namespace {

constexpr std::size_t corpus_input_bytes_max = std::size_t{8} * 1'024U * 1'024U;

[[nodiscard]] auto run_file(const std::filesystem::path& path) -> bool {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    return false;
  }
  std::vector<std::uint8_t> bytes;
  try {
    bytes.assign(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
  } catch (...) {
    return false;
  }
  if (bytes.size() > corpus_input_bytes_max) {
    return false;
  }
  static_cast<void>(LLVMFuzzerTestOneInput(bytes.data(), bytes.size()));
  return true;
}

} // namespace

int main(const int argc, char** const argv) {
  try {
    bool ran = false;
    const auto arguments = std::span(argv, static_cast<std::size_t>(argc));
    for (std::size_t index = 1; index < arguments.size(); ++index) {
      const std::filesystem::path path(arguments.subspan(index, 1).front());
      if (std::filesystem::is_directory(path)) {
        for (const auto& entry : std::filesystem::directory_iterator(path)) {
          if (entry.is_regular_file()) {
            ran = run_file(entry.path()) || ran;
          }
        }
      } else {
        ran = run_file(path) || ran;
      }
    }
    return ran ? 0 : 2;
  } catch (...) {
    return 1;
  }
}
