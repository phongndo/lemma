nix := ""
profile := "release"
build_type := if profile == "release" { "Release" } else { "Debug" }
cpp_files := "apps include src tests benchmarks"
python_paths := "benchmarks scripts tools conanfile.py"

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
    {{ nix }} zig version
    {{ nix }} hk --version
    {{ nix }} uv --version
    {{ nix }} uv run --locked ruff --version
    {{ nix }} uv run --locked ty --version

# Show versions of the optional multiplexer benchmark subjects.
benchmark-versions:
    {{ nix }} tmux -V
    {{ nix }} zellij --version
    {{ nix }} herdr --version

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
        -DCMAKE_BUILD_TYPE={{ build_type }} \
        -DCMAKE_TOOLCHAIN_FILE="$PWD/build/{{ profile }}/conan/conan_toolchain.cmake" \
        -DLEMMA_BUILD_TESTS=ON -DLEMMA_BUILD_BENCHMARKS=ON

# Build the application, tests, and benchmarks.
build: configure
    {{ nix }} cmake --build --preset {{ profile }}

# Run the application.
run: build
    {{ nix }} ./build/{{ profile }}/lemma

# Stop the running daemon so the next launch uses the current build.
kill: build
    {{ nix }} ./build/{{ profile }}/lemma shutdown --confirm

# Run the scripted libghostty-vt demo.
demo: build
    {{ nix }} ./build/{{ profile }}/lemma demo

# Run the GoogleTest/GoogleMock suite.
test: build
    {{ nix }} ctest --preset {{ profile }}

# Run Google Benchmark.
bench: build
    {{ nix }} ./build/{{ profile }}/lemma_benchmarks

# Run release microbenchmarks and Lemma/tmux/Zellij/Herdr process baselines.
mux-bench:
    {{ nix }} scripts/ci/benchmarks extended

# Format C++, Nix, and Python files in place.
fmt:
    {{ nix }} bash -c "find {{ cpp_files }} -type f \
        \\( -name '*.cpp' -o -name '*.hpp' \\) -print0 | xargs -0 clang-format -i"
    {{ nix }} nixpkgs-fmt flake.nix
    {{ nix }} uv run --locked ruff check --fix {{ python_paths }}
    {{ nix }} uv run --locked ruff format {{ python_paths }}

# Check formatting without changing files.
fmt-check:
    {{ nix }} bash -c "find {{ cpp_files }} -type f \
        \\( -name '*.cpp' -o -name '*.hpp' \\) -print0 | \
        xargs -0 clang-format --dry-run --Werror"
    {{ nix }} nixpkgs-fmt --check flake.nix
    {{ nix }} uv run --locked ruff format --check {{ python_paths }}

# Run responsive clang-tidy checks in parallel; ci-lint adds the slower Static Analyzer.
lint: configure
    {{ nix }} bash -c "find apps src tests benchmarks -type f -name '*.cpp' -print0 | \
        xargs -0 -n 1 -P \"\${CLANG_TIDY_JOBS:-4}\" \
        clang-tidy --quiet -p build/{{ profile }}"

# Check every public header and production translation unit through clangd in parallel.
lsp-check: configure
    {{ nix }} bash -c "find apps include src -type f \
        \\( -name '*.hpp' -o -name '*.cpp' \\) -print0 | sort -z | \
        xargs -0 -n 1 -P \"\${CLANGD_JOBS:-4}\" cmake/check-clangd.sh"

# Start clangd for editor integrations.
lsp:
    {{ nix }} clangd --enable-config

# Run Ruff, ty, and Python unit tests.
python-check:
    {{ nix }} scripts/ci/python

# Run formatting, lint, LSP diagnostics, build, and tests.
check: build fmt-check lint lsp-check test python-check

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

# Run the merge-blocking Python quality lane.
ci-python:
    {{ nix }} scripts/ci/python

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
    {{ nix }} scripts/ci/python
    {{ nix }} scripts/ci/workflows

# Run the short F5 evidence smoke (use the default Nix shell for compatibility tools).
f5-smoke:
    {{ nix }} scripts/ci/f5 smoke

# Run the complete finite F5 gate; 24-hour soaks remain separate explicit commands.
f5-extended:
    {{ nix }} scripts/ci/f5 extended

# Run one 24-hour optimized release mixed-output soak.
f5-release-soak:
    {{ nix }} scripts/ci/f5-soak release 86400 300

# Run one 24-hour ASan/UBSan mixed-output soak.
f5-sanitizer-soak:
    {{ nix }} scripts/ci/f5-soak sanitizers 86400 300

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
