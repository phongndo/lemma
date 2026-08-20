#ifndef LEMMA_APP_PROCEDURE_HPP
#define LEMMA_APP_PROCEDURE_HPP

#include "daemon/server.hpp"

#include <string_view>

namespace lemma::app {

// Parses and executes one bounded, versioned JSON action procedure from FILE or stdin ("-").
[[nodiscard]] auto run_procedure(const daemon::RuntimeEndpoint& endpoint, std::string_view source)
    -> int;

} // namespace lemma::app

#endif // LEMMA_APP_PROCEDURE_HPP
