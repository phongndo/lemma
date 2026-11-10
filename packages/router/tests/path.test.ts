import { describe, expect, test } from "vitest";
import { buildPath, compareScores, matchPattern, parsePattern, splitPath } from "../src/path.ts";

const match = (path: string, pathname: string) => matchPattern(parsePattern(path), splitPath(pathname)!);

describe("parsePattern", () => {
  test("reads literal, param, optional, and rest segments", () => {
    expect(parsePattern("/threads/:id/:view?/*rest").segments).toEqual([
      { kind: "static", value: "threads" },
      { kind: "param", name: "id" },
      { kind: "optional", name: "view" },
      { kind: "rest", name: "rest" },
    ]);
  });

  test("refuses ambiguous or malformed patterns", () => {
    expect(() => parsePattern("threads")).toThrow(/start with/);
    expect(() => parsePattern("/a/*rest/b")).toThrow(/last/);
    expect(() => parsePattern("/a/:x?/b")).toThrow(/optional/);
    expect(() => parsePattern("/a/:x/:x")).toThrow(/twice/);
    expect(() => parsePattern("/a/:1x")).toThrow(/valid/);
  });
});

describe("matchPattern", () => {
  test("keeps parameter names that are object property names and requires their own values", () => {
    for (const name of ["__proto__", "constructor", "toString"]) {
      const pattern = parsePattern(`/p/:${name}`);
      const params = Object.fromEntries([[name, "value"]]);
      expect(matchPattern(pattern, ["p", "value"])?.params).toEqual(params);
      expect(buildPath(pattern, params)).toBe("/p/value");
      expect(() => buildPath(pattern, {})).toThrow(/required/);
    }
  });

  test("matches params, filled and empty optionals, and rests", () => {
    expect(match("/threads/:id", "/threads/abc")?.params).toEqual({ id: "abc" });
    expect(match("/threads/:id/:view?", "/threads/abc")?.params).toEqual({ id: "abc" });
    expect(match("/threads/:id/:view?", "/threads/abc/trajectory")?.params).toEqual({ id: "abc", view: "trajectory" });
    expect(match("/files/*path", "/files/a/b/c")?.params).toEqual({ path: "a/b/c" });
    expect(match("/files/*path", "/files")?.params).toEqual({ path: "" });
  });

  test("refuses too few or too many segments", () => {
    expect(match("/threads/:id", "/threads")).toBeUndefined();
    expect(match("/threads/:id", "/threads/a/b")).toBeUndefined();
    expect(match("/", "/a")).toBeUndefined();
  });

  test("decodes segments and ignores empty ones", () => {
    expect(match("/threads/:id", "/threads/a%20b/")?.params).toEqual({ id: "a b" });
    expect(match("/a/:x", "//a//x")?.params).toEqual({ x: "x" });
    expect(splitPath("/threads/%E0%A4%A")).toBeUndefined();
  });
});

describe("compareScores", () => {
  const winner = (pathname: string, ...paths: string[]) =>
    paths
      .map((path) => ({ path, found: match(path, pathname) }))
      .filter((candidate) => candidate.found !== undefined)
      .sort((a, b) => compareScores(a.found!.score, b.found!.score))[0]?.path;

  test("a literal beats a param beats an optional beats a rest", () => {
    expect(winner("/settings/plugins", "/settings/:section?", "/settings/plugins", "/settings/*rest")).toBe("/settings/plugins");
    expect(winner("/settings/plugins", "/settings/:section?", "/settings/*rest")).toBe("/settings/:section?");
    expect(winner("/a/b", "/a/*rest", "/a/:x")).toBe("/a/:x");
    expect(winner("/a/b", "/:x/b", "/a/:y")).toBe("/a/:y");
  });

  test("an exact match beats a rest that matches nothing", () => {
    expect(winner("/a", "/a/*rest", "/a")).toBe("/a");
  });
});

describe("buildPath", () => {
  const pattern = parsePattern("/threads/:id/:view?");

  test("encodes params and leaves out unset optionals", () => {
    expect(buildPath(pattern, { id: "a b/c" })).toBe("/threads/a%20b%2Fc");
    expect(buildPath(pattern, { id: "x", view: "trajectory" })).toBe("/threads/x/trajectory");
    expect(buildPath(parsePattern("/files/*path"), { path: "a/b c" })).toBe("/files/a/b%20c");
    expect(buildPath(parsePattern("/"), {})).toBe("/");
  });

  test("refuses missing required params and gaps", () => {
    expect(() => buildPath(pattern, {})).toThrow(/required/);
    expect(() => buildPath(parsePattern("/a/:x?/:y?"), { y: "1" })).toThrow(/before it/);
  });

  test("what it builds matches back to the same params", () => {
    for (const params of [{ id: "x" }, { id: "with space", view: "v" }, { id: "ü/?#" }]) {
      expect(match("/threads/:id/:view?", buildPath(pattern, params))?.params).toEqual(params);
    }
  });
});
