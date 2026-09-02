#ifndef LEMMA_API_PROC_HPP
#define LEMMA_API_PROC_HPP

#include <cstddef>
#include <string_view>

namespace lemma::api {

inline constexpr std::string_view proc_schema = "lemma.proc/v1";
inline constexpr std::string_view proc_result_schema = "lemma.proc-result/v1";
inline constexpr std::size_t proc_operations_max = 64;

} // namespace lemma::api

#endif // LEMMA_API_PROC_HPP
