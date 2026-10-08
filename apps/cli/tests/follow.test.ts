import { describe, expect, test } from "vitest";
import { Deferred, Effect } from "effect";
import { emptyUsage, HostError } from "@lemma/contracts";
import type { AgentActivity, AgentView, AssistantMessage, EventData, SessionEvent, SessionLogUpdate } from "@lemma/contracts";
import type { Options } from "../src/command.ts";
import { runCommand } from "../src/run.ts";
import { fakeHost, fed } from "./fake.ts";
import type { Fed } from "./fake.ts";

const sessionId = "s1";
const turnId = "t1";
const requestId = "r1";

const answer = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "x",
  provider: "p",
  model: "m",
  usage: emptyUsage,
  stopReason: "stop",
  timestamp: 0,
});
const started: EventData[] = [
  { type: "turn-start", turnId },
  { type: "message", turnId, requestId, message: { role: "user", content: [{ type: "text", text: "ramble" }], timestamp: 0 } },
];
const step = (stepId: string, text: string): EventData[] => [
  { type: "step-start", turnId, stepId },
  { type: "message", turnId, stepId, message: answer(text) },
  { type: "step-end", turnId, stepId },
];
const ended: EventData = { type: "turn-end", turnId, reason: "done" };
const word = (stepId: string, seq: number, text = `word${seq} `): AgentActivity => ({
  type: "delta",
  sessionId,
  turnId,
  stepId,
  seq,
  event: { type: "text-delta", index: 0, delta: text },
});
const turnEnded: AgentActivity = { type: "turn-ended", sessionId, turnId, usage: emptyUsage, reason: "done" };

/** What a scripted host's prompt does: what the agent reports while it runs, through `host`. */
interface Host {
  /** Sends elements on the open `agent.activity`. */
  readonly act: (...elements: readonly AgentActivity[]) => void;
  /** Appends to the session's log, which the open `sessions.log` sends. */
  readonly append: (...data: readonly EventData[]) => void;
  /** Ends the open `agent.activity` withdrawn, as the agent's reload does. */
  readonly reload: () => void;
  /** Resolves once `agent.activity` has been opened again. */
  readonly reopened: Effect.Effect<void>;
}

/**
 * A host whose `agent.prompt` runs `prompt` (its `n`th call), with the
 * session's log as `log` has it and `agent.view` answering `view`.
 * `streamed` is sent on each `agent.activity` after its `subscribed`.
 */
