import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@lemma/contracts";
import { diffStats, parseDiff, readDetails } from "../src/model/details.ts";
import { branchSlug, contextSize, displayPath, partialStringField, summarizeToolArgs, summarizeUsage, tildePath, truncateLines } from "../src/model/format.ts";
import { clampThinking, filterModels, folderName, knownProjects, patchProjectSettings, projectName, resolveModel, thinkingLevels } from "../src/model/prefs.ts";
import { usage } from "./fixtures.ts";

describe("format", () => {
  it("shortens paths", () => {
    expect(tildePath("/home/me/x", "/home/me")).toBe("~/x");
    expect(tildePath("/home/meow", "/home/me")).toBe("/home/meow");
    expect(displayPath("/w/p/src/a.ts", "/w/p", "/home/me")).toBe("src/a.ts");
    expect(displayPath("/home/me/other", "/w/p", "/home/me")).toBe("~/other");
  });

  it("summarizes built-in tool arguments", () => {
    expect(summarizeToolArgs("bash", { command: "ls -la" })).toEqual({ primary: "ls -la", shell: true });
    expect(summarizeToolArgs("read", { path: "/w/a.ts", offset: 10, limit: 5 }, { cwd: "/w" })).toEqual({
      primary: "a.ts",
      secondary: "lines 10–14",
      file: { path: "a.ts", kind: "file" },
    });
    expect(summarizeToolArgs("ls", { path: "/w/src" }, { cwd: "/w" })).toEqual({ primary: "src", file: { path: "src", kind: "directory" } });
    expect(summarizeToolArgs("grep", { pattern: "TODO", path: "/w/src" }, { cwd: "/w" })).toEqual({ primary: "TODO", secondary: "in src" });
    expect(summarizeToolArgs("custom", { n: 1, q: "hello" })).toEqual({ primary: "hello" });
    expect(summarizeToolArgs("custom", undefined)).toEqual({});
  });

  it("reads string fields from partial JSON", () => {
    expect(partialStringField('{"command":"echo \\"hi', "command")).toBe('echo "hi');
    expect(partialStringField('{"command":"a\\', "command")).toBe("a");
    expect(partialStringField('{"com', "command")).toBeUndefined();
  });

  it("summarizes usage", () => {
    const s = summarizeUsage({ ...usage(1200, 300, 0.02), cacheRead: 5000 });
    expect(s).toMatchObject({ input: "6.2k", output: "300", cache: "5.0k", cost: "$0.020" });
  });

  it("truncates lines", () => {
    expect(truncateLines("a\nb\nc", 2)).toEqual({ text: "a\nb", hidden: 1 });
    expect(truncateLines("a", 2)).toEqual({ text: "a", hidden: 0 });
  });
});

describe("details", () => {
  it("reads known shapes and ignores the rest", () => {
    expect(readDetails({ diff: "+a", exitCode: 2, truncation: { truncated: true }, fullOutputPath: "/tmp/x" })).toEqual({
      diff: "+a",
      exitCode: 2,
      truncated: true,
      fullOutputPath: "/tmp/x",
    });
    expect(readDetails("nope")).toEqual({});
    expect(readDetails({ exitCode: "0" })).toEqual({});
  });

  it("parses unified diffs", () => {
    const lines = parseDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n ctx\n");
    expect(lines.map((l) => l.kind)).toEqual(["meta", "meta", "hunk", "del", "add", "ctx"]);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });
});

describe("project settings", () => {
  it("names a project by its setting, else its folder", () => {
    expect(folderName("/home/me/code/lemma/")).toBe("lemma");
    expect(projectName("/home/me/code/lemma", undefined)).toBe("lemma");
    expect(projectName("/home/me/code/lemma", { name: "Lemma" })).toBe("Lemma");
  });

  it("patches one project, trims names, and drops fields and projects returned to their defaults", () => {
    const one = patchProjectSettings({}, "/a", { name: "  Alpha ", worktree: true });
    expect(one).toEqual({ "/a": { name: "Alpha", worktree: true } });
    expect(patchProjectSettings(one, "/a", { name: " " })).toEqual({ "/a": { worktree: true } });
    expect(patchProjectSettings(one, "/a", { name: undefined, worktree: undefined })).toEqual({});
    expect(patchProjectSettings(one, "/b", { worktree: false })).toEqual({ ...one, "/b": { worktree: false } });
  });
});

