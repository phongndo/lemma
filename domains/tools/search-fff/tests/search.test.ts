import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCore } from "@lemma/core";
import { ToolRunner } from "@lemma/tools";
import { attempt, call, context, textOf } from "@lemma/tools/testing";
import registry from "@lemma/tools-registry";
import search, { findTool, grepTool, makeIndexes } from "../src/index.ts";
import type { Finder, Indexes, SearchDetails } from "../src/index.ts";

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

let dir: string;
let indexes: Indexes;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lemma-search-fff-")));
  indexes = makeIndexes({ idleMs: 60_000 });
});
afterEach(async () => {
  indexes.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const write = async (relative: string, content: string, root = dir) => {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), content);
};

/** A repository with sources, a nested folder of the same name, and an ignored one. */
const project = async () => {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await write(".gitignore", "ignored/\n");
  await write("src/app.ts", "import { Composer } from './composer';\nexport const needle = 1;\n");
  await write("src/composer.ts", "export class Composer {\n  // needle in a method\n  run() {}\n}\n");
  await write("pkg/src/other.ts", "export const needle = 2;\n");
  await write("app/[id]/page.tsx", "export const needle = 3;\n");
  await write("Makefile", "needle:\n\techo needle\n");
  await write("ignored/secret.ts", "export const needle = 4;\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: dir });
};

const grep = (input: Record<string, unknown>, cwd = dir) => call(grepTool(indexes), input, context(cwd));
const find = (input: Record<string, unknown>, cwd = dir) => call(findTool(indexes), input, context(cwd));
/** The files a result lists: grep's file headers, find's lines, without tags. */
const files = (output: string) =>
  output
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith(" ") && !line.startsWith("["))
    .map((line) => line.replace(/ {2}\[.*\]$/, ""))
    .sort();

