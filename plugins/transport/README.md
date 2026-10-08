# @lemma/plugin-transport

Serves `RuntimeRpcs` from `@lemma/contracts` with `effect/rpc` on Node's HTTP server, so the web app, the desktop shell, and CLI clients can drive a running host. Requires only what the host provides itself, `Paths` and `HostControl`: each subsystem serves its own calls and streams as channels, which this serves as they come and go, so a subsystem stops, reloads, or is off without the transport restarting or a client losing its connection. Provides nothing; reads `Inspectors` and `Channels` from the core's registries; answers `InteractionHook` for connected clients. Marked `exclusive`: it owns the port, so a reload stops the old instance before starting the new one. The host pins it: it cannot be turned off, only replaced by another transport plugin.

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
| `interactionGraceMs` | `15000`              | How long an open question waits for an answering client to (re)connect before failing `Unavailable`.        |
| `startupTimeoutMs`   | `60000`              | How long a request held while the host starts (below) waits for its plugins before failing `Unavailable`.   |

Endpoints (token as `Authorization: Bearer <token>` or `?token=`, which browser WebSockets need; otherwise `401`):

- `GET /rpc` — WebSocket, JSON serialization. One multiplexed connection for UIs.
- `POST /rpc/http` — streaming HTTP, NDJSON serialization. With `effect/rpc`'s HTTP client, add `HttpClient.filterStatusOk`: otherwise it parses a `401` body as NDJSON and waits forever. Also set the request URL whole (`HttpClientRequest.setUrl`), as `makeHostRpcHttp` in `@lemma/client` does: `RpcClient.layerProtocolHttp` posts to `<url>/`, which is not routed.
- `GET /api/health` — `{ ok: true, version, protocol }`: `protocol` is `HOST_PROTOCOL`, the version of what it serves on the wire (a host without one speaks 1). A client and a host on different protocols cannot talk: the CLI says so and asks for the host to be restarted.
- `GET /api/ui/<source>/<name>` — a UI file the host lists for the web app (`Ui.Composition`); any other name is `404`.

Without a configured `token`, the host's token is the one in `<Paths.home>/token`. The first start creates that file with a random token (mode 0600, in a 0700 home; never starting with `-`, which `--token <token>` would read as an option), complete before it appears and never replacing one another host created at the same moment; later starts read it, so clients on other machines stay valid across host restarts. Surrounding whitespace is ignored; an empty or unreadable file fails the plugin's activation. Delete the file and restart the host to rotate the token. Remote access is described in [docs/remote.md](../../docs/remote.md).

After listening it writes `<Paths.home>/transport.json` (mode 0600), the entry by which clients find the host (`Discovery` in `@lemma/contracts/discovery`), and removes it on shutdown unless another host has replaced it. It also publishes a `Notice` with the URL (and a tokenized link to the web app when `staticDir` is set).

The file is written as soon as the transport listens, before the plugins after it have started; the startup gate (below) holds requests for channels and inspectors until they have. Written later, it would make a starting host look absent: the CLI would report that no host runs, and the desktop app would start a second one. The gate, not the file, says when they are served, so it also covers clients that know the address another way (a remote, a reloaded page).

## Behavior

- **Errors.** Domain errors, a channel's and the host control's
  (`ReloadError`), become `HostError`, whose `code` is the error's `reason`
  (`NotFound`, `Busy`, …) or its tag, and whose `subject` names the session,
  provider, plugin, tool, or path. A handler's defect fails only its own
  request, as a defect carrying its message; the connection and its other
  requests go on.
- **RPCs** are the runtime's own, as
  [`RuntimeRpcs`](../../packages/contracts/src/rpc.ts) documents: the host's
  info, plugins, and changes through `HostControl`, its inspectors, the web
  app's composition, the questions it asks, and the channels. `Host.Inspect`
  checks a snapshot is JSON before sending it, so one that is not fails that
  request `Failed`, naming the inspector, rather than as a defect from the
  protocol.
- **Startup.** `Channel.List`, `Channel.Call`, `Channel.Open`,
  `Host.Inspectors`, and `Host.Inspect` wait until the composition is first
  up (`HostControl.composition` resolves). They answer from registries
  (`Channels`, `Inspectors`), which show a starting composition's
  contributions only once it is up, all at once. So a request made as soon as
  the host was found reaches the channel or inspector of a plugin that starts
  after the transport, rather than failing `NotFound`. One still waiting after
  `startupTimeoutMs` fails `Unavailable`, naming the channel or inspector it
  names. A channel's own error can be `Unavailable` too, so the code alone
  does not say the host is starting. A restarted transport's gate opens at
  once. `Host.Info`, `Host.Plugins`, and the host's changes are not held: they
  wait for the composition through `HostControl`.
