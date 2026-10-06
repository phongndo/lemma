# @lemma/plugin-transport

Serves `HostRpcs` from `@lemma/contracts` with `effect/rpc` on Node's HTTP server, so the web app, the desktop shell, and CLI clients can drive a running host. Requires `Paths`, `Sessions`, `Agent`, `Llm`, `HostControl`, `Workspace`, and `Commands`; provides nothing; reads `Inspectors` and `FileSearchers` from the core's registries; answers `InteractionHook` for connected clients. Marked `exclusive`: it owns the port, so a reload stops the old instance before starting the new one.

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
- `POST /rpc/http` — streaming HTTP, NDJSON serialization. With `effect/rpc`'s HTTP client, add `HttpClient.filterStatusOk`: otherwise it parses a `401` body as NDJSON and waits forever. Also set the request URL whole (`HttpClientRequest.setUrl`), as `makeHostRpcHttp` in `@lemma/client` does: `RpcClient.layerProtocolHttp` posts to `<url>/`, which is not routed.
- `GET /api/health` — `{ ok: true, version }`.
- `GET /api/ui/<source>/<name>` — a UI file the host lists for the web app (`Ui.Composition`); any other name is `404`.

Without a configured `token`, the host's token is the one in `<Paths.home>/token`. The first start creates that file with a random token (mode 0600, in a 0700 home; never starting with `-`, which `--token <token>` would read as an option), complete before it appears and never replacing one another host created at the same moment; later starts read it, so clients on other machines stay valid across host restarts. Surrounding whitespace is ignored; an empty or unreadable file fails the plugin's activation. Delete the file and restart the host to rotate the token. Remote access is described in [docs/remote.md](../../docs/remote.md).

After listening it writes `<Paths.home>/transport.json` as `{ url, token, pid, startedAt }` (mode 0600) and removes it on shutdown unless another host has replaced it. `readDiscovery(home)` returns that entry, or `undefined` when the file is absent, invalid, or its process is gone. It also publishes a `Notice` with the URL (and a tokenized link to the web app when `staticDir` is set).

## Behavior

- **Errors.** Domain errors become `HostError`, whose `code` is the error's
  `reason` (`NotFound`, `Busy`, …) or its tag, and whose `subject` names the
  session, provider, plugin, tool, or path.
- **RPCs** each call one capability, as [`HostRpcs`](../../packages/contracts/src/rpc.ts)
  documents. Two outlive their caller: `Agent.Prompt` (the agent keeps the turn)
  and `Llm.Login`, which runs in this plugin's scope, so a login survives a
  dropped connection and a second call for the same provider joins it.
  `Files.Search` asks `FileSearchers` at each call, so file search can be off
  without the transport noticing.
- **`Host.Events`.** The kernel events behind each [`HostEvent`](../../packages/contracts/src/rpc.ts) are observed once, at activation, and copied into every subscriber's drop-oldest buffer (1024 events): a slow client loses old events, never the publisher's time, and repairs from `Session.Events`. Each kind has its own observer queue, so order holds within a kind but not across kinds (`turn-ended` can overtake the last `delta`). A subscription that asks for it with the `lemma-subscribed` header (`SUBSCRIBED_HEADER`) opens with `{ type: "subscribed" }`, sent once the subscriber has joined: a client that must see the effects of its own next call (a question a command asks) waits for it. Opt-in, so a client from before it never receives an event it cannot decode. A call's reply is no such sign, since the host handles the calls on one socket concurrently and the RPC client sends a stream request asynchronously.
- **Interaction.** With at least one subscriber, an `InteractionHook` request is broadcast as an `interaction` event through a per-subscriber queue that never drops, and replayed to clients that subscribe while it is open. The first `Interaction.Answer` wins; `Interaction.Dismiss` fails it `Dismissed`. Once it settles, or the asking fiber is interrupted, every client receives `interaction-closed`. With no subscriber the request passes to the next handler (and the interaction plugin's terminal reports `Unavailable`). If all clients leave and none returns within `interactionGraceMs`, it fails `Unavailable`.
- **Shutdown** closes the listener and destroys open sockets, including upgraded WebSockets, before any other cleanup: `server.close` and the platform's WebSocket server would each wait for connected clients, so a reload with a UI attached would miss its deadline and leave the port bound.

## Rationale

Two protocols share one handler set because their consumers differ: a UI keeps a socket and multiplexes everything; a script wants one HTTP call that returns when done. Authentication is checked per request before routing, so the WebSocket upgrade is covered by the same check, while static assets stay public because they contain no data. Interaction goes through the hook, not an event, because a question nobody can see must fail the operation rather than hang it; the event stream is only the delivery vehicle. The grace period and replay exist so a page reload does not abort a login in progress.
