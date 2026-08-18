# Lemma

Lemma is a self-hosted terminal multiplexer. A per-user daemon owns sessions, processes, PTYs, and terminal state, so clients can detach without ending pane processes.

The mux hierarchy is **Session -> Tab -> Pane**. Ghostty owns terminal semantics; Lemma owns mux behavior. Keyboard, mouse, CLI, Lua, and agents share one typed command model.

> Lemma is pre-release. See [`docs/current-capabilities.md`](docs/current-capabilities.md) for what works today.

## Usage

```sh
lemma                 # create or enter "default"
lemma new work        # create and attach
lemma start logs      # create detached
lemma list
lemma attach work
```

Use `C-b d` to detach. Run `lemma --help` for all commands and bindings.

## Builds

The default Nix package is the optimized release build. The debug build is exposed separately as
`delemma` so installing both does not create a binary-name collision.

```sh
nix run .#lemma      # release (also: nix run)
nix run .#delemma    # debug
nix build            # release only
```

In the development shell, `just build`, `just test`, and `just run` default to release. Use
`just profile=debug build` (or `test`/`run`) for the in-tree debug build. Both variants use the same
per-user daemon endpoint, so shut down the running daemon before switching between them.

## Python tooling

Python benchmark and automation scripts use uv for dependency management, Ruff for formatting and
linting, and ty for type checking. Run `uv sync --locked` to create the environment, or use
`just python-check` to run all Python checks and tests.

## Documentation

See [`docs/product-contract.md`](docs/product-contract.md) for the intended product and [`docs/architecture.md`](docs/architecture.md) for its design.

## License

[MIT](LICENSE)
