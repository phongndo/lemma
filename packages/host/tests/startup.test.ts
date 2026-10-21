import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const run = promisify(execFile);
const bundled = new URL("../src/bundled.ts", import.meta.url).href;

/**
 * What the host loads as it starts is what the bundled plugins import at their top level: each module is compiled,
 * and its source kept, by every host. These load on first use instead, by the plugins named; at the top level, each
 * would add from a few megabytes (zod, the MCP SDK) to 70 (Playwright) to every host's memory.
 */
const LAZY = ["playwright-core", "@modelcontextprotocol/client", "zod", "typebox", "@redis/client", "quickjs-wasi", "@ff-labs/fff-node"];
/** Modules the bundled plugins load, at most: ~750 now. An index imported instead of its module adds hundreds. */
const MAX_MODULES = 900;

/** The URLs of the modules importing the bundled plugins loads, in a process of its own: Node's loader, not the test runner's. */
const loads = async (): Promise<string[]> => {
  const script = `
    import { registerHooks } from "node:module";
    const loaded = [];
    registerHooks({ load: (url, context, next) => (loaded.push(url), next(url, context)) });
    await import(${JSON.stringify(bundled)});
    console.log(JSON.stringify(loaded));
  `;
  const { stdout } = await run(process.execPath, ["--conditions=lemma-source", "--input-type=module", "--eval", script], { timeout: 60_000 });
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as string[];
};

/** The package a module URL is in: the last `node_modules/<name>` or `node_modules/@scope/<name>` in it. */
const packageOf = (url: string): string | undefined => [...url.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].at(-1)?.[1];

describe("the host's start", () => {
  test("leaves what plugins load on demand unloaded, and loads few modules", async () => {
    const urls = await loads();
    const packages = new Set(urls.map(packageOf));
    expect(LAZY.filter((name) => packages.has(name))).toEqual([]);
    expect(urls.length).toBeLessThan(MAX_MODULES);
  }, 60_000);
});
