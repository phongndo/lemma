#include "app/application.hpp"
#include "daemon/server.hpp"

#include <cstddef>
#include <span>
#include <string_view>
#include <vector>

int main(const int argc, char** argv) {
  try {
    const std::span arguments(argv, static_cast<std::size_t>(argc));
    if (arguments.size() < 3) {
      return 2;
    }
    const auto endpoint =
        fiber::daemon::RuntimeEndpoint::create(std::string_view(arguments.subspan<1, 1>().front()));
    if (!endpoint.has_value()) {
      return 2;
    }

    std::vector<char*> app_arguments;
    app_arguments.reserve(arguments.size() - 1U);
    app_arguments.push_back(arguments.front());
    for (char* const argument : arguments.subspan(2)) {
      app_arguments.push_back(argument);
    }
    return fiber::app::run(*endpoint, static_cast<int>(app_arguments.size()), app_arguments.data());
  } catch (...) {
    return 2;
  }
}
