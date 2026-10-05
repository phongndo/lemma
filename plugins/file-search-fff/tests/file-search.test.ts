import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Either } from "effect";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLoader, Registries } from "@lemma/core";
import { FileSearchError, searchFiles } from "@lemma/contracts";
import type { FileSearchOptions } from "@lemma/contracts";
import fileSearch, { insideGlob, makeFileSearch } from "../src/index.ts";
import type { Finder, OpenFinder } from "../src/index.ts";

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lemma-file-search-")));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const write = async (relative: string, content = "") => {
  await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
  await fs.writeFile(path.join(dir, relative), content);
};

/** A repository with sources, a readme, and an ignored directory. */
const project = async () => {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await write(".gitignore", "ignored/\n");
  await write("README.md", "# readme\n");
  await write("src/app.ts", "export {};\n");
  await write("src/components/Composer.tsx", "export {};\n");
  await write("ignored/secret.ts", "export {};\n");
};

/** Runs `body` with a search over real fff, closed afterwards. */
const withSearch = <A>(
  body: (search: (cwd: string, query: string, options?: FileSearchOptions) => Promise<Either.Either<unknown, FileSearchError>>) => Promise<A>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { service } = yield* makeFileSearch({ idleMs: 60_000 });
        return yield* Effect.promise(() => body((cwd, query, options) => Effect.runPromise(Effect.either(service.search(cwd, query, options)))));
      }),
    ),
  );

const value = <A>(result: Either.Either<A, FileSearchError>): A => {
  if (Either.isLeft(result)) throw new Error(`search failed: ${result.left.message}`);
  return result.right;
};
const paths = (result: Either.Either<unknown, FileSearchError>) =>
  (value(result) as { entries: readonly { path: string; kind: string }[] }).entries.map((entry) => `${entry.kind}:${entry.path}`);

describe("search with fff", () => {
  it("finds files fuzzily, typos included, relative to the directory", async () => {
    await project();
    await withSearch(async (search) => {
      const result = value(await search(dir, "compoesr", { kind: "file" })) as { root: string; entries: readonly { path: string }[] };
      expect(result.root).toBe(dir);
      expect(result.entries[0]).toEqual({ path: "src/components/Composer.tsx", kind: "file" });
    });
  });

  it("leaves out what git ignores and the directory itself", async () => {
    await project();
    await withSearch(async (search) => {
      const all = paths(await search(dir, "", { limit: 200 }));
      expect(all).toEqual(expect.arrayContaining(["file:README.md", "file:src/app.ts", "directory:src", "directory:src/components"]));
      expect(all.some((entry) => entry.includes("ignored"))).toBe(false);
      expect(all).not.toContain("directory:");
    });
  });

  it("returns only the kind asked for, at most `limit`, saying when more matched", async () => {
    await project();
    await withSearch(async (search) => {
      expect(paths(await search(dir, "src", { kind: "directory" }))).toEqual(expect.arrayContaining(["directory:src", "directory:src/components"]));
      expect(paths(await search(dir, "src", { kind: "directory" })).every((entry) => entry.startsWith("directory:"))).toBe(true);
      expect(paths(await search(dir, "", { kind: "file" })).every((entry) => entry.startsWith("file:"))).toBe(true);
      const one = value(await search(dir, "", { kind: "file", limit: 1 })) as { entries: readonly unknown[]; truncated: boolean };
      expect(one.entries).toHaveLength(1);
      expect(one.truncated).toBe(true);
      expect((value(await search(dir, "readme", { kind: "file" })) as { truncated: boolean }).truncated).toBe(false);
    });
  });

  it("keeps to a folder `within` the directory, entries still relative to the directory", async () => {
    await project();
    await withSearch(async (search) => {
      const inside = paths(await search(dir, "", { within: "src", limit: 200 }));
      expect(inside).toEqual(expect.arrayContaining(["file:src/app.ts", "directory:src/components", "file:src/components/Composer.tsx"]));
      expect(inside.every((entry) => entry.split(":")[1]!.startsWith("src/"))).toBe(true);
      expect(paths(await search(dir, "comp", { within: "src/", kind: "file" }))[0]).toBe("file:src/components/Composer.tsx");
      for (const within of ["missing", "../elsewhere", "/etc", "README.md"]) {
        const result = await search(dir, "", { within });
        expect(Either.isLeft(result) && result.left.reason).toBe("NotFound");
      }
    });
  });

  it("finds folders with glob characters or spaces in their names", async () => {
    await project();
    await write("app/[id]/page.tsx");
    await write("my notes/a b.md");
    await write("my-notes/decoy.md");
    await withSearch(async (search) => {
      expect(paths(await search(dir, "", { within: "app/[id]" }))).toEqual(["file:app/[id]/page.tsx"]);
      expect(paths(await search(dir, "", { within: "my notes" }))).toEqual(["file:my notes/a b.md"]);
    });
    expect(insideGlob("a b/[x]{y}*")).toBe("a?b/\\[x\\]\\{y\\}\\*/**");
  });

  it("applies the repository's ignore files to a search in one of its folders, sharing its index", async () => {
    await project();
    await write(".gitignore", "ignored/\ndist/\n");
    await write("pkg/src/index.ts");
    await write("pkg/dist/bundle.js");
    const opened: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { openFff } = yield* Effect.promise(() => import("../src/index.ts"));
          const { service } = yield* makeFileSearch({ idleMs: 60_000, open: (root) => (opened.push(root), openFff(root)) });
          const result = yield* service.search(path.join(dir, "pkg"), "", { limit: 200 });
          expect(result.root).toBe(path.join(dir, "pkg"));
          expect(result.entries.map((entry) => `${entry.kind}:${entry.path}`).sort()).toEqual(["directory:src", "file:src/index.ts"]);
          yield* service.search(dir, "");
        }),
      ),
    );
    expect(opened).toEqual([dir]);
  });

  it("sees files created after the first search", async () => {
    await project();
    await withSearch(async (search) => {
      expect(paths(await search(dir, "later"))).not.toContain("file:src/later.ts");
      await write("src/later.ts");
      await vi.waitFor(async () => expect(paths(await search(dir, "later"))).toContain("file:src/later.ts"), { timeout: 5_000, interval: 100 });
    });
  });

  it("refuses what is not a directory", async () => {
    await project();
    await withSearch(async (search) => {
      for (const target of [path.join(dir, "missing"), path.join(dir, "README.md"), "relative/path"]) {
        const result = await search(target, "");
        expect(Either.isLeft(result) && result.left.reason).toBe("NotFound");
      }
    });
  });
});

