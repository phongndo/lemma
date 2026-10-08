# Configuration

With no config, every bundled plugin runs. `~/.lemma/config.jsonc` and
`<project>/.lemma/config.jsonc` patch that by plugin id:

```jsonc
{
  "plugins": {
    "compaction": { "enabled": false },
    "agent": { "config": { "maxSteps": 100 } },
  },
}
```

`enabled: false` turns a plugin off, and `config` replaces its settings. A
project row overrides the user row for the same plugin, `enabled` and `config`
separately; a project `config` replaces the user's whole object. `$LEMMA_HOME`
moves `~/.lemma`.

The Plugins settings page and `lemma plugins` write these rows and apply them;
a plugin's config Schema is its settings form in both. Turning a plugin off
also unloads the plugins that require what it provides, which return with it.
A capability has one provider, so turning on a plugin that provides what
another provides turns that one off. The `transport` plugin, and everything it
needs, stays on. Each plugin's README lists its settings.

The host itself is not a plugin. It provides `Paths`, `HostControl` (managing
the plugins), `Interaction` (questions to the user), and `HostApi` (its API
version) to every plugin, so they have no row and nothing turns them off. A
`host` or `interaction` row left from when they were plugins names no plugin,
and is ignored with a warning. A plugin that provides one of them is left out,
and one from your own files stops the start (they are required, below): to
change how questions are answered, handle `InteractionHook` instead.

Plugin files in `~/.lemma/plugins/` or `<project>/.lemma/plugins/` load
automatically. One with a bundled plugin's id takes its place, and one
providing what a bundled plugin provides turns that one off unless a row
decides; [approvals](../examples/approvals/README.md) is an example. A file whose
default export is a function receives `{ bundled }`, the bundled plugins by
id, so a replacement can wrap the plugin it replaces and keep its updates
rather than copy it. The web app is composed the same way from its own
plugins, through `"ui"` rows and files in `~/.lemma/ui/`; the runtime they
are written against is the app's own, with no row: see
[its README](../apps/web/README.md).

## When something cannot run

The host starts with what can run. A plugin whose `config` no longer decodes
(a setting changed in an update), that is written for another version of
Lemma's API, or that fails to start is left out, with the plugins that need
it, and the host says why; the Plugins page and `lemma plugins` show it as
left out or failed. A config key a plugin does not read is a warning, which
catches a setting renamed in an update. A row naming no plugin is ignored,
unless it says `"required": true`.

What is **required** must start, or the host does not: the `transport` plugin
and what it needs, every plugin from your own files (a
file that does not load, which therefore names no plugin, too), and any plugin
whose row says `"required": true`, with what it needs: a row turning off what
a required plugin needs stops the start too, and a required plugin is never
turned off for a file's plugin that provides the same (the host reports the
two as a conflict). Mark a plugin that
enforces a policy required, so the host never runs without it; a row saying
`"required": false` lets the host start without one of your plugins instead.
A replacement that cannot run is never swapped back for the bundled plugin it
replaced.

A change made while the host runs (a config edit, the Plugins page) is
refused, and the running composition kept, when it would leave out a plugin
that is not left out already; one that is stays so, and blocks no other change. `--safe` (`pnpm start --safe`, or `LEMMA_SAFE=1`) starts the bundled
plugins as shipped, reading no config file and no plugin file and writing
neither: the way back when your config keeps the host from starting.

A plugin says which version of the host's contracts it is written for by
requiring `HostApi(version)` from `@lemma/contracts`, which the host provides
for each version it supports, and a web app plugin by
`defineUiPlugin({ api })`, so after an incompatible change it is left out with
the version named rather than failing at some later call. A plugin that
renames a setting reads its users' old rows with `migrateConfig` from
`@lemma/contracts`.

## Project trust

Project files can run code and redirect credentials, so a project's config,
plugins, and UI files load only for a project listed (or under a directory
listed) in `"trustedProjects"` in `~/.lemma/config.jsonc`. Otherwise the host
warns and ignores them.

```jsonc
{ "trustedProjects": ["/Users/you/code"] }
```
