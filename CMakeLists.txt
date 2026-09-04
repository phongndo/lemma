cmake_minimum_required(VERSION 3.30)

project(lemma VERSION 0.1.0 LANGUAGES C CXX)

if(NOT CMAKE_CXX_COMPILER_ID MATCHES "^(AppleClang|Clang)$")
  message(FATAL_ERROR "lemma requires Clang or Apple Clang")
endif()

set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Keep compiler output independent of the checkout path so ccache entries can be reused by
# worktrees. CMakePresets.json supplies the matching per-worktree CCACHE_BASEDIR.
add_compile_options("-ffile-prefix-map=${CMAKE_SOURCE_DIR}=.")

option(LEMMA_BUILD_TESTS "Build the test suite" ON)
option(LEMMA_BUILD_BENCHMARKS "Build benchmarks" ON)
option(LEMMA_BUILD_FUZZERS "Build sanitizer-backed parser fuzz targets" OFF)
option(LEMMA_ENABLE_LATENCY_TRACE "Compile the opt-in key-to-visible diagnostic trace" OFF)
option(LEMMA_VALIDATE_GHOSTTY_EVERY_BUILD "Revalidate the Ghostty checkout on every build" ON)

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
  # Ghostty's Zig-produced archive contains assembly objects without GNU-stack notes. Make the
  # intended non-executable stack explicit instead of relying on the linker's deprecated fallback.
  add_link_options("LINKER:-z,noexecstack")
endif()

# libghostty-vt remains pinned, private, and built without generated output in the submodule.
include(cmake/GhosttyVt.cmake)
lemma_add_pinned_ghostty()

find_package(zstd CONFIG REQUIRED)
find_package(Lua 5.4 REQUIRED)
if(TARGET lua::lua)
  set(LEMMA_LUA_TARGET lua::lua)
elseif(TARGET Lua::Lua)
  set(LEMMA_LUA_TARGET Lua::Lua)
else()
  add_library(lemma_lua_external INTERFACE)
  target_include_directories(lemma_lua_external SYSTEM INTERFACE "${LUA_INCLUDE_DIR}")
  target_link_libraries(lemma_lua_external INTERFACE ${LUA_LIBRARIES})
  set(LEMMA_LUA_TARGET lemma_lua_external)
endif()

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

add_library(lemma_protocol STATIC src/protocol/attachment.cpp)
lemma_internal_target(lemma_protocol)
target_link_libraries(lemma_protocol PRIVATE lemma_base)

add_library(
  lemma_render STATIC
  src/render/pane_composition.cpp
  src/render/frame_buffer.cpp
  src/render/ui.cpp
)
lemma_internal_target(lemma_render)
target_link_libraries(
  lemma_render PRIVATE lemma_base lemma_diagnostic lemma_platform lemma_terminal
)

add_library(
  lemma_core STATIC
  src/core/command.cpp
  src/core/copy_mode.cpp
  src/core/layout.cpp
  src/core/session.cpp
  src/core/session_machine.cpp
)
lemma_internal_target(lemma_core)
target_link_libraries(lemma_core PRIVATE lemma_base)

add_library(lemma_input STATIC src/input/input_router.cpp)
lemma_internal_target(lemma_input)
target_link_libraries(lemma_input PRIVATE lemma_base)

file(READ "${CMAKE_CURRENT_SOURCE_DIR}/schema/lemma-api-v1.schema.json" LEMMA_API_SCHEMA)
configure_file(
  "${CMAKE_CURRENT_SOURCE_DIR}/src/api/schema.cpp.in"
  "${CMAKE_CURRENT_BINARY_DIR}/generated/api_schema.cpp"
  @ONLY
)
add_library(
  lemma_api STATIC
  src/api/command.cpp
  src/api/json.cpp
  "${CMAKE_CURRENT_BINARY_DIR}/generated/api_schema.cpp"
)
lemma_internal_target(lemma_api)
target_link_libraries(lemma_api PRIVATE lemma_base lemma_core)

add_library(lemma_config STATIC src/config/config.cpp)
lemma_internal_target(lemma_config)
target_link_libraries(lemma_config PRIVATE lemma_api lemma_base lemma_input)