- **Channels.** `Channel.List`, `Channel.Call`, and `Channel.Open` serve
  whatever host plugins add to
  [`Channels`](../../packages/contracts/src/channels.ts), read at each call,
  so a subsystem reaches its clients, and a plugin gives its own UI a call or
  a stream, without a change here. Payloads and results cross as
  JSON through the channel's own schemas' JSON codecs, inside the request, so a
  schema or handler that throws fails that request alone (`InvalidPayload`,
  `Failed`), and a value its codec cannot send fails `Failed` rather than
  reaching the protocol's serializer. Each call and stream runs as work with
  the channel answering for its id when it arrives (`Registries.run` in the
  core), from decoding its payload to encoding what it sends, so the plugin's
  finalizers wait for it; a request is `NotFound` only when nothing answers,
  once any change to the composition under way has finished (one made during
  an exclusive plugin's restart reaches its replacement).
  When the plugin stops or is replaced, a call in flight finishes on its own
  instance and is interrupted, `Withdrawn`, only if it outlives the dispose
  deadline, unless its handler stops at once for the plugin leaving, as one
  that waits on its plugin does: the transport hands it `left` and a `signal`
  (`CallLifetime`), and a call that stops for them ends `Withdrawn` too. A
  call declared `repeatable` is made again instead, on what answers for its
  id next, a replacement or what the change left (`withChannel` says how,
  and how these waits end): `Withdrawn` exists only because the host
  reloads plugins, so the host hides it where repeating is safe. A
  stream is stopped at once and ends `Withdrawn`, so it never holds its
  plugin's disposal, and it runs outside its plugin's `Admitted` work: a
  change it asks for that restarts its own plugin applies at once rather than
  wait for its client to close it (see `ChangeReport`). A middleware
  around each `Channel.Open` request (`ChannelLifetime`) does the stopping,
  because the RPC server sends the next chunk only once the client
  acknowledged the last (WebSocket) or the response drained (streaming HTTP),
  and only a wrapper around the whole request can end one blocked there: a
  client that stopped reading cannot keep a withdrawn stream running. A stream
  also ends `Withdrawn` when another plugin's channel takes over its id (a
  lower order), so a client that reopens reaches the one answering now; a call
  in flight is left to finish. A stream is pulled at its client's pace over
  either protocol: one chunk ahead of the client over the WebSocket, as far as
  the connection's buffers allow over HTTP. Effect's RPC client reads a
  WebSocket in order, so a client that stops taking a stream's elements stalls
  its own connection, never the host.
- **`Host.Events`.** The runtime's events ([`RuntimeEvent`](../../packages/contracts/src/rpc.ts)): the kernel events behind them (`Notice`, `PluginsChanged`, `UiChanged`) are observed once, at activation, and copied into every subscriber's drop-oldest buffer (1024 events): a slow client loses old events, never the publisher's time, and lists again what they report. `channels-changed` comes from watching `Channels` itself, whenever a different contribution answers for any id, so a client hears that a channel is back even when no plugin event says so (a scheduled restart publishes none). Each kind has its own observer queue, so order holds within a kind but not across kinds. A subscription opens with `{ type: "subscribed" }`, sent once the subscriber has joined: a client that must see the effects of its own next call (a question a command asks) waits for it. A call's reply is no such sign, since the host handles the calls on one socket concurrently and the RPC client sends a stream request asynchronously. A subsystem streams its own changes on its channels (`agent.activity`, `sessions.changes`).
- **Interaction.** A `Host.Events` subscriber says whether it answers questions (`answers`): a web app does, as does a command that asks at its terminal or was given its answers; a client that only watches (`lemma events`, a script's `lemma run`) does not. With at least one answering subscriber, an `InteractionHook` request is held for them and broadcast as an `interaction` event to every subscriber, watchers included, through a per-subscriber queue that never drops, and replayed to clients that subscribe while it is open. The first `Interaction.Answer` wins; `Interaction.Dismiss` fails it `Dismissed`. Once it settles, or the asking fiber is interrupted, every client receives `interaction-closed`. With no answering subscriber the request passes to the next handler (and, with none left, the host's `Interaction` reports `Unavailable`), so a watcher never holds a question nobody will answer. If every answering client leaves and none returns within `interactionGraceMs`, it fails `Unavailable`.
- **Shutdown** closes the listener and destroys open sockets, including upgraded WebSockets, before any other cleanup: `server.close` and the platform's WebSocket server would each wait for connected clients, so a reload with a UI attached would miss its deadline and leave the port bound.

## Rationale

It requires the runtime only, so no subsystem is part of it: a change to any other plugin leaves it running, and with it every client's connection. A repeatable call that change cut off is made again here; any other call, and a stream, ends `Withdrawn`, and the client decides whether to make it again on the same connection (`follow` in `@lemma/client` reopens a stream so). Only a change to the transport itself drops the connections: the host answers it first and applies it once the reply has left (`ChangeReport.deferred`).

Two protocols share one handler set because their consumers differ: a UI keeps a socket and multiplexes everything; a script wants one HTTP call that returns when done. Authentication is checked per request before routing, so the WebSocket upgrade is covered by the same check, while static assets stay public because they contain no data. Interaction goes through the hook, not an event, because a question nobody can see must fail the operation rather than hang it; the event stream is only the delivery vehicle. The grace period and replay exist so a page reload does not abort a login in progress.
