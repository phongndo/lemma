import { describe, expect, test } from "vitest";
import { Effect, Queue, Stream } from "effect";
import { emptyUsage } from "@lemma/contracts";
import type { EventData, HostEvent, SessionEvent } from "@lemma/contracts";
import type { HostRpcClient } from "@lemma/client";
import type { Connection, Options } from "../src/command.ts";
import { runCommand } from "../src/live.ts";

const sessionId = "s1";
const turnId = "t1";
const stepId = "t1.1";
const requestId = "r1";

const data: EventData[] = [
  { type: "turn-start", turnId },
  { type: "message", turnId, requestId, message: { role: "user", content: [{ type: "text", text: "ramble" }], timestamp: 0 } },
  { type: "step-start", turnId, stepId },
  {
    type: "message",
    turnId,
    stepId,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "word1 word2 " }],
      api: "x",
      provider: "p",
      model: "m",
      usage: emptyUsage,
      stopReason: "stop",
      timestamp: 0,
    },
  },
  { type: "step-end", turnId, stepId },
  { type: "turn-end", turnId, reason: "done" },
];
const log: SessionEvent[] = data.map((data, i) => ({ seq: i + 1, id: `e${i + 1}`, parent: i === 0 ? null : `e${i}`, at: 1000 + i, data }));
const word = (n: number): HostEvent => ({ type: "delta", sessionId, turnId, stepId, seq: n, event: { type: "text-delta", index: 0, delta: `word${n} ` } });

/**
 * A host whose `turn-ended` overtakes the answer's last delta, as its events of different kinds may: that delta comes
 * when the command first reads the log after the prompt (`late`), or never.
 */
const overtaken = (late: boolean): Connection => {
  const feed = Effect.runSync(Queue.unbounded<HostEvent>());
  let prompted = false;
  let delivered = false;
  const rpc = {
    "Host.Events": () => Stream.concat(Stream.succeed<HostEvent>({ type: "subscribed" }), Stream.fromQueue(feed)),
    "Agent.Prompt": () =>
      Effect.sync(() => {
        prompted = true;
        const events: HostEvent[] = [
          { type: "turn-started", sessionId, turnId },
          { type: "session-appended", sessionId, event: log[1]! },
          word(1),
          { type: "turn-ended", sessionId, turnId, usage: emptyUsage, reason: "done" },
        ];
        for (const event of events) Queue.offerUnsafe(feed, event);
      }),
    "Session.Events": () =>
      Effect.sync(() => {
        if (!prompted) return [];
        if (late && !delivered) Queue.offerUnsafe(feed, word(2));
        delivered = true;
        return log;
      }),
    "Session.Get": () => Effect.succeed({ id: sessionId, leaf: log.at(-1)!.id }),
  } as unknown as HostRpcClient;
  return { target: {} as Connection["target"], rpc, live: Effect.succeed(rpc) };
};

const options: Options = {
  json: false,
  all: false,
  records: false,
  desc: false,
  images: [],
  follow: true,
  answers: [],
  create: false,
  force: false,
  project: false,
  unset: false,
  requestId,
};

const follow = async (connection: Connection) => {
  let shown = "";
  const io = {
    env: {},
    cwd: "/",
    out: (text: string) => {
      shown += `${text}\n`;
    },
    write: (text: string) => {
      shown += text;
    },
    err: () => {},
  };
  const output = await Effect.runPromise(Effect.scoped(runCommand(sessionId, ["ramble"])(connection, io, options)));
  return { shown, output };
};

describe("run --follow", () => {
  test("shows the answer's text that turn-ended overtook, from the log", async () => {
    const { shown, output } = await follow(overtaken(false));
    expect(shown).toBe("word1 word2 \n");
    expect(output?.exit).toBeUndefined();
  });

  test("skips the overtaken text when it comes after all, so it shows once", async () => {
    expect((await follow(overtaken(true))).shown).toBe("word1 word2 \n");
  });
});
