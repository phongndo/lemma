import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, Events, makeCore, PluginContext } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { emptyUsage, Harnesses, HarnessesChanged, Paths, Sessions } from "@lemma/contracts";
import type { Harness, HarnessInfo, HarnessTurn, SessionEvent } from "@lemma/contracts";
import sessions from "../../sessions/src/index.ts";
import harnesses, { recordTurn } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-harnesses-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const paths = definePlugin({
  id: "paths",
  provides: [Paths],
  layer: Layer.sync(Paths, () => ({ home: dir, userConfig: "", projectConfig: "", auth: "", sessions: path.join(dir, "sessions"), cwd: dir })),
});

const harness = (id: string, fields: Partial<Harness> = {}): Harness => ({
  id,
  title: id,
  capabilities: { steer: false, models: false, resume: false, requests: false },
  status: Effect.succeed({ state: "ready" }),
  run: () => Effect.succeed("done"),
  ...fields,
});

const contributor = (id: string, contributed: readonly Harness[]) =>
  definePlugin({
    id,
    requires: [Harnesses],
    layer: Layer.scopedDiscard(Effect.flatMap(Harnesses, (registry) => Effect.forEach(contributed, registry.register, { discard: true }))),
  });

const changes = () => {
  const seen: (readonly HarnessInfo[])[] = [];
  const plugin = definePlugin({
    id: "listener",
    layer: Layer.effectDiscard(
      Effect.flatMap(PluginContext, (owner) =>
        owner.observe(HarnessesChanged, ({ harnesses: listed }) =>
          Effect.sync(() => {
            seen.push(listed);
          }),
        ),
      ),
    ),
  });
  return { plugin, seen };
};

const run = <A, E>(plugins: readonly Plugin[], body: Effect.Effect<A, E, Harnesses | Sessions | Events>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([paths, sessions, harnesses, ...plugins]);
        return yield* core.run(body);
      }),
    ),
  );

describe("registry", () => {
  it("lists by title with the plugin that registered each, asking a failing or silent status as unavailable", async () => {
    const listener = changes();
    await run(
      [
        listener.plugin,
        contributor("mine", [
          harness("zeta", { title: "Zeta" }),
          harness("alpha", { title: "Alpha", status: Effect.die(new Error("no binary")) }),
          harness("slow", { title: "Slow", status: Effect.never }),
        ]),
      ],
      Effect.gen(function* () {
        const registry = yield* Harnesses;
        const listed = yield* registry.list;
        expect(listed.map((info) => [info.id, info.source, info.status.state])).toEqual([
          ["alpha", "mine", "unavailable"],
          ["slow", "mine", "unavailable"],
          ["zeta", "mine", "ready"],
        ]);
        expect(listed[0]!.status.detail).toContain("no binary");
        expect(listed[1]!.status.detail).toContain("did not answer");
        expect((yield* registry.get("zeta"))?.title).toBe("Zeta");
        expect(yield* registry.get("nope")).toBeUndefined();
      }),
    );
  }, 15_000);

  it("refuses an id another plugin registered", async () => {
    const fault = await Effect.runPromise(
      Effect.scoped(Effect.flip(makeCore([paths, sessions, harnesses, contributor("first", [harness("same")]), contributor("second", [harness("same")])]))),
    );
    // The second contributor fails to activate, saying who holds the id.
    expect(fault).toMatchObject({ _tag: "PluginFault", pluginId: "second", phase: "activate" });
    expect(JSON.stringify(fault)).toContain('Harness \\"same\\" is already registered by first');
  });

  it("asks every status again on refresh and tells listeners", async () => {
    let ready = false;
    const listener = changes();
    await run(
      [
        listener.plugin,
        contributor("mine", [
          harness("late", { status: Effect.sync(() => (ready ? { state: "ready" as const } : { state: "unavailable" as const, detail: "Not yet" })) }),
        ]),
      ],
      Effect.gen(function* () {
        const registry = yield* Harnesses;
        expect((yield* registry.list)[0]!.status.state).toBe("unavailable");
        ready = true;
        // Cached until asked again.
        expect((yield* registry.list)[0]!.status.state).toBe("unavailable");
        expect((yield* registry.refresh)[0]!.status.state).toBe("ready");
        yield* Effect.sleep("20 millis");
        expect(listener.seen.at(-1)?.[0]?.status.state).toBe("ready");
      }),
    );
  });
});

describe("recordTurn", () => {
  const live = { startStep: () => {}, apply: () => 1, endStep: () => {}, toolEnded: () => {} };
  const turnOf = (sessionId: string, fields: Partial<HarnessTurn> = {}): HarnessTurn => ({
    sessionId,
    turnId: "t1",
    cwd: dir,
    options: {},
    prompts: [],
    signal: new AbortController().signal,
    inbox: { steers: Effect.succeed([]), placed: () => Effect.void },
    live,
    logged: () => {},
    suspended: () => false,
    ...fields,
  });
  const producer = { harness: "other", api: "test", provider: "other", model: "m" };

  it("closes a turn a restart cut off, answering its open call, chained after its last event", async () => {
    await run(
      [],
      Effect.gen(function* () {
        const store = yield* Sessions;
        const events = yield* Events;
        const { id } = yield* store.create({ cwd: dir });
        const start = yield* store.append(id, { type: "turn-start", turnId: "t1", harness: "other" });
        const step = yield* store.append(id, { type: "step-start", turnId: "t1", stepId: "s1" }, { parent: start.id });
        const call = yield* store.append(
          id,
          {
            type: "message",
            turnId: "t1",
            stepId: "s1",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
              api: "test",
              provider: "other",
              model: "m",
              usage: emptyUsage,
              stopReason: "toolUse",
              timestamp: 1,
            },
          },
          { parent: step.id },
        );
        // A rename meanwhile hangs off the session's leaf; the closing events still chain after the turn's own.
        yield* store.append(id, { type: "title", title: "Renamed" });
        const reason = yield* recordTurn({ sessions: store, events }, turnOf(id, { resume: { cancelling: false } }), producer, () => Effect.die("not run"));
        expect(reason).toBe("error");
        const log = yield* store.events(id);
        const closing = log.slice(-3);
        expect(closing.map((event) => event.data.type)).toEqual(["message", "step-end", "turn-end"]);
        expect(closing[0]!.parent).toBe(call.id);
        expect(closing[0]!.data).toMatchObject({ stepId: "s1", message: { role: "toolResult", toolCallId: "c1", isError: true } });
        expect((closing[2]!.data as Extract<SessionEvent["data"], { type: "turn-end" }>).error).toContain("cannot continue it");
      }),
    );
  });

  it("closes a cut-off turn whose cancel came first as cancelled", async () => {
    await run(
      [],
      Effect.gen(function* () {
        const store = yield* Sessions;
        const events = yield* Events;
        const { id } = yield* store.create({ cwd: dir });
        yield* store.append(id, { type: "turn-start", turnId: "t1", harness: "other" });
        const reason = yield* recordTurn({ sessions: store, events }, turnOf(id, { resume: { cancelling: true } }), producer, () => Effect.die("not run"));
        expect(reason).toBe("cancelled");
        expect((yield* store.events(id)).map((event) => event.data.type)).toEqual(["turn-start", "turn-end"]);
      }),
    );
  });
});
