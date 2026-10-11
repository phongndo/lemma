import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import type { CompositionChange, SpanRecord } from "@lemma/contracts";
import { CliError } from "../src/command.ts";
import type { Io, Options } from "../src/command.ts";
import { traceCommand } from "../src/trace.ts";
import { fakeHost } from "./fake.ts";

const spans: SpanRecord[] = [
  { id: "a", traceId: "t1", name: "agent.turn", start: 1000, ms: 20, status: "ok", attributes: { "session.id": "s1" } },
  { id: "b", parentId: "a", traceId: "t1", name: "tool bash", start: 1002, ms: 5, status: "error", error: "exit 1", attributes: { "session.id": "s1" } },
];
const changes: CompositionChange[] = [{ at: 900, cause: "start", started: ["agent.loop"], stopped: [], restarted: [], failed: [] }];

const exported = async (argv: readonly string[], options: Partial<Options>) => {
  const asked: unknown[] = [];
  const host = fakeHost({
    calls: {
      "devtools.trace.spans": (payload) => (asked.push(payload), Effect.succeed(spans)),
      "devtools.trace.changes": () => Effect.succeed(changes),
    },
  });
  const io: Io = { env: {}, cwd: tmpdir(), out: () => {}, err: () => {} };
  const command = traceCommand("export", argv, io, { json: false, ...options } as Options);
  if (command instanceof CliError) throw command;
  return { output: await Effect.runPromise(Effect.scoped(command(host, io, { json: false, ...options } as Options))), asked };
};

describe("lemma trace export", () => {
  test("writes every span the host kept, and its changes, in the contracts' shapes; --session asks for a session's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lemma-trace-"));
    try {
      const { output, asked } = await exported([join(dir, "trace.json")], { session: "s1" });
      expect(asked).toEqual([{ where: { "session.id": "s1" }, limit: Number.MAX_SAFE_INTEGER }]);
      expect(output?.text).toBe(`wrote 2 spans of 1 traces, and 1 composition changes, to ${join(dir, "trace.json")}`);
      expect(JSON.parse(await readFile(join(dir, "trace.json"), "utf8"))).toMatchObject({ spans, changes, exportedAt: expect.any(Number) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--format chrome prints Chrome's trace event format, which Perfetto opens", async () => {
    const { output } = await exported([], { format: "chrome" });
    expect(output?.json).toMatchObject({
      displayTimeUnit: "ms",
      traceEvents: [
        { ph: "M", name: "process_name", pid: 1, args: { name: "agent.turn" } },
        { ph: "X", name: "agent.turn", pid: 1, tid: 1, ts: 1_000_000, dur: 20_000 },
        { ph: "X", name: "tool bash", pid: 1, tid: 1, args: { status: "error", error: "exit 1" } },
      ],
    });
  });

  test("names what it takes", () => {
    const io: Io = { env: {}, cwd: "/", out: () => {}, err: () => {} };
    const said = (command: unknown) => (command instanceof CliError ? [command.code, command.message.split("\n")[0]] : command);
    expect(said(traceCommand(undefined, [], io, {} as Options))).toEqual(["Usage", "trace needs a subcommand: export"]);
    expect(said(traceCommand("export", [], io, { format: "otlp" } as Options))).toEqual(["Usage", '--format is json or chrome, not "otlp"']);
  });
});
