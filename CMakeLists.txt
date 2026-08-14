cmake_minimum_required(VERSION 3.30)

project(lemma VERSION 0.1.0 LANGUAGES C CXX)

if(NOT CMAKE_CXX_COMPILER_ID MATCHES "^(AppleClang|Clang)$")
  message(FATAL_ERROR "lemma requires Clang or Apple Clang")
endif()

set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(LEMMA_BUILD_TESTS "Build the test suite" ON)
option(LEMMA_BUILD_BENCHMARKS "Build benchmarks" ON)
option(LEMMA_ENABLE_LATENCY_TRACE "Compile the opt-in key-to-visible diagnostic trace" OFF)

if(LEMMA_ENABLE_LATENCY_TRACE)
  add_compile_definitions(LEMMA_ENABLE_LATENCY_TRACE=1)
endif()

add_library(lemma_warnings INTERFACE)
target_compile_options(
  lemma_warnings
  INTERFACE
    -Wall
    -Wextra
    -Wpedantic
    -Werror
    -Wcast-align
    -Wcast-qual
    -Wconversion
    -Wdocumentation
    -Wdouble-promotion
    -Wextra-semi
    -Wformat=2
    -Wimplicit-fallthrough
    -Wmissing-declarations
    -Wnon-virtual-dtor
    -Wnull-dereference
    -Wold-style-cast
    -Woverloaded-virtual
    -Wshadow-all
    -Wsign-conversion
    -Wswitch-enum
    -Wthread-safety
    -Wundef
    -Wunreachable-code-aggressive
    -Wzero-as-null-pointer-constant
)

# Conan selects Linux's libstdc++ ABI with -stdlib=libstdc++. The Nix Clang wrapper reports the
# otherwise valid default-library selection as unused, so suppress that driver-only diagnostic.
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_compile_options(
    lemma_warnings
    INTERFACE -Wno-unused-command-line-argument
  )
endif()

# libghostty-vt remains pinned, private, and built without generated output in the submodule.
include(cmake/GhosttyVt.cmake)
lemma_add_pinned_ghostty()

find_package(lua CONFIG REQUIRED)
find_package(zstd CONFIG REQUIRED)

function(lemma_internal_target target)
  target_include_directories(
    ${target}
    PUBLIC
      "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
      "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src>"
  )
  target_link_libraries(${target} PRIVATE lemma_warnings)
endfunction()

add_library(lemma_base STATIC src/core/assert.cpp)
lemma_internal_target(lemma_base)

add_library(lemma_diagnostic STATIC src/diagnostic/latency_trace.cpp)
lemma_internal_target(lemma_diagnostic)

# This is the only target that may include Ghostty headers. The final executable receives the
# static archive as a link-only implementation requirement; Ghostty is not part of Lemma's API.
add_library(
  lemma_terminal STATIC
  src/terminal/terminal_core.cpp
  src/terminal/terminal_effects.cpp
  src/terminal/terminal_input.cpp
  src/terminal/terminal_render.cpp
  src/terminal/terminal_selection.cpp
)
lemma_internal_target(lemma_terminal)
target_link_libraries(lemma_terminal PRIVATE lemma_base lemma_diagnostic ghostty-vt-static)

add_library(
  lemma_platform STATIC
  src/platform/io.cpp
  src/platform/pty.cpp
  src/platform/terminal_mode.cpp
)
lemma_internal_target(lemma_platform)

add_library(
  lemma_protocol STATIC
  src/protocol/extension.cpp
  src/protocol/single_pane.cpp
)
lemma_internal_target(lemma_protocol)
target_link_libraries(lemma_protocol PRIVATE lemma_base)

add_library(
  lemma_render STATIC
  src/render/pane_composition.cpp
  src/render/single_pane.cpp
)
lemma_internal_target(lemma_render)
target_link_libraries(
  lemma_render PRIVATE lemma_base lemma_diagnostic lemma_platform lemma_terminal
)

add_library(lemma_extension STATIC src/extension/host.cpp)
lemma_internal_target(lemma_extension)
target_link_libraries(
  lemma_extension PRIVATE lemma_base lemma_platform lemma_protocol lua::lua
)

add_library(
  lemma_core STATIC
  src/core/client_frame_output.cpp
  src/core/command.cpp
  src/core/engine.cpp
  src/core/extension_runtime.cpp
  src/core/frame_scheduler.cpp
  src/core/lemma.cpp
  src/core/input.cpp
  src/core/pty_writer.cpp
  src/core/presentation_gate.cpp
  src/core/terminal_resize.cpp
)
lemma_internal_target(lemma_core)
target_link_libraries(
  lemma_core
  PRIVATE
    lemma_base
    lemma_diagnostic
    lemma_platform
    lemma_protocol
    lemma_render
    lemma_terminal
    lua::lua
    zstd::libzstd_static
)

add_library(lemma_daemon STATIC src/daemon/server.cpp)
lemma_internal_target(lemma_daemon)
target_link_libraries(
  lemma_daemon
  PRIVATE lemma_base lemma_core lemma_extension lemma_platform lemma_protocol
)

