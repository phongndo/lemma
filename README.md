# Lemma

Lemma is a coding-agent harness in which every part, including the agent loop
and the web app's views, is a plugin that can be turned off or replaced by id.
The plugins are written against a runtime the host and the web app provide, so
a plugin of yours stands where a bundled one does.

Lemma runs from a checkout and is under active development.

## Documentation

- [Usage](docs/usage.md): run the host, the web app, the desktop app, and the CLI
- [Configuration](docs/configuration.md): config files, plugins, project trust, and providers
- [Remote access](docs/remote.md): run the host on one machine and use it from another
- [Web app](apps/web/README.md): UI plugins and files, addresses, and devtools
- [CLI](apps/cli/README.md): `lemma`, for people and agents
- [Architecture](docs/architecture.md): packages, plugins, the runtime, and the session log
- [Kernel design](packages/core/DESIGN.md): the plugin kernel's rationale and limits
- [Development](docs/development.md): dev shell, checks, and git hooks
- [App icons](assets/brand/README.md): shared light and dark artwork
