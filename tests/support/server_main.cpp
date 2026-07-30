#include "daemon/server.hpp"

#include <span>
#include <string_view>

int main(const int argc, char** argv) {
  const std::span arguments(argv, static_cast<std::size_t>(argc));
  if (arguments.size() != 2) {
    return 2;
  }
  const auto endpoint = fiber::daemon::RuntimeEndpoint::create(std::string_view(arguments.back()));
  if (!endpoint.has_value()) {
    return 2;
  }
  return fiber::daemon::serve(*endpoint, {.extensions_enabled = false});
}
