import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, expect } from "vitest";
import { makeCore } from "@lemma/core";
import { Agent, branchOf, rebuildRequest, Sessions, ToolResult } from "@lemma/contracts";
import type { LlmRequest, SessionEvent, Tool, ToolCall, ToolResultMessage } from "@lemma/contracts";
import sessions from "../../sessions/src/index.ts";
import tools from "../../tools/src/index.ts";
import agent from "../src/index.ts";
import { TOOLS_STARTED } from "../src/resume.ts";
import { call, failWith, fakeLlm, host, paths, reply, tempDir, testTools, useTools, waitFor } from "./fakes.ts";
import type { Script } from "./fakes.ts";

/*
 * Crash at every point of a turn: the turn runs once to its end; then, for
 * each event it logged, a fresh home holds the log as it stood right after
 * that event (and the journal the agent wrote before the turn's first event),
 * as a crash there would leave it, without the unsynced live file. The agent
 * starts on it and resumes the turn, which must end as if nothing happened:
 * every tool call answered once, no call that is unsafe to repeat run twice,
 * and every request rebuildable from the log. Then the same again for crashes
 * while a resumed turn runs (crash-again.test.ts).
 */

let dirs: string[] = [];
const fresh = async () => {
  const dir = await tempDir();
  dirs.push(dir);
  return dir;
};
beforeEach(() => {
  dirs = [];
});
afterEach(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * The tools, counting what each run executes. `peek` is safe to repeat and runs with others, and `a` takes longer
 * than `b`, so their results are logged out of call order; `poke` runs with others but is unsafe to repeat; `echo`
 * (from the fakes) neither.
 */
const toolset = () => {
  const poked: string[] = [];
  const peek: Tool<{ readonly path: string }> = {
    name: "peek",
    description: "Reads.",
    input: Schema.Struct({ path: Schema.String }),
    replay: "safe",
    parallel: "safe",
    execute: async ({ path }) => {
      if (path === "a") await new Promise((resolve) => setTimeout(resolve, 20));
      return new ToolResult({ content: [{ type: "text", text: `contents of ${path}` }] });
    },
  };
  const poke: Tool<{ readonly at: string }> = {
    name: "poke",
    description: "Changes something.",
    input: Schema.Struct({ at: Schema.String }),
    parallel: "safe",
    execute: async ({ at }) => {
      poked.push(at);
      return new ToolResult({ content: [{ type: "text", text: `poked ${at}` }] });
    },
  };
  return { poked, tools: [peek, poke] };
};

/** The model's answers, in order: two reads and a change together, then an edit; another edit; then text. */
const answers = (): Script[] => [
  useTools(call("r1", "peek", { path: "a" }), call("r2", "peek", { path: "b" }), call("p1", "poke", { at: "x" }), call("e1", "echo", { text: "first" })),
  useTools(call("e2", "echo", { text: "second" })),
  reply("all done"),
];
/** The provider fails the first call, which is asked again. */
const overloaded = () => failWith("529 Overloaded", { kind: "transient" });
/** Calls unsafe to repeat, and what each one does. */
const UNSAFE = [
  { id: "e1", ran: (run: Ran) => run.executed.filter((text) => text === "first").length },
  { id: "e2", ran: (run: Ran) => run.executed.filter((text) => text === "second").length },
  { id: "p1", ran: (run: Ran) => run.poked.length },
] as const;

interface Ran {
  readonly requests: LlmRequest[];
  readonly executed: string[];
  readonly poked: string[];
}

const runAgent = <A>(dir: string, scripts: readonly Script[], body: (ran: Ran) => Effect.Effect<A, unknown, Agent | Sessions>) => {
  const llm = fakeLlm(scripts);
  const own = toolset();
  const test = testTools(own.tools);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([paths(dir, dir), host(), sessions, tools, test.plugin, llm.plugin, agent], {
          configs: { agent: { stopGrace: 0, retryDelay: 0.001 } },
        });
        return yield* core.run(body({ requests: llm.requests, executed: test.executed, poked: own.poked }));
      }),
    ),
  );
};

const sessionFile = async (dir: string): Promise<string> => {
  const root = path.join(dir, "sessions");
  for (const project of await fs.readdir(root)) {
    if (project.startsWith(".")) continue;
    const [file] = await fs.readdir(path.join(root, project));
    if (file !== undefined) return path.join(root, project, file);
  }
  throw new Error("no session file");
};
const readLog = async (file: string) => {
  const [header, ...lines] = (await fs.readFile(file, "utf8")).split("\n").filter((line) => line !== "");
  return { header: header!, lines };
};

const toolCalls = (events: readonly SessionEvent[]): ToolCall[] =>
  events.flatMap((event) =>
    event.data.type === "message" && event.data.message.role === "assistant"
      ? event.data.message.content.filter((block): block is ToolCall => block.type === "toolCall")
      : [],
  );
const resultsOf = (events: readonly SessionEvent[]) =>
  events.flatMap((event) => (event.data.type === "message" && event.data.message.role === "toolResult" ? [event.data.message as ToolResultMessage] : []));

