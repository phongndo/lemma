import { describe, expect, test } from "vitest";
import { dragEdge } from "../src/drag.ts";

/** An edge pressed with `button`: what it captured, and the event that started the drag. */
const pressed = (button: number) => {
  const captured: number[] = [];
  const edge = Object.assign(new EventTarget(), { setPointerCapture: (id: number) => captured.push(id) });
  let prevented = false;
  const event = { button, pointerId: 7, currentTarget: edge, preventDefault: () => (prevented = true) } as unknown as PointerEvent;
  return { edge, event, captured, prevented: () => prevented };
};

describe("dragEdge", () => {
  test("captures the pointer, hears each move, and ends once however the drag ends", () => {
    for (const ending of ["pointerup", "pointercancel", "lostpointercapture"]) {
      const { edge, event, captured, prevented } = pressed(0);
      const moves: Event[] = [];
      let ends = 0;
      expect(dragEdge(event, { move: (moved) => moves.push(moved), end: () => ends++ })).toBe(true);
      expect(captured).toEqual([7]);
      expect(prevented()).toBe(true);
      edge.dispatchEvent(new Event("pointermove"));
      edge.dispatchEvent(new Event("pointermove"));
      edge.dispatchEvent(new Event(ending));
      // A capture lost as the release ends it: still once.
      edge.dispatchEvent(new Event("lostpointercapture"));
      edge.dispatchEvent(new Event("pointermove"));
      expect(moves).toHaveLength(2);
      expect(ends).toBe(1);
    }
  });

  test("leaves a press of another button alone", () => {
    const { edge, event, captured, prevented } = pressed(2);
    let moves = 0;
    expect(dragEdge(event, { move: () => moves++ })).toBe(false);
    edge.dispatchEvent(new Event("pointermove"));
    expect([captured, prevented(), moves]).toEqual([[], false, 0]);
  });
});
