# Installation

A release holds the `lemma` command, the host, and the web app. It also holds
the Node.js they run on. So it needs no checkout, Nix, or Node.js.

- There is a release for macOS on Apple silicon.
- There is one for Linux (glibc) on x64 and on arm64.
- Windows is not supported.
- Each release also has the [desktop app](#the-desktop-app) for those
  platforms.

## Install methods

Install Lemma whichever way suits you:

| Way                             | Command                                                                                     | Installs                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------- |
| [The installer](#the-installer) | `curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh \| sh` | the command, stable or [nightly](#channels) |
| [Homebrew](#homebrew)           | `brew install phongndo/tap/lemma`                                                           | the command                                 |
| [Homebrew's cask](#homebrew)    | `brew install --cask phongndo/tap/lemma`                                                    | the desktop app, and the command inside it  |
| [mise](#mise)                   | `mise use --global github:phongndo/lemma`                                                   | the command                                 |
| [npm](#npm)                     | `npm install --global lemma-harness`                                                        | the command                                 |
| [Nix](#nix)                     | `nix profile install github:phongndo/lemma`                                                 | the command                                 |
| [A download](#the-desktop-app)  | the desktop app's file from a [release](https://github.com/phongndo/lemma/releases)         | the desktop app                             |

- Each way installs the same release files.
- A package manager installs stable releases. Nightly ones come from the
  installer.
- `lemma version` says what installed a `lemma`.
- [`lemma update`](#updating) and Settings › About update it the same way.

## The installer

```sh
curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh | sh
```

It installs the stable release, or says there is none yet. It needs `curl`,
`tar`, and `shasum` or `sha256sum`. It works in these steps:

1. It downloads this machine's archive of a
   [release](https://github.com/phongndo/lemma/releases).
2. It checks the archive against its SHA-256.
3. It puts the release in a directory of its own under
   `~/.local/share/lemma/releases`.
4. It links `~/.local/bin/lemma` to it.

It edits no shell profile. It says when `~/.local/bin` is not on your PATH. It
replaces only a `lemma` it installed, never one that another package manager
or you put there.

On NixOS, the Node.js a release carries needs
[nix-ld](https://github.com/nix-community/nix-ld) (`programs.nix-ld.enable = true`).
[Nix's package](#nix) does not need it.

## Homebrew

```sh
brew install phongndo/tap/lemma          # the lemma command, on macOS and Linux
brew install --cask phongndo/tap/lemma   # the desktop app, with its lemma on PATH (macOS)
```

The [tap](https://github.com/phongndo/homebrew-tap) takes up each stable
release within an hour of its promotion.

- The formula installs the command.
- The cask installs the desktop app in Applications. It links the `lemma`
  inside the app, so the app and the command are always one release.
- Install one or the other, as both link `lemma`.
- The app is not signed with an Apple Developer ID yet. So macOS asks before it
  opens each new version ([the desktop app](#the-desktop-app)).

## mise

```sh
mise use --global github:phongndo/lemma
```

mise installs a release from GitHub itself. It installs whichever version your
config asks for: `latest`, or a prefix such as `0.2`.

## npm

```sh
npm install --global lemma-harness
```

`lemma` is another package's name on npm, so Lemma's is `lemma-harness`. The
command it installs is `lemma`.

- The first time the command runs, it fetches its version's release from
  GitHub. It checks the release against its SHA-256.
- It puts the release in `~/.local/share/lemma/npm` (`LEMMA_NPM_DIR`), outside
  `node_modules`. Lemma runs its TypeScript sources, and Node.js strips their
  types only outside `node_modules`.
- The release then runs on the Node.js it carries. The Node.js npm uses runs
  the launcher alone, and must be version 18 or later.
- pnpm's and bun's global installs work the same way (`pnpm add --global`,
  `bun add --global`).
- On NixOS, the release's Node.js needs nix-ld, as the installer's does.

## Nix

```sh
nix profile install github:phongndo/lemma
```

Or add Lemma to your configuration from the flake. The flake's
`packages.<system>.default` is Lemma's stable release, for `aarch64-darwin`,
`aarch64-linux`, and `x86_64-linux`.

```nix
{
  inputs.lemma.url = "github:phongndo/lemma";
  # in a NixOS, nix-darwin, or home-manager module:
  environment.systemPackages = [ inputs.lemma.packages.${pkgs.system}.default ];
}
```

The package is the release's archive, as the flake's `nix/release.json` names
it. On Linux it runs on nixpkgs' Node.js 24. Its native libraries are patched
to find theirs in the store, so NixOS needs no nix-ld.

## Channels

Each night that `main` has changed, its newest commit that passed its checks
is published as the next release: `v0.2.7`, then `v0.2.8`.

Stable is the release marked latest on GitHub. It moves only when a nightly has
held up and is promoted. So a stable release is the same files nightly users
ran ([releases](development.md#releases)).

| Channel   | Installs                                | For                                      |
| --------- | --------------------------------------- | ---------------------------------------- |
| `stable`  | the release marked latest (the default) | using Lemma                              |
| `nightly` | the newest release                      | trying what is on `main`, and testing it |

For nightly, give the installer its channel:

```sh
curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh | LEMMA_CHANNEL=nightly sh
```

- The installer records the channel with the release, and `lemma update`
  follows it.
- `lemma update --channel stable` switches back.
- A release installed by version alone (`LEMMA_VERSION`) is pinned. It follows
  no channel, so nothing says when a newer one is out. That lasts until
  `lemma update --channel` names a channel.
- There is one `lemma` at a time. Both channels use `~/.lemma`, so your
  settings, credentials, and sessions stay.
- Going from nightly to stable means going back to an older release. An older
  release may not read what a newer one wrote.

| Variable            | Default                                | Meaning                                                                  |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `LEMMA_CHANNEL`     | `stable`, or none with `LEMMA_VERSION` | `stable` or `nightly`, as above                                          |
| `LEMMA_VERSION`     | the channel's newest                   | The release to install, by version (`0.2.7`), whichever channel it is in |
| `LEMMA_INSTALL_DIR` | `~/.local/bin`                         | Where the `lemma` command goes, as an absolute path                      |
| `LEMMA_DATA_DIR`    | `~/.local/share/lemma`                 | Where the releases go, as an absolute path                               |

## First use

```sh
cd your-project
lemma serve
```

The host starts and opens the web app.

1. Log in to a provider from the key icon, or with `lemma login` in another
   terminal.
2. Start a thread.

Ctrl+C stops the host. `lemma serve --detach` runs it in the background.

- [Usage](usage.md) says more.
- [Configuration](configuration.md) says where your settings, credentials, and
  sessions are (`~/.lemma`).
- The agent's tools run Git and a shell.
- Its browser tools need Chrome or Chromium on the machine
  ([browser.chromium](../domains/browser/chromium/README.md)).

## The desktop app

The [desktop app](../apps/desktop/README.md) is the web app in a window of its
own. The release is inside it: the host it starts when none runs, and the
`lemma` command that host and its agent run. All are at the app's version.

Download the file for your system from a
[release](https://github.com/phongndo/lemma/releases):

| System                | File                                             | Install                                   |
| --------------------- | ------------------------------------------------ | ----------------------------------------- |
| macOS (Apple silicon) | `lemma-desktop-v<version>-darwin-arm64.dmg`      | Open it and drag Lemma into Applications  |
| Debian, Ubuntu        | `lemma-desktop-v<version>-linux-<arch>.deb`      | `sudo apt install ./lemma-desktop-v*.deb` |
| Other Linux           | `lemma-desktop-v<version>-linux-<arch>.AppImage` | `chmod +x` it, then run it                |

- **macOS asks before it opens the app.** The app is not signed with an Apple
  Developer ID yet. So macOS says it cannot check the app for malicious
  software.
  1. Open System Settings › Privacy & Security.
  2. Choose **Open Anyway** beside "Lemma was blocked".
  3. Confirm.

  Each new version asks again.

- **On Ubuntu 24.04 and later, prefer the Debian package.** Electron's sandbox
  needs user namespaces. Ubuntu keeps an app from them unless AppArmor lets
  it. The package installs the AppArmor profile that does. An AppImage has no
  profile, so there it runs without the sandbox.
- **On NixOS,** run the AppImage with `appimage-run` (nixpkgs). It gives the
  AppImage the libraries it expects.

Settings › About says which release the app is.

- Installed with [Homebrew's cask](#homebrew), the app updates from there.
  Homebrew replaces it, and **Reopen Lemma** runs the new release.
- Downloaded, the app says when a newer release is out. Install the new
  version's file as you did the first.
- A `lemma` in your terminal from another install is a separate one. Keep it
  at the app's version, as both use `~/.lemma`. The cask's `lemma` is the
  app's own.

To remove the app, do one of these. `~/.lemma` stays.

- Move Lemma from Applications to the Trash.
- Run `sudo apt remove lemma-desktop`.
- Delete the AppImage.

## Updating

Settings › About in the web app says three things:

- which release runs;
- what installed it;
- whether a newer one is out on your channel.

The host asks about newer releases every few hours. The badge shows when one
is out, and `lemma doctor` says so too.

The Update button installs the new release the way this Lemma was installed.
It restarts the host on it, and first says what the restart cuts off. Then it
reloads the page.

From a terminal:

```sh
lemma update --check            # whether a newer release is out on your channel
lemma update                    # install it
lemma restart                   # run the host on it
lemma update --channel nightly  # follow the other channel from now on (the installer's)
lemma update 0.2.5              # install that release: an older one rolls back
```

`lemma update` installs the way `lemma version` says this one was installed:

| Installed with  | `lemma update` runs                                                          | By hand                                                              |
| --------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| the installer   | the installer the release carries, on its channel                            | the installer again                                                  |
| Homebrew        | `brew update`, then `brew upgrade phongndo/tap/lemma`                        | the same                                                             |
| Homebrew's cask | `brew update`, then `brew upgrade --cask phongndo/tap/lemma`; reopen the app | the same                                                             |
| mise            | `mise upgrade github:phongndo/lemma`; with a version, `mise use --global`    | the same                                                             |
| npm             | `npm install --global lemma-harness@<version>`                               | the same, then any `lemma` fetches the release                       |
| Nix             | nothing: it says how                                                         | `nix flake update lemma` and rebuild, or `nix profile upgrade lemma` |
| a download      | nothing: it says how                                                         | download the next release's file                                     |

With no version, `lemma update` installs the channel's newest release only
when it is newer. So when a stable release is rolled back, you stay where you
are. To go back, run `lemma update <version>`.

- A package manager follows stable.
- Homebrew installs only its tap's newest release. So for nightly, or for a
  version Homebrew does not have, use the installer.
- The tap takes up a release within an hour of its promotion. `lemma update`
  says when it has not yet.
- Homebrew runs without its cleanup. So a running host keeps its files until
  it restarts.

The installer installs one release at a time. An install that was killed
leaves a lock, and the next install takes it back.

- It puts the new release in a directory of its own.
- It switches `lemma` to the new release once that release runs.
- It keeps the release before. It removes older ones, but not any that a
  running host still uses.

A running host keeps the release it started with until `lemma restart`.
`lemma restart` first says what the restart cuts off. Then it stops the host
and starts it again on the new release:

- A user service restarts through the service manager, since it runs the
  `lemma` that the installer or package manager links
  (`lemma service install`).
- Any other host restarts in the background, for the same project and on the
  same port.
- A host the desktop app runs runs the new release once the app is reopened.
  That applies when Homebrew's cask replaced the app.

`lemma version` says which release a `lemma` is, what installed it, and the
channel it follows. Turn off `release.updates`'s `check` to stop the host
asking ([release.updates](../domains/release/updates/README.md)).

[Versioning](versioning.md) says what a new release may change. `lemma plugins`
says why a plugin written for another release is left out
([configuration](configuration.md#when-something-cannot-run)).

## Verifying a release

The installer checks an archive against the `.sha256` beside it. That says the
archive arrived whole.

The archive's build attestation says it was built by this repository's Nightly
workflow, from the commit it names. The GitHub CLI checks the attestation:

```sh
gh attestation verify lemma-v0.2.7-linux-x64.tar.gz --repo phongndo/lemma \
  --signer-workflow phongndo/lemma/.github/workflows/nightly.yml
```

- The desktop app's files have an attestation each too. Verify one the same
  way, by its name.
- Homebrew's formula and cask, npm's launcher, and Nix's package each check the
  same SHA-256 before they install a release.

## Removing

Stop the host first. Run `lemma stop`, or `lemma service uninstall` for a host
a service runs. Then remove Lemma the way it was installed:

| Installed with | Remove                                                                 |
| -------------- | ---------------------------------------------------------------------- |
| the installer  | `~/.local/bin/lemma` and `~/.local/share/lemma`                        |
| Homebrew       | `brew uninstall lemma`, or `brew uninstall --cask lemma`               |
| mise           | `mise uninstall github:phongndo/lemma`, and its line in your config    |
| npm            | `npm uninstall --global lemma-harness`, and `~/.local/share/lemma/npm` |
| Nix            | `nix profile remove lemma`, or its line in your configuration          |

Your settings, credentials, and sessions in `~/.lemma` stay, unless you remove
that too.
