import { describe, expect, it } from "vitest";
import { formatRef, hasTarget, parseRef, targetProblem } from "../src/index.ts";

describe("targets", () => {
  it("name exactly one thing: a ref, a locator, a selector, or a point", () => {
    expect(targetProblem({ ref: "s1-e2" })).toBeUndefined();
    expect(targetProblem({ locator: "role=button[name='Save']" })).toBeUndefined();
    expect(targetProblem({ selector: "button" })).toBeUndefined();
    expect(targetProblem({ x: 0, y: 10 })).toBeUndefined();
  });

  it("refuse none, several, or half a point, saying what to give", () => {
    expect(targetProblem({})).toMatch(/a ref from browser_snapshot/);
    expect(targetProblem({ ref: "s1-e2", selector: "button" })).toMatch(/not several/);
    expect(targetProblem({ x: 3 })).toMatch(/x and y go together/);
  });

  it("are optional for actions on the page", () => {
    expect(hasTarget({})).toBe(false);
    expect(hasTarget({ y: 1 })).toBe(true);
  });
});

describe("refs", () => {
  it("carry their snapshot's generation", () => {
    expect(formatRef(3, "e12")).toBe("s3-e12");
    expect(parseRef("s3-e12")).toEqual({ generation: 3, element: "e12" });
    expect(parseRef(" s10-f1e4 ")).toEqual({ generation: 10, element: "f1e4" });
  });

  it("are only what a snapshot gave", () => {
    expect(parseRef("e12")).toBeUndefined();
    expect(parseRef("s3-")).toBeUndefined();
    expect(parseRef("button")).toBeUndefined();
  });
});
