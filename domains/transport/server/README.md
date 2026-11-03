# transport.server

Serves `RuntimeRpcs` from `@lemma/contracts` with `effect/rpc` on Node's HTTP
server. The web app, the desktop shell, and CLI clients drive a running host
through it. It provides nothing. It reads `Inspectors` and `Channels` from the
core's registries, and answers `InteractionHook` for connected clients. It is
`exclusive` because it owns the port: a reload stops the old instance before
starting the new one. The host pins it, so replace it with another transport
plugin rather than turning it off.

## Use

```jsonc
{ "plugins": { "transport.server": { "config": { "port": 7433, "staticDir": "/path/to/apps/web/dist" } } } }
```

| Config               | Default              | Meaning                                                                                                     |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `host`               | `"127.0.0.1"`        | Bind address. Loopback unless set explicitly.                                                               |
| `port`               | `7433`               | `0` asks the OS for a free port.                                                                            |
| `token`              | `<Paths.home>/token` | Required on `/rpc*` and `/api*`. The default is read from that file, created at the first start (below).    |
| `staticDir`          | none                 | Built web app served at `/`; extensionless paths without a file fall back to `index.html`. No token needed. |
| `compression`        | `true`               | Compress WebSocket messages and `/rpc/http` replies of 1 KiB or more for a client that accepts it (below).  |
| `interactionGraceMs` | `15000`              | How long an open question waits for an answering client to (re)connect before failing `Unavailable`.        |
| `startupTimeoutMs`   | `60000`              | How long a request held while the host starts (below) waits for its plugins before failing `Unavailable`.   |

Send the token as `Authorization: Bearer <token>`, or as `?token=`, which
browser WebSockets need. A request without it gets `401`.

- `GET /rpc` — WebSocket, JSON serialization. One multiplexed connection for
  UIs.
- `POST /rpc/http` — streaming HTTP, NDJSON serialization. With `effect/rpc`'s
  HTTP client, add `HttpClient.filterStatusOk`, or it parses a `401` body as
  NDJSON and waits forever. Set the request URL whole
  (`HttpClientRequest.setUrl`), as `makeHostRpcHttp` in `@lemma/client` does:
  `RpcClient.layerProtocolHttp` posts to `<url>/`, which is not routed.
- `GET /api/health` — `{ ok: true, version, protocol }`. `protocol` is
  `HOST_PROTOCOL`, the version of what it serves on the wire (a host without
  one speaks 1). A client and a host on different protocols cannot talk: the
  CLI says so and asks for the host to be restarted.
- `GET /api/web/<source>/<path>` — a web half or stylesheet the host lists for
  the web app from the plugin directories (`Web.Composition`). Any other path
  is `404`.

With `compression` on, `/rpc` accepts `permessage-deflate`, which browsers and
Node's `WebSocket` offer. The host compresses each message of 1 KiB or more at
zlib's fastest level: a thread's log, a listing, a finished message. A
10,000-event log of 6.4 MB crosses as 1.1 MB, which opens the thread three
times as fast over a 50 Mbit/s link, for about 30 ms of CPU. Smaller messages,
such as a turn's deltas, go as they are. A browser compresses everything it
sends once the extension is on, which adds about 25 µs to a small message's
round trip. Turn compression off when every client runs on the host's machine.

Over `/rpc/http`, the host compresses replies of 1 KiB or more as the client's
`Accept-Encoding` allows: brotli at quality 4, else gzip at zlib's fastest
level. Node's `fetch`, and so the CLI, asks for it. A stream's replies are
compressed as they come, each flushed at once. A 7.4 MB log crosses as 1.4 MB,
which the CLI reads in 0.32 s rather than 1.26 s over a 50 Mbit/s link with a
20 ms round trip. Compressing it costs the host about 40 ms.

The web app's files are served from the compressed copies its build writes
beside each (`<file>.br`, `<file>.gz`), brotli first, then gzip, to a client
that accepts them. A copy older than its file is never sent. So nothing is
compressed while serving, and the first load crosses as 346 kB of brotli rather
than 1.28 MB. Files under `assets/` are named by their content, so they are
cached for a year (`immutable`). Anything else (`index.html`) is revalidated
each time, and answered `304` while its `ETag` or date holds. A `staticDir` of
your own is served the same way.

Without a configured `token`, the host uses the one in `<Paths.home>/token`.

