import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { projectPluginsDir } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";
import { listWebFiles, userPluginsDir } from "../src/web.ts";

describe("listWebFiles", () => {
  test("lists web halves and stylesheets, a package's too, user files first, and a project's only when trusted", async () => {
    const root = await mkdtemp(join(tmpdir(), "lemma-ui-"));
    try {
      const paths = resolvePaths({ env: { LEMMA_HOME: join(root, "home") }, cwd: join(root, "project") });
      const user = userPluginsDir(paths);
      await mkdir(join(user, "ticker"), { recursive: true });
      await mkdir(projectPluginsDir(paths), { recursive: true });
      await writeFile(join(user, "theme.css"), "");
      await writeFile(join(user, "composer.web.js"), "");
      // A host half, and what is no half at all, are not the web app's.
      await writeFile(join(user, "approvals.ts"), "");
      await writeFile(join(user, "notes.txt"), "");
      await mkdir(join(user, "lib.web.js"));
      await writeFile(
        join(user, "ticker", "package.json"),
        JSON.stringify({ lemma: { host: "./ticker.ts", web: "./web.js", styles: ["./ticker.css", "../theme.css", "./absent.css"] } }),
      );
      await writeFile(join(user, "ticker", "web.js"), "");
      await writeFile(join(user, "ticker", "ticker.css"), "");
      // A folder with no manifest is no plugin.
      await mkdir(join(user, "scratch"));
      await writeFile(join(user, "scratch", "web.js"), "");
      await writeFile(join(projectPluginsDir(paths), "panel.web.mjs"), "");

      const untrusted = await Effect.runPromise(listWebFiles(paths, false));
      expect(untrusted.map((file) => [file.source, file.name, file.kind])).toEqual([
        ["user", "composer.web.js", "script"],
        ["user", "theme.css", "style"],
        ["user", "ticker/web.js", "script"],
        ["user", "ticker/ticker.css", "style"],
      ]);
      expect(untrusted[0]!.path).toBe(join(user, "composer.web.js"));
      // A file's version is its mtime; a package's, the files its web half may import, so a module it imports is versioned with it.
      expect(untrusted[0]!.url).toMatch(/^\/api\/web\/user@\d+\/composer\.web\.js$/);
      expect(untrusted[2]!.url).toMatch(/^\/api\/web\/user@[0-9a-f]{12}\/ticker\/web\.js$/);
      expect(untrusted[3]!.url.split("/")[3]).toBe(untrusted[2]!.url.split("/")[3]);

      const trusted = await Effect.runPromise(listWebFiles(paths, true));
      expect(trusted.map((file) => `${file.source}/${file.name}`).slice(-1)).toEqual(["project/panel.web.mjs"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("lists a web half written in TypeScript, and a package's version changes with any module of it, not its data", async () => {
    const root = await mkdtemp(join(tmpdir(), "lemma-ui-"));
    try {
      const paths = resolvePaths({ env: { LEMMA_HOME: join(root, "home") }, cwd: join(root, "project") });
      const user = userPluginsDir(paths);
      await mkdir(join(user, "board"), { recursive: true });
      await writeFile(join(user, "notes.web.ts"), "");
      await writeFile(join(user, "board", "package.json"), JSON.stringify({ lemma: { web: "./web.ts" } }));
      await writeFile(join(user, "board", "web.ts"), "");
      await writeFile(join(user, "board", "model.ts"), "");
      await writeFile(join(user, "board", "data.json"), "[]");
      const before = await Effect.runPromise(listWebFiles(paths, false));
      expect(before.map((file) => [file.name, file.kind, file.plugin])).toEqual([
        ["board/web.ts", "script", "board"],
        ["notes.web.ts", "script", "notes"],
      ]);
      // Edited later than it was: a new mtime, whatever the clock's resolution. Data the web half cannot import is not read for it.
      await utimes(join(user, "board", "data.json"), new Date(), new Date(Date.now() + 5_000));
      expect((await Effect.runPromise(listWebFiles(paths, false)))[0]!.url).toBe(before[0]!.url);
      await writeFile(join(user, "board", "model.ts"), "export const x = 1;");
      await utimes(join(user, "board", "model.ts"), new Date(), new Date(Date.now() + 5_000));
      const after = await Effect.runPromise(listWebFiles(paths, false));
      expect(after[0]!.url).not.toBe(before[0]!.url);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a missing directory lists nothing", async () => {
    const paths = resolvePaths({ env: { LEMMA_HOME: join(tmpdir(), "lemma-absent-home") }, cwd: join(tmpdir(), "lemma-absent-project") });
    expect(await Effect.runPromise(listWebFiles(paths, true))).toEqual([]);
  });
});
