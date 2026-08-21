#ifndef LEMMA_API_SCHEMA_HPP
#define LEMMA_API_SCHEMA_HPP

#include <string_view>

namespace lemma::api {

[[nodiscard]] auto schema_document() noexcept -> std::string_view;

} // namespace lemma::api

#endif // LEMMA_API_SCHEMA_HPP