- The first start creates the file with a random token, mode 0600 in a 0700
  home. The token never starts with `-`, which `--token <token>` would read as
  an option.
- The file is complete before it appears, and never replaces one another host
  created at the same moment.
- Later starts read it, so clients on other machines stay valid across host
  restarts.
- Surrounding whitespace is ignored. An empty or unreadable file fails the
  plugin's activation.
- To rotate the token, delete the file and restart the host.

[docs/remote.md](../../../docs/remote.md) describes remote access.

After listening, it writes `<Paths.home>/transport.json` (mode 0600), the entry
by which clients find the host (`Discovery` in `@lemma/contracts/discovery`).
It removes the file on shutdown unless another host has replaced it. It also
publishes a `Notice` with the URL, and a tokenized link to the web app when
`staticDir` is set.

It writes the file as soon as it listens, before the plugins after it have
started. A file written later would make a starting host look absent: the CLI
would report that no host runs, and the desktop app would start a second one.
The startup gate (below) holds requests until the plugins are up, which also
covers clients that know the address another way (a remote, a reloaded page).

## Behavior

- **Errors.** Domain errors become `HostError`. Its `code` is the error's
  `reason` (`NotFound`, `Busy`, …) or tag, and its `subject` names the session,
  provider, plugin, tool, or path. A handler's defect fails only its request.
- **Startup.** Channel and inspector requests wait until the composition is
  first up, so a request made as soon as the host is found reaches a plugin
  that starts after the transport. One still waiting after `startupTimeoutMs`
  fails `Unavailable`, which a channel's own error can be too.
- **Channels** are read from
  [`Channels`](../../../packages/contracts/src/channels.ts) at each call, so a
  plugin serves a call or stream without a change here. Payloads and results
  cross as JSON inside the request: a bad payload fails `InvalidPayload`, and a
  throwing handler or a value its codec cannot send fails `Failed`. `Channel`
  says how a call ends across a reload.
- **Streams** end `Withdrawn` at once when their plugin stops, or when another
  channel takes over their id. A middleware (`ChannelLifetime`) ends them,
  because the RPC server waits for the client's acknowledgement before the next
  chunk. A stream is pulled at its client's pace and sends what it made
  meanwhile as one chunk (`mapChunks`), so it costs at most a message per round
  trip. A client that stops reading stalls only its own connection.
- **Replies.** A change that restarts the transport is applied once the reply
  asking for it has left (`ChangeReport.deferred`), since every request but a
  stream runs as the transport's own work until then.
- **`Host.Events`** copies `Notice`, `PluginsChanged`, and `WebChanged` into
  each subscriber's drop-oldest buffer of 1024 events, so a slow client loses
  old events, never the publisher's time. `channels-changed` comes from
  watching `Channels`, so a client hears a channel is back even when no plugin
  event says so. Order holds within a kind, not across kinds.
- **Interaction.** While a `Host.Events` subscriber `answers` questions, an
  `InteractionHook` request is broadcast to every subscriber, never dropped,
  and replayed to clients that subscribe while it is open. The first
  `Interaction.Answer` wins, `Interaction.Dismiss` fails it `Dismissed`, and
  every client then receives `interaction-closed`. With no answering
  subscriber, the request passes to the next handler. If every answering client
  leaves and none returns within `interactionGraceMs`, it fails `Unavailable`.
- **Shutdown** destroys open sockets before any other cleanup, because
  `server.close` would wait for connected clients and a reload with a UI
  attached would miss its deadline and leave the port bound.

## Rationale

It requires the runtime only (`Paths`, `HostControl`), so no domain is part of
it. A change to any other plugin leaves it running, and with it every client's
connection. Only a change to the transport itself drops the connections, and
the host applies it once the reply asking for it has left. Only the transport
knows when it has written a reply, so it holds its requests itself, as an item
of a registry of its own. A plugin's disposal waits for the work run with its
items, and the host defers a change by that work (`Admitted`), naming no
transport.

Two protocols share one handler set because their consumers differ: a UI keeps
a socket and multiplexes everything, and a script wants one HTTP call that
returns when done. Authentication is checked per request before routing, so the
WebSocket upgrade is covered by the same check. Static assets stay public
because they contain no data. Interaction goes through the hook, not an event,
because a question nobody can see must fail the operation rather than hang it.
The grace period and replay exist so a page reload does not abort a login in
progress.
