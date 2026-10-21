import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vitest";
import { makeSpanCollector } from "@lemma/core";
import { attribute, ownerOfFile } from "../src/stall-owners.ts";
import { recordStall } from "../src/stall.ts";

const run = promisify(execFile);
const script = fileURLToPath(new URL("./fixtures/stall/run.ts", import.meta.url));
/** Runs the fixture in a process of its own: the watchdog reads the process's main thread, which a test runner's may not be. */
const blocking = async (ms: number, how: "busy" | "native" | "linked" = "busy") => {
  const { stdout, stderr } = await run(process.execPath, ["--conditions=lemma-source", script, String(ms), how], { timeout: 20_000 });
  return { stall: JSON.parse(stdout.trim().split("\n").at(-1)!), stderr };
};

describe("watchStalls", () => {
  test("names the plugin whose handler blocks the event loop, while it is blocked and once it runs again", async () => {
    const { stall, stderr } = await blocking(1_500);
    expect(stall).toMatchObject({ pluginId: "test.busy" });
    expect(stall.share).toBeGreaterThan(0.5);
    expect(stall.ms).toBeGreaterThanOrEqual(1_400);
    // Said at once, then again once whose code it is is known.
    expect(stderr).toMatch(/^lemma: the event loop has been blocked for 1\.\d s$/m);
    expect(stderr).toMatch(/lemma: the event loop has been blocked for \d+\.\d s, running test\.busy's code \(\d+% of its stacks\)/);
  }, 30_000);

  test("names a plugin whose code it knows by a path through a symlink", async () => {
    const { stall } = await blocking(1_500, "linked");
    expect(stall).toMatchObject({ pluginId: "test.busy" });
  }, 30_000);

  test("says a loop blocked outside JavaScript is blocked while it is, though no stack can be read then", async () => {
    const { stall, stderr } = await blocking(1_500, "native");
    expect(stall.ms).toBeGreaterThanOrEqual(1_400);
    expect(stderr).toMatch(/^lemma: the event loop has been blocked for 1\.\d s$/m);
  }, 30_000);

  test("hears nothing of a loop blocked for less than the threshold", async () => {
    const { stall, stderr } = await blocking(300);
    expect(stall).toBe("no stall heard");
    expect(stderr).toBe("");
  }, 30_000);

  test("loads nothing into its worker but Node's own and the attribution: Effect there would cost the host about 35 MB", async () => {
    const imports = async (file: string) =>
      [...(await readFile(new URL(`../src/${file}`, import.meta.url), "utf8")).matchAll(/^import (?!type )[^;]*? from "([^"]+)";$/gm)].map((found) => found[1]);
    expect(await imports("stall-worker.ts")).toEqual(["node:fs", "node:worker_threads", "./stall-owners.ts"]);
    expect(await imports("stall-owners.ts")).toEqual(["node:path", "node:url"]);
  });
});

describe("recordStall", () => {
  test("keeps a stall in the trace as a host.stall span over its time, under the plugin whose code it was", () => {
    const spans = makeSpanCollector();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      recordStall(spans.tracer, { start: 1_000, ms: 1_500, pluginId: "test.busy", share: 0.8 });
      recordStall(spans.tracer, { start: 5_000, ms: 1_200 });
      expect(logged.mock.calls.map(([line]) => line)).toEqual([
        "lemma: the event loop was blocked for 1.5 s, running test.busy's code",
        "lemma: the event loop was blocked for 1.2 s",
      ]);
    } finally {
      logged.mockRestore();
    }
    expect(spans.spans().map(({ name, start, ms, status, attributes }) => ({ name, start, ms, status, attributes }))).toEqual([
      { name: "host.stall", start: 1_000, ms: 1_500, status: "ok", attributes: { "stall.ms": 1_500, "plugin.id": "test.busy", "stall.share": 0.8 } },
      { name: "host.stall", start: 5_000, ms: 1_200, status: "ok", attributes: { "stall.ms": 1_200 } },
    ]);
  });
});

describe("attribute", () => {
  const owners = [
    { path: "/plugins/notes", id: "notes" },
    { path: "/plugins/notes/vendor/inner.js", id: "inner" },
    { path: "/repo/domains/agent/loop", id: "agent.loop" },
  ];

  test("a file belongs to the deepest owner holding it, a file owner included", () => {
    expect(ownerOfFile(owners, "/plugins/notes/index.ts")).toBe("notes");
    expect(ownerOfFile(owners, "/plugins/notes/vendor/inner.js")).toBe("inner");
    expect(ownerOfFile(owners, "/plugins/notes-other/index.ts")).toBeUndefined();
    expect(ownerOfFile(owners, "/repo/packages/core/src/hooks.ts")).toBeUndefined();
  });

  test("gives each stack to its innermost plugin frame, through the kernel's and Effect's", () => {
    const turn = [
      "file:///repo/node_modules/effect/dist/Effect.js",
      "file:///repo/packages/core/src/internal/hooks.ts",
      "file:///repo/domains/agent/loop/src/turn.ts",
      "file:///repo/packages/host/src/main.ts",
    ];
    const notes = ["file:///plugins/notes/index.ts?v=123", "file:///repo/domains/agent/loop/src/turn.ts"];
    const nobody = ["node:internal/timers", ""];
    // A CommonJS script is named by its path.
    const required = ["/repo/packages/core/src/hooks.js", "/plugins/notes/vendor/inner.js"];
    expect(attribute([turn, turn, notes, nobody], owners)).toEqual({ pluginId: "agent.loop", share: 2 / 4 });
    expect(attribute([required], owners)).toEqual({ pluginId: "inner", share: 1 });
    expect(attribute([nobody, nobody], owners)).toEqual({});
    expect(attribute([], owners)).toEqual({});
  });
});
