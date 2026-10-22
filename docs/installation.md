# Installation

A release holds the `lemma` command, the host, and the web app, with the
Node.js they run on, so it needs no checkout, Nix, or Node.js. There is one
for macOS on Apple silicon and for Linux (glibc) on x64 and arm64; Windows is
not supported. On NixOS, its Node.js needs
[nix-ld](https://github.com/nix-community/nix-ld) (`programs.nix-ld.enable = true`).
Each release also has the [desktop app](#the-desktop-app) for those platforms.

```sh
curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh | sh
```

It installs the stable release, or says there is none yet. It needs `curl`, `tar`, and `shasum` or `sha256sum`. It downloads
this machine's archive of a [release](https://github.com/phongndo/lemma/releases),
checks it against its SHA-256, puts it in a directory of its own under
`~/.local/share/lemma/releases`, and links `~/.local/bin/lemma` to it. It
edits no shell profile, and says when `~/.local/bin` is not on your PATH. It
replaces only a `lemma` it installed, never one another package manager or you
put there.

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

Settings › About says which release the app is. It does not update itself
yet: install the new version's file as you did the first. The `lemma` in your
terminal is the installer's, a separate install of its own: keep it at the
app's version (`lemma update <version>`), as both use `~/.lemma`. To remove the
app, move Lemma from Applications to the Trash, run
`sudo apt remove lemma-desktop`, or delete the AppImage; `~/.lemma` stays.

## Updating

Settings › About in the web app says which release runs and whether a newer
one is out on your channel, which the host asks every few hours (its badge
shows when one is, and `lemma doctor` says so too). Its Update button installs
it and restarts the host on it, saying first what that cuts off, then reloads
the page. From a terminal:

```sh
lemma update --check            # whether a newer release is out on your channel
lemma update                    # install it
lemma restart                   # run the host on it
lemma update --channel nightly  # follow the other channel from now on
lemma update 0.2.5              # install that release: an older one rolls back
```

With no version, `lemma update` installs the channel's newest only when it is
newer, so a stable release rolled back leaves you where you are: going back is
`lemma update <version>`. It installs as the installer does, with the
installer the release carries, one install at a time (an install that was
killed leaves a lock the next takes back): the new release in a
directory of its own, `lemma` switched to it once it runs, the release before
kept and older ones removed but for any a running host still uses. A running
host keeps the release it started with until `lemma restart` stops it, saying
first what that cuts off, and starts it again on the new one: a user service
through the service manager, since it runs the `lemma` the installer links
(`lemma service install`); any other in the background, for the same project
and on the same port. `lemma version` says which release a `lemma` is, and the
channel it follows. Turning off `release.updates`'s `check` stops the host
asking ([release.updates](../domains/release/updates/README.md)).

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

## Removing

Stop the host (`lemma stop`, or `lemma service uninstall` for one a service
runs), then remove `~/.local/bin/lemma` and `~/.local/share/lemma`. Your
settings, credentials, and sessions in `~/.lemma` stay unless you remove that
too.
