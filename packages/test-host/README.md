# @lemma/test-host

A plugin tested in real turns. `testHost` starts the host's own agent loop
(`agent.loop`), sessions store (`sessions.files`), and tool registry
(`tools.registry`) with the plugins under test and a model that answers from a
script, in a home of its own. The plugins' behavior is what a turn logged, what
the model was sent, and what the tools did, end to end, with no provider and
no credentials.

```ts
import { call, callTools, reply, testHost } from "@lemma/test-host";
import plugin from "../plugin.ts";

const host = await testHost({ plugins: [plugin], model: [callTools(call("greet", { name: "Ada" })), reply("Done.")] });
try {
  const turn = await host.prompt("say hello to Ada");
  // turn.requests: what the model was sent; turn.events: the session's log; turn.answer: its last text.
} finally {
  await host.close();
}
```

- **The model.** `model` is its answers, one per request, in order: `reply(text)`,
  `callTools(call(name, args), ...)` (the turn takes another step to read
  their results), `fail(message)` (a provider's error), or a function of the
  request that returns one. A request past the end of the script fails, saying
  so, and so does the turn.
- **The host.** `prompt` sends a prompt to a new session (or `sessionId`) and
  waits for its turn to end. `run` runs an Effect with the composition's
  services (`Sessions`, `Agent`, a capability a plugin under test provides).
  `bundled` adds bundled plugins by id (`tools.read`), and `configs` gives
  plugins their config, as a row in `config.jsonc` does.
- **What is not there.** The host's control (reloading, configuring,
  restarting) fails as unavailable, and there is no web app or transport: a
  test that needs them runs the plugin in a host, as `lemma plugins check` does.

It runs in Node's test runner or vitest. `lemma plugins test` runs a plugin
folder's tests with it, resolving `@lemma/*` and `effect` to this checkout
([Writing plugins](../../docs/plugins.md#testing)). It is a package of its own,
not part of `@lemma/host` or `@lemma/testing`, because it imports domain
contracts, which the host's runtime may not, and the bundled plugins, which
`@lemma/testing`'s users are.