add_library(lemma_extension STATIC src/extension/lua_host.cpp)
lemma_internal_target(lemma_extension)
target_link_libraries(
  lemma_extension PRIVATE lemma_base lemma_config lemma_input lemma_platform ${LEMMA_LUA_TARGET}
)

add_library(
  lemma_runtime STATIC
  src/core/client_frame_output.cpp
  src/core/command_history.cpp
  src/core/command_line.cpp
  src/core/engine.cpp
  src/core/frame_scheduler.cpp
  src/core/input.cpp
  src/core/pane_residency.cpp
  src/core/pane_snapshot_quota.cpp
  src/core/pane_snapshot_storage.cpp
  src/core/pty_writer.cpp
  src/core/presentation_gate.cpp
  src/core/terminal_resize.cpp
)
lemma_internal_target(lemma_runtime)
target_compile_definitions(
  lemma_runtime
  PRIVATE
    LEMMA_GHOSTTY_PINNED_COMMIT="${LEMMA_GHOSTTY_PINNED_COMMIT}"
    LEMMA_GHOSTTY_PINNED_PROFILE="${LEMMA_GHOSTTY_PINNED_PROFILE}"
)
target_link_libraries(
  lemma_runtime
  PRIVATE
    lemma_api
    lemma_base
    lemma_core
    lemma_diagnostic
    lemma_input
    lemma_platform
    lemma_protocol
    lemma_render
    lemma_terminal
)

# Public dependency-version helpers remain separate from semantic Core and Runtime ownership.
add_library(lemma_metadata STATIC src/core/lemma.cpp)
lemma_internal_target(lemma_metadata)
target_link_libraries(lemma_metadata PRIVATE lemma_terminal zstd::libzstd_static)

add_library(lemma_daemon STATIC src/daemon/server.cpp)
lemma_internal_target(lemma_daemon)
target_link_libraries(
  lemma_daemon
  PRIVATE lemma_api lemma_base lemma_extension lemma_platform lemma_protocol lemma_runtime
)

add_library(
  lemma_client STATIC
  src/client/attached_client.cpp
  src/client/host_input_parser.cpp
  src/client/host_terminal_theme.cpp
)
lemma_internal_target(lemma_client)
target_link_libraries(
  lemma_client
  PRIVATE lemma_daemon lemma_diagnostic lemma_platform lemma_protocol
)

add_library(lemma_app STATIC src/app/application.cpp src/app/proc.cpp)
lemma_internal_target(lemma_app)
target_link_libraries(
  lemma_app PRIVATE lemma_api lemma_client lemma_daemon lemma_extension lemma_terminal
)