/** The whole turn, uninterrupted, and what a crash needs to start from: the log's header, the journal, the session. */
/** Runs the turn once to its end; `resumeFrom` then crashes it at a point and checks the resumption (registers temp-dir hooks). */
export const original = async () => {
  const dir = await fresh();
  const { id, prompt } = await runAgent(dir, [overloaded(), ...answers()], () =>
    Effect.gen(function* () {
      const { id } = yield* (yield* Sessions).create();
      yield* (yield* Agent).prompt(id, [{ type: "text", text: "go" }], { requestId: "req-1" });
      const events = yield* (yield* Sessions).events(id);
      const user = events.find((event) => event.data.type === "message" && event.data.message.role === "user")!;
      return { id, prompt: user };
    }),
  );
  const file = await sessionFile(dir);
  const { header, lines } = await readLog(file);
  const events = lines.map((line) => JSON.parse(line) as SessionEvent);
  expect(events.at(-1)!.data.type).toBe("turn-end");
  expect(events.filter((event) => event.data.type === "attempt")).toHaveLength(1);
  // The reads together, logged out of call order.
  const order = resultsOf(events).map((result) => result.toolCallId);
  expect(order.indexOf("r1")).toBeGreaterThan(order.indexOf("r2"));
  const turnId = (events.find((event) => event.data.type === "turn-start")!.data as { turnId: string }).turnId;
  const journal = {
    turn: { turnId, marked: true, prompts: [{ requestId: "req-1", content: [{ type: "text", text: "go" }], mode: "follow-up", at: prompt.at }] },
    queue: [],
  };

  /**
   * Starts the agent over a fresh home holding `lines` of the log and the journal, as a crash after the last of
   * them would leave it, and checks the turn it resumes. Returns the lines of the log it ends with.
   */
  const resumeFrom = async (lines: readonly string[], where: string): Promise<string[]> => {
    const before = lines.map((line) => JSON.parse(line) as SessionEvent);
    const home = await fresh();
    const target = path.join(home, path.relative(dir, file));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, [header, ...lines].map((line) => `${line}\n`).join(""));
    await fs.mkdir(path.join(home, "agent"), { recursive: true });
    await fs.writeFile(path.join(home, "agent", `${id}.json`), JSON.stringify(journal));

    // The model answers from where the log stops: answers it has logged are not asked for again, nor a failure it has.
    const answered = before.filter((event) => event.data.type === "message" && event.data.message.role === "assistant").length;
    const failed = before.some((event) => event.data.type === "attempt");
    const answeredBefore = new Set(resultsOf(before).map((result) => result.toolCallId));
    const startedBefore = new Set(
      before.flatMap((event) =>
        event.data.type === "custom" && event.data.kind === TOOLS_STARTED ? (event.data.data as { toolCallIds: string[] }).toolCallIds : [],
      ),
    );

    await runAgent(home, [...(failed || answered > 0 ? [] : [overloaded()]), ...answers().slice(answered)], (ran) =>
      Effect.gen(function* () {
        const events = yield* waitFor((yield* Sessions).events(id), (log) => log.some((event) => event.data.type === "turn-end"));

        const ends = events.filter((event) => event.data.type === "turn-end");
        expect(
          ends.map((event) => (event.data as { reason: string }).reason),
          where,
        ).toEqual(["done"]);
        const users = events.filter((event) => event.data.type === "message" && event.data.message.role === "user");
        expect(users, where).toHaveLength(1);

        // Every call on the final branch answered exactly once.
        const branch = branchOf(events, ends[0]!.id);
        const answers = new Map<string, number>();
        for (const result of resultsOf(branch)) answers.set(result.toolCallId, (answers.get(result.toolCallId) ?? 0) + 1);
        for (const toolCall of toolCalls(branch)) expect(answers.get(toolCall.id), `${where}: ${toolCall.id}`).toBe(1);

        // A call unsafe to repeat that had begun (or ended) before the crash never runs again, and one cut off is
        // reported as interrupted; one that had not begun runs now.
        for (const unsafe of UNSAFE) {
          const begun = answeredBefore.has(unsafe.id) || startedBefore.has(unsafe.id);
          expect(unsafe.ran(ran), `${where}: ${unsafe.id}`).toBe(begun ? 0 : 1);
          if (startedBefore.has(unsafe.id) && !answeredBefore.has(unsafe.id)) {
            const result = resultsOf(branch).find((message) => message.toolCallId === unsafe.id)!;
            expect(result.content[0], `${where}: ${unsafe.id}`).toMatchObject({ text: expect.stringContaining("interrupted") });
          }
        }

        // What the resumed agent asked the model is what its log says it asked.
        const logged = events.filter((event) => event.data.type === "request" && !before.some((old) => old.id === event.id));
        expect(logged.length, where).toBe(ran.requests.length);
        logged.forEach((event, i) => expect(rebuildRequest(branchOf(events, event.id), event.id, id), where).toEqual(ran.requests[i]));
      }),
    );
    return (await readLog(target)).lines;
  };
  return { lines, events, resumeFrom };
};
