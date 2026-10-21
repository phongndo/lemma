# Versioning

Lemma has one version you install, and a few that decide whether its parts
fit together: a client and a host, a plugin and the app, a session file and
the Lemma reading it. Where two of them differ, Lemma says so, naming both,
rather than failing at some later call.

## The release version

`0.2.7` is what `lemma --version` prints, and its release's tag is `v0.2.7`.
Its major and minor are the line, which `apps/cli/package.json` sets; each
nightly takes the next patch in it, so a later version is a later build of
`main`, however much changed. A stable release is a nightly promoted, keeping
its version ([installation](installation.md#channels),
[releases](development.md#releases)).

While Lemma is 0.x, a release may change what plugins are written against and
what Lemma does; a new line (`0.3`) marks a change you will notice in how Lemma
is used, configured, or extended. Within a line, the versions below still say
where a release no longer fits a plugin or a session.

`lemma version` says what a `lemma` is (`--json` for all of it):

| Field             | Says                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `version`         | The release, or a checkout's `apps/cli/package.json`                                           |
| `kind`            | `release`, or `checkout`: a clone of the repository, as developers run Lemma                   |
| `commit`, `built` | The commit a release was built from, and when (its `release.json`); a checkout's commit        |
| `channel`         | The channel the installer installed it from, which `lemma update` follows (its `install.json`) |
| `link`, `dataDir` | The `lemma` command the installer links to it, and where it keeps releases                     |
| `root`, `node`    | Where its files are, and the Node.js it runs on                                                |

`lemma update` installs the channel's newest release, another channel's
(`--channel`), or a version given, an older one rolling back
([installation](installation.md#updating)).

## Versions that must match

| Version                                               | Between                                    | Goes up when                                    | When they differ                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPC protocol (`HOST_PROTOCOL` in `@lemma/contracts`)  | a client (the CLI, the web app) and a host | what the host serves on the wire changes        | The CLI says the host runs another version and to restart it from this one: `lemma restart`                                                                   |
| Host and web API (`HOST_API`, `WEB_API`)              | a plugin and the host or the web app       | the runtime's contracts change incompatibly     | The plugin is left out, both versions named ([plugins](plugins.md#contract-versions))                                                                         |
| A domain's contract (`lemma/tools@1`)                 | a plugin and the plugin serving the domain | something in it is removed, renamed, or changes | The plugin is left out, both versions named ([plugins](plugins.md#contract-versions))                                                                         |
| Session format (`FORMAT_VERSION` in `sessions.files`) | a session file and the Lemma reading it    | a line's shape changes                          | An older file is read through migrations; a newer one is refused, both versions named ([sessions.files](../domains/sessions/files/README.md#format-versions)) |

The web app comes from the host it talks to, so the two always match; a
running host keeps the release it started with until it restarts, so after
`lemma update` the CLI may be newer than the host until `lemma restart`.

A plugin's own `version` is the plugin's, not Lemma's: `lemma status`'s
`transport 0.1.0` is the transport plugin's.
