import * as fs from "node:fs/promises";
import { Deferred, Effect, Schedule } from "effect";
import type { Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCore } from "@lemma/core";
import { Agent } from "@lemma/agent";
import { titleFrom } from "@lemma/agent/kit";
import { CommandRunner } from "@lemma/commands";
import type { LlmRequest } from "@lemma/llm";
import { Sessions } from "@lemma/sessions";
import agent from "@lemma/agent-loop";
import commands from "@lemma/commands-registry";
import smallModel from "@lemma/llm-small-model";
import sessions from "@lemma/sessions-files";
import tools from "@lemma/tools-registry";
import { failWith, fakeLlm, gated, host, paths, reply, tempDir } from "../../loop/tests/fakes.ts";
import type { Script } from "../../loop/tests/fakes.ts";
import type { SessionEvent } from "@lemma/sessions";
import titles, { REGENERATE, TITLE_PROMPT } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const asked = "the upload test fails every other run on CI, can you find out why and fix it please";
const from = titleFrom([{ type: "text", text: asked }])!;
const isTitle = (request: LlmRequest) => request.system === TITLE_PROMPT;

/**
 * A model that answers the first title request with `first`, a later one with "Retry uploads on timeout", and the
 * thread's own requests with a reply.
 */
const naming = (first: Script) => {
  let asked = 0;
  return fakeLlm(
    Array.from(
      { length: 8 },
      () => (request: LlmRequest) => (isTitle(request) ? (++asked === 1 ? first : reply("Retry uploads on timeout")) : reply("On it.")),
    ),
  );
};

const titlesOf = (events: readonly SessionEvent[]) => events.flatMap(({ data }) => (data.type === "title" ? [data.title] : []));

/** Once a title has been asked for. */
const asking = (llm: ReturnType<typeof fakeLlm>) =>
  Effect.repeat(
    Effect.sync(() => llm.requests.some(isTitle)),
    { until: (asked) => asked, schedule: Schedule.spaced("10 millis"), times: 200 },
  );

/** Runs `test` in a host with the agent, the session log, the small model, and `agent.titles`. */
const run = <A>(llm: ReturnType<typeof fakeLlm>, test: Effect.Effect<A, unknown, Agent | Sessions | CommandRunner | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([paths(dir, dir), host(), sessions, tools, llm.plugin, agent, smallModel, commands, titles]);
        return yield* core.run(test);
      }),
    ),
  );

/** The session's title once `done` holds of it, or its title after two seconds. */
const titled = (id: string, done: (title: string | undefined) => boolean) =>
  Effect.gen(function* () {
    const store = yield* Sessions;
    return yield* store.get(id).pipe(
      Effect.map((info) => info.title),
      Effect.repeat({ until: done, schedule: Schedule.spaced("10 millis"), times: 200 }),
    );
  });

describe("agent.titles", () => {
  it("names a thread by its first prompt once its first turn has titled it, on the thread's model where its provider has no small one", async () => {
    // A model that writes on past its first line: the line is the title.
    const llm = naming(reply("Fix the flaky upload test\nIt fails because"));
    const title = await run(
      llm,
      Effect.gen(function* () {
        const { id } = yield* (yield* Sessions).create();
        yield* (yield* Agent).prompt(id, [{ type: "text", text: asked }]);
        return yield* titled(id, (title) => title !== from);
      }),
    );
    expect(title).toBe("Fix the flaky upload test");
    const named = llm.requests.filter(isTitle);
    expect(named).toHaveLength(1);
    expect(named[0]!.model).toBe("fake/m1");
    // A title is a few words: the call is capped.
    expect(named[0]!.maxTokens).toBeLessThanOrEqual(100);
    expect(JSON.stringify(named[0]!.messages)).toContain(asked);
  });

  it("keeps a rename made while it writes", async () => {
    const gate = Deferred.makeUnsafe<void>();
    const llm = naming(gated(gate, reply("Fix the flaky upload test")));
    const titles = await run(
      llm,
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* (yield* Agent).prompt(id, [{ type: "text", text: asked }]);
        yield* asking(llm);
        yield* store.append(id, { type: "title", title: "Mine" });
        yield* Deferred.succeed(gate, undefined);
        // Asked anew, after the first title is written or given up on.
        yield* (yield* CommandRunner).run(REGENERATE, { cwd: dir, sessionId: id });
        return titlesOf(yield* store.events(id));
      }),
    );
    expect(titles).toEqual([from, "Mine", "Retry uploads on timeout"]);
  });

  it("leaves the title from the prompt when the model fails", async () => {
    const llm = naming(failWith("overloaded"));
    const titles = await run(
      llm,
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* (yield* Agent).prompt(id, [{ type: "text", text: asked }]);
        yield* asking(llm);
        yield* (yield* CommandRunner).run(REGENERATE, { cwd: dir, sessionId: id });
        return titlesOf(yield* store.events(id));
      }),
    );
    expect(titles).toEqual([from, "Retry uploads on timeout"]);
  });

  it("names nothing named before its first prompt, as an agent's thread is, though by the words its prompt starts with", async () => {
    const llm = naming(reply("Review the upload retries"));
    const titles = await run(
      llm,
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        // As tools.delegate names an agent: its prompt's first line, here the title its prompt would give it.
        yield* store.append(id, { type: "title", title: from });
        yield* (yield* Agent).prompt(id, [{ type: "text", text: asked }]);
        yield* (yield* CommandRunner).run(REGENERATE, { cwd: dir, sessionId: id });
        return titlesOf(yield* store.events(id));
      }),
    );
    // The one title asked for is the one asked anew.
    expect(titles).toEqual([from, "Review the upload retries"]);
    expect(llm.requests.filter(isTitle)).toHaveLength(1);
  });

  it("names a thread anew when asked, by its latest messages, whatever its title", async () => {
    const llm = naming(reply("Fix the flaky upload test"));
    const result = await run(
      llm,
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        const turns = yield* Agent;
        yield* turns.prompt(id, [{ type: "text", text: asked }]);
        yield* titled(id, (title) => title !== from);
        yield* store.append(id, { type: "title", title: "Mine" });
        yield* turns.prompt(id, [{ type: "text", text: "make the upload retry on a timeout instead" }]);
        const outcome = yield* (yield* CommandRunner).run(REGENERATE, { cwd: dir, sessionId: id });
        return { outcome, title: (yield* store.get(id)).title };
      }),
    );
    expect(result).toEqual({ outcome: { message: "Titled “Retry uploads on timeout”" }, title: "Retry uploads on timeout" });
    const again = JSON.stringify(llm.requests.filter(isTitle).at(-1)!.messages);
    expect(again).toContain("make the upload retry");
    expect(again).toContain('Its title now is \\"Mine\\"');
  });

  it("asks for an open thread", async () => {
    const error = await run(
      naming(reply("x")),
      Effect.gen(function* () {
        return yield* Effect.flip((yield* CommandRunner).run(REGENERATE, { cwd: dir }));
      }),
    );
    expect(error.message).toContain("Open a thread");
  });
});
