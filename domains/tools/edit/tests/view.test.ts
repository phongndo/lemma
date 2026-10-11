import { describe, expect, it } from "vitest";
import { editView } from "../src/view.ts";

describe("editView", () => {
  it("shows the file changed, from the session's directory", () => {
    expect(editView.summary?.({ path: "/w/src/a.ts", edits: [] }, { cwd: "/w" })).toEqual({ primary: "src/a.ts", file: { path: "src/a.ts", kind: "file" } });
  });
});
