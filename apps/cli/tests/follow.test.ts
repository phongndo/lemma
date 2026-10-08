import { describe, expect, test } from "vitest";
import { Deferred, Effect } from "effect";
import { RpcClientError } from "effect/rpc";
import { emptyUsage, HostError } from "@lemma/contracts";
import type { AgentActivity, AgentView, AssistantMessage, EventData, RuntimeEvent, SessionEvent, SessionLogUpdate } from "@lemma/contracts";
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
  /** Resolves once what `act` sent has gone out to the command. */
  readonly sent: Effect.Effect<void>;
  /** Appends to the session's log, which the open `sessions.log` sends. */
  readonly append: (...data: readonly EventData[]) => void;
  /** Ends the open `agent.activity` withdrawn, as the agent's reload does. */
  readonly reload: () => void;
  /** Resolves once `agent.activity` has been opened again. */
  readonly reopened: Effect.Effect<void>;
  /** Resolves once the command has shown `text`: what it shows before the log has the answer that says it. */
  readonly showing: (text: string) => Effect.Effect<void>;
  /** Publishes the host's own events, and resolves once they have gone out to the command. */
  readonly publish: (...events: readonly RuntimeEvent[]) => Effect.Effect<void>;
}

/**
 * A host whose `agent.prompt` runs `prompt` (its `n`th call), with the
 * session's log as `log` has it and `agent.view` answering `view`.
 * `streamed` is sent on each `agent.activity` after its `subscribed`.
 */
