# Configuration

With no config, every bundled plugin runs. `~/.lemma/config.jsonc` and
`<project>/.lemma/config.jsonc` patch that by plugin id:

```jsonc
{
  "plugins": {
    "context.compaction": { "enabled": false },
    "agent.loop": { "config": { "maxSteps": 100 } },
  },
}
```

`enabled: false` turns a plugin off, and `config` replaces its settings. A
project row overrides the user row for the same plugin, `enabled` and `config`
separately; a project `config` replaces the user's whole object. `$LEMMA_HOME`
moves `~/.lemma`. MCP servers have a file of their own, `~/.lemma/mcp.json`
([mcp.servers](../domains/mcp/servers/README.md)).

The Plugins settings page and `lemma plugins` write these rows and apply them;
a plugin's config Schema is its settings form in both. Turning a plugin off
also unloads the plugins that require what it provides, which return with it.
A capability has one provider, so turning on a plugin that provides what
another provides turns that one off. The `transport.server` plugin stays on, and
needs only what the host provides itself (below), so any other plugin turns
off, or restarts with a change, without dropping a client's connection. A
change to the transport itself is answered first and applied after, and
clients reconnect. Each plugin's README lists its settings.

The host itself is not a plugin. It provides `Paths`, `HostControl` (managing
the plugins), `Interaction` (questions to the user), `Trace` (what it keeps of
its own running), and `HostApi` (its API version) to every plugin, so they have
no row and nothing turns them off. A plugin that provides one of them is left
out, and one from your own files stops the start (they are required, below):
to change how questions are answered, handle `InteractionHook` instead.

The host plans the host halves and the web app the web halves, each from the
same rows. The host knows every web half's id without running it: the bundled
ones', and yours by their files' names (below). So a row naming no plugin
either app has (a `host` or `interaction` row left from when they were
plugins, a plugin renamed or removed, a typo) is ignored with a warning, which
names the plugin meant when it is a typo off; a `required` one stops the
start; and writing one (`lemma plugins`, the Plugins page) is refused. A config
key a plugin does not read is warned of too: by the host for a plugin with a
host half, which declares all the plugin's config (its web half reads what it
needs of it), and by the web app for a web-only one.

## Your plugins

`~/.lemma/plugins/` and a trusted project's `<project>/.lemma/plugins/` hold
your plugins. What is there loads by itself, and again when it changes:

| Entry                          | What it is                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `approvals.ts` (`.js`, `.mjs`) | A host half, which the host runs                                                                                                           |
| `notes.web.js` (`.web.mjs`)    | A web half, which open web apps run                                                                                                        |
| `theme.css`                    | A stylesheet the web app applies after its own                                                                                             |
| `ticker/`                      | A folder plugin, its `package.json` naming its halves: `"lemma": { "host": "./ticker.ts", "web": "./web.js", "styles": ["./ticker.css"] }` |

A plugin is one id, with a host half, a web half, or both. Both halves of one
plugin define its id, so its one row decides both, and the web app runs the
web half only while the host half runs; [ticker](../examples/ticker/README.md)
is an example. A web half's file is named for its plugin (`notes.web.js`
defines `notes`), and a folder plugin's folder for its own (`ticker/`): the web
app does not run one that defines another. A plugin with both halves declares
all its config in its host half's schema, as its row's `config` goes to both. The bundled plugins are laid out the same way, a package each
in its domain's folder (`domains/tools/bash` is `tools.bash`), whose
`package.json` names its halves.

A plugin with a bundled plugin's id takes its place, and one providing what a
bundled plugin provides turns that one off unless a row decides;
[approvals](../examples/approvals/README.md) is an example. A host half whose
default export is a function receives `{ bundled }`, the bundled plugins by
id, so a replacement can wrap the plugin it replaces and keep its updates
rather than copy it; what a web half receives is in
[the web app's README](../apps/web/README.md), with the runtime the web
halves are written against.

## When something cannot run

The host starts with what can run. A plugin whose `config` no longer decodes
(a setting changed in an update), that is written for another version of
Lemma's API, or that fails to start is left out, with the plugins that need
it, and the host says why; the Plugins page and `lemma plugins` show it as
left out or failed. A config key a plugin does not read is a warning, which
catches a setting renamed in an update. A row naming no plugin is ignored,
unless it says `"required": true`.

What is **required** must start, or the host does not: the `transport.server` plugin,
every host half from your own files (a
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
`defineWebPlugin({ api })`, so after an incompatible change it is left out with
the version named rather than failing at some later call. It says the same of
each domain's contract it uses with `uses: ["lemma/tools@1", …]`, and is left
out when the plugin serving that domain implements another version
([writing plugins](plugins.md#contract-versions)). A plugin that
renames a setting reads its users' old rows with `migrateConfig` from
`@lemma/contracts`.

## Project trust

Project files can run code and redirect credentials, so a project's config
and plugins load only for a project listed (or under a directory
listed) in `"trustedProjects"` in `~/.lemma/config.jsonc`. Otherwise the host
warns and ignores them.

```jsonc
{ "trustedProjects": ["/Users/you/code"] }
```

`lemma trust add [path]` and `lemma trust remove [path]` write that list,
keeping the file's comments; `lemma trust` lists it and says whether the
current directory is trusted. `lemma config --show-origin` lists what the files
set for this directory's host, and which file sets each.
