import { execFile } from "node:child_process";
import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Effect } from "effect";
import type { Plugin } from "@lemma/core";
import { loadLocalPlugins } from "../src/local.ts";

/** A plugin as the loader checks it: an id and a layer function (no kernel needed to load one). */
const fake = (id: string) => ({ id, layer: () => undefined }) as unknown as Plugin;

describe("loadLocalPlugins", () => {
  test("a file's plugins keep their identity across loads until the file changes, a function export included", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lemma-local-"));
    try {
      await writeFile(join(dir, "plain.js"), `export default { id: "plain", layer: () => undefined };\n`);
      await writeFile(join(dir, "made.js"), `export default ({ bundled }) => ({ ...bundled.base, id: "made" });\n`);
      // A whole second, so the file's time can be put back exactly.
      const written = new Date(Math.floor(Date.now() / 1000) * 1000);
      await utimes(join(dir, "made.js"), written, written);
      const context = { bundled: { base: fake("base") } };
      const load = async () => {
        const loaded = await Effect.runPromise(loadLocalPlugins([dir], context));
        expect(loaded.diagnostics).toEqual([]);
        return Object.fromEntries(loaded.plugins.map(({ plugin }) => [plugin.id, plugin]));
      };
      const first = await load();
      const second = await load();
      // The same definitions, so a reload leaves them running instead of restarting them.
      expect(second.plain).toBe(first.plain);
      expect(second.made).toBe(first.made);
      expect(first.made?.layer).toBe(context.bundled.base.layer);
      // An edited file is a new module, and its plugins new definitions.
      await utimes(join(dir, "made.js"), new Date(), new Date(Date.now() + 5_000));
      const edited = (await load()).made;
      expect(edited).not.toBe(first.made);
      // Put back to the version before (as a refused reload leaves running), it finds the definitions it made then.
      await utimes(join(dir, "made.js"), written, written);
      expect((await load()).made).toBe(first.made);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // In Node itself, as the host runs: Vitest's own module runner takes `import()` past Node's resolve hooks.
  test("a folder plugin loads again when any of its files changes, its own imports with it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lemma-local-"));
    try {
      const folder = join(dir, "plugins", "ticker");
      await mkdir(join(folder, "src"), { recursive: true });
      await writeFile(join(folder, "package.json"), JSON.stringify({ lemma: { host: "./plugin.js" } }));
      await writeFile(join(folder, "plugin.js"), `import { name } from "./src/name.js";\nexport default { id: name, layer: () => undefined };\n`);
      await writeFile(join(folder, "src", "name.js"), `export const name = "first";\n`);
      const script = join(dir, "load.ts");
      await writeFile(
        script,
        [
          `import { utimes, writeFile } from "node:fs/promises";`,
          `import { Effect } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("effect")).href)};`,
          `import { loadLocalPlugins } from ${JSON.stringify(fileURLToPath(new URL("../src/local.ts", import.meta.url)))};`,
          `const load = async () => (await Effect.runPromise(loadLocalPlugins([${JSON.stringify(join(dir, "plugins"))}], { bundled: {} }))).plugins.map(({ plugin }) => plugin);`,
          `const [first] = await load();`,
          `const [again] = await load();`,
          `const named = ${JSON.stringify(join(folder, "src", "name.js"))};`,
          `await writeFile(named, 'export const name = "second";\\n');`,
          `await utimes(named, new Date(), new Date(Date.now() + 5_000));`,
          `const [edited] = await load();`,
          `console.log(JSON.stringify({ first: first?.id, same: again === first, edited: edited?.id }));`,
        ].join("\n"),
      );
      const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=lemma-source", script], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
      });
      // Only the file it imports changed: the plugin is loaded again, and reads the new one.
      expect(JSON.parse(stdout)).toEqual({ first: "first", same: true, edited: "second" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("says what a folder plugin's manifest names that is left out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lemma-local-"));
    try {
      const folder = join(dir, "notes");
      await mkdir(folder);
      await writeFile(join(folder, "package.json"), JSON.stringify({ lemma: { host: "../elsewhere.js", web: "./wbe.js", styles: ["./notes.css"] } }));
      const loaded = await Effect.runPromise(loadLocalPlugins([dir], { bundled: {} }));
      expect(loaded.plugins).toEqual([]);
      expect(loaded.diagnostics.map((diagnostic) => [diagnostic.severity, diagnostic.pluginId, diagnostic.message])).toEqual([
        ["warning", "notes", `${folder}/package.json: "lemma.host" names ../elsewhere.js, outside the package; it is left out`],
        ["warning", "notes", `${folder}/package.json: "lemma.web" names ./wbe.js, which is missing; it is left out`],
        ["warning", "notes", `${folder}/package.json: "lemma.styles" names ./notes.css, which is missing; it is left out`],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
