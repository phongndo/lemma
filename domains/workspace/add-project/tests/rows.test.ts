import { describe, expect, test } from "vitest";
import type { DirectoryEntry } from "@lemma/workspace";
import { above, listRows } from "../src/rows.ts";
import type { Listing } from "../src/rows.ts";

const folder = (parent: string, name: string): DirectoryEntry => ({ name, path: `${parent}/${name}`, git: false, matches: [] });
const listing = (parent: string, ...names: string[]): Listing => ({ parent, entries: names.map((name) => folder(parent, name)), truncated: false });
const kinds = (typed: string, listed: Listing | undefined, home = "/Users/dp") =>
  listRows(typed, listed, home).map((row) => (row.kind === "entry" ? row.entry.name : row.kind === "up" ? `.. ${row.path}` : `${row.kind} ${row.path}`));

describe("listRows", () => {
  test("gone into a folder, the first row opens it, so Enter does; `..` goes back up", () => {
    expect(kinds("~/code/llvm-dev/", listing("/Users/dp/code/llvm-dev", "build", "llvm-project"))).toEqual([
      "here ~/code/llvm-dev/",
      ".. /Users/dp/code",
      "build",
      "llvm-project",
    ]);
  });

  test("a name lists the folders it matches first, then one to create when none is it", () => {
    expect(kinds("~/code/llvm", listing("/Users/dp/code", "llvm-dev"))).toEqual(["llvm-dev", "create ~/code/llvm"]);
    expect(kinds("~/code/llvm-dev", listing("/Users/dp/code", "llvm-dev"))).toEqual(["llvm-dev"]);
  });

  test("the rows about the path follow what is typed while the folders are still the last path's", () => {
    expect(kinds("~/code/", listing("/Users/dp", "code", "notes"))).toEqual(["here ~/code/", ".. /Users/dp", "code", "notes"]);
    expect(kinds("~/code/", undefined)).toEqual(["here ~/code/", ".. /Users/dp"]);
  });

  test("the disk's root has nothing above it", () => {
    expect(kinds("/", listing("/", "Users"))).toEqual(["here /", "Users"]);
  });
});

describe("above", () => {
  test("is the folder holding the one typed, and that one's name", () => {
    expect(above("~/code/llvm-dev/", "/Users/dp")).toEqual({ path: "/Users/dp/code", from: "llvm-dev" });
    expect(above("~/", "/Users/dp")).toEqual({ path: "/Users", from: "dp" });
    expect(above("/Users/", undefined)).toEqual({ path: "/", from: "Users" });
  });

  test("is nothing at the root, or at ~ before home is known", () => {
    expect(above("/", "/Users/dp")).toBeUndefined();
    expect(above("~/", undefined)).toBeUndefined();
  });
});
