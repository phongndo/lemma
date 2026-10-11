import { describe, expect, it } from "vitest";
import { bashView } from "../src/view.ts";

describe("bashView", () => {
  it("shows a call's command as a shell line", () => {
    expect(bashView.summary?.({ command: "ls -la" }, {})).toEqual({ primary: "ls -la", shell: true });
    expect(bashView.summary?.(undefined, {})).toEqual({});
  });
});
