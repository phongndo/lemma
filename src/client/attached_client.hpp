#ifndef LEMMA_CLIENT_ATTACHED_CLIENT_HPP
#define LEMMA_CLIENT_ATTACHED_CLIENT_HPP

#include "daemon/server.hpp"

#include <string_view>

namespace lemma::client {

[[nodiscard]] auto attach(const daemon::RuntimeEndpoint& endpoint, std::string_view session) -> int;

} // namespace lemma::client

#endif // LEMMA_CLIENT_ATTACHED_CLIENT_HPP
