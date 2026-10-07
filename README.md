# Lemma

Lemma is a coding-agent harness in which every part, including the agent loop
and the web app, is a plugin that can be turned off or replaced by id.

Lemma is under active development. Install the CLI and web app to try it in
your projects; no Nix, Node.js, or pnpm installation is needed.

## Install

Install on macOS or Linux (Apple Silicon/ARM64 or Intel/AMD64):

```sh
brew install phongndo/tap/lemma
```

Or use the portable installer:

```sh
curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh | sh
```

Then start Lemma from your project:

```sh
cd your-project
lemma serve
```

This opens the web app in your browser. Connect a provider there, then start a
thread. Keep the terminal running; Ctrl+C stops the host. In another terminal,
`lemma --help` lists the CLI commands.

See [installation](docs/installation.md) for updates, preview builds, platform
requirements, and removal. The Electron desktop window currently runs from
source; the installed version provides the same web app in your browser.

## Documentation

- [Usage](docs/usage.md): run the host, the web app, the desktop app, and the CLI
- [Installation](docs/installation.md): install, update, and try preview builds
- [Configuration](docs/configuration.md): config files, plugins, project trust, and providers
- [Remote access](docs/remote.md): run the host on one machine and use it from another
- [Web app](apps/web/README.md): UI plugins and files, addresses, and devtools
- [CLI](apps/cli/README.md): `lemma`, for people and agents
- [Architecture](docs/architecture.md): packages, plugins, and the session log
- [Kernel design](packages/core/DESIGN.md): the plugin runtime's rationale and limits
- [Development](docs/development.md): dev shell, checks, and git hooks
- [App icons](assets/brand/README.md): shared light and dark artwork
