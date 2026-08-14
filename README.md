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

## Documentation

See [`docs/product-contract.md`](docs/product-contract.md) for the intended product and [`docs/architecture.md`](docs/architecture.md) for its design.

## License

[MIT](LICENSE)
