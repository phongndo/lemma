# Lemma

Lemma is a self-hosted terminal multiplexer. A per-user daemon owns sessions, processes, PTYs, and terminal state, so clients can detach without ending pane processes. Creation starts the daemon automatically; it exits after its final session ends.

The mux hierarchy is **Session -> Tab -> Pane**. Ghostty owns terminal semantics; Lemma owns mux behavior. Keyboard, mouse, CLI, Lua, and agents share one typed command model.

> Lemma is pre-release. See [`docs/current-capabilities.md`](docs/current-capabilities.md) for what works today.

## Usage

```sh
lemma                                      # create a numbered session and attach
lemma new [NAME] ...                       # create a session and attach
lemma start [NAME] ...                     # create a detached session
lemma attach [NAME]
lemma list                                 # alias: lemma ls
lemma inspect NAME
lemma rename OLD NEW
lemma kill NAME

lemma action tab new --session work --title tests --hold -- just test
lemma action pane split --session work --pane 0:1 --right
lemma action pane capture --session work --pane 0:1
```

Common Session lifecycle commands are noun-free at the top level. The complete Session, Tab, and
Pane operation set is symmetric under `action`; there are no `lemma tab ...` or `lemma pane ...`
command families. Inside a Lemma pane, omitted `--session`, `--tab`, and `--pane` targets resolve
from the caller's current stable Lemma context. Explicit selectors operate on other resources.
Keybindings and mouse remain the primary interactive mux interface. Use `C-b d` to detach.

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
    {"action":"pane.zoom", "pane":{"result":"tests"}, "enabled":true},
    {"action":"session.kill", "session":{"result":"qa"}}
  ]
}
JSON
```

The procedure result is compact `lemma.proc-result/v1` JSON containing the canonical typed result
of each Action. See [`docs/procedures.md`](docs/procedures.md)
for the schema and supported action fields.

## Machine control and observation

Coding agents should use `lemma action`, `lemma proc`, and `lemma events` (`lemma skill`). The
owner-only `/tmp/lemma-UID.sock` endpoint is the public integration API for dedicated clients: a
CONTROL connection accepts lock-step `lemma.action/v1` Actions and `lemma.proc/v1` Procedures, and
an OBSERVE connection begins with a `lemma.events/v1` subscription then receives an initial
snapshot plus typed NDJSON Events. `lemma api schema --json` prints the complete version-matched
JSON Schema without contacting the daemon. See [`docs/control-api.md`](docs/control-api.md).

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
