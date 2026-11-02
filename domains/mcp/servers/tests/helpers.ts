import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";
import type { Scope } from "effect";
import { Events, Hooks, makeCore, Registries } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { eventFeed, Paths } from "@lemma/contracts";
import { Mcp, McpChanged } from "@lemma/mcp";
import type { McpState } from "@lemma/mcp";
import { ToolInvocation, ToolRunner } from "@lemma/tools";
import registry from "@lemma/tools-registry";
import mcpServers from "../src/index.ts";

/** A core with the tools registry and the plugin, in a home of its own with `servers` in its `mcp.json`. */
export const withCore = <A>(
  servers: Readonly<Record<string, unknown>>,
  body: (
    core: { run: <B, E>(effect: Effect.Effect<B, E, Mcp | ToolRunner | Events | Hooks | Registries>) => Effect.Effect<B, E> },
    home: string,
  ) => Effect.Effect<A, unknown, Scope.Scope>,
  extra: readonly Plugin[] = [],
  configs: Readonly<Record<string, unknown>> = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "lemma-mcp-")));
        yield* Effect.promise(() => writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: servers })));
        const paths = { home, root: home, userConfig: join(home, "config.jsonc"), projectConfig: join(home, "project.jsonc"), cwd: home };
        const core = yield* makeCore([registry, mcpServers, ...extra], { configs, provide: { provides: [Paths], layer: Layer.succeed(Paths, paths) } });
        return yield* body(core as never, home);
      }),
    ),
  );

/** The state once `check` holds of it: now, or after a change. */
export const until = (check: (state: McpState) => boolean) =>
  Effect.gen(function* () {
    const mcp = yield* Mcp;
    const events = yield* Events;
    const found = yield* eventFeed(mcp.state, [events.stream(McpChanged)]).pipe(Stream.filter(check), Stream.runHead);
    return found._tag === "Some" ? found.value : yield* Effect.die(new Error("the state stream ended"));
  }).pipe(Effect.timeout("30 seconds"));

/** Runs the tool `name` with `input`, as the model would. */
export const call = (name: string, input: unknown) =>
  Effect.flatMap(ToolRunner, (tools) =>
    tools.execute(new ToolInvocation({ sessionId: "s", toolCallId: "c", name, input, cwd: process.cwd() }), new AbortController().signal),
  );
