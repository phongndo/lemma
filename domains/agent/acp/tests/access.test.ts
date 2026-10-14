import { describe, expect, it } from "vitest";
import { allowsItself, modeFor, offered } from "../src/access.ts";

const claude = [
  { id: "default", name: "Manual" },
  { id: "acceptEdits", name: "Accept edits" },
  { id: "plan", name: "Plan" },
  { id: "auto", name: "Auto" },
  { id: "bypassPermissions", name: "Bypass permissions" },
];
const codex = [
  { id: "read-only", name: "Read-only" },
  { id: "workspace-write", name: "Workspace access" },
  { id: "agent", name: "Auto review" },
  { id: "agent-full-access", name: "Full access" },
];

describe("access levels", () => {
  it("map to Claude Code's and Codex's own modes", () => {
    expect(offered(claude)).toEqual([
      { access: "supervised", mode: "default" },
      { access: "auto-edits", mode: "acceptEdits" },
      { access: "auto", mode: "auto" },
      { access: "full", mode: "bypassPermissions" },
    ]);
    expect(offered(codex).map((level) => level.mode)).toEqual(["read-only", "workspace-write", "agent", "agent-full-access"]);
  });

  it("offer only what Lemma can keep for an agent with no modes: auto needs the agent to judge", () => {
    expect(offered([])).toEqual([{ access: "supervised" }, { access: "auto-edits" }, { access: "full" }]);
    expect(modeFor("auto", [])).toBeUndefined();
  });

  it("let Lemma allow edits at auto-edits, and everything at full access", () => {
    expect(allowsItself("auto-edits", "edit")).toBe(true);
    expect(allowsItself("auto-edits", "execute")).toBe(false);
    expect(allowsItself("supervised", "edit")).toBe(false);
    expect(allowsItself("full", "execute")).toBe(true);
  });
});
