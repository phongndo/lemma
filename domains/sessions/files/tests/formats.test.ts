import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCore } from "@lemma/core";
import { pathsPlugin } from "@lemma/contracts/testing";
import { Sessions } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";
import { projectionOf } from "@lemma/testing";
import type { Projection } from "@lemma/testing";
import sessions from "../src/index.ts";
import { FORMAT_VERSION } from "../src/format.ts";

/**
 * The format's fixture corpus: session files each format version wrote, frozen (`pnpm sim --fixtures`), and how every
 * reader projected them when they were written. A change that reads an old session differently, or not at all, fails
 * here. A new version adds a directory; none is ever regenerated (see the README's "Format versions").
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-formats-"));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

/** Every session file of a version's corpus, by its path under `sessions/`. */
async function corpus(version: string): Promise<string[]> {
  const root = path.join(fixtures, version);
  const files: string[] = [];
  for (const project of await fs.readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const name of await fs.readdir(path.join(root, project.name))) if (name.endsWith(".jsonl")) files.push(`${project.name}/${name}`);
  }
  return files.sort();
}

const versions = async () => (await fs.readdir(fixtures, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

describe("session format corpus", () => {
  it("has a corpus for the version the store writes", async () => {
    expect(await versions()).toContain(`v${FORMAT_VERSION}`);
  });

  it("reads every session of every version as it read them when they were written", async () => {
    for (const version of await versions()) {
      const files = await corpus(version);
      expect(files.length).toBeGreaterThan(0);
      const expected = JSON.parse(await fs.readFile(path.join(fixtures, version, "projections.json"), "utf8")) as Record<string, Projection>;
      expect(Object.keys(expected).sort()).toEqual(files);
      const versionHome = path.join(home, version);
      for (const file of files) {
        const target = path.join(versionHome, "sessions", file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(fixtures, version, file), target);
      }
      const read = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const core = yield* makeCore([pathsPlugin(versionHome, { cwd: "/fixtures" }), sessions]);
            return yield* core.run(
              Effect.gen(function* () {
                const store = yield* Sessions;
                const out = new Map<string, readonly SessionEvent[]>();
                const listed = new Set((yield* store.list()).map((info) => info.id));
                for (const file of files) {
                  const id = /_([A-Za-z0-9_-]+)\.jsonl$/.exec(file)![1]!;
                  expect(listed.has(id), `${version}/${file} is listed`).toBe(true);
                  out.set(file, yield* store.events(id));
                }
                return out;
              }),
            );
          }),
        ),
      );
      for (const file of files) expect(projectionOf(read.get(file)!), `${version}/${file}`).toEqual(expected[file]);
    }
  });
});
