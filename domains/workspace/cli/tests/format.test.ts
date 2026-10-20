import { describe, expect, test } from "vitest";
import { formatFiles, formatListing, formatWorkspace, formatWorktrees } from "../src/index.ts";

describe("workspace formatting", () => {
  test("a project's status: its branch, head, changes, and upstream; or why there is none", () => {
    const git = { root: "/work", branch: "main", head: "abc1234", changes: 2, upstream: "origin/main", ahead: 1, behind: 0 };
    expect(formatWorkspace({ path: "/work", exists: true, git }).split("\n")).toEqual([
      "path      /work",
      "branch    main",
      "head      abc1234",
      "changes   2",
      "upstream  origin/main (ahead 1, behind 0)",
    ]);
    expect(formatWorkspace({ path: "/work", exists: true, git: { ...git, branch: null, upstream: undefined } })).toContain("(detached at abc1234)");
    expect(formatWorkspace({ path: "/work", exists: true })).toBe("/work: not a git repository");
    expect(formatWorkspace({ path: "/gone", exists: false })).toBe("/gone: does not exist");
  });

  test("a project's worktrees: branch, path, and whether the folder is gone", () => {
    expect(formatWorktrees([]).split("\n")).toEqual(["No worktrees."]);
    expect(
      formatWorktrees([
        { path: "/trees/a", branch: "feat/a" },
        { path: "/trees/b", branch: null, missing: true },
      ]).split("\n"),
    ).toEqual(["feat/a      /trees/a", "(detached)  /trees/b  missing"]);
  });

  test("found files, directories with a slash, and what may be missing", () => {
    const entries = [
      { path: "src/components/Composer.tsx", kind: "file" as const },
      { path: "src/components", kind: "directory" as const },
    ];
    expect(formatFiles({ root: "/work", entries, truncated: true })).toBe("src/components/Composer.tsx\nsrc/components/\n…");
    expect(formatFiles({ root: "/work", entries: [], truncated: false, indexing: true })).toBe(
      "No matches.\n(still reading the directory: some may be missing)",
    );
  });

  test("a directory's subdirectories, marking repositories", () => {
    expect(
      formatListing({
        parent: "/work",
        entries: [
          { name: "lemma", path: "/work/lemma", git: true, matches: [] },
          { name: "notes", path: "/work/notes", git: false, matches: [] },
        ],
        truncated: false,
      }),
    ).toBe("/work\n  lemma/  (git)\n  notes/");
  });
});