const scripted = (script: {
  readonly log?: readonly EventData[];
  readonly view?: AgentView;
  readonly streamed?: readonly AgentActivity[];
  readonly prompt: (host: Host, n: number) => Effect.Effect<void, HostError>;
}) => {
  const logged: SessionEvent[] = [];
  const activities: Fed<AgentActivity>[] = [];
  const logs: Fed<SessionLogUpdate>[] = [];
  const prompts: unknown[] = [];
  const reopened = Deferred.makeUnsafe<void>();
  const append = (...data: readonly EventData[]) => {
    for (const item of data) {
      const seq = logged.length + 1;
      const event: SessionEvent = { seq, id: `e${seq}`, parent: seq === 1 ? null : `e${seq - 1}`, at: 1000 + seq, data: item };
      logged.push(event);
      logs.at(-1)?.push({ type: "appended", event });
    }
  };
  append(...(script.log ?? []));
  const host: Host = {
    act: (...elements) => activities.at(-1)!.push(...elements),
    append,
    reload: () => activities.at(-1)!.fail(new HostError({ code: "Withdrawn", subject: "agent.activity", message: "withdrawn" })),
    reopened: Deferred.await(reopened),
  };
  const connection = fakeHost({
    calls: {
      "agent.prompt": (payload) => {
        prompts.push(payload);
        return script.prompt(host, prompts.length);
      },
      "agent.view": () => Effect.succeed(script.view ?? { output: [], queue: [], queueRevision: 0 }),
      "sessions.events": () => Effect.sync(() => [...logged]),
      "sessions.get": () =>
        Effect.sync(() => ({
          id: sessionId,
          cwd: "/",
          createdAt: 0,
          updatedAt: 0,
          lastSeq: logged.length,
          ...(logged.length ? { leaf: logged.at(-1)!.id } : {}),
        })),
    },
    streams: {
      "agent.activity": () => {
        const opened = fed<AgentActivity>({ type: "subscribed", running: [] }, ...(script.streamed ?? []));
        activities.push(opened);
        if (activities.length === 2) Deferred.doneUnsafe(reopened, Effect.void);
        return opened.stream;
      },
      "sessions.log": ({ after }: { after?: number }) => {
        const opened = fed<SessionLogUpdate>({ type: "subscribed", events: logged.filter((event) => event.seq > (after ?? 0)) });
        logs.push(opened);
        return opened.stream;
      },
    },
  });
  return { connection, prompts };
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

/** `lemma run s1 ramble --follow` against `host`: what it showed, and its result. */
const follow = async (host: ReturnType<typeof scripted>) => {
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
  const output = await Effect.runPromise(Effect.scoped(runCommand(sessionId, ["ramble"])(host.connection, io, options)));
  return { shown, output };
};

describe("run --follow", () => {
  test("shows the answer's text that turn-ended overtook, from the log", async () => {
    const host = scripted({
      prompt: ({ act, append }) =>
        Effect.sync(() => {
          act({ type: "turn-started", sessionId, turnId }, word("t1.1", 1), turnEnded);
          append(...started, ...step("t1.1", "word1 word2 "), ended);
        }),
    });
    const { shown, output } = await follow(host);
    expect(shown).toBe("word1 word2 \n");
    expect(output?.exit).toBeUndefined();
  });

  test("skips the overtaken text when it comes after all, so it shows once", async () => {
    const host = scripted({
      prompt: ({ act, append }) =>
        Effect.sync(() => {
          act({ type: "turn-started", sessionId, turnId }, word("t1.1", 1));
          append(...started, ...step("t1.1", "word1 word2 "));
          act(word("t1.1", 2), turnEnded);
          append(ended);
        }),
    });
    expect((await follow(host)).shown).toBe("word1 word2 \n");
  });

  test("holds output the log has not placed yet, so one step's answer never shows after the next one's", async () => {
    // The first step's output was lost; the second's comes before the log has either.
    const host = scripted({
      prompt: ({ act, append }) =>
        Effect.sync(() => {
          act({ type: "turn-started", sessionId, turnId }, word("t1.2", 1, "second "));
          append(...started, ...step("t1.1", "first "), ...step("t1.2", "second "), ended);
          act(turnEnded);
        }),
    });
    expect((await follow(host)).shown).toBe("first second \n");
  });

  test("a retry joins its running turn: what it said so far, from the agent, then the rest as it comes, once each", async () => {
    const host = scripted({
      log: [...started, { type: "step-start", turnId, stepId: "t1.1" }],
      view: {
        turnId,
        draft: { stepId: "t1.1", seq: 3, blocks: [{ index: 0, block: { type: "text", text: "word1 word2 word3 " } }] },
        output: [],
        queue: [],
        queueRevision: 0,
      },
      // What was streamed between the activity's and the log's `subscribed`: some of it is in the draft.
      streamed: [word("t1.1", 2), word("t1.1", 3), word("t1.1", 4)],
      prompt: ({ act, append }) =>
        Effect.sync(() => {
          act(word("t1.1", 5));
          append(
            { type: "message", turnId, stepId: "t1.1", message: answer("word1 word2 word3 word4 word5 ") },
            { type: "step-end", turnId, stepId: "t1.1" },
            ended,
          );
          act(turnEnded);
        }),
    });
    expect((await follow(host)).shown).toBe("word1 word2 word3 word4 word5 \n");
  });

  test("an agent reload withdraws the prompt and its activity: the prompt is sent again with its id, and the turn caught up from the agent", async () => {
    const host = scripted({
      view: {
        turnId,
        draft: { stepId: "t1.1", seq: 2, blocks: [{ index: 0, block: { type: "text", text: "word1 word2 " } }] },
        output: [],
        queue: [],
        queueRevision: 0,
      },
      prompt: ({ act, append, reload, reopened }, n) => {
        if (n === 1) {
          // Placed, then the agent reloads mid-answer: what it said meanwhile is lost with the activity.
          act({ type: "turn-started", sessionId, turnId }, word("t1.1", 1));
          append(...started, { type: "step-start", turnId, stepId: "t1.1" });
          reload();
          return Effect.fail(new HostError({ code: "Withdrawn", subject: "agent.prompt", message: "withdrawn" }));
        }
        return Effect.andThen(
          reopened,
          Effect.sync(() => {
            act(word("t1.1", 3));
            append({ type: "message", turnId, stepId: "t1.1", message: answer("word1 word2 word3 ") }, { type: "step-end", turnId, stepId: "t1.1" }, ended);
            act(turnEnded);
          }),
        );
      },
    });
    const { shown, output } = await follow(host);
    expect(host.prompts).toHaveLength(2);
    expect(host.prompts.map((payload) => (payload as { requestId: string }).requestId)).toEqual([requestId, requestId]);
    expect(shown).toBe("word1 word2 word3 \n");
    expect(output?.exit).toBeUndefined();
  });
});