add_library(lemma_client STATIC src/client/attached_client.cpp)
lemma_internal_target(lemma_client)
target_link_libraries(
  lemma_client
  PRIVATE lemma_daemon lemma_diagnostic lemma_platform lemma_protocol
)

add_library(lemma_app STATIC src/app/application.cpp)
lemma_internal_target(lemma_app)
target_link_libraries(lemma_app PRIVATE lemma_client lemma_daemon lemma_terminal)

# Compatibility aggregate for existing tests and embedders. New internal code should depend on the
# narrow component target it uses rather than this aggregate.
add_library(lemma_lib INTERFACE)
add_library(lemma::lib ALIAS lemma_lib)
target_link_libraries(
  lemma_lib
  INTERFACE lemma_core lemma_extension lemma_terminal
)
target_include_directories(
  lemma_lib
  INTERFACE
    "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
    "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src>"
    "$<INSTALL_INTERFACE:include>"
)

add_executable(lemma apps/lemma/main.cpp)
target_link_libraries(lemma PRIVATE lemma_app lemma_warnings)

if(LEMMA_BUILD_TESTS OR LEMMA_BUILD_BENCHMARKS)
  add_executable(lemma_test_server tests/support/server_main.cpp)
  lemma_internal_target(lemma_test_server)
  target_link_libraries(lemma_test_server PRIVATE lemma_daemon)

  add_executable(lemma_test_cli tests/support/cli_main.cpp)
  lemma_internal_target(lemma_test_cli)
  target_link_libraries(lemma_test_cli PRIVATE lemma_app)

  add_executable(lemma_test_pty_peer tests/support/pty_peer_main.cpp)
  target_link_libraries(lemma_test_pty_peer PRIVATE lemma_warnings)
endif()

if(LEMMA_BUILD_TESTS)
  enable_testing()
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)

  add_executable(
    lemma_tests
    tests/client_frame_output_test.cpp
    tests/connection_output_test.cpp
    tests/core_input_test.cpp
    tests/extension_test.cpp
    tests/core_test.cpp
    tests/frame_scheduler_test.cpp
    tests/lemma_test.cpp
    tests/latency_trace_test.cpp
    tests/ghostty_parity_regression_test.cpp
    tests/platform_test.cpp
    tests/protocol_test.cpp
    tests/pty_writer_test.cpp
    tests/render_composition_test.cpp
    tests/terminal_test.cpp
  )
  target_link_libraries(
    lemma_tests
    PRIVATE
      lemma::lib
      lemma_diagnostic
      lemma_platform
      lemma_protocol
      lemma_render
      lemma_warnings
      GTest::gtest_main
      GTest::gmock
  )
  gtest_discover_tests(lemma_tests)

  add_executable(
    lemma_e2e_tests
    tests/support/process.cpp
    tests/e2e_mux_test.cpp
  )
  lemma_internal_target(lemma_e2e_tests)
  target_link_libraries(
    lemma_e2e_tests
    PRIVATE lemma_platform lemma_protocol lemma_terminal GTest::gtest_main
  )
  target_compile_definitions(
    lemma_e2e_tests
    PRIVATE
      LEMMA_TEST_SERVER_PATH="$<TARGET_FILE:lemma_test_server>"
      LEMMA_TEST_CLI_PATH="$<TARGET_FILE:lemma_test_cli>"
      LEMMA_TEST_PTY_PEER_PATH="$<TARGET_FILE:lemma_test_pty_peer>"
  )
  add_dependencies(lemma_e2e_tests lemma_test_server lemma_test_cli lemma_test_pty_peer)
  gtest_discover_tests(
    lemma_e2e_tests
    PROPERTIES TIMEOUT 120 LABELS "integration;pty"
  )

  add_executable(lemma_steady_state_allocation_audit tests/steady_state_allocation_audit.cpp)
  lemma_internal_target(lemma_steady_state_allocation_audit)
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    # The audit replaces every sized delete form so malloc-backed global new remains ASan-correct.
    target_compile_options(lemma_steady_state_allocation_audit PRIVATE -fsized-deallocation)
  endif()
  target_link_libraries(
    lemma_steady_state_allocation_audit
    PRIVATE lemma_core lemma_render lemma_terminal
  )
  add_test(
    NAME steady_state_allocation_audit
    COMMAND lemma_steady_state_allocation_audit
  )
  set_tests_properties(
    steady_state_allocation_audit
    PROPERTIES TIMEOUT 30 LABELS "component;allocation"
  )
endif()

if(LEMMA_BUILD_BENCHMARKS)
  find_package(benchmark CONFIG REQUIRED)

  add_executable(lemma_benchmarks benchmarks/lemma_benchmark.cpp)
  target_link_libraries(
    lemma_benchmarks
    PRIVATE lemma::lib lemma_warnings benchmark::benchmark
  )

  add_executable(lemma_memory_census benchmarks/terminal_memory.cpp)
  lemma_internal_target(lemma_memory_census)
  target_link_libraries(lemma_memory_census PRIVATE lemma_render lemma_terminal)
endif()
