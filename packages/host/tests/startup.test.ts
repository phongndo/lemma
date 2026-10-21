import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const run = promisify(execFile);
const host = fileURLToPath(new URL("..", import.meta.url));
const bundled = new URL("../src/bundled.ts", import.meta.url).href;
const launch = new URL("../src/launch.mjs", import.meta.url).href;

/**
 * What the host loads as it starts is what the bundled plugins import at their top level: each module is compiled,
 * and its source kept, by every host. These load on first use instead, by the plugins named; at the top level, each
 * would add from a few megabytes (zod, the MCP SDK) to 70 (Playwright) to every host's memory.
 */
const LAZY = ["playwright-core", "@modelcontextprotocol/client", "zod", "typebox", "@redis/client", "quickjs-wasi", "@ff-labs/fff-node"];
/** Modules the bundled plugins load, at most: ~750 now. An index imported instead of its module adds hundreds. */
const MAX_MODULES = 900;
/** How many fewer modules a start loads with Effect's bundle, at least: ~300 now, its start's modules in one chunk. */
const FEWER_BUNDLED = 200;

/** A bundle of Effect built for these tests, as `pnpm build` builds the host's. */
let cache: string;
beforeAll(async () => {
  cache = await mkdtemp(join(tmpdir(), "lemma-startup-effect-"));
  await run(process.execPath, ["--conditions=lemma-source", join(host, "scripts/bundle-effect.ts"), cache], { cwd: host, timeout: 60_000 });
}, 90_000);
afterAll(() => rm(cache, { recursive: true, force: true }));

/** The URLs of the modules importing the bundled plugins loads, in a process of its own: Node's loader, not the test runner's. */
const loads = async (effectBundle?: string): Promise<string[]> => {
  const script = `
    import { registerHooks } from "node:module";
    const loaded = [];
    registerHooks({ load: (url, context, next) => (loaded.push(url), next(url, context)) });
    ${effectBundle === undefined ? "" : `if (!(await import(${JSON.stringify(launch)})).useEffectBundle(${JSON.stringify(effectBundle)})) throw new Error("no bundle");`}
    await import(${JSON.stringify(bundled)});
    console.log(JSON.stringify(loaded));
  `;
  const { stdout } = await run(process.execPath, ["--conditions=lemma-source", "--input-type=module", "--eval", script], { timeout: 60_000 });
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as string[];
};

/** The package a module URL is in: the last `node_modules/<name>` or `node_modules/@scope/<name>` in it. */
const packageOf = (url: string): string | undefined => [...url.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].at(-1)?.[1];

describe("the host's start", () => {
  test("leaves what plugins load on demand unloaded, and loads few modules, the fewer with Effect's bundle", async () => {
    const [urls, withBundle] = await Promise.all([loads(), loads(cache)]);
    for (const loaded of [urls, withBundle]) {
      const packages = new Set(loaded.map(packageOf));
      expect(LAZY.filter((name) => packages.has(name))).toEqual([]);
      expect(loaded.length).toBeLessThan(MAX_MODULES);
    }
    expect(withBundle.length).toBeLessThan(urls.length - FEWER_BUNDLED);
  }, 60_000);
});