const scripted = (script: {
  readonly log?: readonly EventData[];
  readonly view?: AgentView | ((host: Host) => Effect.Effect<AgentView>);
  readonly streamed?: readonly AgentActivity[];
  readonly prompt: (host: Host, n: number) => Effect.Effect<void, HostError>;
}) => {
  const logged: SessionEvent[] = [];
  const activities: Fed<AgentActivity>[] = [];
  const logs: Fed<SessionLogUpdate>[] = [];
  const events = fed<RuntimeEvent>();
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
  const screen = { text: "", waiting: [] as { readonly text: string; readonly shown: Deferred.Deferred<void> }[] };
  const show = (text: string) => {
    screen.text += text;
    for (const waiting of screen.waiting) if (screen.text.includes(waiting.text)) Deferred.doneUnsafe(waiting.shown, Effect.void);
  };
  const host: Host = {
    act: (...elements) => activities.at(-1)!.push(...elements),
    sent: Effect.suspend(() => activities.at(-1)!.sent),
    append,
    reload: () => activities.at(-1)!.fail(new HostError({ code: "Withdrawn", subject: "agent.activity", message: "withdrawn" })),
    reopened: Deferred.await(reopened),
    showing: (text) =>
      Effect.suspend(() => {
        if (screen.text.includes(text)) return Effect.void;
        const shown = Deferred.makeUnsafe<void>();
        screen.waiting.push({ text, shown });
        return Deferred.await(shown);
      }),
    publish: (...published) =>
      Effect.andThen(
        Effect.sync(() => events.push(...published)),
        events.sent,
      ),
  };
  const view = script.view ?? { output: [], queue: [], queueRevision: 0 };
  const connection = fakeHost({
    calls: {
      "agent.prompt": (payload) => {
        prompts.push(payload);
        return script.prompt(host, prompts.length);
      },
      "agent.view": () => (typeof view === "function" ? view(host) : Effect.succeed(view)),
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
    events: events.stream,
  });
  return { connection, prompts, screen, show };
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
  const io = { env: {}, cwd: "/", out: (text: string) => host.show(`${text}\n`), write: host.show, err: () => {} };
  const output = await Effect.runPromise(Effect.scoped(runCommand(sessionId, ["ramble"])(host.connection, io, options)));
  return { shown: host.screen.text, output };
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
      prompt: ({ act, append, showing }) => {
        act(word("t1.1", 5));
        // All of it shows as it comes, before the log's answer could say it.
        return Effect.andThen(
          showing("word1 word2 word3 word4 word5 "),
          Effect.sync(() => {
            append(
              { type: "message", turnId, stepId: "t1.1", message: answer("word1 word2 word3 word4 word5 ") },
              { type: "step-end", turnId, stepId: "t1.1" },
              ended,
            );
            act(turnEnded);
          }),
        );
      },
    });
    expect((await follow(host)).shown).toBe("word1 word2 word3 word4 word5 \n");
  });

  test("a retry joins a turn that goes on answering while the agent's view of it comes, however much it says meanwhile", async () => {
    const said = Array.from({ length: 60 }, (_, i) => `word${i + 1} `).join("");
    const host = scripted({
      log: [...started, { type: "step-start", turnId, stepId: "t1.1" }],
      // More than the client holds of a stream unread goes out before the view's answer: on the socket, the answer would
      // wait behind it, and the command, which reads neither stream until it has the view, would wait for that answer.
      view: ({ act, sent }) =>
        Effect.gen(function* () {
          act(...Array.from({ length: 57 }, (_, i) => word("t1.1", i + 4)));
          yield* sent;
          return {
            turnId,
            draft: { stepId: "t1.1", seq: 3, blocks: [{ index: 0, block: { type: "text", text: "word1 word2 word3 " } }] },
            output: [],
            queue: [],
            queueRevision: 0,
          };
        }),
      prompt: ({ act, append, showing }) =>
        Effect.andThen(
          showing(said),
          Effect.sync(() => {
            append({ type: "message", turnId, stepId: "t1.1", message: answer(said) }, { type: "step-end", turnId, stepId: "t1.1" }, ended);
            act(turnEnded);
          }),
        ),
    });
    expect((await follow(host)).shown).toBe(`${said}\n`);
  });

  test("an agent reload withdraws the turn's activity: the prompt, sent once, is the host's to make again, and the turn is caught up from the agent", async () => {
    const host = scripted({
      view: {
        turnId,
        draft: { stepId: "t1.1", seq: 2, blocks: [{ index: 0, block: { type: "text", text: "word1 word2 " } }] },
        output: [],
        queue: [],
        queueRevision: 0,
      },
      prompt: ({ act, append, reload, reopened, showing }) => {
        // Placed, then the agent reloads mid-answer: what it said meanwhile is lost with the activity. The call goes on,
        // made again on the replacement by the host, and answers when the turn ends there.
        act({ type: "turn-started", sessionId, turnId }, word("t1.1", 1));
        append(...started, { type: "step-start", turnId, stepId: "t1.1" });
        reload();
        return reopened.pipe(
          Effect.andThen(Effect.sync(() => act(word("t1.1", 3)))),
          // What was lost shows from the agent's view, and what follows it from the reopened activity, before the log has the answer.
          Effect.andThen(showing("word1 word2 word3 ")),
          Effect.andThen(
            Effect.sync(() => {
              append({ type: "message", turnId, stepId: "t1.1", message: answer("word1 word2 word3 ") }, { type: "step-end", turnId, stepId: "t1.1" }, ended);
              act(turnEnded);
            }),
          ),
        );
      },
    });
    const { shown, output } = await follow(host);
    expect(host.prompts).toHaveLength(1);
    expect(shown).toBe("word1 word2 word3 \n");
    expect(output?.exit).toBeUndefined();
  });

  test("a burst of the host's events while the agent's view is on its way, on the same socket, does not hold the view back", async () => {
    const notices = Array.from({ length: 40 }, (_, i): RuntimeEvent => ({ type: "notice", notice: { level: "info", message: `notice ${i}` } }));
    const host = scripted({
      log: [...started, { type: "step-start", turnId, stepId: "t1.1" }],
      // More of the host's events than the client holds of a stream unread go out before the view's answer, while the
      // command shows none of them until it has the view: they wait for the lock that joining the turn holds.
      view: ({ publish }) =>
        Effect.as(publish(...notices), {
          turnId,
          draft: { stepId: "t1.1", seq: 1, blocks: [{ index: 0, block: { type: "text", text: "word1 " } }] },
          output: [],
          queue: [],
          queueRevision: 0,
        }),
      prompt: ({ act, append }) =>
        Effect.sync(() => {
          append({ type: "message", turnId, stepId: "t1.1", message: answer("word1 ") }, { type: "step-end", turnId, stepId: "t1.1" }, ended);
          act(turnEnded);
        }),
    });
    const { shown, output } = await follow(host);
    expect(shown.startsWith("word1 ")).toBe(true);
    expect(shown.split("\n").filter((line) => line.startsWith("[info] notice "))).toHaveLength(notices.length);
    expect(output?.exit).toBeUndefined();
  });
});

describe("run", () => {
  test("a run whose connection fails says the request id it chose, which rejoins its turn", async () => {
    const lost = new RpcClientError.RpcClientError({ reason: new RpcClientError.RpcClientDefect({ message: "socket closed", cause: undefined }) });
    let sent: string | undefined;
    const connection = fakeHost({
      calls: {
        "agent.prompt": (payload: { requestId: string }) => {
          sent = payload.requestId;
          return Effect.fail(lost as never);
        },
      },
    });
    const said: string[] = [];
    const io = { env: {}, cwd: "/", out: () => {}, err: (text: string) => void said.push(text) };
    const run = (fields: Partial<Options>) =>
      Effect.runPromise(Effect.flip(Effect.scoped(runCommand(sessionId, ["ramble"])(connection, io, { ...options, follow: false, ...fields }))));
    expect(await run({ requestId: undefined })).toBe(lost);
    expect(said).toEqual([expect.stringContaining(`\`lemma run ${sessionId} --request-id ${sent}\``)]);
    // One it was given, it does not repeat.
    said.length = 0;
    expect(await run({ requestId: "mine" })).toBe(lost);
    expect(said).toEqual([]);
  });
});
