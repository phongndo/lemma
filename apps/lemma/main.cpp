#include "app/application.hpp"
#include "daemon/server.hpp"

int main(const int argc, char** argv) {
  const auto endpoint = lemma::daemon::default_runtime_endpoint();
  return lemma::app::run(endpoint, argc, argv);
}
