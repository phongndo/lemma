import { describe, expect, test } from "vitest";
import { Cause, Deferred, Effect } from "effect";
import { emptyUsage, HostError } from "@lemma/contracts";
import type { AgentActivity, AgentView, AssistantMessage, EventData, InteractionRequest, RuntimeEvent, SessionEvent, SessionLogUpdate } from "@lemma/contracts";
import { GIVE_UP } from "../src/channels.ts";
import { ExitCode } from "../src/command.ts";
import type { Io, Options } from "../src/command.ts";
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
  /** Cuts the command's connection: what is in flight on it is lost, and it cannot connect again until `restore`. */
  readonly drop: () => void;
  readonly restore: () => void;
}

/**
 * A host whose `agent.prompt` runs `prompt` (its `n`th call), with the
 * session's log as `log` has it and `agent.view` answering `view`.
 * `streamed` is sent on each `agent.activity` after its `subscribed`. `rpcs`
 * and `backoff` are `fakeHost`'s.
 */
const scripted = (script: {
  readonly log?: readonly EventData[];
  readonly view?: AgentView | ((host: Host) => Effect.Effect<AgentView>);
  readonly streamed?: readonly AgentActivity[];
  readonly prompt: (host: Host, n: number) => Effect.Effect<void, HostError>;
  readonly rpcs?: Readonly<Record<string, (payload: any) => unknown>>;
  readonly backoff?: number;
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
    drop: () => connection.drop(),
    restore: () => connection.restore(),
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
    ...(script.rpcs === undefined ? {} : { rpcs: script.rpcs }),
    ...(script.backoff === undefined ? {} : { backoff: script.backoff }),
  });
  return { connection, logged, prompts, screen, show };
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

/** `lemma run s1 ramble --follow` (or as `fields` say) against `host`, at a terminal that asks with `ask`: what it showed, and said on stderr, and its result or failure. */
const run = async (host: ReturnType<typeof scripted>, fields: Partial<Options> = {}, ask?: Io["ask"]) => {
  const said: string[] = [];
  const io: Io = {
    env: {},
    cwd: "/",
    out: (text) => host.show(`${text}\n`),
    write: host.show,
    err: (text) => void said.push(text),
    ...(ask === undefined ? {} : { ask }),
  };
  const exit = await Effect.runPromise(Effect.exit(Effect.scoped(runCommand(sessionId, ["ramble"])(host.connection, io, { ...options, ...fields }))));
  return { shown: host.screen.text, said, exit };
};

