# Installation

Release archives contain the `lemma` CLI, built web app, production dependencies,
and a pinned Node.js runtime. They run without a source checkout or development
tools. macOS and Linux builds are provided for ARM64 and x86_64. Linux builds
target glibc (Ubuntu 24.04 or newer is tested); Alpine/musl and Windows are not
supported. Git and a shell are needed for workspace and agent tools.

## Homebrew

```sh
brew install phongndo/tap/lemma
brew upgrade lemma
```

Homebrew manages the files and installs Git if needed. The tap picks up stable
releases from Lemma's generated formula, automatically within six hours, or
immediately when its updater is dispatched.

## Portable installer

```sh
curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh | sh
```

The installer requires `curl`, `tar`, and either `shasum` or `sha256sum`. It checks
the archive's SHA-256 before installing a versioned directory under
`~/.local/share/lemma/releases`, then switches the `~/.local/bin/lemma` symlink.
It does not edit your shell profile. Add `~/.local/bin` to PATH if needed:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Rerun the installer to update, then restart running hosts so they use the new
code. Older directories stay in place so an update does not remove code a
running host still needs. Once all hosts have stopped, unused release
directories can be removed.

To choose a release, including a prerelease:

```sh
curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh |
  LEMMA_VERSION=v0.1.1 sh
```

`LEMMA_INSTALL_DIR` changes the command directory; `LEMMA_DATA_DIR` changes the
release directory. Both must be absolute paths. The installer refuses to replace
an existing command it does not own; update a Homebrew install through Homebrew.
`LEMMA_RELEASE_BASE_URL` can point to a directory on a download mirror containing
the selected release's archives and checksum files.

## Try a preview before a release

The repository's **Check** workflow uploads a `lemma-<platform>-<architecture>`
artifact for each supported platform. Download the matching artifact from the
[Actions run](https://github.com/phongndo/lemma/actions/workflows/check.yml),
unzip it, then check and extract its archive. For example, on Apple Silicon:

```sh
shasum -a 256 -c lemma-v0.1.1-darwin-arm64.tar.gz.sha256
tar -xzf lemma-v0.1.1-darwin-arm64.tar.gz
cd your-project
/path/to/lemma-v0.1.1-darwin-arm64/bin/lemma serve
```

Use the version and target actually named in your download; on Linux,
`sha256sum -c` also works. The extracted directory can move as a unit. You can
link its `bin/lemma` onto PATH. Preview artifacts expire after 14 days; GitHub
release assets are the persistent downloads.

To build and check a package yourself from a checkout:

```sh
nix develop -c pnpm install --frozen-lockfile
nix develop -c pnpm dist:build
nix develop -c pnpm dist:check
```

The archive and checksum land in `dist/`. The check installs into temporary
directories, starts a host with a separate home, tests the web assets and local
plugins, and runs a mock agent turn without provider credentials.

## First use and removal

Run `lemma serve` in your project, then connect a provider in the browser.
`lemma login <provider>` also works from another terminal. Settings and sessions
live in `~/.lemma`; [configuration](configuration.md) describes overrides and
project trust. For a disposable trial, set `LEMMA_HOME` to a separate directory
on both the host and CLI commands.

To remove Homebrew's installation, run `brew uninstall lemma`. For a default
portable installation, stop Lemma, remove `~/.local/bin/lemma`, and remove
`~/.local/share/lemma`. Your `~/.lemma` settings, credentials, and sessions are
separate and survive removal.
