#include "app/application.hpp"
#include "daemon/server.hpp"

int main(const int argc, char** argv) {
  const auto endpoint = fiber::daemon::default_runtime_endpoint();
  return fiber::app::run(endpoint, argc, argv);
}