const follow = async (host: ReturnType<typeof scripted>) => {
  const { shown, exit } = await run(host);
  if (exit._tag === "Failure") throw new Error(`run failed: ${String(exit.cause)}`);
  return { shown, output: exit.value };
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

/** What a run failed with. */
const failed = (exit: Awaited<ReturnType<typeof run>>["exit"]) => {
  if (exit._tag === "Success") throw new Error("the run succeeded");
  return Cause.squash(exit.cause) as { readonly code?: string; readonly exit?: number; readonly message: string };
};

/** The request ids `agent.prompt` was called with. */
const ids = (prompts: readonly unknown[]) => prompts.map((payload) => (payload as { readonly requestId: string }).requestId);

const lostLine = "lemma: lost the connection to the host; reconnecting…";
const backLine = "lemma: reconnected to the host";

describe("a run whose connection drops", () => {
  test("--follow goes on once it is back: the rest of the turn shows, none of it twice, and the prompt, sent again with its request id, is placed once", async () => {
    for (const json of [false, true]) {
      const host = scripted({
        prompt: ({ act, append, drop, restore, reopened, showing }, n) =>
          n === 1
            ? Effect.gen(function* () {
                act({ type: "turn-started", sessionId, turnId }, word("t1.1", 1));
                append(...started, { type: "step-start", turnId, stepId: "t1.1" });
                yield* showing("word1 ");
                // What the agent says while the connection is down is lost with it; what the log gets meanwhile waits there.
                drop();
                act(word("t1.1", 2));
                append({ type: "message", turnId, stepId: "t1.1", message: answer("word1 word2 ") }, { type: "step-end", turnId, stepId: "t1.1" });
                append({ type: "step-start", turnId, stepId: "t1.2" });
                restore();
                return yield* Effect.never;
              })
            : // Made again on the new connection: the host rejoins the turn that placed the prompt, and answers when it ends.
              Effect.gen(function* () {
                yield* reopened;
                act(word("t1.2", 1, "more "));
                yield* showing(json ? '"delta":"more "' : "word1 word2 more ");
                append({ type: "message", turnId, stepId: "t1.2", message: answer("more ") }, { type: "step-end", turnId, stepId: "t1.2" }, ended);
                act(turnEnded);
              }),
      });
      const { shown, said, exit } = await run(host, { json });
      expect(exit._tag).toBe("Success");
      expect(ids(host.prompts)).toEqual([requestId, requestId]);
      expect(said).toEqual([lostLine, backLine]);
      if (!json) {
        expect(shown).toBe("word1 word2 more \n");
        continue;
      }
      const lines = shown
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; event?: SessionEvent; stepId?: string; seq?: number });
      // Every event of the log from the prompt's message on, once and in order, those it got while the connection was down among them.
      const placed = host.logged.findIndex((event) => event.data.type === "message" && event.data.requestId === requestId);
      expect(lines.filter((line) => line.type === "appended").map((line) => line.event!.seq)).toEqual(host.logged.slice(placed).map((event) => event.seq));
      expect(lines.filter((line) => line.type === "delta").map((line) => `${line.stepId}:${line.seq}`)).toEqual(["t1.1:1", "t1.2:1"]);
      expect(exit._tag === "Success" && exit.value?.json).toMatchObject({ type: "result", reason: "done", text: "more " });
    }
  });

  test("without --follow goes on once it is back, and ends with the turn's result", async () => {
    const host = scripted({
      prompt: ({ append, drop, restore }, n) =>
        n === 1
          ? Effect.andThen(
              Effect.sync(() => {
                append(...started, ...step("t1.1", "first "));
                drop();
                append(...step("t1.2", "second "));
                restore();
              }),
              Effect.never,
            )
          : Effect.sync(() => append(ended)),
    });
    const { said, exit } = await run(host, { follow: false, json: true });
    if (exit._tag === "Failure") throw new Error(String(exit.cause));
    expect(exit.value?.json).toMatchObject({ session: sessionId, turn: turnId, reason: "done", steps: 2, text: "second " });
    expect(ids(host.prompts)).toEqual([requestId, requestId]);
    expect(said).toEqual([lostLine, backLine]);
    // With nothing to answer them with, it never heard the host's events: the host asks it no questions, which go to
    // another client or fail as unanswerable.
    expect(host.connection.subscriptions()).toBe(0);
  });

  test("answers a question asked while it was down, which the host still waits on", async () => {
    const approval: InteractionRequest = { type: "confirm", id: "q1", origin: `session:${sessionId}`, title: "Run rm -rf build?" };
    const waiting: InteractionRequest[] = [];
    const answered = Deferred.makeUnsafe<unknown>();
    const host = scripted({
      rpcs: {
        "Interaction.List": () => Effect.sync(() => [...waiting]),
        "Interaction.Answer": ({ id, answer: given }: { id: string; answer: unknown }) =>
          Effect.sync(() => {
            waiting.splice(
              waiting.findIndex((request) => request.id === id),
              1,
            );
            Deferred.doneUnsafe(answered, Effect.succeed(given));
          }),
      },
      prompt: ({ append, drop, restore }, n) =>
        n === 1
          ? Effect.andThen(
              Effect.sync(() => {
                append(...started);
                drop();
                // Asked with no client connected: its event reaches no one.
                waiting.push(approval);
                restore();
              }),
              Effect.never,
            )
          : Effect.andThen(
              Deferred.await(answered),
              Effect.sync(() => append(...step("t1.1", "removed "), ended)),
            ),
    });
    const { exit } = await run(host, { follow: false, answers: ["yes"] });
    expect(exit._tag).toBe("Success");
    expect(await Effect.runPromise(Deferred.await(answered))).toEqual({ type: "confirm", value: true });
  });

  test("closes the prompt of a question that closed while it was down, whose closing it never heard", async () => {
    const approval: InteractionRequest = { type: "confirm", id: "q1", origin: `session:${sessionId}`, title: "Run rm -rf build?" };
    const waiting: InteractionRequest[] = [];
    const asking = Deferred.makeUnsafe<AbortSignal>();
    const closed = Deferred.makeUnsafe<void>();
    const host = scripted({
      rpcs: { "Interaction.List": () => Effect.sync(() => [...waiting]) },
      prompt: ({ append, drop, publish, restore }, n) =>
        n === 1
          ? Effect.gen(function* () {
              append(...started);
              waiting.push(approval);
              yield* publish({ type: "interaction", request: approval });
              yield* Deferred.await(asking);
              drop();
              // Answered in the web app, say: its `interaction-closed` goes to no one here.
              waiting.length = 0;
              restore();
              return yield* Effect.never;
            })
          : Effect.andThen(
              Deferred.await(closed),
              Effect.sync(() => append(...step("t1.1", "kept "), ended)),
            ),
    });
    const { said, exit } = await run(host, { follow: false }, (_question, _secret, signal) => {
      signal?.addEventListener("abort", () => Deferred.doneUnsafe(closed, Effect.void));
      Deferred.doneUnsafe(asking, Effect.succeed(signal!));
      return new Promise<string>(() => {});
    });
    expect(exit._tag).toBe("Success");
    expect(said).toEqual([lostLine, backLine, "(answered elsewhere)"]);
  });

  test(`gives up after ${GIVE_UP} attempts in a row fail, exiting 3 with the request id it chose, which rejoins the turn`, async () => {
    const lost = async (fields: Partial<Options>) => {
      const host = scripted({
        backoff: 1,
        prompt: ({ drop }) => Effect.andThen(Effect.sync(drop), Effect.never),
      });
      const { said, exit } = await run(host, { follow: false, ...fields });
      return { said, error: failed(exit), sent: ids(host.prompts) };
    };
    const { said, error, sent } = await lost({ requestId: undefined });
    expect(error).toMatchObject({ code: "Disconnected", exit: ExitCode.unavailable });
    expect(error.message).toContain(`${GIVE_UP} attempts`);
    expect(sent).toHaveLength(1);
    expect(said).toEqual([lostLine, expect.stringContaining(`\`lemma run ${sessionId} --request-id ${sent[0]}\``)]);
    // One it was given, it does not repeat.
    expect((await lost({ requestId: "mine" })).said).toEqual([lostLine]);
  });

  test("whose prompt the agent never came back for, after the host's own repeat, says the prompt may be taken, as when it gives up", async () => {
    const host = scripted({
      prompt: () => Effect.fail(new HostError({ code: "Withdrawn", subject: "agent.prompt", message: "agent.prompt was withdrawn" })),
    });
    const { said, exit } = await run(host, { follow: false, requestId: undefined });
    const error = failed(exit);
    expect(error).toMatchObject({ code: "Withdrawn", exit: ExitCode.unavailable });
    expect(error.message).toContain("may take the prompt still");
    // Running it again would choose another id, and place the prompt twice: the one it chose rejoins its turn.
    const [sent] = ids(host.prompts);
    expect(said).toEqual([expect.stringContaining(`\`lemma run ${sessionId} --request-id ${sent}\``)]);
  });
});
