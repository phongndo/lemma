#include "core/session.hpp"

#include "lemma/id.hpp"

#include <algorithm>
#include <cstddef>
#include <cstring>
#include <memory>
#include <span>
#include <string_view>
#include <utility>

namespace lemma::core {

Tab::Tab(const TabId assigned_id, std::unique_ptr<Pane> first_pane) noexcept : id(assigned_id) {
  const auto first_id = PaneId::from_parts(0, 1);
  first_pane->id = first_id;
  panes.front() = {.pane = std::move(first_pane), .generation = first_id.generation()};
  layout.front() = {.active = true, .leaf = true, .pane = first_id};
  focused_pane = first_id;
  previous_pane = first_id;
}

Session::Session(const std::string_view session_name,
                 const std::string_view initial_working_directory,
                 const std::span<const std::byte> initial_environment,
                 const LaunchEnvironmentMode initial_environment_mode) noexcept
    : name_size(session_name.size()), working_directory_size(initial_working_directory.size()),
      environment_size(initial_environment.size()), environment_mode(initial_environment_mode) {
  std::memcpy(name.data(), session_name.data(), session_name.size());
  if (!initial_working_directory.empty()) {
    std::memcpy(working_directory.data(), initial_working_directory.data(),
                initial_working_directory.size());
  }
  std::ranges::copy(initial_environment, environment.begin());
}

auto Session::session_name() const noexcept -> std::string_view { return {name.data(), name_size}; }

auto Session::cwd() const noexcept -> std::string_view {
  return {working_directory.data(), working_directory_size};
}

auto Session::launch_environment() const noexcept -> std::span<const std::byte> {
  return std::span(environment).first(environment_size);
}

} // namespace lemma::core
