# Configuration

With no config, every bundled plugin runs. Two files patch that, by plugin id:

- `~/.lemma/config.jsonc`, your own;
- `<project>/.lemma/config.jsonc`, the project's.

The project is the directory the host was started in. A session in another
project with config of its own is told that config does not apply there. That
project's `AGENTS.md`, skills, and modes do apply.

```jsonc
{
  "plugins": {
    "context.compaction": { "enabled": false },
    "agent.loop": { "config": { "maxSteps": 100 } },
  },
}
```

- `enabled: false` turns a plugin off.
- `config` replaces its settings.
- A project row overrides the user row for the same plugin. It overrides
  `enabled` and `config` separately. A project `config` replaces the user's
  whole object.
- `$LEMMA_HOME` moves `~/.lemma`. Run from a checkout, the home defaults to
  `~/.lemma-dev`. Neither runs on the other's home ([development](development.md)).
- MCP servers have a file of their own, `~/.lemma/mcp.json`. The sign-ins Lemma
  holds for them are in another, `mcp-auth.json`
  ([mcp.servers](../domains/mcp/servers/README.md)).

The Plugins settings page and `lemma plugins` write these rows and apply them.
In both, a plugin's config Schema is its settings form. Each plugin's README
lists its settings.

- Turning a plugin off also unloads the plugins that require what it provides.
  They return with it.
- A capability has one provider. So turning on a plugin that provides what
  another provides turns the other off.
- The `transport.server` plugin stays on. It needs only what the host provides
  itself (below). So any other plugin can turn off, or restart with a change,
  without dropping a client's connection.
- A change to the transport itself is answered first and applied after. Then
  clients reconnect.

The host itself is not a plugin. It provides these to every plugin:

- `Paths`;
- `HostControl`, which manages the plugins;
- `Interaction`, questions to the user;
- `Trace`, what the host keeps of its own running;
- `HostApi`, its API version.

They have no row, and nothing turns them off. A plugin that provides one of
them is left out. One from your own files stops the start, as those are
required (below). To change how questions are answered, handle
`InteractionHook` instead.

The host plans the host halves, and the web app plans the web halves. Both plan
from the same rows. The host knows every web half's id without running it: the
bundled ones' ids, and yours by their files' names (below).

So the host can tell a row that names no plugin either app has. Such a row
might be left from when `host` or `interaction` were plugins. It might name a
plugin renamed or removed, or have a typo.

- It is ignored with a warning. When it is a typo, the warning names the plugin
  meant.
- A `required` one stops the start.
- Writing one (`lemma plugins`, the Plugins page) is refused.

A config key a plugin does not read is warned of too:

- by the host, for a plugin with a host half. The host half declares all the
  plugin's config, and its web half reads what it needs of it.
- by the web app, for a web-only plugin.

## Your plugins

`~/.lemma/plugins/` holds your plugins, and so does a trusted project's
`<project>/.lemma/plugins/`. What is there loads by itself. It loads again when
it changes.

| Entry                                  | What it is                                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `approvals.ts` (`.js`, `.mjs`)         | A host half, which the host runs                                                                                                          |
| `notes.web.js` (`.web.mjs`, `.web.ts`) | A web half, which open web apps run. TypeScript's types are stripped as it is served.                                                     |
| `theme.css`                            | A stylesheet the web app applies after its own                                                                                            |
| `ticker/`                              | A folder plugin. Its `package.json` names its halves: `"lemma": { "host": "./ticker.ts", "web": "./web.js", "styles": ["./ticker.css"] }` |

A folder plugin's manifest can also name folders of things other plugins read,
by kind: `"resources": { "skills": "./skills", "modes": "./modes" }`.

- They come and go with the plugin's host half. They go when it is turned off
  or fails, or when its project is not trusted.
- The plugin that reads a kind finds them in plugin status (`resourcesOf`).
- `skills.files` reads `skills`, and `agent.modes` reads `modes`. Each ranks
  them below your own of the same name.
- A field Lemma does not read is reported, which catches a typo.

As the host starts, it links what a plugin file may import into
`~/.lemma/node_modules`: `effect`, `@lemma/core`, `@lemma/contracts`, and the
domains' contracts. The links point at the packages the host runs. So those
files resolve them, and an editor finds their types, with nothing installed. A
directory of your own there is left alone.

A plugin is one id, with a host half, a web half, or both.
[ticker](../examples/ticker/README.md) is an example.

- Both halves of one plugin define its id, so its one row decides both.
- The web app runs the web half only while the host half runs.
- A web half's file is named for its plugin: `notes.web.js` defines `notes`.
- A folder plugin's folder is named for its plugin: `ticker/`.
- The web app does not run a half that defines another id.
- A plugin with both halves declares all its config in its host half's schema.
  Its row's `config` goes to both halves.

The bundled plugins are laid out the same way. Each is a package in its
domain's folder, and its `package.json` names its halves. For example,
`domains/tools/bash` is `tools.bash`.

A plugin with a bundled plugin's id takes that plugin's place. A plugin that
provides what a bundled plugin provides turns that one off, unless a row
decides. [approvals](../examples/approvals/README.md) is an example.

