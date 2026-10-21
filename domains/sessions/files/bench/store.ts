// The session log on the real disk: an append waits for its fdatasync, a restarted host lists what it has, and a long
// session (an agent's turns: prompts, requests, replies with thinking, tool output up to 50 KB) is opened, held,
// projected, searched, and listed without its index. Absolute numbers depend on the disk and the machine; compare runs on
// one machine. Run: `pnpm sessions:bench`.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Duration, Effect } from "effect";
import { makeCore } from "@lemma/core";
import { Sessions, trajectory } from "@lemma/sessions";
import type { EventData } from "@lemma/sessions";
import { pathsPlugin } from "@lemma/contracts/testing";
import { nodeFileSystem } from "@lemma/contracts/fs";
import type { FileSystem } from "@lemma/contracts/fs";
import { finish, record } from "../../../../packages/core/bench/budgets.ts";
import sessions, { makeSessionsPlugin } from "../src/index.ts";

const appends = Number(process.env.LEMMA_BENCH_APPENDS ?? 500);
const listed = Number(process.env.LEMMA_BENCH_SESSIONS ?? 200);
const events = Number(process.env.LEMMA_BENCH_EVENTS ?? 10_000);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-sessions-bench-"));
const paths = pathsPlugin(dir);
const host = <A, E>(body: Effect.Effect<A, E, Sessions>, plugin = sessions) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(makeCore([paths, plugin]), (core) => core.run(body))));
const percentile = (values: readonly number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!;
const timed = <A, E>(body: Effect.Effect<A, E, Sessions>) =>
  host(Effect.map(Effect.timed(body), ([taken, value]) => ({ ms: Duration.toMillis(taken), value })));
const heap = () => {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) throw new Error("Run with --expose-gc");
  for (let i = 0; i < 3; i++) gc();
  return process.memoryUsage().heapUsed;
};

/** The disk without its syncs: the long session is written fast, and what is measured of it is reading. */
const unsynced: FileSystem = {
  ...nodeFileSystem,
  open: async (file, flags, mode) => {
    const handle = await nodeFileSystem.open(file, flags, mode);
    return {
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      write: (buffer, offset, length, position) => handle.write(buffer, offset, length, position),
      appendFile: (data) => handle.appendFile(data),
      writeFile: (data) => handle.writeFile(data),
      chmod: (mode) => handle.chmod(mode),
      stat: () => handle.stat(),
      truncate: (length) => handle.truncate(length),
      close: () => handle.close(),
      datasync: async () => {},
      sync: async () => {},
    };
  },
};

/** An agent's session, `count` events long, the same every run: turns of one to five steps, each a request and a reply with thinking, and most a tool call or two whose output is usually a few KB and sometimes near the 50 KB cut. */
function* agentSession(count: number): Generator<EventData> {
  let state = 0x2545f491;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const words = (chars: number) => {
    let text = "";
    while (text.length < chars)
      text += `${["the", "build", "session", "file", "error", "test", "request", "plugin"][Math.floor(random() * 8)]}${random() < 0.1 ? "\n" : " "}`;
    return text.slice(0, chars);
  };
  const usage = {
    input: 40_000,
    output: 400,
    cacheRead: 36_000,
    cacheWrite: 300,
    totalTokens: 40_400,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const tools = ["read", "bash", "edit", "write", "grep", "find", "ls", "patch", "codemode", "html", "lemma", "ask", "todo", "web", "search"];
  const contributions = [
    ...["base", "environment", "skills", "agents-md"].map((label) => ({ source: "agent.loop", kind: "system" as const, label, chars: 2000 })),
    ...tools.map((label) => ({ source: `tools.${label}`, kind: "tool" as const, label, chars: 600 })),
  ];
  const system = Array.from({ length: 4 }, () => words(2000)).join("\n\n");
  const specs = tools.map((name) => ({ name, description: words(500), parameters: { type: "object", properties: { path: { type: "string" } } } }));
  for (let n = 0, turn = 0; n < count; turn++) {
    const turnId = `turn${turn}`;
    yield { type: "turn-start", turnId, model: "p/m" };
    yield { type: "message", turnId, message: { role: "user", content: [{ type: "text", text: words(200 + Math.floor(random() * 1300)) }], timestamp: 0 } };
    n += 2;
    const steps = 1 + Math.floor(random() * 5);
    for (let step = 0; step < steps; step++) {
      const stepId = `step${turn}.${step}`;
      const calls =
        step === steps - 1
          ? []
          : Array.from({ length: 1 + Math.floor(random() * 2) }, (_, i) => ({
              type: "toolCall" as const,
              id: `call${turn}.${step}.${i}`,
              name: tools[Math.floor(random() * tools.length)]!,
              arguments: { path: "/src/index.ts" },
            }));
      yield { type: "step-start", turnId, stepId };
      yield {
        type: "request",
        turnId,
        stepId,
        model: "p/m",
        composition: "c",
        ...(n === 2 ? { system, tools: specs, restart: "start" as const } : {}),
        contributions,
      };
      yield {
        type: "message",
        turnId,
        stepId,
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: words(200 + Math.floor(random() * 2300)), thinkingSignature: "s".repeat(800) },
            { type: "text", text: words(100 + Math.floor(random() * 800)) },
            ...calls,
          ],
          api: "x",
          provider: "p",
          model: "m",
          usage,
          stopReason: calls.length === 0 ? "stop" : "toolUse",
          timestamp: 0,
        },
      };
      for (const call of calls) {
        const chars = random() < 0.15 ? 20_000 + Math.floor(random() * 30_000) : 100 + Math.floor(random() * 6000);
        yield {
          type: "message",
          turnId,
          stepId,
          message: {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: words(chars) }],
            isError: false,
            timestamp: 0,
          },
        };
      }
      yield { type: "step-end", turnId, stepId };
      n += 4 + calls.length;
    }
    yield { type: "turn-end", turnId, reason: "done" };
    n++;
  }
}

