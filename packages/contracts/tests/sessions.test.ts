import { describe, expect, test } from "vitest";
import { NewThreadRoute, ThreadRoute } from "../src/sessions.ts";

describe("thread routes", () => {
  test("threads have readable paths", () => {
    expect(NewThreadRoute.href({})).toBe("/");
    expect(ThreadRoute.href({ id: "s1" })).toBe("/threads/s1");
    expect(ThreadRoute.href({ id: "s1", view: "trajectory" })).toBe("/threads/s1/trajectory");
  });
});
