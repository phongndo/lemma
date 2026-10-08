import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { resolvePaths } from "../src/paths.ts";
import { listUiFiles, projectUiDir, userUiDir } from "../src/ui.ts";

describe("listUiFiles", () => {
  test("lists scripts and stylesheets, user files first, and a project's only when trusted", async () => {
    const root = await mkdtemp(join(tmpdir(), "lemma-ui-"));
    try {
      const paths = resolvePaths({ env: { LEMMA_HOME: join(root, "home") }, cwd: join(root, "project") });
      await mkdir(userUiDir(paths), { recursive: true });
      await mkdir(projectUiDir(paths), { recursive: true });
      await writeFile(join(userUiDir(paths), "theme.css"), "");
      await writeFile(join(userUiDir(paths), "composer.js"), "");
      await writeFile(join(userUiDir(paths), "notes.txt"), "");
      await mkdir(join(userUiDir(paths), "lib.js"));
      await writeFile(join(projectUiDir(paths), "panel.mjs"), "");

      const untrusted = await Effect.runPromise(listUiFiles(paths, false));
      expect(untrusted.map((file) => [file.source, file.name, file.kind])).toEqual([
        ["user", "composer.js", "script"],
        ["user", "theme.css", "style"],
      ]);
      expect(untrusted[0]!.path).toBe(join(userUiDir(paths), "composer.js"));
      expect(untrusted[0]!.url).toMatch(/^\/api\/ui\/user\/composer\.js\?v=\d+$/);

      const trusted = await Effect.runPromise(listUiFiles(paths, true));
      expect(trusted.map((file) => `${file.source}/${file.name}`)).toEqual(["user/composer.js", "user/theme.css", "project/panel.mjs"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a missing directory lists nothing", async () => {
    const paths = resolvePaths({ env: { LEMMA_HOME: join(tmpdir(), "lemma-absent-home") }, cwd: join(tmpdir(), "lemma-absent-project") });
    expect(await Effect.runPromise(listUiFiles(paths, true))).toEqual([]);
  });
});
