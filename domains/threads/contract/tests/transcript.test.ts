import { describe, expect, it } from "vitest";
import { createProjector, pendingToolCalls, promptBases, promptMarks } from "../src/transcript.ts";
import type { AssistantItem } from "../src/transcript.ts";
import { assistant, branch, toolResult, transcriptOf, usage, user } from "../src/testing.ts";
import type { EventData } from "@lemma/sessions";

const call = (id: string) => ({ type: "toolCall" as const, id, name: "bash", arguments: { command: "ls" } });

describe("transcript", () => {
  it("joins a message's adjacent thoughts into one block, keyed where the first starts", () => {
    const t = transcriptOf(
      branch({ type: "turn-start", turnId: "t1" }, user("hi", "t1"), {
        type: "message",
        turnId: "t1",
        stepId: "s1",
        message: assistant([
          { type: "thinking", thinking: "**One**\n\na" },
          { type: "thinking", thinking: "**Two**\n\nb" },
          { type: "text", text: "ok" },
          { type: "thinking", thinking: "three" },
        ]),
      }),
    );
    const blocks = (t.turns[0]!.items[1] as AssistantItem).blocks;
    expect(blocks.map((block) => block.kind)).toEqual(["thinking", "text", "thinking"]);
    expect(blocks[0]).toMatchObject({ index: 0, text: "**One**\n\na\n\n**Two**\n\nb", redacted: false });
    expect(blocks[2]).toMatchObject({ index: 3, text: "three" });
  });

  it("groups a turn and pairs tool calls with results", () => {
    const t = transcriptOf(
      branch(
        { type: "turn-start", turnId: "t1" },
        user("hi", "t1"),
        { type: "message", turnId: "t1", stepId: "s1", message: assistant([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "ok" }, call("c1")]) },
        toolResult("c1", "a\nb", { details: { exitCode: 0 } }),
        { type: "message", turnId: "t1", stepId: "s2", message: assistant([{ type: "text", text: "done" }]) },
        { type: "turn-end", turnId: "t1", reason: "done" },
      ),
    );
    expect(t.turns).toHaveLength(1);
    const turn = t.turns[0]!;
    expect(turn.turnId).toBe("t1");
    expect(turn.items.map((item) => item.kind)).toEqual(["user", "assistant", "assistant"]);
    const first = turn.items[1] as AssistantItem;
    expect(first.blocks.map((block) => block.kind)).toEqual(["thinking", "text", "tool"]);
    const tool = first.blocks[2]!;
    expect(tool.kind === "tool" && tool.result?.details).toEqual({ exitCode: 0 });
    expect(turn.steps).toBe(2);
    expect(turn.usage.input).toBe(20);
    expect(turn.end).toEqual({ reason: "done" });
    expect(turn.endedAt! - turn.startedAt).toBe(5000);
  });

  it("attaches turn-start to a preceding user message", () => {
    const t = transcriptOf(branch(user("hi"), { type: "turn-start", turnId: "t1" }, { type: "turn-end", turnId: "t1", reason: "cancelled" }));
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]).toMatchObject({ key: "t1", turnId: "t1", end: { reason: "cancelled" } });
  });

  it("starts a new turn per user message and per turn-start", () => {
    const t = transcriptOf(
      branch(
        { type: "turn-start", turnId: "t1" },
        user("a", "t1"),
        { type: "message", turnId: "t1", message: assistant([{ type: "text", text: "x" }]) },
        { type: "turn-end", turnId: "t1", reason: "done" },
        { type: "turn-start", turnId: "t2" },
        user("b", "t2"),
      ),
    );
    expect(t.turns.map((turn) => turn.key)).toEqual(["t1", "t2"]);
    expect(t.turns[1]!.end).toBeUndefined();
  });

  it("shows a steer in the turn it joined, between its steps", () => {
    const t = transcriptOf(
      branch(
        { type: "turn-start", turnId: "t1" },
        user("a", "t1"),
        { type: "message", turnId: "t1", stepId: "s1", message: assistant([{ type: "text", text: "working" }]) },
        user("also b", "t1"),
        { type: "message", turnId: "t1", stepId: "s2", message: assistant([{ type: "text", text: "both done" }]) },
        { type: "turn-end", turnId: "t1", reason: "done" },
      ),
    );
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]!.items.map((item) => item.kind)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(t.turns[0]!.items.map((item) => item.kind === "user" && item.steer === true)).toEqual([false, false, true, false]);
  });

  it("marks no prompt placed before the work began as a steer: what a stopped turn left goes in with the next", () => {
    const t = transcriptOf(
      branch({ type: "turn-start", turnId: "t1" }, user("held", "t1"), user("next", "t1"), {
        type: "message",
        turnId: "t1",
        stepId: "s1",
        message: assistant([{ type: "text", text: "both" }]),
      }),
    );
    expect(t.turns[0]!.items.filter((item) => item.kind === "user").map((item) => item.steer)).toEqual([undefined, undefined]);
  });

  it("shows attempts distinctly and counts their usage but not as steps", () => {
    const t = transcriptOf(
      branch(
        { type: "turn-start", turnId: "t1" },
        {
          type: "attempt",
          turnId: "t1",
          stepId: "s1",
          message: assistant([], { stopReason: "error", errorMessage: "overloaded", usage: usage(3, 0) }),
          timing: { startedAt: 0, endedAt: 5 },
        },
        { type: "message", turnId: "t1", stepId: "s1", message: assistant([{ type: "text", text: "ok" }]) },
      ),
    );
    const turn = t.turns[0]!;
    expect(turn.items.map((item) => item.kind)).toEqual(["attempt", "assistant"]);
    expect(turn.steps).toBe(1);
    expect(turn.usage.input).toBe(13);
  });

  it("keeps the latest title, compactions, and orphan results", () => {
    const t = transcriptOf(
      branch(
        { type: "title", title: "one" },
        { type: "compaction", summary: "s", firstKeptId: "e1", tokensBefore: 900, source: "x" },
        toolResult("nope", "?"),
        { type: "title", title: "two" },
      ),
    );
    expect(t.title).toBe("two");
    expect(t.turns[0]!.items.map((item) => item.kind)).toEqual(["compaction", "orphan-result"]);
  });

  it("shows what a plugin told the model as its display, else its text", () => {
    const t = transcriptOf(
      branch(
        { type: "context", source: "mail", content: [{ type: "text", text: "From: a@b\nHello" }], display: "1 new email" },
        { type: "context", source: "sensor", content: [{ type: "text", text: "21.5 °C" }] },
      ),
    );
    expect(t.turns[0]!.items).toMatchObject([
      { kind: "context", source: "mail", text: "1 new email" },
      { kind: "context", source: "sensor", text: "21.5 °C" },
    ]);
  });

  it("marks the errors of a stopped turn's last step as the stop's, and no other errors", () => {
    const stopped = (reason: "cancelled" | "error") => {
      const project = createProjector();
      const events = branch(
        { type: "turn-start", turnId: "t1" },
        user("hi", "t1"),
        { type: "step-start", turnId: "t1", stepId: "s1" },
        { type: "message", turnId: "t1", stepId: "s1", message: assistant([call("c1")]) },
        toolResult("c1", "exit 1", { isError: true, turnId: "t1", stepId: "s1" }),
        { type: "step-start", turnId: "t1", stepId: "s2" },
        { type: "message", turnId: "t1", stepId: "s2", message: assistant([call("c2"), call("c3")]) },
        toolResult("c2", "ok", { turnId: "t1", stepId: "s2" }),
        toolResult("c3", 'Tool "bash" was cancelled', { isError: true, turnId: "t1", stepId: "s2" }),
      );
      // Its results are logged before the turn ends, and become the stop's once it has.
      const running = project(events);
      const ended = project([...events, { seq: 10, id: "e10", parent: "e9", at: 9000, data: { type: "turn-end", turnId: "t1", reason } }]);
      const results = (t: typeof ended) =>
        t.turns[0]!.items.flatMap((item) => (item.kind === "assistant" ? item.blocks : [])).map((block) =>
          block.kind === "tool" ? block.result?.stopped : undefined,
        );
      return { running: results(running), ended: results(ended) };
    };
    expect(stopped("cancelled")).toEqual({ running: [undefined, undefined, undefined], ended: [undefined, undefined, true] });
    expect(stopped("error").ended).toEqual([undefined, undefined, undefined]);
  });

  it("lists pending tool calls", () => {
    const t = transcriptOf(
      branch({ type: "turn-start", turnId: "t1" }, { type: "message", turnId: "t1", message: assistant([call("c1"), call("c2")]) }, toolResult("c1", "x")),
    );
    expect([...pendingToolCalls(t)]).toEqual(["c2"]);
  });
});

