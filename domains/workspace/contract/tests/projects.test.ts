import { describe, expect, it } from "vitest";
import { folderName, knownProjects, patchProjectSettings, projectName } from "../src/web/projects.ts";

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

describe("known projects", () => {
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