describe("grep", () => {
  it("lists matches by file, with line numbers, tagging what git sees changed and leaving out what it ignores", async () => {
    await project();
    await write("src/new.ts", "export const needle = 6;\n");
    const result = await grep({ pattern: "needle" });
    expect(files(textOf(result))).toEqual(["Makefile", "app/[id]/page.tsx", "pkg/src/other.ts", "src/app.ts", "src/composer.ts", "src/new.ts"]);
    expect(textOf(result)).toContain(" 2: // needle in a method");
    expect((result.details as SearchDetails).root).toBe(dir);
    // fff reads git's status on a thread of its own once the scan ends, so the first answers can come before the tags.
    await vi.waitFor(async () => expect(textOf(await grep({ pattern: "needle" }))).toContain("src/new.ts  [untracked in git]\n 1: export const needle = 6;"), {
      timeout: 5_000,
      interval: 10,
    });
  });

  it("keeps to an existing folder or file exactly, a missing name anywhere, and drops excludes", async () => {
    await project();
    expect(files(textOf(await grep({ pattern: "needle", path: "src" })))).toEqual(["src/app.ts", "src/composer.ts"]);
    expect(files(textOf(await grep({ pattern: "needle", path: "src/app.ts" })))).toEqual(["src/app.ts"]);
    expect(files(textOf(await grep({ pattern: "needle", path: "app/[id]" })))).toEqual(["app/[id]/page.tsx"]);
    expect(files(textOf(await grep({ pattern: "needle", path: "other.ts" })))).toEqual(["pkg/src/other.ts"]);
    expect(files(textOf(await grep({ pattern: "needle", path: "src/**/*.ts" })))).toEqual(["src/app.ts", "src/composer.ts"]);
    expect(files(textOf(await grep({ pattern: "needle", exclude: ["src/", "!page.tsx"] })))).toEqual(["Makefile"]);
    expect(files(textOf(await grep({ pattern: "needle", path: `${dir}/pkg` })))).toEqual(["pkg/src/other.ts"]);
  });

  it("shows context, reads regex syntax as a regex, and refuses a pattern that matches everything", async () => {
    await project();
    expect(textOf(await grep({ pattern: "run", path: "src/composer.ts", context: 1 }))).toBe("src/composer.ts\n 2- // needle in a method\n 3: run() {}\n 4- }");
    expect(files(textOf(await grep({ pattern: "needle = [23]" })))).toEqual(["app/[id]/page.tsx", "pkg/src/other.ts"]);
    expect(textOf(await grep({ pattern: ".*" }))).toMatch(/^Pattern '\.\*' matches everything/);
    expect(await attempt(grepTool(indexes), { pattern: " " }, context(dir))).toBe("error: The pattern is empty: give a word or identifier to search for");
  });

  it("shows close fuzzy matches when a plain pattern matches nothing", async () => {
    await project();
    const result = await grep({ pattern: "Composr" });
    expect(textOf(result)).toMatch(/^\[No exact matches; these are close\]\n/);
    expect((result.details as SearchDetails).fuzzy).toBe(true);
    expect(textOf(await grep({ pattern: "zzqqxx_nothing_like_it" }))).toBe("No matches found");
  });

  it("continues with a cursor that holds no state, so another index answers it", async () => {
    await project();
    const first = textOf(await grep({ pattern: "needle", limit: 1 }));
    const cursor = /cursor="(\d+)"/.exec(first)?.[1];
    expect(cursor).toBeDefined();
    indexes.close();
    indexes = makeIndexes({ idleMs: 60_000 });
    const second = textOf(await grep({ pattern: "needle", limit: 1, cursor }));
    expect(files(second)).toHaveLength(1);
    expect(files(second)).not.toEqual(files(first));
    expect(await attempt(grepTool(indexes), { pattern: "needle", cursor: "fff_c1" }, context(dir))).toBe(
      'error: cursor "fff_c1" is not one a previous result gave',
    );
  });

  it("searches a directory outside the working directory, showing absolute paths", async () => {
    await project();
    const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lemma-search-fff-other-")));
    try {
      await write("lib/far.ts", "export const needle = 5;\n", other);
      const result = await grep({ pattern: "needle", path: other });
      expect(files(textOf(result))).toEqual([path.join(other, "lib/far.ts")]);
      expect((result.details as SearchDetails).root).toBe(other);
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it("refuses to index the home directory, and names a working directory that is gone", async () => {
    expect(await attempt(grepTool(indexes), { pattern: "x", path: "~" }, context(dir))).toMatch(/would index all of the home directory/);
    expect(await attempt(grepTool(indexes), { pattern: "x" }, context(path.join(dir, "gone")))).toMatch(/does not exist/);
  });
});

describe("find", () => {
  it("finds files fuzzily by their whole path, typos included", async () => {
    await project();
    expect(textOf(await find({ pattern: "compoesr" })).split("\n")[0]).toBe("src/composer.ts");
    expect(files(textOf(await find({ pattern: "", path: "src" })))).toEqual(["src/app.ts", "src/composer.ts"]);
    expect(textOf(await find({ pattern: "secret" }))).not.toContain("ignored/");
  });

  it("pages with a cursor, and caps weak matches", async () => {
    await project();
    const first = textOf(await find({ pattern: "", limit: 2 }));
    expect(first).toMatch(/\[\d+ more: continue with cursor="2"\]$/);
    const second = textOf(await find({ pattern: "", limit: 2, cursor: "2" }));
    expect(files(second).some((file) => files(first).includes(file))).toBe(false);
    expect(textOf(await find({ pattern: "qzxapmxe" }))).toMatch(/No files found|Only weak, scattered matches/);
  });
});

describe("the plugin", () => {
  it("adds grep and find, read-only and safe to run together, with clean schemas", async () => {
    const listed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([registry, search]);
          return yield* core.run(Effect.flatMap(ToolRunner, (runner) => runner.list));
        }),
      ),
    );
    expect(listed.map((tool) => [tool.spec.name, tool.source, tool.replay, tool.parallel])).toEqual([
      ["find", "tools.search-fff", "safe", "safe"],
      ["grep", "tools.search-fff", "safe", "safe"],
    ]);
    const grepSpec = listed.find((tool) => tool.spec.name === "grep")!.spec.parameters;
    expect(grepSpec).toMatchObject({ type: "object", required: ["pattern"] });
    expect(JSON.stringify(listed)).not.toContain("$schema");
  });
});

describe("the indexes", () => {
  const fake = (): Finder & { destroyed: number } => {
    const finder = {
      destroyed: 0,
      grep: () => ({ ok: false as const, error: "unused" }),
      fileSearch: () => ({ ok: false as const, error: "unused" }),
      isScanning: () => false,
      waitForScan: async () => ({ ok: true as const, value: true }),
      getScanProgress: () => ({ ok: true as const, value: { scannedFilesCount: 3, isScanning: false, isWatcherReady: true, isWarmupComplete: true } }),
      destroy: () => {
        finder.destroyed++;
      },
    };
    return finder;
  };

  it("opens one per directory for calls that arrive together, and closes it once idle", async () => {
    const opened: string[] = [];
    const finder = fake();
    const pool = makeIndexes({ idleMs: 20, open: async (root) => (opened.push(root), finder) });
    await Promise.all([pool.use("/a", async () => undefined), pool.use("/a", async () => undefined)]);
    expect(opened).toEqual(["/a"]);
    expect(await pool.snapshot()).toMatchObject([{ root: "/a", files: 3, searching: 0 }]);
    await vi.waitFor(() => expect(finder.destroyed).toBe(1), { timeout: 2_000, interval: 5 });
    expect(await pool.snapshot()).toEqual([]);
  });

  it("tries a failed open again on the next call", async () => {
    let attempts = 0;
    const pool = makeIndexes({
      idleMs: 60_000,
      open: async () => {
        attempts++;
        if (attempts === 1) throw new Error("no native library");
        return fake();
      },
    });
    await expect(pool.use("/a", async () => undefined)).rejects.toThrow("File search is unavailable here: no native library");
    await expect(pool.use("/a", async () => "ok")).resolves.toBe("ok");
    pool.close();
  });
});
