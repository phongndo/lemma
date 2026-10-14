import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import { HostError } from "@lemma/contracts";
import type { NoticePayload } from "@lemma/contracts";
import type { AgentActivity } from "@lemma/agent";
import type { SessionEvent } from "@lemma/sessions";
import type { CliElement } from "@lemma/cli";
import { answer, ended, failure, follow, requestId, run, sessionId, started, startRun, step, turnEnded, turnId, turnStarted, withHost, word } from "./host.ts";

describe("run --follow", () => {
  test("shows the answer's text that turn-ended overtook, from the log", async () => {
    const { shown, result } = await withHost(
      {
        prompt: ({ act, append }) =>
          Effect.sync(() => {
            act(turnStarted, word("t1.1", 1), turnEnded);
            append(...started, ...step("t1.1", "word1 word2 "), ended);
          }),
      },
      (host) => follow(host),
    );
    expect(shown).toBe("word1 word2 \n");
    expect(result).toMatchObject({ type: "result", text: expect.stringMatching(/^── turn done · 1 step · 0 tool calls/) });
    expect(result?.failed).toBeUndefined();
  });

  test("skips the overtaken text when it comes after all, so it shows once", async () => {
    const { shown } = await withHost(
      {
        prompt: ({ act, append }) =>
          Effect.sync(() => {
            act(turnStarted, word("t1.1", 1));
            append(...started, ...step("t1.1", "word1 word2 "));
            act(word("t1.1", 2), turnEnded);
            append(ended);
          }),
      },
      (host) => follow(host),
    );
    expect(shown).toBe("word1 word2 \n");
  });

  test("holds output the log has not placed yet, so one step's answer never shows after the next one's", async () => {
    // The first step's output was lost; the second's comes before the log has either.
    const { shown } = await withHost(
      {
        prompt: ({ act, append }) =>
          Effect.sync(() => {
            act(turnStarted, word("t1.2", 1, "second "));
            append(...started, ...step("t1.1", "first "), ...step("t1.2", "second "), ended);
            act(turnEnded);
          }),
      },
      (host) => follow(host),
    );
    expect(shown).toBe("first second \n");
  });

  test("the turn's end coming after its prompt answered still shows the whole reply, then the result", async () => {
    const { shown, result } = await withHost({}, (host) =>
      Effect.gen(function* () {
        const running = yield* startRun(host);
        yield* host.prompted(1);
        host.act(turnStarted, word("t1.1", 1));
        host.append(...started, { type: "step-start", turnId, stepId: "t1.1" });
        yield* running.showing("word1 ");
        // The agent answers the prompt; what is left of its reply, and the turn's end, come after.
        yield* host.answer(1);
        host.act(word("t1.1", 2));
        host.append({ type: "message", turnId, stepId: "t1.1", message: answer("word1 word2 ") }, { type: "step-end", turnId, stepId: "t1.1" }, ended);
        host.act(turnEnded);
        return yield* running.done;
      }),
    );
    expect(shown).toBe("word1 word2 \n");
    expect(result?.text).toMatch(/^── turn done · 1 step/);
  });

  test("indents a tool's output under its call as it comes, continuing a partial line, once the log has shown the call", async () => {
    const call: SessionEvent["data"] = {
      type: "message",
      turnId,
      stepId: "t1.1",
      message: { ...answer(""), content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" },
    };
    const output = (chunk: string, offset: number): AgentActivity => ({ type: "tool-output", sessionId, toolCallId: "c1", chunk, offset });
    const { shown } = await withHost({}, (host) =>
      Effect.gen(function* () {
        const running = yield* startRun(host);
        yield* host.prompted(1);
        // Its output comes before the log has the call: it waits for it.
        host.act(turnStarted, output("a.txt\nb.", 0));
        host.append(...started, { type: "step-start", turnId, stepId: "t1.1" }, call);
        yield* running.showing("  b.");
        // A chunk it was sent twice shows once.
        host.act(output("a.txt\nb.", 0), output("txt\n", 8));
        yield* running.showing("b.txt\n");
        host.append(
          {
            type: "message",
            turnId,
            stepId: "t1.1",
            message: {
              role: "toolResult",
              toolCallId: "c1",
              toolName: "bash",
              content: [{ type: "text", text: "a.txt\nb.txt" }],
              isError: false,
              timestamp: 0,
            },
          },
          { type: "step-end", turnId, stepId: "t1.1" },
          ...step("t1.2", "Two files."),
          ended,
        );
        host.act(turnEnded);
        yield* host.answer(1);
        return yield* running.done;
      }),
    );
    expect(shown).toBe('→ bash {"command":"ls"}\n  a.txt\n  b.txt\n← bash ok: a.txt\nTwo files.\n');
  });

  test("a retry joins its running turn: what it said so far, from the agent, then the rest as it comes, once each", async () => {
    const { shown } = await withHost(
      {
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
      },
      (host) =>
        Effect.gen(function* () {
          const running = yield* startRun(host);
          yield* host.prompted(1);
          host.act(word("t1.1", 5));
          // All of it shows as it comes, before the log's answer could say it.
          yield* running.showing("word1 word2 word3 word4 word5 ");
          host.append(
            { type: "message", turnId, stepId: "t1.1", message: answer("word1 word2 word3 word4 word5 ") },
            { type: "step-end", turnId, stepId: "t1.1" },
            ended,
          );
          host.act(turnEnded);
          yield* host.answer(1);
          return yield* running.done;
        }),
    );
    expect(shown).toBe("word1 word2 word3 word4 word5 \n");
  });

  test("a retry joins a turn that goes on answering while the agent's view of it comes, however much it says meanwhile", async () => {
    const said = Array.from({ length: 60 }, (_, i) => `word${i + 1} `).join("");
    const { shown } = await withHost(
      {
        log: [...started, { type: "step-start", turnId, stepId: "t1.1" }],
        // The rest of the answer goes out while the view is on its way, which the command waits for before it shows any.
        view: ({ act }) =>
          Effect.sync(() => {
            act(...Array.from({ length: 57 }, (_, i) => word("t1.1", i + 4)));
            return {
              turnId,
              draft: { stepId: "t1.1", seq: 3, blocks: [{ index: 0, block: { type: "text", text: "word1 word2 word3 " } }] },
              output: [],
              queue: [],
              queueRevision: 0,
            };
          }),
      },
      (host) =>
        Effect.gen(function* () {
          const running = yield* startRun(host);
          yield* running.showing(said);
          host.append({ type: "message", turnId, stepId: "t1.1", message: answer(said) }, { type: "step-end", turnId, stepId: "t1.1" }, ended);
          host.act(turnEnded);
          yield* host.answer(1);
          return yield* running.done;
        }),
    );
    expect(shown).toBe(`${said}\n`);
  });

  for (const how of ["reload", "withdraw"] as const) {
    test(`an agent ${how === "reload" ? "reload" : "stream"} that withdraws the turn's activity goes on: the turn is caught up from the agent, none of it twice, and its prompt placed by one request id`, async () => {
      const { shown, result, prompts } = await withHost(
        {
          view: {
            turnId,
            draft: { stepId: "t1.1", seq: 2, blocks: [{ index: 0, block: { type: "text", text: "word1 word2 " } }] },
            output: [],
            queue: [],
            queueRevision: 0,
          },
        },
        (host) =>
          Effect.gen(function* () {
            const running = yield* startRun(host);
            yield* host.prompted(1);
            host.act(turnStarted, word("t1.1", 1));
            host.append(...started, { type: "step-start", turnId, stepId: "t1.1" });
            yield* running.showing("word1 ");
            // The agent goes mid-answer: what it says meanwhile is lost with its activity.
            if (how === "reload") yield* host.reload;
            else host.withdraw();
            yield* host.opened(2);
            host.act(word("t1.1", 3));
            // What was lost shows from the agent's view, and what follows it from the reopened activity, before the log has the answer.
            yield* running.showing("word1 word2 word3 ");
            host.append(
              { type: "message", turnId, stepId: "t1.1", message: answer("word1 word2 word3 ") },
              { type: "step-end", turnId, stepId: "t1.1" },
              ended,
            );
            host.act(turnEnded);
            // The prompt's call goes on: made again on the replacement after a reload, with the same request id.
            yield* host.answer(host.prompts.length);
            const ran = yield* running.done;
            return { ...ran, prompts: host.prompts.map((prompt) => prompt.requestId) };
          }),
      );
      expect(shown).toBe("word1 word2 word3 \n");
      expect(result?.failed).toBeUndefined();
      expect(prompts).toEqual(how === "reload" ? [requestId, requestId] : [requestId]);
    });
  }

  test("shows the host's notices as they come, also while the agent's view of a turn it joins is on its way", async () => {
    const notices = Array.from({ length: 40 }, (_, i): NoticePayload => ({ level: "info", message: `notice ${i}` }));
    const { shown, result } = await withHost(
      {
        log: [...started, { type: "step-start", turnId, stepId: "t1.1" }],
        view: ({ notify }) =>
          Effect.as(notify(...notices), {
            turnId,
            draft: { stepId: "t1.1", seq: 1, blocks: [{ index: 0, block: { type: "text", text: "word1 " } }] },
            output: [],
            queue: [],
            queueRevision: 0,
          }),
      },
      (host) =>
        Effect.gen(function* () {
          const running = yield* startRun(host);
          yield* running.showing("word1 ");
          yield* running.showing("[info] notice 39\n");
          yield* host.notify({ level: "warning", source: "llm", message: "rate limited", code: "429" });
          yield* running.showing("[warning] llm: rate limited (code: 429)\n");
          host.append({ type: "message", turnId, stepId: "t1.1", message: answer("word1 ") }, { type: "step-end", turnId, stepId: "t1.1" }, ended);
          host.act(turnEnded);
          yield* host.answer(1);
          return yield* running.done;
        }),
    );
    expect(shown.startsWith("word1 ")).toBe(true);
    expect(shown.split("\n").filter((line) => line.startsWith("[info] notice "))).toHaveLength(notices.length);
    expect(result?.failed).toBeUndefined();
  });

  test("--json prints the turn's activity and its events in the log as their channels send them, and its result last", async () => {
    const delta = (seq: number) => (element: CliElement) =>
      element.type === "json" && (element.value as { type?: string; seq?: number }).type === "delta" && (element.value as { seq?: number }).seq === seq;
    const { lines, result, shown } = await withHost({}, (host) =>
      Effect.gen(function* () {
        const running = yield* startRun(host, { json: true });
        yield* host.prompted(1);
        yield* host.notify({ level: "info", message: "working" });
        yield* running.sent((element) => element.type === "json" && (element.value as { type?: string }).type === "notice");
        host.act(turnStarted, word("t1.1", 1));
        host.append(...started, { type: "step-start", turnId, stepId: "t1.1" });
        yield* running.sent(delta(1));
        host.act(word("t1.1", 2));
        yield* running.sent(delta(2));
        host.append({ type: "message", turnId, stepId: "t1.1", message: answer("word1 word2 ") }, { type: "step-end", turnId, stepId: "t1.1" }, ended);
        host.act(turnEnded);
        yield* host.answer(1);
        return yield* running.done;
      }),
    );
    expect(shown).toBe("");
    const typed = lines as readonly { readonly type: string; readonly event?: SessionEvent; readonly seq?: number }[];
    // Every event of the log from the prompt's message on, once and in order.
    expect(typed.filter((line) => line.type === "appended").map((line) => line.event!.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(typed.filter((line) => line.type === "delta").map((line) => line.seq)).toEqual([1, 2]);
    expect(typed.filter((line) => line.type === "turn-started" || line.type === "turn-ended")).toHaveLength(2);
    expect(lines).toContainEqual({ type: "notice", notice: { level: "info", message: "working" } });
    expect(result).toMatchObject({
      type: "result",
      json: { type: "result", session: sessionId, turn: turnId, reason: "done", steps: 1, text: "word1 word2 " },
    });
  });
});

describe("run", () => {
  test("without --follow answers with the turn's result once its prompt's call does", async () => {
    const { shown, result } = await withHost(
      { prompt: ({ append }) => Effect.sync(() => append(...started, ...step("t1.1", "first "), ...step("t1.2", "second "), ended)) },
      (host) => run(host, { follow: false, json: true }),
    );
    expect(shown).toBe("");
    expect(result?.json).toMatchObject({ session: sessionId, turn: turnId, reason: "done", steps: 2, toolCalls: 0, text: "second " });
    expect(result?.text).toMatch(/^second\n\n── turn done · 2 steps/);
  });

  test("says, before it sends its prompt, that its client answers the session's questions and the request id that rejoins its turn", async () => {
    for (const given of [requestId, undefined]) {
      const { elements, prompts } = await withHost({ prompt: ({ append }) => Effect.sync(() => append(...started, ...step("t1.1", "x "), ended)) }, (host) =>
        Effect.map(follow(host, { follow: false, requestId: given }), (ran) => ({ ...ran, prompts: host.prompts })),
      );
      const [sent] = prompts.map((prompt) => prompt.requestId);
      if (given !== undefined) expect(sent).toBe(given);
      expect(elements.slice(1, 3)).toEqual([
        { type: "rerun", args: ["run", sessionId, "ramble", "--request-id", sent] },
        { type: "answer", origin: `session:${sessionId}` },
      ]);
    }
  });

  test("a turn that did not end done exits 1 with its error", async () => {
    const { result } = await withHost(
      {
        prompt: ({ append }) =>
          Effect.sync(() => append(...started, ...step("t1.1", "partial "), { type: "turn-end", turnId, reason: "error", error: "boom" })),
      },
      (host) => follow(host, { follow: false }),
    );
    expect(result).toMatchObject({ failed: true, json: { reason: "error", error: "boom" } });
    expect(result?.text).toMatch(/── turn error · .*\nerror: boom$/);
  });

  test("a prompt a plugin handled answers at once with what the plugin said, with --follow or without", async () => {
    for (const follow of [false, true]) {
      const { result } = await withHost({ prompt: () => Effect.succeed({ kind: "handled", by: "commands", message: "ran /help" }) }, (host) =>
        run(host, { follow }),
      );
      expect(result).toEqual({ type: "result", json: { type: "handled", by: "commands", message: "ran /help" }, text: "ran /help" });
    }
  });

  test("new makes a session in the client's directory, says which on stderr, and is run again in that session, not a new one", async () => {
    const { said, prompts, elements } = await withHost(
      { prompt: ({ append }) => Effect.sync(() => append(...started, ...step("t1.1", "x "), ended)) },
      (host) => Effect.map(follow(host, { session: "new", follow: true }), (ran) => ({ ...ran, prompts: host.prompts })),
    );
    expect(said).toBe(`lemma: session ${sessionId}\n`);
    expect(prompts[0]?.sessionId).toBe(sessionId);
    expect(elements).toContainEqual({ type: "rerun", args: ["run", sessionId, "ramble", "--request-id", requestId, "--follow"] });
  });
});

describe("a run that fails once its prompt may be placed", () => {
  test("fails as what failed did, having said the request id that rejoins its turn", async () => {
    const { exit, elements, prompts } = await withHost(
      {
        prompt: () => Effect.void,
        get: () => Effect.fail(new HostError({ code: "Failed", subject: sessionId, message: "the disk is full" })),
      },
      (host) => Effect.map(run(host, { follow: false, requestId: undefined }), (ran) => ({ ...ran, prompts: host.prompts })),
    );
    expect(failure(exit)).toMatchObject({ code: "Failed", subject: sessionId });
    expect(elements).toContainEqual({ type: "rerun", args: ["run", sessionId, "ramble", "--request-id", prompts[0]!.requestId] });
  });

  test("a prompt the agent refused was never placed: it is reported as it is", async () => {
    for (const follow of [false, true]) {
      for (const code of ["Busy", "NoModel", "Retracted"]) {
        const { exit } = await withHost({ prompt: () => Effect.fail(new HostError({ code, subject: sessionId, message: `${code}: ${sessionId}` })) }, (host) =>
          run(host, { follow }),
        );
        expect(failure(exit)).toMatchObject({ code, subject: sessionId });
      }
      const { exit } = await withHost({ prompt: () => Effect.succeed({ kind: "refused", by: "guard", reason: "not now" }) }, (host) => run(host, { follow }));
      expect(failure(exit)).toMatchObject({ code: "Refused", subject: "guard", message: "guard refused the prompt: not now" });
    }
  });

  test("whose prompt the agent never came back for says the prompt may be taken still", async () => {
    const { exit } = await withHost({}, (host) =>
      Effect.gen(function* () {
        const running = yield* startRun(host, { follow: false });
        yield* host.prompted(1);
        // The agent is turned off while it has the prompt: nothing answers for it once the change has finished.
        yield* Effect.orDie(host.loader.apply({ plugins: { "fake.sessions": {}, "cli.registry": {}, "agent.cli": {} } }));
        return yield* running.done;
      }),
    );
    expect(failure(exit)).toMatchObject({ code: "Withdrawn", subject: "agent.prompt", message: expect.stringContaining("may take the prompt still") });
  });
});
