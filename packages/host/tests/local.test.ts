import { describe, expect, test } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      expect((await load()).made).not.toBe(first.made);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
