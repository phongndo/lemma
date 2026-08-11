# Continuous integration

## Pull-request workflow

[`quality.yml`](../.github/workflows/quality.yml) computes the complete affected diff and fans selected
work out to isolated jobs:

```text
Classify changes
  ├─ CI contracts
  ├─ ShellCheck
  ├─ Actionlint
  ├─ Format
  ├─ Build and test
  ├─ Clang-tidy
  ├─ Clangd
  └─ ASan/UBSan
          ↓
       CI gate
```

Formatting, compilation/tests, clang-tidy, clangd, and sanitizers do not wait for one another. Each
job has one responsibility, its own timeout, and a fresh checkout. The deterministic correctness
lanes remain merge-blocking without putting performance workloads on the pull-request critical path.

The lanes perform these checks:

- **CI contracts:** Python tests for change classification and diff semantics.
- **ShellCheck:** shell diagnostics for every CI script.
- **Actionlint:** GitHub Actions syntax, expression, and workflow diagnostics.
- **Format:** clang-format, Nix formatting, and `justfile` formatting.
- **Build and test:** hk/flake validation, locked debug configuration, compilation including the
  benchmark binary, parallel component tests, serialized process tests, and command-dispatch smoke.
- **Clang-tidy:** independent locked configuration followed by static analysis of application,
  production, test, and benchmark translation units.
- **Clangd:** independent locked configuration followed by isolated parse/diagnostic checks.
- **ASan/UBSan:** an independent Linux build and the complete component/process suite with leak
  detection and undefined-behavior failures enabled.

The conservative mapping lives in [`scripts/ci/changes.py`](../scripts/ci/changes.py), with contract
tests in [`tools/test_ci_changes.py`](../tools/test_ci_changes.py):

- production headers, sources, tests, benchmark sources, or the Ghostty submodule select every C++
  job;
- CMake, Conan, and dependency changes select every C++ job;
- CI orchestration changes deliberately select every active job;
- unrelated documentation can proceed directly from classification to the gate.

Pull requests and merge groups use merge-base-to-head changes. Pushes compare the old and new ref
endpoints so force-push removals and reverts are not lost. When no trustworthy base commit is
available, classification fails safe by selecting every lane. Do not replace the classifier with
workflow-level `paths` filters: GitHub can leave an entirely skipped required workflow pending.

## Caches and isolation

All jobs use the locked Nix and Conan inputs. Analysis jobs may restore the trusted debug dependency
cache, but only successful `main` build/test and sanitizer jobs save their respective caches. Pull
requests can read these caches but cannot replace default-branch entries.

Ghostty's current CMake wrapper writes all build profiles to one source-tree `zig-out`. Hosted jobs
are safe because their checkouts are isolated. The local and scheduled benchmark script removes
ReleaseFast output on every exit so a later local debug or sanitizer build must regenerate the correct
archive. Do not run local debug, sanitizer, and benchmark builds concurrently in one checkout.

## Extended validation

[`extended.yml`](../.github/workflows/extended.yml) runs daily and on demand. Its platform matrix
covers every system exported by the Nix flake:

- `x86_64-linux`;
- `aarch64-linux`;
- `x86_64-darwin`;
- `aarch64-darwin`.

It also runs benchmark smoke in an isolated release checkout, validates the microbenchmark, Lemma
process-level, and pinned tmux/Zellij comparison JSON reports, and uploads them for inspection. A
separate F5 foundation smoke builds release tests, audits steady-state allocations, exercises the
locked real-application matrix and repeated adversarial cases, records a short mixed-output soak,
and uploads every `build/release/f5-*` report. Short scheduled smoke does not satisfy the 24-hour
soak gate. Timing is evidence only; shared-runner latency is not a regression threshold. Platform component
tests run in parallel; real PTY/socket
process tests run serially to avoid host-resource contention while retaining per-test deadlines and
isolated runtime paths.

## Local hooks

[`hk.pkl`](../hk.pkl) mirrors the validation tiers without making every commit wait for a build.
Pre-commit operates only on staged files, applies safe formatters, preserves unstaged changes, and
runs hygiene/actionlint/ShellCheck or classifier tests only when their inputs are staged. Pre-push
adds one incremental Conan/CMake refresh and debug build/test pass, then clang-tidy and clangd only
for affected C++ files. Linux sanitizers remain merge-blocking CI; platform matrices and benchmark
execution remain scheduled.

Install both hooks with `just hooks`. Use `just hooks-check` to run fast and pre-push checks over the
entire repository, and `just hooks-fix` to apply safe pre-commit-tier fixers. Run Git from
`nix develop` so the pinned hook tools are on `PATH`.

## Required repository setting

Configure the `main` branch ruleset with:

- pull requests required;
- `CI gate` required;
- merge queue enabled only while the existing `merge_group` trigger remains.

Individual change-aware jobs should not be required checks. `CI gate` verifies that every selected
job succeeded while allowing intentionally skipped jobs.

## Local reproduction

Each merge-blocking job has a direct command:

```sh
scripts/ci/format
scripts/ci/build-test
scripts/ci/lint
scripts/ci/lsp
scripts/ci/sanitizers
scripts/ci/contracts
scripts/ci/shellcheck
scripts/ci/actionlint
```

The corresponding `just` recipes are `ci-format`, `ci-build-test`, `ci-lint`, `ci-lsp`,
`ci-sanitizers`, `ci-contracts`, `ci-shellcheck`, and `ci-actionlint`. `scripts/ci/cpp` runs the first
four C++ jobs sequentially, while `scripts/ci/workflows` aggregates the three automation checks.
`just ci-check` runs every merge-blocking job locally in a safe sequence. On Darwin, the sanitizer
script disables unsupported LeakSanitizer while retaining ASan/UBSan; the hosted Linux lane is the
authoritative leak check.

Scheduled suites can be reproduced with:

```sh
scripts/ci/platform
scripts/ci/benchmarks smoke
nix develop --command scripts/ci/f5 smoke
```

The finite F5 gate is `nix develop --command scripts/ci/f5 extended`. The release and sanitizer
24-hour soaks are intentionally separate `scripts/ci/f5-soak <profile> 86400 300` commands and are
never inferred from a successful finite or scheduled smoke.

CI always passes `conan.lock` explicitly. If dependencies change, regenerate and review the lock
rather than bypassing it with a partial or unlocked install.
