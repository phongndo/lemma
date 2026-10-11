import { describe, expect, it } from "vitest";
import { branchSlug } from "../src/slug.ts";

describe("branchSlug", () => {
  it("names a worktree branch from the first words of the message", () => {
    expect(branchSlug("Fix the login redirect, please! It loops forever")).toBe("lemma/fix-the-login-redirect-please");
    expect(branchSlug("   ")).toBe("lemma/task");
    expect(branchSlug("é ✨")).toBe("lemma/task");
  });
});