try {
  // Appends to one session, each durable before the next.
  const latencies = await host(
    Effect.gen(function* () {
      const store = yield* Sessions;
      const { id } = yield* store.create();
      const taken: number[] = [];
      for (let n = 0; n < appends; n++) {
        const start = performance.now();
        yield* store.append(id, { type: "custom", kind: "bench", data: { n, text: "x".repeat(200) } });
        taken.push(performance.now() - start);
      }
      return taken;
    }),
  );
  const total = latencies.reduce((sum, value) => sum + value, 0);
  record("sessionAppendsPerSecond", (appends * 1000) / total, "count/s");
  record("sessionAppendP50Ms", percentile(latencies, 0.5), "ms", latencies);
  record("sessionAppendP99Ms", percentile(latencies, 0.99), "ms", latencies);

  // A restarted host listing many sessions: the first list reads them, the next is served by the index.
  await host(
    Effect.gen(function* () {
      const store = yield* Sessions;
      for (let n = 0; n < listed; n++) {
        const { id } = yield* store.create();
        yield* store.append(id, { type: "title", title: `session ${n}` });
      }
    }),
  );
  await fs.rm(path.join(dir, "sessions", ".index.json"), { force: true });
  const listing = () => host(Effect.flatMap(Sessions, (store) => Effect.map(Effect.timed(store.list()), ([taken]) => Duration.toMillis(taken))));
  const cold = await listing();
  const warm = await listing();
  record("sessionListColdMs", cold, "ms");
  record("sessionListWarmMs", warm, "ms");

  // A long session, written through the store, then read by restarted hosts.
  const id = await host(
    Effect.gen(function* () {
      const store = yield* Sessions;
      const { id } = yield* store.create({ cwd: path.join(dir, "long") });
      for (const data of agentSession(events)) yield* store.append(id, data);
      return id;
    }),
    makeSessionsPlugin({ fs: unsynced }),
  );
  const { size } = await fs.stat(
    (await fs.readdir(path.join(dir, "sessions"), { recursive: true }))
      .map((name) => path.join(dir, "sessions", name))
      .find((file) => file.endsWith(`_${id}.jsonl`))!,
  );
  // Opened: read, validated, and held; its heap is what the store holds once garbage is collected.
  const opened = await host(
    Effect.gen(function* () {
      const store = yield* Sessions;
      const before = heap();
      const [taken, log] = yield* Effect.timed(store.events(id));
      const held = heap() - before;
      const branch = yield* store.branch(id);
      const start = performance.now();
      trajectory(branch);
      return { ms: Duration.toMillis(taken), events: log.length, held, trajectoryMs: performance.now() - start };
    }),
  );
  record("sessionOpenMs", opened.ms, "ms");
  record("sessionHeapPerEventBytes", opened.held / opened.events, "bytes");
  record("sessionTrajectoryMs", opened.trajectoryMs, "ms");
  // Searched for a word it does not hold, by a host that has not loaded it: the whole file is read for it.
  const searched = await timed(Effect.flatMap(Sessions, (store) => store.search("zqxjv")));
  record("sessionSearchMissMs", searched.ms, "ms");
  // Listed by a host whose index is gone: the whole file is read, but its events only from their heads.
  await fs.rm(path.join(dir, "sessions", ".index.json"), { force: true });
  const unindexed = await timed(Effect.flatMap(Sessions, (store) => store.list({ cwd: path.join(dir, "long") })));
  record("sessionListUnindexedMs", unindexed.ms, "ms");
  console.log(
    `${appends} appends: ${((appends * 1000) / total).toFixed(0)}/s, p50 ${percentile(latencies, 0.5).toFixed(2)} ms, p99 ${percentile(latencies, 0.99).toFixed(2)} ms; ` +
      `list of ${listed + 1}: cold ${cold.toFixed(1)} ms, warm ${warm.toFixed(1)} ms; ` +
      `a session of ${opened.events} events (${(size / 1e6).toFixed(1)} MB): open ${opened.ms.toFixed(0)} ms, ${(opened.held / opened.events).toFixed(0)} bytes held an event (${(opened.held / size).toFixed(2)}x its file), ` +
      `trajectory ${opened.trajectoryMs.toFixed(1)} ms, search with no match ${searched.ms.toFixed(1)} ms, listed without its index ${unindexed.ms.toFixed(1)} ms`,
  );
  finish("sessions", { appends, listed, events: opened.events, fileBytes: size });
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