describe("promptBases", () => {
  it("goes back to before the turn a prompt opened, and has nowhere for a steer, a second prompt, or the first", () => {
    const events = branch(
      { type: "turn-start", turnId: "t1" },
      user("first", "t1"),
      { type: "message", turnId: "t1", stepId: "s1", message: assistant([{ type: "text", text: "a" }]) },
      user("steer", "t1"),
      { type: "turn-end", turnId: "t1", reason: "done" },
      { type: "turn-start", turnId: "t2" },
      user("second", "t2"),
      user("with it", "t2"),
      { type: "turn-end", turnId: "t2", reason: "cancelled" },
      user("older"),
      { type: "turn-start", turnId: "t3" },
    );
    // Event ids are e1, e2, … in order (`branch`).
    expect([...promptBases(events)]).toEqual([
      ["e7", "e5"],
      ["e10", "e9"],
    ]);
  });
});

describe("createProjector", () => {
  it("reuses unchanged items, blocks, and turns across calls", () => {
    const project = createProjector();
    const events = branch(
      { type: "turn-start", turnId: "t1" },
      user("hi", "t1"),
      { type: "message", turnId: "t1", message: assistant([{ type: "text", text: "a" }, call("c1")]) },
      { type: "turn-end", turnId: "t1", reason: "done" },
      { type: "turn-start", turnId: "t2" },
      user("next", "t2"),
      { type: "message", turnId: "t2", message: assistant([call("c2")]) },
    );
    const before = project(events);
    const after = project([...events, { seq: 8, id: "e8", parent: "e7", at: 9000, data: toolResult("c2", "out") }]);
    expect(after.turns[0]).toBe(before.turns[0]);
    const [a, b] = [before.turns[1]!, after.turns[1]!];
    expect(b).not.toBe(a);
    expect(b.items[0]).toBe(a.items[0]);
    expect(b.items[1]).not.toBe(a.items[1]);
    const block = (b.items[1] as AssistantItem).blocks[0]!;
    expect(block.kind === "tool" && block.result?.content).toEqual([{ type: "text", text: "out" }]);
    // Stable again once nothing changes.
    const again = project([...events, { seq: 8, id: "e8", parent: "e7", at: 9000, data: toolResult("c2", "out") }]);
    expect(again.turns[1]).toBe(b);
  });

  it("projects a branch carried on through events appended as it would project it whole, keeping what is unchanged", () => {
    // mulberry32: the same cases each run.
    let seed = 11;
    const pick = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    // A turn's id is its own (turn-start's): another event may name a turn not started yet, or none known.
    let turns = 0;
    const turnId = () => `t${pick(turns + 1)}`;
    const stepId = () => `s${pick(4)}`;
    const callId = () => `c${pick(5)}`;
    // Logs as agents write them, and as they should not: steers, retries, results before or long after their calls,
    // a result twice, turns ended late or twice, events outside any turn.
    const anyEvent = (): EventData => {
      switch (pick(13)) {
        case 0:
        case 1:
          return { type: "turn-start", turnId: `t${turns++}` };
        case 2:
          return user("hi", pick(3) === 0 ? undefined : turnId());
        case 3:
          return { type: "step-start", turnId: turnId(), stepId: stepId() };
        case 4:
        case 5:
          return {
            type: "message",
            turnId: turnId(),
            stepId: stepId(),
            message: assistant(
              pick(2) === 0 ? [{ type: "text", text: "a" }, call(callId())] : [{ type: "thinking", thinking: "t" }, call(callId()), call(callId())],
            ),
          };
        case 6:
        case 7:
          return toolResult(callId(), "out", { isError: pick(2) === 0, turnId: turnId(), stepId: stepId() });
        case 8:
          return { type: "turn-end", turnId: turnId(), reason: (["done", "cancelled", "error"] as const)[pick(3)]! };
        case 9:
          return {
            type: "attempt",
            turnId: turnId(),
            stepId: stepId(),
            message: assistant([{ type: "text", text: "x" }]),
            timing: { startedAt: 0, endedAt: 1 },
          };
        case 10:
          return { type: "compaction", summary: "s", firstKeptId: "e1", tokensBefore: 10, source: "c" };
        case 11:
          return { type: "context", source: "mail", content: [{ type: "text", text: "1 new email" }] };
        default:
          return { type: "title", title: `title ${pick(3)}` };
      }
    };
    const shape = (transcript: ReturnType<ReturnType<typeof createProjector>>) => JSON.parse(JSON.stringify(transcript));
    for (let round = 0; round < 300; round++) {
      turns = 0;
      const events = branch(...Array.from({ length: 1 + pick(30) }, anyEvent));
      const project = createProjector();
      let shown: ReturnType<typeof project> | undefined;
      for (let end = pick(3); end <= events.length; end += 1 + pick(3)) {
        const next = project(events.slice(0, end));
        expect(shape(next), JSON.stringify(events.slice(0, end).map((event) => event.data))).toEqual(shape(createProjector()(events.slice(0, end))));
        // A turn that did not change is the same object, so a view keyed by it keeps its DOM. (Not when turns share a
        // key, as two do when a turn is started with an id a prompt before it already named: the cache is by key.)
        const keys = next.turns.map((turn) => turn.key);
        if (shown !== undefined && new Set(keys).size === keys.length)
          next.turns.forEach((turn, at) => {
            const before = shown!.turns[at];
            if (before !== undefined && JSON.stringify(before) === JSON.stringify(turn)) expect(turn).toBe(before);
          });
        shown = next;
      }
    }
  });
});

