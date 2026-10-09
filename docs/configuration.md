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
another provides turns that one off. The `transport` plugin stays on, and
needs only what the host provides itself (below), so any other plugin turns
off, or restarts with a change, without dropping a client's connection. A
change to the transport itself is answered first and applied after, and
clients reconnect. Each plugin's README lists its settings.

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

## Feature bundles

The Plugins page groups related host and web app plugins into features, with
individual plugin controls still available in the advanced inspector. One
feature switch writes a desired bundle selection:

```jsonc
{
  "bundles": {
    "compaction": { "enabled": false },
  },
  "plugins": {
    "compaction": { "enabled": true }, // explicit plugin overrides win
  },
}
```

A bundle is a composition manifest, not a runtime plugin. It has no lifecycle,
capability, hook, or dependency of its own. Plugins continue requiring
capabilities, never bundle ids. A selected bundle includes its members; a
member shared by several bundles stays included while any of them is selected.
With none selected, expansion writes an effective off row rather than letting
the planner's default-on behavior turn it back on. Explicit `plugins` and `ui`
rows always win, including `enabled: true` against a disabled bundle. The
settings page preserves that explicit override when saving it.

Selections merge by bundle id, project over user, and require the same project
trust as plugin rows. Turning a feature off does not override required or
pinned runtime protections. A capability dependency may keep a plugin from
running even when its feature is selected; the inspector explains that chain.

The feature switch coordinates desired host and UI settings in one config
change. The host applies its composition, then connected web apps reconcile
theirs independently. This is not an atomic transaction across runtimes:
missing, disabled, failed, or not-yet-applied members are shown as incomplete.
Explicit member overrides are shown as customized. Unselected bundles may
still have running members because another bundle or an override needs them.

### Authoring a bundle

Add `bundleDefinitions` to the user config, or a trusted project's config, to
group existing plugins, including third-party plugin ids:

```jsonc
{
  "bundleDefinitions": [
    {
      "id": "my-feature",
      "title": "My feature",
      "description": "A related host capability and its view",
      "host": ["my-provider"],
      "ui": ["my-view"],
      "enabledByDefault": true,
      "defaults": {
        "plugins": { "my-provider": { "config": { "limit": 10 } } },
        "ui": { "my-view": { "config": { "compact": true } } },
      },
    },
  ],
}
```

Members must still be installed as ordinary plugin files. Definitions later in
the configuration hierarchy replace earlier definitions with the same id;
duplicate definitions in one file are errors. The host supplies the shipped
feature definitions. Defaults may set `config` and `required`, only for declared
members; enablement comes from selection, so `defaults.enabled` is rejected.
Omitting `enabledByDefault` means selected. Defaults from selected bundles
merge by top-level config key; equal values are accepted, conflicting values
are diagnosed regardless of manifest order. An explicit member config replaces
the complete bundle default config, and an explicit `required` resolves a
conflict in that field. Existing app defaults still sit underneath the result.

Neither old configs nor third-party plugins need bundle declarations. Selected
members remain eligible for the existing capability-based provider replacement.
Manifests and desired selection do not guarantee an implementation is active;
the individual plugin catalog remains the source of runtime status.

## When something cannot run

The host starts with what can run. A plugin whose `config` no longer decodes
(a setting changed in an update), that is written for another version of
Lemma's API, or that fails to start is left out, with the plugins that need
it, and the host says why; the Plugins page and `lemma plugins` show it as
left out or failed. A config key a plugin does not read is a warning, which
catches a setting renamed in an update. A row naming no plugin is ignored,
unless it says `"required": true`.

What is **required** must start, or the host does not: the `transport` plugin,
every plugin from your own files (a
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
for the version it implements (`HOST_API`), and a web app plugin by
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
