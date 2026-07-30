#ifndef FIBER_CLIENT_ATTACHED_CLIENT_HPP
#define FIBER_CLIENT_ATTACHED_CLIENT_HPP

#include "daemon/server.hpp"

#include <string_view>

namespace fiber::client {

[[nodiscard]] auto attach(const daemon::RuntimeEndpoint& endpoint, std::string_view workspace)
    -> int;

} // namespace fiber::client

#endif // FIBER_CLIENT_ATTACHED_CLIENT_HPP
