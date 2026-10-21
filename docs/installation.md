# Installation

A release holds the `lemma` command, the host, and the web app, with the
Node.js they run on, so it needs no checkout, Nix, or Node.js. There is one
for macOS on Apple silicon and for Linux (glibc) on x64 and arm64; Windows is
not supported. On NixOS, its Node.js needs
[nix-ld](https://github.com/nix-community/nix-ld) (`programs.nix-ld.enable = true`). The desktop app is not in a release yet: `lemma serve` opens
the web app in your browser.

```sh
curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh | sh
```

The installer needs `curl`, `tar`, and `shasum` or `sha256sum`. It downloads
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

```sh
curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh | LEMMA_CHANNEL=nightly sh
```

The installer records the channel with the release, and `lemma update` follows
it; `lemma update --channel stable` switches back. There is one `lemma` at a
time, and both channels use `~/.lemma`, so your settings, credentials, and
sessions stay. Going from nightly to stable is going back to an older release,
which may not read what a newer one wrote.

| Variable                 | Default                | Meaning                                                                        |
| ------------------------ | ---------------------- | ------------------------------------------------------------------------------ |
| `LEMMA_CHANNEL`          | `stable`               | `stable` or `nightly`, as above                                                |
| `LEMMA_VERSION`          | the channel's          | The release to install, by version (`0.2.7`), whichever channel it is in       |
| `LEMMA_INSTALL_DIR`      | `~/.local/bin`         | Where the `lemma` command goes, as an absolute path                            |
| `LEMMA_DATA_DIR`         | `~/.local/share/lemma` | Where the releases go, as an absolute path                                     |
| `LEMMA_RELEASE_BASE_URL` | the release on GitHub  | A directory holding the release's archive and its `.sha256`, such as a mirror  |
| `LEMMA_RELEASE_API_URL`  | GitHub's, for Lemma    | Where the installer and `lemma update` ask which release is a channel's newest |

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

`lemma update` installs as the installer does, with the installer the release
carries: the new release in a directory of its own, `lemma` switched to it once
it runs, the release before kept and older ones removed. A running host keeps
the release it started with, which is why the one before stays, until
`lemma restart` stops it, saying first what that cuts off, and starts it again
on the new one: a user service through the service manager, since it runs the
`lemma` the installer links (`lemma service install`); any other in the
background, for the same project and on the same port. `lemma version` says
which release a `lemma` is ([versioning](versioning.md)). Turning off
`release.updates`'s `check` stops the host asking
([release.updates](../domains/release/updates/README.md)).

While Lemma is 0.x, a release may change what plugins are written against: a
plugin written for another version is left out, and `lemma plugins` says why
([configuration](configuration.md#when-something-cannot-run)).

## Verifying a release

The installer checks an archive against the `.sha256` beside it, which says it
arrived whole. That it was built by this repository's Nightly workflow, from
the commit it names, its build attestation says, which the GitHub CLI checks:

```sh
gh attestation verify lemma-v0.2.7-linux-x64.tar.gz --repo phongndo/lemma \
  --signer-workflow phongndo/lemma/.github/workflows/nightly.yml
```

## Removing

Stop the host, then remove `~/.local/bin/lemma` and `~/.local/share/lemma`.
Your settings, credentials, and sessions in `~/.lemma` stay unless you remove
that too.

## Before a release

Each Check run keeps the Linux x64 archive it built for a week, as its
`lemma-linux-x64` artifact, so a pull request can be tried before it is
merged:

```sh
gh run download <run-id> --repo phongndo/lemma --name lemma-linux-x64 --dir /tmp/lemma-preview
(cd /tmp/lemma-preview && sha256sum -c ./*.sha256 && tar -xzf ./*.tar.gz)
LEMMA_HOME=/tmp/lemma-preview/home /tmp/lemma-preview/lemma-v*/bin/lemma serve      # in your project
```

From a checkout, `nix develop -c pnpm dist` builds this machine's archive into
`dist/` ([development](development.md#releases)).
