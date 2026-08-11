nix := ""
profile := "debug"
build_type := if profile == "release" { "Release" } else { "Debug" }
cpp_files := "apps include src tests benchmarks"

_default:
    @just --list

# Show the pinned development tool versions.
versions:
    {{ nix }} clang++ --version
    {{ nix }} clangd --version
    {{ nix }} clang-tidy --version
    {{ nix }} cmake --version
    {{ nix }} ninja --version
    {{ nix }} ccache --version
    {{ nix }} conan --version
    {{ nix }} tmux -V
    {{ nix }} zellij --version
    {{ nix }} zig version
    {{ nix }} hk --version

# Install Conan dependencies for the selected profile.
deps:
    rm -f CMakeUserPresets.json
    {{ nix }} conan install . \
        --output-folder=build/{{ profile }}/conan \
        --profile:all=conan/profiles/llvm \
        --settings=build_type={{ build_type }} \
        --conf=tools.cmake.cmaketoolchain:user_presets= \
        --build=missing

# Generate Ninja files and compile_commands.json.
configure: deps
    {{ nix }} cmake --preset {{ profile }} \
        -DLEMMA_BUILD_TESTS=ON -DLEMMA_BUILD_BENCHMARKS=ON

# Build the application, tests, and benchmarks.
build: configure
    {{ nix }} cmake --build --preset {{ profile }}

# Run the application.
run: build
    {{ nix }} ./build/{{ profile }}/lemma

# Run the scripted libghostty-vt demo.
demo: build
    {{ nix }} ./build/{{ profile }}/lemma demo

# Run the GoogleTest/GoogleMock suite.
test: build
    {{ nix }} ctest --preset {{ profile }}

# Run Google Benchmark.
bench: build
    {{ nix }} ./build/{{ profile }}/lemma_benchmarks

# Run release microbenchmarks and Lemma/tmux/Zellij process baselines.
mux-bench:
    {{ nix }} scripts/ci/benchmarks extended

# Format C++ and Nix files in place.
fmt:
    {{ nix }} bash -c "find {{ cpp_files }} -type f \
        \\( -name '*.cpp' -o -name '*.hpp' \\) -print0 | xargs -0 clang-format -i"
    {{ nix }} nixpkgs-fmt flake.nix

# Check formatting without changing files.
fmt-check:
    {{ nix }} bash -c "find {{ cpp_files }} -type f \
        \\( -name '*.cpp' -o -name '*.hpp' \\) -print0 | \
        xargs -0 clang-format --dry-run --Werror"
    {{ nix }} nixpkgs-fmt --check flake.nix

# Run clang-tidy with all diagnostics promoted to errors.
lint: configure
    {{ nix }} bash -c "find apps src tests benchmarks -type f -name '*.cpp' -print0 | \
        xargs -0 clang-tidy --quiet -p build/{{ profile }}"

# Check public headers and production translation units through clangd.
lsp-check: configure
    {{ nix }} bash -c "find apps include src -type f \
        \\( -name '*.hpp' -o -name '*.cpp' \\) \
        ! -path 'include/lemma/command.hpp' \
        ! -path 'include/lemma/generational_store.hpp' \
        ! -path 'src/client/attached_client.cpp' \
        ! -path 'src/core/client_frame_output.cpp' \
        ! -path 'src/core/connection_output.hpp' \
        ! -path 'src/core/engine.cpp' \
        ! -path 'src/core/input.cpp' \
        ! -path 'src/core/pty_writer.cpp' \
        ! -path 'src/daemon/server.cpp' \
        ! -path 'src/platform/io.cpp' \
        ! -path 'src/platform/terminal_mode.cpp' \
        ! -path 'src/protocol/single_pane.cpp' \
        ! -path 'src/render/single_pane.cpp' -print0 | sort -z | \
        xargs -0 cmake/check-clangd.sh"

# Start clangd for editor integrations.
lsp:
    {{ nix }} clangd --enable-config

# Run formatting, lint, LSP diagnostics, build, and tests.
check: build fmt-check lint lsp-check test

# Check the merge-blocking formatter lane.
ci-format:
    {{ nix }} scripts/ci/format

# Run the merge-blocking debug build and test lane.
ci-build-test:
    {{ nix }} scripts/ci/build-test

# Run the merge-blocking clang-tidy lane.
ci-lint:
    {{ nix }} scripts/ci/lint

# Run the merge-blocking clangd lane.
ci-lsp:
    {{ nix }} scripts/ci/lsp

# Run the regular C++ lanes sequentially for local reproduction.
ci-cpp:
    {{ nix }} scripts/ci/cpp

# Run the scheduled/local release benchmark smoke lane.
ci-benchmarks:
    {{ nix }} scripts/ci/benchmarks smoke

# Reproduce the sanitizer suite (the merge-blocking hosted lane uses Linux).
ci-sanitizers:
    {{ nix }} scripts/ci/sanitizers

# Run the CI change-classification contract tests.
ci-contracts:
    {{ nix }} scripts/ci/contracts

# Run ShellCheck over CI scripts.
ci-shellcheck:
    {{ nix }} scripts/ci/shellcheck

# Run Actionlint over GitHub Actions workflows.
ci-actionlint:
    {{ nix }} scripts/ci/actionlint

# Run all automation checks sequentially for local reproduction.
ci-workflows:
    {{ nix }} scripts/ci/workflows

# Reproduce every merge-blocking CI lane locally in a safe sequence.
ci-check:
    {{ nix }} scripts/ci/cpp
    {{ nix }} scripts/ci/sanitizers
    {{ nix }} scripts/ci/workflows

# Configure the debug tree and install this repository's hk hooks.
hooks:
    {{ nix }} bash -c 'scripts/ci/configure debug -DLEMMA_BUILD_TESTS=ON -DLEMMA_BUILD_BENCHMARKS=ON && hk validate && hk install'

# Run every fast and pre-push hk check over the repository.
hooks-check:
    {{ nix }} hk check --all --check

# Apply every safe pre-commit-tier hk fixer.
hooks-fix:
    {{ nix }} hk fix --all

# Remove generated build and vendored Zig output.
clean:
    rm -rf build CMakeUserPresets.json .zig-cache \
        third_party/ghostty/.zig-cache third_party/ghostty/zig-out third_party/ghostty/zig-pkg
    {{ nix }} ccache --clear
