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
another provides turns that one off. The `host` and `transport` plugins, and
everything they need, stay on. Each plugin's README lists its settings.

Plugin files in `~/.lemma/plugins/` or `<project>/.lemma/plugins/` load
automatically, and one with a bundled plugin's id takes its place;
[approvals](../examples/approvals/README.md) is an example. The web app is
composed the same way from its own plugins, through `"ui"` rows and files in
`~/.lemma/ui/`: see [its README](../apps/web/README.md).

## Project trust

Project files can run code and redirect credentials, so a project's config,
plugins, and UI files load only for a project listed (or under a directory
listed) in `"trustedProjects"` in `~/.lemma/config.jsonc`. Otherwise the host
warns and ignores them.

```jsonc
{ "trustedProjects": ["/Users/you/code"] }
```
