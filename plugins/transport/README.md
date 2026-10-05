# @lemma/plugin-transport

Serves `HostRpcs` from `@lemma/contracts` with `@effect/rpc` on Node's HTTP server, so the web app, the desktop shell, and CLI clients can drive a running host. Requires `Paths`, `Sessions`, `Agent`, `Llm`, `HostControl`, `Workspace`, and `Commands`; provides nothing; reads `Inspectors` and `FileSearchers` from the core's registries; answers `InteractionHook` for connected clients. Marked `exclusive`: it owns the port, so a reload stops the old instance before starting the new one.

## Use

```jsonc
{ "plugins": { "transport": { "config": { "port": 7433, "staticDir": "/path/to/apps/web/dist" } } } }
```

| Config               | Default              | Meaning                                                                                                     |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `host`               | `"127.0.0.1"`        | Bind address. Loopback unless set explicitly.                                                               |
| `port`               | `7433`               | `0` asks the OS for a free port.                                                                            |
| `token`              | `<Paths.home>/token` | Required on `/rpc*` and `/api*`. The default is read from that file, created at the first start (below).    |
| `staticDir`          | none                 | Built web app served at `/`; extensionless paths without a file fall back to `index.html`. No token needed. |
| `interactionGraceMs` | `15000`              | How long an open question waits for a client to (re)connect before failing `Unavailable`.                   |

Endpoints (token as `Authorization: Bearer <token>` or `?token=`, which browser WebSockets need; otherwise `401`):

- `GET /rpc` — WebSocket, JSON serialization. One multiplexed connection for UIs.
- `POST /rpc/http` — streaming HTTP, NDJSON serialization. With `@effect/rpc`'s HTTP client, add `HttpClient.filterStatusOk`: otherwise it parses a `401` body as NDJSON and waits forever.
- `GET /api/health` — `{ ok: true, version }`.

Without a configured `token`, the host's token is the one in `<Paths.home>/token`. The first start creates that file with a random token (mode 0600, in a 0700 home), complete before it appears and never replacing one another host created at the same moment; later starts read it, so clients on other machines stay valid across host restarts. Surrounding whitespace is ignored; an empty or unreadable file fails the plugin's activation. Delete the file and restart the host to rotate the token. Remote access is described in [docs/remote.md](../../docs/remote.md).

After listening it writes `<Paths.home>/transport.json` as `{ url, token, pid, startedAt }` (mode 0600) and removes it on shutdown unless another host has replaced it. `readDiscovery(home)` returns that entry, or `undefined` when the file is absent, invalid, or its process is gone. It also publishes a `Notice` with the URL (and a tokenized link to the web app when `staticDir` is set).

## Behavior

- **Errors.** Domain errors become `HostError`: `code` is the error's `reason` (`NotFound`, `Busy`, `UnknownProvider`) or, without one, its tag (`ReloadError`, `CoreClosed`); `subject` is the session, provider, plugin, tool, or workspace path. A `ReloadError`'s diagnostics become the message, one per line, and the plugin they all name (if one) the subject. Interaction answers fail `NotFound` (already answered, dismissed, or withdrawn) or `Mismatch` (wrong type, or a `select` value that was not offered).
- **RPCs** each call one capability. `Session.Create` defaults `cwd` to `Paths.cwd`; `Session.SetTitle` appends a `title` event and returns the updated info; `Session.Mark` pins or archives through `Sessions.mark`; `Session.Delete` fails `Busy` while a turn runs in the session, else calls `Sessions.remove`; `Agent.Prompt` calls `Agent.prompt` and returns when the turn ends (keeping a turn alive after its caller disconnects is the agent's responsibility); `Llm.Login` runs `Llm.login` in this plugin's scope and waits for it, so a login outlives a dropped caller; a second call for the same provider and method joins it, and a different method fails `Busy`; `Files.Search` asks the first of `FileSearchers` at each call and fails `Unavailable` when no plugin contributes one, so file search is neither required nor restarted with the transport; `Host.Info` reports this plugin's `VERSION`, `Paths.cwd`/`home`, and `HostControl.composition`; `Host.Plugins` lists every known plugin as `PluginStatus` (a plugin the core has not loaded reports `state: "disabled"`); `Host.RestartPlugin` takes `force` to restart a running plugin; `Host.Configure` writes plugin rows into the user or project config file through `HostControl.configure` and returns what started and stopped.
- **`Host.Events`.** `SessionAppended`, `SessionChanged`, `SessionRemoved`, `AssistantDelta`, `TurnStarted`, `TurnEnded`, `Notice`, and `PluginsChanged` are observed once, at activation, and copied into every subscriber's drop-oldest buffer (1024 events): a slow client loses old events, never the publisher's time, and repairs from `Session.Events`. Each kind has its own observer queue, so order holds within a kind but not across kinds (`turn-ended` can overtake the last `delta`). The `@effect/rpc` client sends a stream request asynchronously; a client that must see the effects of its own next call should wait for its first event.
- **Interaction.** With at least one subscriber, an `InteractionHook` request is broadcast as an `interaction` event through a per-subscriber queue that never drops, and replayed to clients that subscribe while it is open. The first `Interaction.Answer` wins; `Interaction.Dismiss` fails it `Dismissed`. Once it settles, or the asking fiber is interrupted, every client receives `interaction-closed`. With no subscriber the request passes to the next handler (and the interaction plugin's terminal reports `Unavailable`). If all clients leave and none returns within `interactionGraceMs`, it fails `Unavailable`.
- **Shutdown** closes the listener and destroys open sockets, including upgraded WebSockets, before any other cleanup: `server.close` and the platform's WebSocket server would each wait for connected clients, so a reload with a UI attached would miss its deadline and leave the port bound.

## Rationale

Two protocols share one handler set because their consumers differ: a UI keeps a socket and multiplexes everything; a script wants one HTTP call that returns when done. Authentication is checked per request before routing, so the WebSocket upgrade is covered by the same check, while static assets stay public because they contain no data. Interaction goes through the hook, not an event, because a question nobody can see must fail the operation rather than hang it; the event stream is only the delivery vehicle. The grace period and replay exist so a page reload does not abort a login in progress.