# Compatibility aggregate for existing tests and embedders. New internal code should depend on the
# narrow component target it uses rather than this aggregate.
add_library(lemma_lib INTERFACE)
add_library(lemma::lib ALIAS lemma_lib)
target_link_libraries(
  lemma_lib
  INTERFACE lemma_core lemma_input lemma_metadata lemma_runtime lemma_terminal
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
install(TARGETS lemma RUNTIME DESTINATION bin)

if(LEMMA_BUILD_TESTS OR LEMMA_BUILD_BENCHMARKS)
  add_executable(lemma_test_server tests/support/server_main.cpp)
  lemma_internal_target(lemma_test_server)
  target_link_libraries(lemma_test_server PRIVATE lemma_daemon)

  add_executable(lemma_test_cli tests/support/cli_main.cpp)
  lemma_internal_target(lemma_test_cli)
  target_link_libraries(lemma_test_cli PRIVATE lemma_app)

  add_executable(lemma_test_pty_peer tests/support/pty_peer_main.cpp)
  target_link_libraries(lemma_test_pty_peer PRIVATE lemma_warnings)

  add_executable(lemma_benchmark_probe benchmarks/process_probe.cpp)
  target_link_libraries(lemma_benchmark_probe PRIVATE lemma_warnings)

  add_executable(lemma_terminal_memory_probe benchmarks/terminal_memory_probe.cpp)
  lemma_internal_target(lemma_terminal_memory_probe)
  target_link_libraries(lemma_terminal_memory_probe PRIVATE lemma_terminal)

  add_executable(lemma_reactor_thread_probe benchmarks/reactor_thread_probe.cpp)
  target_link_libraries(lemma_reactor_thread_probe PRIVATE lemma_warnings)
endif()

if(LEMMA_BUILD_TESTS)
  enable_testing()
  add_test(NAME benchmark.probe COMMAND lemma_benchmark_probe --self-test)
  find_package(GTest CONFIG REQUIRED)
  find_package(Python3 REQUIRED COMPONENTS Interpreter)
  include(GoogleTest)

  # Fast pure/component invariants. The developer entry point runs this binary once; CTest still
  # discovers individual cases for filtering and CI reporting.
  add_executable(
    lemma_unit_tests
    tests/api_test.cpp
    tests/config_test.cpp
    tests/command_history_test.cpp
    tests/command_line_test.cpp
    tests/connection_output_test.cpp
    tests/core_test.cpp
    tests/frame_scheduler_test.cpp
    tests/host_input_parser_test.cpp
    tests/host_terminal_theme_test.cpp
    tests/input_router_test.cpp
    tests/latency_trace_test.cpp
    tests/layout_test.cpp
    tests/pane_snapshot_quota_test.cpp
    tests/protocol_test.cpp
    tests/reactor_environment_test.cpp
  )
  lemma_internal_target(lemma_unit_tests)
  target_link_libraries(
    lemma_unit_tests
    PRIVATE
      lemma_api
      lemma_client
      lemma_config
      lemma_core
      lemma_diagnostic
      lemma_extension
      lemma_input
      lemma_protocol
      lemma_runtime
      GTest::gtest_main
      GTest::gmock
  )
  gtest_discover_tests(lemma_unit_tests PROPERTIES LABELS "unit")

  # Lemma-owned assumptions at the concrete libghostty-vt boundary. These tests do not open PTYs
  # or spawn children; expensive history/resource sweeps are separate below.
  add_executable(
    lemma_terminal_boundary_tests
    tests/client_frame_output_test.cpp
    tests/core_input_test.cpp
    tests/pane_residency_test.cpp
    tests/pane_snapshot_storage_test.cpp
    tests/pty_writer_test.cpp
    tests/render_composition_test.cpp
    tests/terminal_integration_regression_test.cpp
    tests/terminal_test.cpp
  )
  lemma_internal_target(lemma_terminal_boundary_tests)
  target_link_libraries(
    lemma_terminal_boundary_tests
    PRIVATE
      lemma::lib
      lemma_client
      lemma_diagnostic
      lemma_platform
      lemma_protocol
      lemma_render
      GTest::gtest_main
      GTest::gmock
  )
  gtest_discover_tests(lemma_terminal_boundary_tests PROPERTIES LABELS "terminal-unit")

  # Real platform-process contracts remain native but are never presented as pure unit tests.
  add_executable(lemma_component_integration_tests tests/platform_test.cpp)
  lemma_internal_target(lemma_component_integration_tests)
  target_link_libraries(
    lemma_component_integration_tests
    PRIVATE lemma::lib lemma_client lemma_platform lemma_protocol GTest::gtest_main
  )
  gtest_discover_tests(
    lemma_component_integration_tests
    PROPERTIES TIMEOUT 30 LABELS "component-integration" RUN_SERIAL TRUE
  )

  add_executable(lemma_dependency_integrity_tests tests/dependency_integrity_test.cpp)
  lemma_internal_target(lemma_dependency_integrity_tests)
  target_link_libraries(
    lemma_dependency_integrity_tests PRIVATE lemma_terminal GTest::gtest_main
  )
  gtest_discover_tests(
    lemma_dependency_integrity_tests PROPERTIES LABELS "dependency-terminal"
  )
  add_test(
    NAME dependency.ghostty_header_boundary
    COMMAND
      "${CMAKE_COMMAND}" "-DLEMMA_SOURCE_DIR=${CMAKE_SOURCE_DIR}" -P
      "${CMAKE_SOURCE_DIR}/cmake/CheckGhosttyHeaderBoundary.cmake"
  )
  set_tests_properties(
    dependency.ghostty_header_boundary PROPERTIES LABELS "dependency;terminal"
  )

  add_executable(lemma_terminal_resource_tests tests/terminal_resource_test.cpp)
  lemma_internal_target(lemma_terminal_resource_tests)
  target_link_libraries(lemma_terminal_resource_tests PRIVATE lemma_terminal GTest::gtest_main)
  gtest_discover_tests(
    lemma_terminal_resource_tests
    PROPERTIES TIMEOUT 60 LABELS "extended-stress-terminal" RUN_SERIAL TRUE
  )

  add_executable(
    lemma_core_sim_tests
    tests/sim/core_world_test.cpp
    tests/sim/mux_trace.cpp
    tests/sim/mux_world_test.cpp
    tests/sim/reduce_test.cpp
  )
  lemma_internal_target(lemma_core_sim_tests)
  target_link_libraries(lemma_core_sim_tests PRIVATE lemma_core GTest::gtest_main)
  gtest_discover_tests(
    lemma_core_sim_tests
    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
    PROPERTIES TIMEOUT 30 LABELS "extended-stress-sim" RUN_SERIAL TRUE
  )

  add_executable(lemma_protocol_sim_tests tests/sim/protocol_world_test.cpp)
  lemma_internal_target(lemma_protocol_sim_tests)
  target_link_libraries(
    lemma_protocol_sim_tests PRIVATE lemma_api lemma_protocol GTest::gtest_main
  )
  gtest_discover_tests(
    lemma_protocol_sim_tests
    PROPERTIES TIMEOUT 30 LABELS "extended-stress-sim-protocol" RUN_SERIAL TRUE
  )

  add_executable(
    lemma_terminal_sim_tests
    tests/sim/composition_world_test.cpp
    tests/sim/presentation_world_test.cpp
    tests/sim/terminal_world_test.cpp
  )
  lemma_internal_target(lemma_terminal_sim_tests)
  target_link_libraries(
    lemma_terminal_sim_tests
    PRIVATE lemma_protocol lemma_render lemma_runtime lemma_terminal GTest::gtest_main
  )
  gtest_discover_tests(
    lemma_terminal_sim_tests
    PROPERTIES TIMEOUT 30 LABELS "extended-stress-sim-terminal" RUN_SERIAL TRUE
  )

  function(lemma_add_python_mux_test name module)
    add_test(
      NAME "mux.${name}"
      COMMAND
        "${CMAKE_COMMAND}" -E env
        "LEMMA_TEST_SERVER=$<TARGET_FILE:lemma_test_server>"
        "LEMMA_TEST_CLI=$<TARGET_FILE:lemma_test_cli>"
        "LEMMA_TEST_PTY_PEER=$<TARGET_FILE:lemma_test_pty_peer>"
        "${Python3_EXECUTABLE}" -m unittest -v "${module}"
    )
    set_tests_properties(
      "mux.${name}"
      PROPERTIES
        WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
        TIMEOUT 45
        LABELS "mux;integration;pty"
        RUN_SERIAL TRUE
    )
  endfunction()

  lemma_add_python_mux_test(configuration tests.mux.test_configuration)
  lemma_add_python_mux_test(command_line tests.mux.test_command_line)
  lemma_add_python_mux_test(pane_lifecycle tests.mux.test_pane_lifecycle)
  lemma_add_python_mux_test(session_lifecycle tests.mux.test_session_lifecycle)
  lemma_add_python_mux_test(resize tests.mux.test_resize)
  lemma_add_python_mux_test(terminal_boundary tests.mux.test_terminal_boundary)
  lemma_add_python_mux_test(agent tests.mux.test_agent)
  lemma_add_python_mux_test(process_boundary tests.mux.test_process_boundary)

  add_custom_target(
    lemma_fast_test_binaries
    DEPENDS
      lemma_unit_tests
      lemma_terminal_boundary_tests
      lemma_component_integration_tests
      lemma_dependency_integrity_tests
      lemma_benchmark_probe
      lemma_test_server
      lemma_test_cli
      lemma_test_pty_peer
  )

  add_test(
    NAME stress.mux_state_machine
    COMMAND
      "${CMAKE_COMMAND}" -E env
      "LEMMA_TEST_SERVER=$<TARGET_FILE:lemma_test_server>"
      "LEMMA_TEST_CLI=$<TARGET_FILE:lemma_test_cli>"
      "LEMMA_TEST_PTY_PEER=$<TARGET_FILE:lemma_test_pty_peer>"
      "${Python3_EXECUTABLE}" -m unittest -v tests.stress.test_mux_state_machine
  )
  set_tests_properties(
    stress.mux_state_machine
    PROPERTIES
      WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
      TIMEOUT 180
      LABELS "extended;integration;mux;stress"
      RUN_SERIAL TRUE
  )

  add_test(
    NAME stress.mux_backpressure
    COMMAND
      "${CMAKE_COMMAND}" -E env
      "LEMMA_TEST_SERVER=$<TARGET_FILE:lemma_test_server>"
      "LEMMA_TEST_CLI=$<TARGET_FILE:lemma_test_cli>"
      "LEMMA_TEST_PTY_PEER=$<TARGET_FILE:lemma_test_pty_peer>"
      "${Python3_EXECUTABLE}" -m unittest -v tests.stress.test_backpressure
  )
  set_tests_properties(
    stress.mux_backpressure
    PROPERTIES
      WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
      TIMEOUT 60
      LABELS "extended;integration;mux;stress;backpressure"
      RUN_SERIAL TRUE
  )

  add_test(
    NAME stress.mux_trace_replay
    COMMAND
      "${CMAKE_COMMAND}" -E env
      "LEMMA_TEST_SERVER=$<TARGET_FILE:lemma_test_server>"
      "LEMMA_TEST_CLI=$<TARGET_FILE:lemma_test_cli>"
      "LEMMA_TEST_PTY_PEER=$<TARGET_FILE:lemma_test_pty_peer>"
      "${Python3_EXECUTABLE}" -m unittest -v tests.stress.test_mux_trace_replay
  )
  set_tests_properties(
    stress.mux_trace_replay
    PROPERTIES
      WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
      TIMEOUT 180
      LABELS "extended;integration;mux;stress;trace-replay"
      RUN_SERIAL TRUE
  )

  add_executable(lemma_steady_state_allocation_audit tests/steady_state_allocation_audit.cpp)
  lemma_internal_target(lemma_steady_state_allocation_audit)
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    # The audit replaces every sized delete form so malloc-backed global new remains ASan-correct.
    target_compile_options(lemma_steady_state_allocation_audit PRIVATE -fsized-deallocation)
  endif()
  target_link_libraries(
    lemma_steady_state_allocation_audit
    PRIVATE lemma_render lemma_runtime lemma_terminal
  )
  add_test(
    NAME steady_state_allocation_audit
    COMMAND lemma_steady_state_allocation_audit
  )
  set_tests_properties(
    steady_state_allocation_audit
    PROPERTIES
      TIMEOUT 30
      LABELS "allocation;extended;performance"
      RUN_SERIAL TRUE
  )
endif()

if(LEMMA_BUILD_FUZZERS)
  function(lemma_add_fuzzer target source)
    if(APPLE)
      # Xcode Clang does not ship libclang_rt.fuzzer_osx. Keep the same entry points and sanitizer
      # instrumentation, but link a corpus replay driver so Darwin can verify every checked-in seed.
      add_executable(${target} ${source} fuzz/corpus_driver.cpp)
      set(fuzzer_sanitizers -fsanitize=address,undefined)
    else()
      add_executable(${target} ${source})
      set(fuzzer_sanitizers -fsanitize=fuzzer,address,undefined)
    endif()
    lemma_internal_target(${target})
    target_compile_options(${target} PRIVATE ${fuzzer_sanitizers} -fno-omit-frame-pointer)
    target_link_options(${target} PRIVATE ${fuzzer_sanitizers} -fno-omit-frame-pointer)
    target_link_libraries(${target} PRIVATE ${ARGN})
  endfunction()

  lemma_add_fuzzer(
    lemma_attachment_decoder_fuzz fuzz/attachment_decoder_fuzz.cpp lemma_protocol
  )
  lemma_add_fuzzer(
    lemma_host_input_parser_fuzz fuzz/host_input_parser_fuzz.cpp lemma_client
  )
  lemma_add_fuzzer(lemma_api_json_fuzz fuzz/api_json_fuzz.cpp lemma_api)
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