A host half whose default export is a function receives `{ bundled }`, the
bundled plugins by id. So a replacement can wrap the plugin it replaces, and
keep its updates, rather than copy it. [The web app's README](../apps/web/README.md)
says what a web half receives. It also describes the runtime the web halves
are written against.

## When something cannot run

The host starts with what can run. It leaves out a plugin that:

- has a `config` that no longer decodes, such as a setting changed in an
  update;
- is written for another version of Lemma's API;
- fails to start.

The plugins that need it are left out with it, and the host says why. The
Plugins page and `lemma plugins` show it as left out or failed.

A config key a plugin does not read is a warning. That catches a setting
renamed in an update. A row naming no plugin is ignored, unless it says
`"required": true`.

What is **required** must start, or the host does not start:

- the `transport.server` plugin;
- every host half from your own files, including a file that does not load,
  and so names no plugin;
- any plugin whose row says `"required": true`;
- what each of these needs.

So a row that turns off what a required plugin needs stops the start too. A
required plugin is never turned off for a file's plugin that provides the same.
The host reports the two as a conflict.

- Mark a plugin that enforces a policy as required. Then the host never runs
  without it.
- A row saying `"required": false` lets the host start without one of your
  plugins instead.
- A replacement that cannot run is never swapped back for the bundled plugin it
  replaced.

A change made while the host runs, such as a config edit or a change on the
Plugins page, can be refused:

- If the change would leave out a plugin that runs now, the host refuses it. It
  keeps what is running.
- A plugin already left out stays left out. It blocks no other change.

`--safe` starts the bundled plugins as shipped. It reads no config file and no
plugin file, and writes neither. Use it when your config keeps the host from
starting. `pnpm start --safe` and `LEMMA_SAFE=1` do the same.

A plugin says which version of the host's contracts it is written for:

- A host half requires `HostApi(version)` from `@lemma/contracts`. The host
  provides it for the version it implements (`HOST_API`).
- A web app plugin says so with `defineWebPlugin({ api })`.

So after an incompatible change, the plugin is left out, and the version is
named. It does not fail at some later call.

A plugin says the same of each domain's contract it uses, with
`uses: ["lemma/tools@2", …]`. It is left out when the plugin serving that domain
implements another version ([writing plugins](plugins.md#contract-versions)).

A plugin that renames a setting reads its users' old rows with `migrateConfig`
from `@lemma/contracts`.

## Project trust

Project files can run code and redirect credentials. So a project's config and
plugins load only for a trusted project. A project is trusted when it is listed
in `"trustedProjects"` in `~/.lemma/config.jsonc`, or is under a listed
directory. Otherwise the host warns and ignores them.

```jsonc
{ "trustedProjects": ["/Users/you/code"] }
```

- `lemma trust add [path]` and `lemma trust remove [path]` write that list. They
  keep the file's comments.
- `lemma trust` lists it, and says whether the current directory is trusted.
- `lemma config --show-origin` lists what the files set for this directory's
  host, and which file sets each.

## Profiles

A profile is a separate Lemma on the same machine. It has its own plugins,
config, look, threads, and logins. They are in a home of its own, and a host of
its own serves them.

Make a profile when the plugins or the interface differ, such as a coding agent
beside a research desk. When it is the same app with another agent, use a mode
instead ([agent.modes](../domains/agent/modes/README.md)).

Until you make one, there is only the default. The default is `~/.lemma`
itself, shown as Core.

```sh
lemma profile create research    # an empty home, ~/.lemma/profiles/research, with a port of its own
lemma --profile research serve   # its host; LEMMA_PROFILE=research does the same for every command
lemma profile                    # the profiles, their ports, and which hosts run
```

- **Where.** A profile lives in `<home>/profiles/<name>/`. It is laid out as the
  home is, with its own `config.jsonc`, `plugins/`, sessions, `auth.json`, and
  `trustedProjects`.
  - `<home>/profiles/` holds profiles and nothing else.
  - A profile's `profile.json` keeps the port its host listens on, unless its
    config names another. So its address stays the same, and so does what a
    browser keeps for that address.
- **Which one.**
  - `--profile <name>` picks a profile for one command.
  - `LEMMA_PROFILE` picks one for every command and host started from that
    shell.
  - `default`, `core` in any case, or unset, is the home's own.
  - A host's tools run `lemma` in their own profile.
  - The desktop app opens its first window on `LEMMA_PROFILE`'s profile. It
    opens another profile in a window of its own.
- **Nothing is shared.** Profiles share no plugins, rows, logins, threads, or
  trusted projects. A new profile starts as a fresh install does.
  - To run a plugin in each profile, link its file or folder into each
    profile's `plugins/`.
  - To use the same provider, log in from the profile. Or set the provider's
    API key variable where its host starts.
- **Names.** A profile's name, such as `research`, uses lowercase letters,
  digits, `-`, and `_`. It is the folder's name and what `--profile` takes. It
  never changes.
  - The name it is shown by is any text on one line, at most 60 characters. It
    is kept in the profile's home, in `title.json`.
  - Without one, a profile is shown by its name in words: `trading-desk` is
    Trading desk. The default is shown as Core.
  - Core is the default's alone. `--profile core` is the default, and no other
    profile is named or shown so.
- **Settings › Profiles** lists the profiles. It makes one, named from what it
  is to be shown by. It renames, stops, and deletes them.
  - Once there is more than one, the web app's sidebar shows the page's profile
    as its avatar, as a browser does.
  - Its menu opens another profile, and starts its host when none runs
    ([profiles.switcher](../domains/profiles/switcher/README.md)).
  - A profile on a server is reached at its own port
    ([remote access](remote.md#profiles)).
- **Removing.** `lemma profile remove <name>`, or Settings › Profiles, deletes a
  profile and everything in its home. It stops the profile's host first,
  whoever started it.
  - A user service that starts its host (`lemma --profile <name> service`)
    stays. Uninstall it first.
  - The default is never deleted, as it is the home the others live in.

Profiles keep work apart, but they do not keep it safe from each other. Every
host runs as you. So one profile's tools, such as a shell, can read another's
files, its logins included. Work that must not mix belongs to another user
account.
