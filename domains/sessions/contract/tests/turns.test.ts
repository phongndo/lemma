import { describe, expect, it } from "vitest";
import type { EventData, SessionEvent } from "../src/sessions.ts";
import { createTurnProjector } from "../src/turns.ts";
import type { TurnFold } from "../src/turns.ts";

function log(...items: readonly EventData[]): SessionEvent[] {
  return items.map((data, i) => ({ seq: i + 1, id: `e${i + 1}`, parent: i === 0 ? null : `e${i}`, at: 1000 + i, data }));
}

interface Turn {
  readonly turnId: string;
  readonly events: string[];
}

/** A fold that keeps, for each turn, the ids of the events naming it; a `custom` event asks for the branch afresh. */
const counting = () => {
  const seen = { starts: 0, fed: [] as string[] };
  const start = (): TurnFold<Turn> => {
    seen.starts++;
    const turns: Turn[] = [];
    return {
      turns,
      feed: (branch, position) => {
        const event = branch[position]!;
        seen.fed.push(event.id);
        const data = event.data;
        if (data.type === "custom") return "afresh";
        if (data.type === "turn-start") {
          turns.push({ turnId: data.turnId, events: [event.id] });
          return [];
        }
        const turn = turns.find((candidate) => "turnId" in data && candidate.turnId === data.turnId);
        if (turn === undefined) return [];
        turn.events.push(event.id);
        return [turn];
      },
    };
  };
  const project = createTurnProjector(start, (turn: Turn) => ({ turnId: turn.turnId, events: [...turn.events] }));
  return { seen, project };
};

const events = log(
  { type: "turn-start", turnId: "t1" },
  { type: "turn-end", turnId: "t1", reason: "done" },
  { type: "turn-start", turnId: "t2" },
  { type: "step-start", turnId: "t2", stepId: "s1" },
  { type: "title", title: "Named" },
  { type: "step-end", turnId: "t2", stepId: "s1" },
);

describe("createTurnProjector", () => {
  it("feeds only the events appended, and keeps the view of each turn they did not change", () => {
    const { seen, project } = counting();
    const before = project(events.slice(0, 4));
    const after = project(events);
    expect(seen.starts).toBe(1);
    expect(seen.fed).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
    expect(after).toEqual([
      { turnId: "t1", events: ["e1", "e2"] },
      { turnId: "t2", events: ["e3", "e4", "e6"] },
    ]);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  });

  it("returns the list it returned before while every view in it is", () => {
    const { project } = counting();
    const before = project(events.slice(0, 4));
    // The same events in a new array, and an event that changes no turn.
    expect(project(events.slice(0, 4))).toBe(before);
    expect(project(events.slice(0, 5))).toBe(before);
  });

  it("folds any other branch from its start: one shorter, or not grown from the last", () => {
    const { seen, project } = counting();
    const whole = project(events);
    const back = project(events.slice(0, 2));
    expect(seen.starts).toBe(2);
    expect(back).toEqual([{ turnId: "t1", events: ["e1", "e2"] }]);
    expect(back[0]).not.toBe(whole[0]);
    project(log({ type: "turn-start", turnId: "t9" }));
    expect(seen.starts).toBe(3);
  });

  it("folds the branch afresh when the fold asks", () => {
    const { seen, project } = counting();
    const before = project(events.slice(0, 2));
    const after = project([...events.slice(0, 2), ...log({ type: "custom", kind: "x", data: null }).map((event) => ({ ...event, id: "e3", seq: 3 }))]);
    expect(seen.starts).toBe(2);
    expect(after).toEqual(before);
    expect(after[0]).not.toBe(before[0]);
  });
});
