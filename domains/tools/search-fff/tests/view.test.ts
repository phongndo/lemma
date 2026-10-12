import { describe, expect, it } from "vitest";
import { findView, grepView } from "../src/view.ts";

describe("the search views", () => {
  it("show the pattern, and where it searched relative to the working directory", () => {
    expect(grepView.summary?.({ pattern: "needle", path: "/p/src" }, { cwd: "/p" })).toEqual({ primary: "needle", secondary: "in src" });
    expect(grepView.summary?.({ pattern: "needle" }, {})).toEqual({ primary: "needle" });
    expect(findView.summary?.({ pattern: "", path: "src" }, {})).toEqual({ primary: "src" });
    expect(findView.summary?.(undefined, {})).toEqual({});
  });
});
