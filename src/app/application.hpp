#ifndef FIBER_APP_APPLICATION_HPP
#define FIBER_APP_APPLICATION_HPP

#include "daemon/server.hpp"

namespace fiber::app {

// Owns command-line parsing and dispatch. Process main selects the production endpoint; test
// drivers inject a fixture-owned endpoint while exercising the same parser and components.
[[nodiscard]] auto run(const daemon::RuntimeEndpoint& endpoint, int argument_count,
                       char** argument_values) -> int;

} // namespace fiber::app

#endif // FIBER_APP_APPLICATION_HPP
