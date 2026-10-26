# Development

The dev shell supplies Node.js 24 and pnpm from [`flake.nix`](../flake.nix),
for CI too. Node runs the TypeScript sources directly through type stripping,
so source must use erasable syntax only (`erasableSyntaxOnly` enforces it).
Processes run with `--conditions=lemma-source`, which selects `@lemma/core`'s
and `@lemma/router`'s sources over their builds; the condition is Lemma's own because dependencies
publish a `source` condition for files they do not ship.

The type checker is [tsrs](https://github.com/oxc-project/tsrs), a Rust port of
TypeScript 7's compiler: each package's `check` is `tsrs --noEmit`, and the
core's and router's builds are `tsrs -p`. It reports what TypeScript does, a few
times faster and in under half the memory. It follows a TypeScript prerelease,
which its version names, so a message can differ slightly from a stable
`tsc`'s. The packed-package check (`pnpm package:check`) still type-checks a
consumer with TypeScript itself, as the packages' users do. Its Linux binary
links against glibc: on NixOS it runs through `programs.nix-ld`.

```sh
nix develop -c pnpm install --frozen-lockfile
nix develop -c pnpm check          # build, import boundaries, test hygiene, lint, format check, type-check
nix develop -c pnpm test           # every package's tests
nix develop -c pnpm run ci         # check, then test: CI's check and test jobs in one
nix develop -c pnpm format         # write the formatting `pnpm check` expects
nix develop -c hk install          # git hooks (hk.pkl), below
```

`pnpm run ci` needs `run`: `pnpm ci` is pnpm's own clean install.

The hooks format and lint-fix the staged files on commit, and run `pnpm run ci`
on push; the push check sees the working tree, uncommitted changes included.
They call the dev shell's `hk`: commit and push from inside `nix develop`, or
set `HK=0` to skip them once.

CI (`.github/workflows/check.yml`) runs its checks as parallel jobs, in the dev
shell on Linux: `pnpm check`, the packed-package and browser checks, and
`pnpm test` and the web app's `ui:check`, each in two halves on runners of
their own (`--shard=1/2`, `--shard=2/2`); on main, macOS runs `pnpm test` in
thirds, with plain Node.js and pnpm. Pull requests skip macOS: GitHub's free
plan runs five macOS jobs at once, so one pull request's run queued behind
another's, and a Mac that pushes has run the tests in the pre-push hook
(`gh workflow run check.yml --ref <branch>` runs them on a branch). The
tests' shards are split by how long each file took (`scripts/test-shards.ts`,
from `scripts/test-durations.json`), so they end
together; when they drift apart, `nix develop -c pnpm test:durations` measures
again. The `passed` job succeeds only when every
other job does, so it is the one check a branch rule needs to require. Daily it reruns
every job on main, unchanged, so a flake shows.

A red run means a change broke something, not that a runner was slow. CI
tries a failed test again, twice, a second apart (`--retry.count=2
--retry.delay=1000`), and runs a UI check lane that failed once more
(`--retry=1`); locally neither retries, so a flake shows at once. What a
failed try saved (a test's evidence, a lane's traces) is uploaded even when a
retry passes. A check that passes only on a retry passes the run, as a warning
on it and in its summary, with what its failed try said (`scripts/flaky.ts`),
and on main the `flakes` job files it as an issue labelled `flaky`, or comments
on its open one, with each runner it flaked on (`scripts/file-issue.ts`); a
failure to file leaves the run passed. A flake is a race in the test or the
code: fix it, and close its issue.

The long checks are the Soak workflow's (`.github/workflows/soak.yml`), daily
on main: the tests with fresh seeds and many more random cases, the torture
test, the mutation checks, and the performance checks, each within a timeout of
its own. What one finds is a bug to fix, not a change that broke: a check that
fails, or hangs past its timeout, opens an issue labelled `soak`, or comments on
its open one, with the command that replays it and the end of its output, and
the run passes. It fails only when it cannot file what it found.

