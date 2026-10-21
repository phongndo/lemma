# Lemma

Lemma is an agent harness in which every part, including the agent loop and
the web app's views, is a plugin that can be turned off or replaced by id.
What a thread's agent is for is its profile: coding by default, or writing,
research, or anything a profile of yours describes.
The plugins are written against a runtime the host and the web app provide, so
a plugin of yours stands where a bundled one does.

Lemma is under active development: while its version is 0.x, a release may
change what plugins are written against.

## Install

On macOS (Apple silicon) or Linux (x64 or arm64):

```sh
curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh | sh
cd your-project
lemma serve
```

`lemma serve` starts the host and opens the web app, where you log in to a
provider. That installs the stable release; `… | LEMMA_CHANNEL=nightly sh`
installs the newest build of `main`. [Installation](docs/installation.md)
covers channels, updating, and removing a release;
[Development](docs/development.md) running Lemma from a checkout.

## Principles

- **Every part is a plugin.** The agent loop, the tools, the session store,
  and the web app's views are plugins on the same footing as yours, met
  only through contracts, so any of them can be turned off or replaced by id.
- **The runtime stays small.** What no plugin can replace (the kernel, the
  runtime's contracts, the host and web runtimes) is held to a size budget
  (`scripts/size.ts`), raised only on purpose.
- **The session log is the truth.** Every model request can be rebuilt from
  it, with the plugin that contributed each part, so what the model saw is
  never a guess.
- **Legible over clever.** A useful plugin is one short file; each extension
  point says how it composes where it is declared; a plugin's failure is
  named for it.

## Documentation

- [Installation](docs/installation.md): install a release, update it, and remove it
- [Usage](docs/usage.md): run the host, the web app, the desktop app, and the CLI
- [Configuration](docs/configuration.md): config files, plugins, project trust, and providers
- [Remote access](docs/remote.md): run the host on one machine and use it from another
- [Building on Lemma](docs/building.md): one plugin built in three steps, a tool, a view of it, and a profile that uses it
- [Writing plugins](docs/plugins.md): the five shapes, where to plug in, testing, and coming from Pi
- [Debugging plugins](docs/debugging.md): whether one runs, what it is plugged into, what it did, and why it failed
- [Web app](apps/web/README.md): its plugins and web halves, addresses, and devtools
- [CLI](apps/cli/README.md): `lemma`, for people and agents
- [Architecture](docs/architecture.md): packages, plugins, the runtime, and the session log
- [Kernel design](packages/core/DESIGN.md): the plugin kernel's rationale and limits
- [Development](docs/development.md): dev shell, checks, git hooks, and releases
- [App icons](assets/brand/README.md): shared light and dark artwork

## License

[MIT](LICENSE)
