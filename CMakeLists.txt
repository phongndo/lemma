cmake_minimum_required(VERSION 3.30)

project(fiber VERSION 0.1.0 LANGUAGES C CXX)

if(NOT CMAKE_CXX_COMPILER_ID MATCHES "^(AppleClang|Clang)$")
  message(FATAL_ERROR "fiber requires Clang or Apple Clang")
endif()

set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(FIBER_BUILD_TESTS "Build the test suite" ON)
option(FIBER_BUILD_BENCHMARKS "Build benchmarks" ON)

add_library(fiber_warnings INTERFACE)
target_compile_options(
  fiber_warnings
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
    fiber_warnings
    INTERFACE -Wno-unused-command-line-argument
  )
endif()

# libghostty-vt remains pinned and built from the third-party Ghostty source.
add_subdirectory(third_party/ghostty EXCLUDE_FROM_ALL SYSTEM)

find_package(lua CONFIG REQUIRED)
find_package(zstd CONFIG REQUIRED)

function(fiber_internal_target target)
  target_include_directories(
    ${target}
    PUBLIC
      "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
      "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src>"
  )
  target_link_libraries(${target} PRIVATE fiber_warnings)
endfunction()

add_library(fiber_base STATIC src/core/assert.cpp)
fiber_internal_target(fiber_base)

# This is the only target that may include Ghostty headers. The final executable receives the
# static archive as a link-only implementation requirement; Ghostty is not part of Fiber's API.
add_library(fiber_terminal STATIC src/terminal/terminal.cpp)
fiber_internal_target(fiber_terminal)
target_link_libraries(fiber_terminal PRIVATE fiber_base ghostty-vt-static)

add_library(
  fiber_platform STATIC
  src/platform/io.cpp
  src/platform/pty.cpp
  src/platform/terminal_mode.cpp
)
fiber_internal_target(fiber_platform)

add_library(
  fiber_protocol STATIC
  src/protocol/extension.cpp
  src/protocol/single_pane.cpp
)
fiber_internal_target(fiber_protocol)
target_link_libraries(fiber_protocol PRIVATE fiber_base)

add_library(
  fiber_render STATIC
  src/render/pane_composition.cpp
  src/render/single_pane.cpp
)
fiber_internal_target(fiber_render)
target_link_libraries(fiber_render PRIVATE fiber_base fiber_platform fiber_terminal)

add_library(fiber_extension STATIC src/extension/host.cpp)
fiber_internal_target(fiber_extension)
target_link_libraries(
  fiber_extension PRIVATE fiber_base fiber_platform fiber_protocol lua::lua
)

add_library(
  fiber_core STATIC
  src/core/command.cpp
  src/core/engine.cpp
  src/core/extension_runtime.cpp
  src/core/fiber.cpp
  src/core/input.cpp
  src/core/pty_writer.cpp
)
fiber_internal_target(fiber_core)
target_link_libraries(
  fiber_core
  PRIVATE
    fiber_base
    fiber_platform
    fiber_protocol
    fiber_render
    fiber_terminal
    lua::lua
    zstd::libzstd_static
)

add_library(fiber_daemon STATIC src/daemon/server.cpp)
fiber_internal_target(fiber_daemon)
target_link_libraries(
  fiber_daemon
  PRIVATE fiber_base fiber_core fiber_extension fiber_platform fiber_protocol
)

add_library(fiber_client STATIC src/client/attached_client.cpp)
fiber_internal_target(fiber_client)
target_link_libraries(
  fiber_client
  PRIVATE fiber_daemon fiber_platform fiber_protocol
)

add_library(fiber_app STATIC src/app/application.cpp)
fiber_internal_target(fiber_app)
target_link_libraries(fiber_app PRIVATE fiber_client fiber_daemon fiber_terminal)

# Compatibility aggregate for existing tests and embedders. New internal code should depend on the
# narrow component target it uses rather than this aggregate.
add_library(fiber_lib INTERFACE)
add_library(fiber::lib ALIAS fiber_lib)
target_link_libraries(
  fiber_lib
  INTERFACE fiber_core fiber_extension fiber_terminal
)
target_include_directories(
  fiber_lib
  INTERFACE
    "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
    "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src>"
    "$<INSTALL_INTERFACE:include>"
)

add_executable(fiber apps/fiber/main.cpp)
target_link_libraries(fiber PRIVATE fiber_app fiber_warnings)

if(FIBER_BUILD_TESTS OR FIBER_BUILD_BENCHMARKS)
  add_executable(fiber_test_server tests/support/server_main.cpp)
  fiber_internal_target(fiber_test_server)
  target_link_libraries(fiber_test_server PRIVATE fiber_daemon)

  add_executable(fiber_test_cli tests/support/cli_main.cpp)
  fiber_internal_target(fiber_test_cli)
  target_link_libraries(fiber_test_cli PRIVATE fiber_app)

  add_executable(fiber_test_pty_peer tests/support/pty_peer_main.cpp)
  target_link_libraries(fiber_test_pty_peer PRIVATE fiber_warnings)
endif()

if(FIBER_BUILD_TESTS)
  enable_testing()
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)

  add_executable(
    fiber_tests
    tests/connection_output_test.cpp
    tests/core_input_test.cpp
    tests/extension_test.cpp
    tests/core_test.cpp
    tests/fiber_test.cpp
    tests/platform_test.cpp
    tests/protocol_test.cpp
    tests/pty_writer_test.cpp
    tests/render_composition_test.cpp
    tests/terminal_test.cpp
  )
  target_link_libraries(
    fiber_tests
    PRIVATE
      fiber::lib
      fiber_platform
      fiber_protocol
      fiber_render
      fiber_warnings
      GTest::gtest_main
      GTest::gmock
  )
  gtest_discover_tests(fiber_tests)

  add_executable(
    fiber_e2e_tests
    tests/support/process.cpp
    tests/e2e_mux_test.cpp
  )
  fiber_internal_target(fiber_e2e_tests)
  target_link_libraries(
    fiber_e2e_tests
    PRIVATE fiber_platform fiber_protocol fiber_terminal GTest::gtest_main
  )
  target_compile_definitions(
    fiber_e2e_tests
    PRIVATE
      FIBER_TEST_SERVER_PATH="$<TARGET_FILE:fiber_test_server>"
      FIBER_TEST_CLI_PATH="$<TARGET_FILE:fiber_test_cli>"
      FIBER_TEST_PTY_PEER_PATH="$<TARGET_FILE:fiber_test_pty_peer>"
  )
  add_dependencies(fiber_e2e_tests fiber_test_server fiber_test_cli fiber_test_pty_peer)
  gtest_discover_tests(
    fiber_e2e_tests
    PROPERTIES TIMEOUT 120 LABELS "integration;pty"
  )
endif()

if(FIBER_BUILD_BENCHMARKS)
  find_package(benchmark CONFIG REQUIRED)

  add_executable(fiber_benchmarks benchmarks/fiber_benchmark.cpp)
  target_link_libraries(
    fiber_benchmarks
    PRIVATE fiber::lib fiber_warnings benchmark::benchmark_main
  )
endif()
