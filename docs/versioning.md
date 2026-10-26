# Versioning

Lemma has one version you install. A few other versions decide whether its
parts fit together:

- a client and a host;
- a plugin and the app;
- a session file and the Lemma reading it.

Where two of them differ, Lemma says so and names both. It does not fail at
some later call instead.

## The release version

`lemma --version` prints the release version, such as `0.2.7`. That release's
tag is `v0.2.7`.

- `apps/cli/package.json` sets the minor version (`0.2`).
- Each nightly takes the next patch in that minor version. So a later version
  is a later build of `main`, however much changed.
- A stable release is a promoted nightly, and it keeps its version
  ([installation](installation.md#channels), [releases](development.md#releases)).

While Lemma is 0.x, a release may change what plugins are written against. It
may also change what Lemma does. A new minor version (`0.3`) marks a change you
will notice in how Lemma is used, configured, or extended. Within a minor
version, the versions below still say where a release no longer fits a plugin
or a session.

`lemma version` says which release a `lemma` is.
[Updating](installation.md#updating) says how to replace it.

## Versions that must match

| Version                                               | Between                                    | Goes up when                                    | When they differ                                                                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPC protocol (`HOST_PROTOCOL` in `@lemma/contracts`)  | a client (the CLI, the web app) and a host | what the host serves on the wire changes        | The CLI says the host runs another version. It says to restart the host from this one: `lemma restart`.                                                                |
| Host and web API (`HOST_API`, `WEB_API`)              | a plugin and the host or the web app       | the runtime's contracts change incompatibly     | The plugin is left out, and both versions are named ([plugins](plugins.md#contract-versions)).                                                                         |
| A domain's contract (`lemma/tools@2`)                 | a plugin and the plugin serving the domain | something in it is removed, renamed, or changes | The plugin is left out, and both versions are named ([plugins](plugins.md#contract-versions)).                                                                         |
| Session format (`FORMAT_VERSION` in `sessions.files`) | a session file and the Lemma reading it    | a line's shape changes                          | An older file is read through migrations. A newer one is refused, and both versions are named ([sessions.files](../domains/sessions/files/README.md#format-versions)). |

The web app comes from the host it talks to, so the two always match.

A plugin's own `version` is the plugin's, not Lemma's. For example,
`transport 0.1.0` in `lemma status` is the transport plugin's version.