describe("prefs", () => {
  const model = (ref: string, levels: ModelInfo["thinkingLevels"], reasoning = true): ModelInfo => ({
    ref,
    provider: ref.split("/")[0]!,
    id: ref.split("/")[1]!,
    name: ref.toUpperCase(),
    api: "x",
    reasoning,
    thinkingLevels: levels,
    input: ["text"],
    contextWindow: 1,
    maxTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  it("shows the chosen model, else the one the host would run", () => {
    const models = [model("opencode-go/glm", []), model("opencode-go/kimi", [])];
    expect(resolveModel(models, "opencode-go/kimi")?.ref).toBe("opencode-go/kimi");
    // Nothing chosen yet, or a choice whose provider is gone: the first available, as the host picks.
    expect(resolveModel(models, undefined)?.ref).toBe("opencode-go/glm");
    expect(resolveModel(models, "anthropic/claude")?.ref).toBe("opencode-go/glm");
    expect(resolveModel([], undefined)).toBeUndefined();
  });
  it("filters and groups models by provider", () => {
    const groups = filterModels([model("a/one", []), model("b/two", []), model("a/three", [])], "a o");
    expect(groups.map((g) => [g.provider, g.models.map((m) => m.ref)])).toEqual([["a", ["a/one"]]]);
    expect(filterModels([model("a/one", []), model("b/two", [])], "").map((g) => g.provider)).toEqual(["a", "b"]);
  });
  it("offers and clamps thinking levels to the model", () => {
    const m = model("a/x", ["low", "medium", "high"]);
    expect(thinkingLevels(model("a/y", ["low"], false))).toEqual([]);
    // A single level is no choice at all.
    expect(thinkingLevels(model("a/z", ["off"]))).toEqual([]);
    expect(clampThinking(model("d/v", ["off", "low", "high", "max"]), "medium")).toBe("high");
    expect(clampThinking(model("d/v", ["off", "low", "high", "max"]), "xhigh")).toBe("max");
    expect(clampThinking(m, "medium")).toBe("medium");
    expect(clampThinking(m, "xhigh")).toBe("high");
    expect(clampThinking(m, "off")).toBe("low");
    expect(clampThinking(m, undefined)).toBeUndefined();
    expect(clampThinking(undefined, "high")).toBeUndefined();
  });
  it("lists folders with sessions by recency, then added projects, and none before there are any", () => {
    const sessions = [
      { cwd: "/b", updatedAt: 1 },
      { cwd: "/c", updatedAt: 5 },
      { cwd: "/b", updatedAt: 9 },
    ];
    expect(knownProjects([], [])).toEqual([]);
    expect(knownProjects(sessions, ["/d", "/c"])).toEqual(["/b", "/c", "/d"]);
  });
  it("leaves out hidden projects until they have a session, and the standalone folder always", () => {
    const sessions = [
      { cwd: "/b", updatedAt: 1 },
      { cwd: "/scratch", updatedAt: 2 },
    ];
    expect(knownProjects(sessions, ["/b", "/d"], { hidden: ["/b", "/d"], standalone: "/scratch" })).toEqual(["/b"]);
  });
});

describe("branchSlug", () => {
  it("names a worktree branch from the first words of the message", () => {
    expect(branchSlug("Fix the login redirect, please! It loops forever")).toBe("lemma/fix-the-login-redirect-please");
    expect(branchSlug("   ")).toBe("lemma/task");
    expect(branchSlug("é ✨")).toBe("lemma/task");
  });
});

describe("contextSize", () => {
  it("abbreviates token counts", () => {
    expect(contextSize(1_000_000)).toBe("1M");
    expect(contextSize(1_048_576)).toBe("1M");
    expect(contextSize(203_000)).toBe("203K");
    expect(contextSize(2_500_000)).toBe("2.5M");
  });
});
