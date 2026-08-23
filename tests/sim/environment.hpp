#ifndef LEMMA_TESTS_SIM_ENVIRONMENT_HPP
#define LEMMA_TESTS_SIM_ENVIRONMENT_HPP

#include <cerrno>
#include <cstdint>
#include <cstdlib>

namespace lemma::test::sim {

[[nodiscard]] inline auto environment_u64(const char* const name, std::uint64_t& value) noexcept
    -> bool {
  const auto* const text = std::getenv(name);
  if (text == nullptr) {
    return true;
  }
  errno = 0;
  char* end = nullptr;
  const auto parsed = std::strtoull(text, &end, 0);
  if (errno != 0 || end == text || *end != '\0') {
    return false;
  }
  value = parsed;
  return true;
}

} // namespace lemma::test::sim

#endif // LEMMA_TESTS_SIM_ENVIRONMENT_HPP