/** A finder over a fixed list, counting opens and closes. */
const fakeEngine = (options: { fail?: boolean; delay?: number } = {}) => {
  const opened: string[] = [];
  const destroyed: string[] = [];
  const open: OpenFinder = async (root) => {
    opened.push(root);
    if (options.delay !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delay));
    if (options.fail === true) throw new Error("native library not found");
    const page = { items: [{ relativePath: "a.ts" }], totalMatched: 1 };
    const finder: Finder = {
      fileSearch: () => ({ ok: true, value: page }),
      directorySearch: () => ({ ok: true, value: { items: [], totalMatched: 0 } }),
      mixedSearch: () => ({ ok: true, value: { items: [{ type: "file", item: { relativePath: "a.ts" } }], totalMatched: 1 } }),
      isScanning: () => false,
      waitForScan: async () => ({ ok: true, value: true }),
      getScanProgress: () => ({ ok: true, value: { scannedFilesCount: 1 } }),
      destroy: () => destroyed.push(root),
    };
    return finder;
  };
  return { open, opened, destroyed };
};

describe("indexes", () => {
  it("opens one per directory, shared by searches that arrive while it opens", async () => {
    const engine = fakeEngine();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { service } = yield* makeFileSearch({ idleMs: 60_000, open: engine.open });
          yield* Effect.all([service.search(dir, "a"), service.search(dir, "b"), service.search(`${dir}/`, "c")], { concurrency: "unbounded" });
        }),
      ),
    );
    expect(engine.opened).toEqual([dir]);
    expect(engine.destroyed).toEqual([dir]);
  });

  it("reports an engine that cannot open as unavailable, and tries again on the next search", async () => {
    const engine = fakeEngine({ fail: true });
    const failures = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { service } = yield* makeFileSearch({ idleMs: 60_000, open: engine.open });
          return yield* Effect.all([Effect.flip(service.search(dir, "a")), Effect.flip(service.search(dir, "a"))]);
        }),
      ),
    );
    expect(failures.map((failure) => failure.reason)).toEqual(["Unavailable", "Unavailable"]);
    expect(failures[0]!.message).toContain("native library not found");
    expect(engine.opened).toEqual([dir, dir]);
  });

  it("keeps an index open while a search uses it, however short `idleMs` is", async () => {
    const engine = fakeEngine({ delay: 80 });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { service } = yield* makeFileSearch({ idleMs: 5, open: engine.open });
          expect((yield* service.search(dir, "a")).entries).toEqual([{ path: "a.ts", kind: "file" }]);
          yield* Effect.promise(() => vi.waitFor(() => expect(engine.destroyed).toEqual([dir]), { timeout: 2_000, interval: 5 }));
        }),
      ),
    );
  });

  it("closes an index nobody searched for `idleMs`", async () => {
    const engine = fakeEngine();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { service, snapshot } = yield* makeFileSearch({ idleMs: 30, open: engine.open });
          yield* service.search(dir, "a");
          expect((yield* snapshot).map((index) => index.root)).toEqual([dir]);
          yield* Effect.promise(() => vi.waitFor(() => expect(engine.destroyed).toEqual([dir]), { timeout: 2_000, interval: 10 }));
          expect(yield* snapshot).toEqual([]);
          yield* service.search(dir, "a");
        }),
      ),
    );
    expect(engine.opened).toEqual([dir, dir]);
  });
});

describe("plugin", () => {
  it("answers FileSearchers with its default config, and leaves it when it stops", async () => {
    await project();
    const [found, after] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const loader = yield* makeLoader({ source: { resolve: () => Effect.succeed(fileSearch) }, composition: { plugins: { "file-search": {} } } });
          const found = yield* loader.core.run(Effect.flatMap(Registries, (registries) => searchFiles(registries, dir, "app", { kind: "file" })));
          yield* loader.apply({ plugins: { "file-search": { enabled: false } } });
          const after = yield* loader.core.run(Effect.flatMap(Registries, (registries) => Effect.flip(searchFiles(registries, dir, "app"))));
          return [found, after] as const;
        }),
      ),
    );
    expect(found.entries[0]).toEqual({ path: "src/app.ts", kind: "file" });
    expect(after.reason).toBe("Unavailable");
  });
});
