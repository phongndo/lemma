# transport

How clients reach the host: the web app, the desktop shell, and the CLI. The domain has no contract: what it serves is the runtime's (`RuntimeRpcs` in [`@lemma/contracts`](../../packages/contracts/src/rpc.ts)) and the channels every other domain adds.

| Plugin                                 | Halves | What it does                                                                                                                                 |
| -------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [`transport.server`](server/README.md) | host   | Serves the runtime's calls and every channel over WebSocket and streaming HTTP. Pinned: replace it with another transport, never turn it off |

## Extending it

A transport of your own provides nothing and requires only what the host provides: it serves `RuntimeRpcs`, reads `Channels` and `Inspectors` from the core's registries, and answers `InteractionHook` for its clients. Give it `transport.server`'s id to replace it. To have the host apply a change that restarts it once the reply asking for it has left, rather than cut that reply off, run each request as work of its own until then, as `transport.server` does ([replies](server/README.md#behavior)).
