import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCore } from "@lemma/core";
import { ToolInvocation, ToolRunner } from "@lemma/tools";
import { textOf } from "@lemma/tools/testing";
import registry from "@lemma/tools-registry";
import isolated, { makeIsolated } from "../isolated.ts";
import { startIsolate } from "../isolate.ts";

let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lemma-isolated-")));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A tools module in the test's directory, of `tools` given as source. */
const toolsModule = async (name: string, tools: string): Promise<URL> => {
  const file = path.join(dir, name);
  await fs.writeFile(file, `export default [${tools}];\n`);
  return pathToFileURL(file);
};
const tool = (name: string, execute: string) =>
  `{ name: "${name}", description: "${name}", parameters: { type: "object", properties: {} }, execute: ${execute} }`;

describe("as a plugin", () => {
  it("offers the module's tools with their JSON Schemas, and runs them in the worker", async () => {
    const [text, declared] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([registry, isolated]);
          return yield* core.run(
            Effect.gen(function* () {
              const runner = yield* ToolRunner;
              const done = yield* runner.execute(
                new ToolInvocation({ sessionId: "s", toolCallId: "c", name: "word_frequency", input: { text: "a b a c a b", top: 2 }, cwd: "/" }),
                new AbortController().signal,
              );
              return [textOf(done), yield* runner.list] as const;
            }),
          );
        }),
      ),
    );
    expect(text).toBe("a 3\nb 2");
    // The model is told of it as the module describes it.
    expect(declared.find((tool) => tool.spec.name === "word_frequency")).toMatchObject({
      source: "isolated",
      spec: { parameters: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
    });
  });
});

describe("the worker", () => {
  it("is stopped when a call does not answer in time, while the host's loop keeps running, and started again for the next", async () => {
    const isolate = startIsolate(await toolsModule("spin.mjs", [tool("spin", "() => { for (;;) {} }"), tool("echo", "() => 'still here'")].join(",")), {
      timeoutMs: 300,
      memoryMb: 64,
    });
    try {
      let ticks = 0;
      const ticking = setInterval(() => ticks++, 20);
      await expect(isolate.call("spin", {})).rejects.toThrow("No answer in 300 ms: the tools' worker was stopped");
      clearInterval(ticking);
      // The host's own timers ran all along: the loop was the worker's.
      expect(ticks).toBeGreaterThanOrEqual(5);
      expect(await isolate.call("echo", {})).toBe("still here");
      expect(isolate.started()).toBe(2);
    } finally {
      await isolate.close();
    }
  });

  it("is stopped when its call is cancelled", async () => {
    const isolate = startIsolate(await toolsModule("spin.mjs", tool("spin", "() => { for (;;) {} }")), { timeoutMs: 60_000, memoryMb: 64 });
    try {
      const cancel = new AbortController();
      const call = isolate.call("spin", {}, cancel.signal);
      setTimeout(() => cancel.abort(), 100);
      await expect(call).rejects.toThrow("Cancelled: the tools' worker was stopped");
    } finally {
      await isolate.close();
    }
  });

  it("stops at its memory limit, and the host does not", async () => {
    const hog = tool("hog", "() => { const kept = []; for (;;) kept.push(new Array(1e6).fill(Math.random())); }");
    const isolate = startIsolate(await toolsModule("hog.mjs", hog), { timeoutMs: 60_000, memoryMb: 32 });
    try {
      await expect(isolate.call("hog", {})).rejects.toThrow();
    } finally {
      await isolate.close();
    }
  });

  it("loads the module afresh once closed and started again, where the host's import would keep the first", async () => {
    const module = await toolsModule("version.mjs", tool("version", "() => 'first'"));
    const first = startIsolate(module, { timeoutMs: 5_000, memoryMb: 64 });
    expect(await first.call("version", {})).toBe("first");
    await first.close();
    await fs.writeFile(new URL(module), `export default [${tool("version", "() => 'second'")}];\n`);
    const second = startIsolate(module, { timeoutMs: 5_000, memoryMb: 64 });
    try {
      expect(await second.call("version", {})).toBe("second");
      // In the host, the same address is the module imported first, for as long as the process runs.
      const imported = (await import(module.href)) as { default: { execute: () => string }[] };
      await fs.writeFile(new URL(module), `export default [${tool("version", "() => 'third'")}];\n`);
      expect(((await import(module.href)) as typeof imported).default[0]!.execute()).toBe(imported.default[0]!.execute());
    } finally {
      await second.close();
    }
  });

  it("is a plugin per module: two run apart", async () => {
    const one = makeIsolated(await toolsModule("one.mjs", tool("one", "() => 'one'")), "one");
    const two = makeIsolated(await toolsModule("two.mjs", tool("two", "() => 'two'")), "two");
    const texts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([registry, one, two]);
          return yield* core.run(
            Effect.gen(function* () {
              const runner = yield* ToolRunner;
              const run = (name: string) =>
                Effect.map(
                  runner.execute(new ToolInvocation({ sessionId: "s", toolCallId: name, name, input: {}, cwd: "/" }), new AbortController().signal),
                  textOf,
                );
              return [yield* run("one"), yield* run("two")];
            }),
          );
        }),
      ),
    );
    expect(texts).toEqual(["one", "two"]);
  });
});
