# Lemma

Lemma is a self-hosted terminal multiplexer. A per-user daemon owns sessions, processes, PTYs, and terminal state, so clients can detach without ending pane processes. Creation starts the daemon automatically; it exits after its final session ends.

The mux hierarchy is **Session -> Tab -> Pane**. Ghostty owns terminal semantics; Lemma owns mux behavior. Keyboard, mouse, CLI, Lua, and agents share one typed command model.

> Lemma is pre-release. See [`docs/current-capabilities.md`](docs/current-capabilities.md) for what works today.

## Usage

```sh
lemma                                    # create a numbered session and attach
lemma new work                            # create named session and attach
lemma start logs                          # create named session detached
lemma new editor -c ~/src -- nvim
lemma list                                # alias: lemma ls
lemma attach work

lemma tab new work --title tests --hold -- just test
lemma pane list work
lemma pane capture work 1:1
lemma pane wait work 1:1 --exit --timeout 30s
```

Session controls are top-level; tab and pane actions use explicit namespaces. `--hold` keeps an
exited pane's canonical terminal and exit status available until the pane is killed. Pane waits can
require an exact exit code or signal. Use `C-b d` to detach and run `lemma --help` for the complete
command surface.

## Procedures

`lemma proc` executes up to 64 ordered actions from one bounded `lemma.proc/v1` JSON document.
Actions may reference session, tab, or pane IDs returned by earlier actions. The complete document
is validated strictly before any action runs. Procedures are sequential and non-atomic; they stop
at the first runtime failure unless `"on_error":"continue"` is set.

```sh
lemma proc - <<'JSON'
{
  "schema": "lemma.proc/v1",
  "on_error": "continue",
  "actions": [
    {"id":"qa", "action":"session.start", "name":"qa"},
    {"id":"tests", "action":"tab.new", "session":{"result":"qa"},
     "hold":true, "argv":["just","test"]},
    {"action":"pane.wait", "pane":{"result":"tests"},
     "exit":{"code":0}, "timeout_ms":120000},
    {"action":"pane.capture", "pane":{"result":"tests"}, "lines":100},
    {"action":"session.kill", "session":{"result":"qa"}}
  ]
}
JSON
```

The procedure result is compact `lemma.results/v1` JSON containing each action's status and any
created IDs, structured topology arrays, captured text, or process exit outcome. See [`docs/procedures.md`](docs/procedures.md)
for the schema and supported action fields.

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

For selective feedback, use `./test unit`, `./test layout`, `./test terminal`, or
`./test mux resize`; `./test stress` and `./test extended` are explicit. `./bench` runs the short
native smoke, with `terminal`, `layout`, `protocol`, `mux`, and `extended` selectors. See
[`docs/testing.md`](docs/testing.md) for the audited taxonomy.

## Python tooling

Python benchmark and automation scripts use uv for dependency management, Ruff for formatting and
linting, and ty for type checking. Run `uv sync --locked` to create the environment, or use
`just python-check` to run all Python checks and tests.

## Documentation

See [`docs/product-contract.md`](docs/product-contract.md) for the intended product and [`docs/architecture.md`](docs/architecture.md) for its design.

## License

[MIT](LICENSE)
