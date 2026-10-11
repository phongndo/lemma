import { describe, expect, it } from "vitest";
import { writeView } from "../src/view.ts";

describe("writeView", () => {
  it("shows the file written, from home when outside the session's directory", () => {
    expect(writeView.summary?.({ path: "/home/me/notes.md", content: "hi" }, { cwd: "/w", home: "/home/me" })).toEqual({
      primary: "~/notes.md",
      file: { path: "~/notes.md", kind: "file" },
    });
  });
});