`node scripts/bench-compare.ts` compares the core's benchmarks, and with `--harness` the harness's, with a base
revision (see [the core's README](../packages/core/README.md#develop)).
`pnpm harness:bench` measures what the harness does per step, in simulated
time, as a session grows ([`@lemma/sim`](../packages/sim/README.md#the-harness-benchmark)):
its counts are the same on every machine, and hard budgets.

`pnpm check` also holds the runtime (what no plugin can replace: the kernel,
the runtime's contracts, the host and web runtimes, the planner, the client)
to a size budget in lines (`scripts/size.ts`), and prints how many extension
points each domain's contract declares. A change that needs more raises the
budget in the same change. It fails on a registry, hook, event, slot, or part
that no bundled plugin, example, or contract adds to, handles, or observes
outside tests, unless the script's `NO_USER` names it, and reports how many
points the examples show (`scripts/examples-coverage.ts`; `--list` says which
examples show each).

Tests wait for a condition, never a fixed time, and make their temporary files
with `mkdtemp`: `scripts/check-boundaries.ts` (in `pnpm check`) counts fixed
waits and fixed temporary names per file, and fails when a count rises above
its recorded ceiling. To show that a test is flaky, or no longer is, run it
many times at once:

```sh
nix develop -c pnpm stress apps/cli/tests/turns.test.ts --runs 30 --jobs 8
```

A flake the runners' slower cores and disks bring out may never show on a fast
machine: the Stress workflow (`.github/workflows/stress.yml`) runs the same on
a Linux or macOS runner, as Check runs there:

```sh
gh workflow run stress.yml --ref <branch> -f target=domains/workspace/tidy/tests/tidy.test.ts -f os=macos
```

Keep `pnpm dev` running while you work: it starts the host, the web app's dev
server, and the desktop window on them. The host restarts when its code changes
and the web app hot-reloads. Quitting the window leaves the rest running;
Ctrl+C stops everything.

```sh
nix develop -c pnpm dev            # host (restarting on edits), dev server, and window; prints a browser link too
nix develop -c pnpm dev:desktop    # the window again, while `pnpm dev` runs
nix develop -c pnpm lemma status   # the CLI from the checkout, on the host `pnpm dev` runs
```

What runs from a checkout (`pnpm dev`, `dev:desktop`, `dev:web`, `desktop`,
`start`, `lemma`) keeps apart from a Lemma you [installed](installation.md), so
the two run side by side and a development build never reaches your sessions
and settings. Each has its own (`KINDS` in `packages/host/src/paths.ts`):

|                                           | Installed                 | Checkout                            |
| ----------------------------------------- | ------------------------- | ----------------------------------- |
| Home, unless `LEMMA_HOME` names another   | `~/.lemma`                | `~/.lemma-dev`                      |
| The host's port                           | 7433                      | 7533                                |
| Its profiles' ports                       | 7434 up                   | 7534 up                             |
| Its service (systemd, launchd)            | `lemma`, `dev.lemma.host` | `dev-lemma`, `dev.lemma.dev-host`   |
| Its icon, in a window and a tab           | charcoal                  | [orange](../assets/brand/README.md) |
| Its name, in a window's and a tab's title | `lemma`                   | `lemma dev`                         |
| Its desktop app: name, links              | Lemma, `lemma://`         | Lemma Dev, `lemma-dev://`           |

Neither runs a host on the other's home, nor starts, stops, or restarts one
there: a `LEMMA_HOME` naming it, inherited from the other's host or your shell,
is refused unless `LEMMA_ALLOW_OTHER_HOME=1`. A host names its home to the
tools it runs only when it is not its kind's own (a profile's, or another
`LEMMA_HOME`), so `pnpm dev` run by an installed Lemma's agent uses
`~/.lemma-dev`. `pnpm dev:web` alone proxies to the host running on the
checkout's home, else to 7533, unless `LEMMA_HOST_URL` names another. Log in to
a provider there once. Every checkout shares `~/.lemma-dev`, which has one host
at a time.

Browser checks (the web app's `ui:check`, the core's `browser:check`) run in
the `browser` shell, which supplies pinned Chromium on Linux. On macOS, install
one with `nix develop .#browser -c pnpm exec playwright install chromium`, or
set `LEMMA_CHROMIUM` to an existing executable.

Randomized tests run a fixed number of seeded cases in `pnpm test` and many
more in the Soak workflow, through `pnpm test:random`; a failure prints the
seed and path that replay it:

| Test                                              | Checks                                                                                                                            | Variables (`_RUNS`, `_SEED`, `_PATH`) |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `packages/core/tests/sequences.test.ts`           | the kernel's load, reload, fail, and restart sequences                                                                            | `LEMMA_SEQUENCE_*`                    |
| `domains/sessions/files/tests/simulation.test.ts` | the session log on a simulated disk that crashes, tears writes, and fails ([README](../domains/sessions/files/README.md#testing)) | `LEMMA_SIM_*`                         |
| `domains/agent/loop/tests/conversation.test.ts`   | random conversations and checkouts: every request is well formed and rebuilds from the log                                        | `LEMMA_CONVERSATION_*`                |
| `packages/sim/tests/world.test.ts`                | the harness in simulated time under a seed's workload and faults, crashes, and restarts ([README](../packages/sim/README.md))     | `LEMMA_HARNESS_*` (`_TICKS`)          |

Code a simulation runs (the sessions store, the agent loop, the tool registry,
compaction, the kernel's step timings) takes its disk as a `FileSystem`
(`@lemma/contracts/fs`), its time and timers from Effect's `Clock`, and its
randomness from Effect's `Random` or, where it must stay unguessable, the
`IdSource` it is made with (`@lemma/contracts`), so these tests control all of
them; `scripts/check-boundaries.ts` fails on a seamed file that reaches around
them (the wall clock, a timer, a random source, `node:fs`). Its invariants are
`assert`ed (`@lemma/core`), on in production; checks too costly for every call
run only under `Verify`, which a simulation turns on. [`@lemma/testing`](../packages/testing/README.md) holds the
simulated disk and the contract conformance suites.

`scripts/mock-openai.ts` is a scripted provider for end-to-end runs without an
API key; `scripts/e2e.ts` starts it and a host for tests. The web app's
`ui:check` runs on such hosts too ([its AGENTS.md](../apps/web/AGENTS.md)).

`pnpm torture` tests the harness from the outside, under process faults
(`scripts/torture.ts`, in the Soak workflow):

- **Setup.** A real host, the scripted provider over HTTP, and the CLI.
- **Workload.** A seeded workload sends, retries, cancels, and withdraws
  prompts. Meanwhile the host is killed (`kill -9`) and restarted, or stopped
  (`SIGSTOP`) and continued.
- **Liveness.** Then every prompt is asked for again by its request id, and
  must reach the end of a turn.
- **Safety.** The logs, read back through the CLI, must show:
  - parents in order;
  - turns in pairs;
  - each tool call answered once;
  - each request placed at most once;
  - no command unsafe to repeat run twice.

`--seed` (`LEMMA_TORTURE_SEED`) replays the workload. The processes' timing is
not replayed, so a failing run is not reproduced bit for bit, as the
simulator's is. `--seconds` (`LEMMA_TORTURE_SECONDS`, default 30) sets how
long the workload runs.

A failing simulation seed, fault-point test, or torture run saves its evidence
before its temporary files go: the seed and the command that replays it, what
the run did last, and the disk or home it left, never credentials. It goes
under `LEMMA_TEST_ARTIFACTS` (the OS temp directory by default), which CI
uploads when a job fails ([`@lemma/testing`](../packages/testing/README.md#failure-evidence)).

`nix develop -c pnpm test:mutations` checks that the tests still catch what
they are for: in a copy of the working tree, it puts back faults the harness
has had, and faults a replacement provider could have, one at a time, and
fails when a fault's focused test no longer fails with an assertion
(`scripts/test-mutations.ts` lists them).

The web app's conventions are in [its AGENTS.md](../apps/web/AGENTS.md), and
the core's checks and benchmarks in [its README](../packages/core/README.md#develop).

## Releases

A release is an archive for each platform with the `lemma` command, the host,
the built web app, their production dependencies, and the Node.js they run on
([installation](installation.md)). `nix develop -c pnpm dist` builds this
platform's into `dist/` at the checkout's version (`scripts/dist.ts`;
`--target all` builds every platform's, `--version` sets the version).
`nix develop -c pnpm dist:check` installs it with `scripts/install.sh`, outside
the checkout and with a `node` on PATH that fails, and runs it: the host and
its plugins, the web app, a TypeScript plugin file, the file search, the CLI
the agent is told of, and a turn on the scripted provider. CI's `dist` job
runs both for Linux on x64. For tests, the installer and `lemma update` take
two variables, which `dist:check` points at a server of its own:
`LEMMA_RELEASE_BASE_URL`, a directory holding the release's archive and its
`.sha256` (the release on GitHub by default), and `LEMMA_RELEASE_API_URL`,
where they ask which release is a channel's newest (GitHub's API for this
repository by default).

Each Check run keeps the Linux x64 archive it built, and the desktop app made
from it, for a week, as its `lemma-linux-x64` artifact, so a pull request can
be tried before it is merged:

```sh
gh run download <run-id> --repo phongndo/lemma --name lemma-linux-x64 --dir /tmp/lemma-preview
(cd /tmp/lemma-preview && sha256sum -c ./*.sha256 && tar -xzf ./*.tar.gz)
LEMMA_HOME=/tmp/lemma-preview/home /tmp/lemma-preview/lemma-v*/bin/lemma serve      # in your project
```

An archive says what it is in `release.json` (its version, the commit it was
built from, and when), and carries the installer, which `lemma update` runs
([updating](installation.md#updating)). The archive keeps the workspace's layout, as
Lemma runs its TypeScript sources: Node.js strips types only outside `node_modules`, and the host finds
the web app and each bundled plugin by its path in the workspace. One machine
builds every platform's, as pnpm installs another platform's prebuilt packages
when told it (`--os`, `--cpu`, `--libc`); nothing compiles at install, so a
dependency that must would fail that platform's check. `scripts/dist-config.ts`
pins the Node.js an archive carries, by version and checksum; update them
together.

`nix develop .#desktop -c pnpm dist:desktop` builds this platform's desktop
app from its archive in `dist/` (`scripts/dist-desktop.ts` says what it holds):
a disk image on macOS, and an AppImage and a Debian package on Linux, which
builds either architecture's. `nix develop .#desktop -c pnpm dist:desktop:check`
opens one as a user would, outside the checkout, and runs it: its window, the
host it starts on Electron, what that host does as the archive's does,
quitting, and then a host the app's own `lemma` starts, on its Electron run as
Node.js (`scripts/dist-desktop-check.ts`; on Linux in a virtual display,
`xvfb-run -a` before `pnpm`). With `--installed`, it opens the Debian package
apt installed. The `desktop` shell brings what Linux needs for both: nixpkgs'
fpm for the Debian package, and on NixOS the libraries Electron loads through
nix-ld. CI's `dist` job installs and opens Linux x64's, as the Nightly workflow
does each platform's.

The macOS app is signed ad hoc, which Apple silicon requires of every app, and
not with a Developer ID, so Gatekeeper asks before it opens. Opening it without
asking takes an Apple Developer Program membership: its Developer ID
certificate and an App Store Connect API key as the Nightly workflow's secrets,
given to the macOS job as electron-builder reads them (`CSC_LINK` and
`CSC_KEY_PASSWORD`; `APPLE_API_KEY`, the key file's path, with
`APPLE_API_KEY_ID` and `APPLE_API_ISSUER`), and `dist-desktop.ts` signing with
the certificate, with the hardened runtime, rather than ad hoc. electron-builder
notarizes an app it signed when those `APPLE_API_*` variables are set.

Signing walks the app for the files to sign. electron-builder 26 signs with
`@electron/osx-sign` 1.3.3, whose walk follows links: through pnpm's in the
archive it reaches the same packages again by every path to them, millions of
paths for the archive's 15,000 files, and runs out of memory. A patch
(`patches/@electron__osx-sign@1.3.3.patch`) has it look at a link rather than
through it, as osx-sign 2 does
([osx-sign#372](https://github.com/electron/osx-sign/pull/372)); it goes when
electron-builder signs with osx-sign 2. Only the Nightly workflow builds the
macOS app: to try a change to it before merging, run Nightly on the branch
without publishing (below).

Every build is a release, and stable is the one marked latest:

- **Nightly** (`.github/workflows/nightly.yml`), daily and by hand, takes the
  newest commit on `main` whose Check run passed, unless the last release has
  it already. It numbers it the next patch in the minor version
  `apps/cli/package.json` names (`0.2.0` is `0.2`: `v0.2.0`, `v0.2.1`, …), builds every
  platform's archive on one runner and the desktop app made from each (macOS's
  on a macOS runner), installs and runs each on its platform (with the
  installer, npm's launcher, and Homebrew's formula, made for the files where
  they are and installed from a tap of its own, and on macOS its cask too),
  and publishes them as a GitHub prerelease with its installer and Homebrew's
  formula and cask (`lemma.rb`, `lemma-cask.rb`, from `scripts/homebrew.ts`),
  its notes listing the pull requests since the release before. Nightlies a
  month old that were not promoted are deleted, with their tags. By hand with
  `publish` off, it builds and checks the commit it runs on instead, and
  publishes nothing: `gh workflow run nightly.yml --ref <branch> -f
  publish=false` tries a branch's release files on every platform, the macOS
  app and Homebrew's cask included, and keeps them as the run's artifacts for a
  week (`gh run download <run-id> --name lemma-desktop-darwin-arm64`).
- **Promote** (`.github/workflows/promote.yml`), by hand, makes a nightly (the
  newest, or the version you give) the stable release: it marks it latest and
  not a prerelease, and rewrites its notes to cover everything since the last
  stable release. Nothing is rebuilt. It refuses a release older than the
  stable one unless asked to roll back: then that release is the stable one
  again, for new installs; a stable user already on the newer one stays there
  until they go back by version (`lemma update 0.2.5`) or a newer release is
  promoted. Then the package managers that install stable releases get it:
  npm's `lemma-harness` at its version (`packaging/npm`), or, published
  already, tagged `latest` again; the Nix package's `nix/release.json`, built
  and run, then committed to `main`; and Homebrew's tap, which takes up the
  release's formula and cask within the hour, or at once when
  `HOMEBREW_TAP_TOKEN` (a token that may dispatch phongndo/homebrew-tap's
  workflows) lets Promote tell it.

To ship a change: merge it, let a nightly carry it (or run the Nightly
workflow), use that nightly yourself, then promote it:
`gh workflow run promote.yml -f version=0.2.7`. To start a new minor version, set
`apps/cli/package.json`'s version (`0.3.0`) in a pull request; the next
nightly is `v0.3.0`. A run that fails publishes nothing and is safe to run
again. A published release's files are never changed; a fix is the next
nightly. When a stable release turns out bad and the fix is not ready, put the
one before back: `gh workflow run promote.yml -f version=0.2.5 -f rollback=true`.

The Nightly workflow attests each file's build provenance before publishing
it ([verifying a release](installation.md#verifying-a-release)).

npm publishes `lemma-harness` by trusted publishing: npm's settings for the
package name `promote.yml` in this repository as its publisher, so Promote
needs no token. A package's first publish comes before it has those settings,
so it takes `NPM_TOKEN`, an npm token that may publish it, as a secret, which
Promote uses while it is set; so does tagging a version published already
`latest` again (a rollback), which trusted publishing does not cover.
