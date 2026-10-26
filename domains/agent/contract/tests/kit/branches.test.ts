import { describe, expect, it } from "vitest";
import { makeKeptBranches } from "../../src/kit/agent/branches.ts";
import type { KeptBranch } from "../../src/kit/turn.ts";

const branch = (): KeptBranch => ({ events: [], request: {} });

describe("kept branches", () => {
  it("hand a session's branch to its next turn once, keeping the most recently kept up to the limit", () => {
    const branches = makeKeptBranches(2);
    const kept = branch();
    branches.of("a").keep(kept);
    branches.of("b").keep(branch());
    // Kept again, `a` is the newest, so `b` goes when `c` comes.
    branches.of("a").keep(kept);
    branches.of("c").keep(branch());
    expect(branches.of("b").take()).toBeUndefined();
    expect(branches.of("a").take()).toBe(kept);
    expect(branches.of("a").take()).toBeUndefined();
  });

  it("let go of a branch no turn kept since the sweep before", () => {
    const branches = makeKeptBranches();
    branches.of("idle").keep(branch());
    branches.sweep();
    branches.of("busy").keep(branch());
    branches.sweep();
    expect(branches.of("idle").take()).toBeUndefined();
    expect(branches.of("busy").take()).toBeDefined();
  });

  it("drop a deleted session's branch", () => {
    const branches = makeKeptBranches();
    branches.of("gone").keep(branch());
    branches.drop("gone");
    expect(branches.of("gone").take()).toBeUndefined();
  });
});
