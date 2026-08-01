#ifndef LEMMA_ASSERT_HPP
#define LEMMA_ASSERT_HPP

#include <source_location>

namespace lemma {

[[noreturn]] void
assertion_failed(const char* expression,
                 std::source_location location = std::source_location::current()) noexcept;

} // namespace lemma

#define LEMMA_ASSERT(expression)                                                                   \
  (static_cast<bool>(expression)                                                                   \
       ? static_cast<void>(0)                                                                      \
       : ::lemma::assertion_failed(#expression, std::source_location::current()))

#endif // LEMMA_ASSERT_HPP