describe("promptMarks", () => {
  it("marks each steer too, at its place, with what answered it", () => {
    const t = transcriptOf(
      branch(
        { type: "turn-start", turnId: "t1" },
        user("teach me llvm", "t1"),
        { type: "message", turnId: "t1", stepId: "s1", message: assistant([{ type: "text", text: "Where to start?" }]) },
        { type: "message", turnId: "t1", message: { role: "user", content: [{ type: "text", text: "the   codebase" }], timestamp: 0 } },
        { type: "message", turnId: "t1", stepId: "s2", message: assistant([{ type: "text", text: "Read lib/ first." }]) },
        { type: "turn-end", turnId: "t1", reason: "done" },
      ),
    );
    const marks = promptMarks(t.turns);
    const steer = t.turns[0]!.items.filter((item) => item.kind === "user")[1]!;
    expect(marks).toEqual([
      { key: "t1", prompt: "teach me llvm", reply: "Where to start?" },
      { key: `t1:${steer.id}`, prompt: "the codebase", reply: "Read lib/ first." },
    ]);
    expect(steer.kind === "user" && steer.steer).toBe(true);
  });

  it("marks each turn that starts with a prompt, with its answer", () => {
    const answer = "## Fixed\n\nThe **cause** was `retry_count`.";
    const t = transcriptOf(
      branch(
        { type: "turn-start", turnId: "t1" },
        user("fix   the\nbuild", "t1"),
        {
          type: "message",
          turnId: "t1",
          stepId: "s1",
          message: assistant([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Reading the log." }, call("c1")]),
        },
        toolResult("c1", "ok"),
        { type: "message", turnId: "t1", stepId: "s2", message: assistant([{ type: "text", text: answer }]) },
        { type: "turn-end", turnId: "t1", reason: "done" },
        { type: "turn-start", turnId: "t2" },
        { type: "message", turnId: "t2", message: { role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }], timestamp: 0 } },
        // Cut off after a note and a tool call: the note is not its answer.
        { type: "message", turnId: "t2", stepId: "s3", message: assistant([{ type: "text", text: "Let me look." }, call("c2")]) },
        { type: "turn-end", turnId: "t2", reason: "cancelled" },
      ),
    );
    expect(promptMarks(t.turns)).toEqual([
      { key: "t1", prompt: "fix the build", reply: answer },
      { key: "t2", prompt: "Image", reply: "" },
    ]);
  });
});
