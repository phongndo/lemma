# Installation

A release holds the `lemma` command, the host, and the web app, with the
Node.js they run on, so it needs no checkout, Nix, or Node.js. There is one
for macOS on Apple silicon and for Linux (glibc) on x64 and arm64; Windows is
not supported. Each release also has the [desktop app](#the-desktop-app) for
those platforms. Install it whichever way suits you:

| Way                             | Command                                                                                     | Installs                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------- |
| [The installer](#the-installer) | `curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh \| sh` | the command, stable or [nightly](#channels) |
| [Homebrew](#homebrew)           | `brew install phongndo/tap/lemma`                                                           | the command                                 |
| [Homebrew's cask](#homebrew)    | `brew install --cask phongndo/tap/lemma`                                                    | the desktop app, and the command inside it  |
| [mise](#mise)                   | `mise use --global github:phongndo/lemma`                                                   | the command                                 |
| [npm](#npm)                     | `npm install --global lemma-harness`                                                        | the command                                 |
| [Nix](#nix)                     | `nix profile install github:phongndo/lemma`                                                 | the command                                 |
| [A download](#the-desktop-app)  | the desktop app's file from a [release](https://github.com/phongndo/lemma/releases)         | the desktop app                             |

Each installs the same release files. A package manager installs stable
releases; nightly ones come from the installer. `lemma version` says what
installed a `lemma`, and [`lemma update`](#updating) and Settings › About
update it that way.

## The installer

```sh
curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh | sh
```

It installs the stable release, or says there is none yet. It needs `curl`, `tar`, and `shasum` or `sha256sum`. It downloads
this machine's archive of a [release](https://github.com/phongndo/lemma/releases),
checks it against its SHA-256, puts it in a directory of its own under
`~/.local/share/lemma/releases`, and links `~/.local/bin/lemma` to it. It
edits no shell profile, and says when `~/.local/bin` is not on your PATH. It
replaces only a `lemma` it installed, never one another package manager or you
put there. On NixOS, the Node.js a release carries needs
[nix-ld](https://github.com/nix-community/nix-ld) (`programs.nix-ld.enable = true`);
[Nix's package](#nix) does not.

## Homebrew

```sh
brew install phongndo/tap/lemma          # the lemma command, on macOS and Linux
brew install --cask phongndo/tap/lemma   # the desktop app, with its lemma on PATH (macOS)
```

The [tap](https://github.com/phongndo/homebrew-tap) takes up each stable
release within an hour of its promotion. The formula installs the command;
the cask installs the desktop app in Applications and links the `lemma` inside
it, so the app and the command are always one release. Install one or the
other, as both link `lemma`. The app is not signed with an Apple Developer ID
yet, so macOS asks before it opens each new version
([the desktop app](#the-desktop-app)).

## mise

```sh
mise use --global github:phongndo/lemma
```

mise installs a release from GitHub itself, whichever version your config asks
for (`latest`, or a prefix such as `0.2`).

## npm

```sh
npm install --global lemma-harness
```

`lemma` is another package's name on npm, so Lemma's is `lemma-harness`; the
command it installs is `lemma`. The first time it runs, it fetches its
version's release from GitHub, checked against its SHA-256, into
`~/.local/share/lemma/npm` (`LEMMA_NPM_DIR`), outside `node_modules`, as Lemma
runs its TypeScript sources and Node.js strips their types only there. The
release then runs on the Node.js it carries: the one npm uses runs the
launcher alone (version 18 or later). pnpm's and bun's global installs work the
same (`pnpm add --global`, `bun add --global`). On NixOS, the release's Node.js
needs nix-ld, as the installer's does.

## Nix

```sh
nix profile install github:phongndo/lemma
```

Or in your configuration, from the flake: its `packages.<system>.default` is
Lemma's stable release, for `aarch64-darwin`, `aarch64-linux`, and
`x86_64-linux`.

```nix
{
  inputs.lemma.url = "github:phongndo/lemma";
  # in a NixOS, nix-darwin, or home-manager module:
  environment.systemPackages = [ inputs.lemma.packages.${pkgs.system}.default ];
}
```

It is the release's archive, as the flake's `nix/release.json` names it. On
Linux it runs on nixpkgs' Node.js 24, its native libraries patched to find
theirs in the store, so NixOS needs no nix-ld.

## Channels

Each night that `main` has changed, its newest commit that passed its checks
is published as the next release: `v0.2.7`, then `v0.2.8`. Stable is the one
of them marked latest on GitHub, which moves only when a nightly has held up
and is promoted, so a stable release is the same files nightly users ran
([releases](development.md#releases)).

| Channel   | Installs                                | For                                      |
| --------- | --------------------------------------- | ---------------------------------------- |
| `stable`  | the release marked latest (the default) | using Lemma                              |
| `nightly` | the newest release                      | trying what is on `main`, and testing it |

For nightly, give the installer its channel:

```sh
curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh | LEMMA_CHANNEL=nightly sh
```

The installer records the channel with the release, and `lemma update` follows
it; `lemma update --channel stable` switches back. A release installed by
version alone (`LEMMA_VERSION`) is pinned: it follows no channel, so nothing
says when a newer one is out, until `lemma update --channel` names one. There
is one `lemma` at a time, and both channels use `~/.lemma`, so your settings,
credentials, and sessions stay. Going from nightly to stable is going back to
an older release, which may not read what a newer one wrote.

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

The host starts and opens the web app: log in to a provider from the key icon
(or with `lemma login` in another terminal), then start a thread. Ctrl+C stops
the host; `lemma serve --detach` runs it in the background. [Usage](usage.md)
says more, and [configuration](configuration.md) where your settings,
credentials, and sessions are (`~/.lemma`). The agent's tools run Git and a
shell; its browser tools need a Chrome or Chromium on the machine
([browser.chromium](../domains/browser/chromium/README.md)).

## The desktop app

The [desktop app](../apps/desktop/README.md) is the web app in a window of its
own, with the release inside it: the host it starts when none runs, and the
`lemma` command that host and its agent run, all at the app's version.
Download the file for your system from a
[release](https://github.com/phongndo/lemma/releases):

| System                | File                                             | Install                                   |
| --------------------- | ------------------------------------------------ | ----------------------------------------- |
| macOS (Apple silicon) | `lemma-desktop-v<version>-darwin-arm64.dmg`      | Open it and drag Lemma into Applications  |
| Debian, Ubuntu        | `lemma-desktop-v<version>-linux-<arch>.deb`      | `sudo apt install ./lemma-desktop-v*.deb` |
| Other Linux           | `lemma-desktop-v<version>-linux-<arch>.AppImage` | `chmod +x` it, then run it                |

- **macOS asks before it opens the app.** It is not signed with an Apple
  Developer ID yet, so macOS says it cannot check it for malicious software.
  Open System Settings › Privacy & Security, choose **Open Anyway** beside
  "Lemma was blocked", and confirm. Each new version asks again.
- **On Ubuntu 24.04 and later, prefer the Debian package.** Ubuntu keeps an
  app from the user namespaces Electron's sandbox needs unless AppArmor lets
  it, and the package installs the profile that does. An AppImage has none, so
  there it runs without the sandbox.
- **On NixOS,** run the AppImage with `appimage-run` (nixpkgs), which gives it
  the libraries it expects.

Settings › About says which release the app is. Installed with
[Homebrew's cask](#homebrew), the app updates from there: Homebrew replaces it,
and **Reopen Lemma** runs the new release. Downloaded, it says a newer release
is out: install the new version's file as you did the first. A `lemma` in your
terminal from another install is a separate one: keep it at the app's version,
as both use `~/.lemma` (the cask's `lemma` is the app's own). To remove the
app, move Lemma from Applications to the Trash, run
`sudo apt remove lemma-desktop`, or delete the AppImage; `~/.lemma` stays.

## Updating

Settings › About in the web app says which release runs, what installed it,
and whether a newer one is out on your channel, which the host asks every few
hours (its badge shows when one is, and `lemma doctor` says so too). Its Update
button installs it the way this Lemma was installed and restarts the host on
it, saying first what that cuts off, then reloads the page. From a terminal:

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

With no version, `lemma update` installs the channel's newest only when it is
newer, so a stable release rolled back leaves you where you are: going back is
`lemma update <version>`. A package manager follows stable, and Homebrew
installs its tap's newest alone, so for nightly, or a version Homebrew has not,
use the installer. The tap takes up a release within an hour of its promotion;
`lemma update` says when it has not yet. Homebrew runs without its cleanup, so
a running host keeps its files until it restarts. The installer installs one
at a time (an install that was killed leaves a lock the next takes back): the
new release in a directory of its own, `lemma` switched to it once it runs,
the release before kept and older ones removed but for any a running host
still uses. A running host keeps the release it started with until `lemma
restart` stops it, saying first what that cuts off, and starts it again on the
new one: a user service through the service manager, since it runs the
`lemma` the installer or package manager links (`lemma service install`); any
other in the background, for the same project and on the same port. A host the
desktop app runs, its app replaced by Homebrew's cask, runs the new release
once the app is reopened. `lemma version` says which release a `lemma` is,
what installed it, and the channel it follows. Turning off
`release.updates`'s `check` stops the host asking
([release.updates](../domains/release/updates/README.md)).

[Versioning](versioning.md) says what a new release may change; `lemma plugins`
says why a plugin written for another one is left out
([configuration](configuration.md#when-something-cannot-run)).

## Verifying a release

The installer checks an archive against the `.sha256` beside it, which says it
arrived whole. That it was built by this repository's Nightly workflow, from
the commit it names, its build attestation says, which the GitHub CLI checks:

```sh
gh attestation verify lemma-v0.2.7-linux-x64.tar.gz --repo phongndo/lemma \
  --signer-workflow phongndo/lemma/.github/workflows/nightly.yml
```

The desktop app's files have one each too: verify one the same way, by its name.
Homebrew's formula and cask, npm's launcher, and Nix's package each check the
same SHA-256 before they install a release.

## Removing

Stop the host (`lemma stop`, or `lemma service uninstall` for one a service
runs), then remove Lemma the way it was installed:

| Installed with | Remove                                                                 |
| -------------- | ---------------------------------------------------------------------- |
| the installer  | `~/.local/bin/lemma` and `~/.local/share/lemma`                        |
| Homebrew       | `brew uninstall lemma`, or `brew uninstall --cask lemma`               |
| mise           | `mise uninstall github:phongndo/lemma`, and its line in your config    |
| npm            | `npm uninstall --global lemma-harness`, and `~/.local/share/lemma/npm` |
| Nix            | `nix profile remove lemma`, or its line in your configuration          |

Your settings, credentials, and sessions in `~/.lemma` stay unless you remove
that too.
