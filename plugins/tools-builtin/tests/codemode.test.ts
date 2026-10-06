import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect, Fiber, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Events, definePlugin, makeCore } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { InteractionOrigin, ToolInvocation, ToolOutput, ToolResult, Tools } from "@lemma/contracts";
import tools from "../../tools/src/index.ts";
import builtin from "../src/index.ts";
import { tempDir, textOf } from "./support.ts";

const run = (code: string, cwd = process.cwd(), extra: readonly Plugin[] = [], signal = new AbortController().signal) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([tools, ...builtin, ...extra]);
        return yield* core.run(
          Effect.flatMap(Tools, (registry) =>
            registry.execute(new ToolInvocation({ sessionId: "s", toolCallId: "c", name: "codemode", input: { code }, cwd }), signal),
          ),
        );
      }),
    ),
  );

/** One codemode call, with what the agent passes: the request's tools, an origin, and the registry's config. */
const call = (
  code: string,
  options: {
    readonly offered?: readonly string[];
    readonly update?: (chunk: string) => void;
    readonly origin?: string;
    readonly extra?: readonly Plugin[];
    readonly maxResultChars?: number;
    readonly published?: unknown[];
  } = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([tools, ...builtin, ...(options.extra ?? [])], {
          configs: options.maxResultChars === undefined ? {} : { tools: { maxResultChars: options.maxResultChars } },
        });
        return yield* core.run(
          Effect.gen(function* () {
            const events = yield* Events;
            const watching = yield* Effect.forkChild(
              Stream.runForEach(events.stream(ToolOutput), (payload) => Effect.sync(() => options.published?.push(payload))),
            );
            yield* Effect.yieldNow;
            const registry = yield* Tools;
            const invocation = new ToolInvocation({
              sessionId: "s",
              toolCallId: "c",
              name: "codemode",
              input: { code },
              cwd: process.cwd(),
              ...(options.offered === undefined ? {} : { offered: options.offered }),
            });
            const result = yield* Effect.provideService(
              registry.execute(invocation, new AbortController().signal, options.update === undefined ? undefined : { update: options.update }),
              InteractionOrigin,
              options.origin,
            );
            yield* Effect.sleep("100 millis");
            yield* Fiber.interrupt(watching);
            return result;
          }),
        );
      }),
    ),
  );

describe("pi codemode", () => {
  it("composes the coding tools in the session cwd and returns only selected output", async () => {
    const cwd = await tempDir();
    try {
      const result = await run(
        `
        await tools.write({path: "hello.txt", content: "hello"});
        await tools.edit({path: "hello.txt", edits: [{oldText: "hello", newText: "world"}]});
        const [file, shell] = await Promise.all([
          tools.read({path: "hello.txt"}), tools.bash({command: "printf shell"})
        ]);
        text(file);
        return shell;
      `,
        cwd,
      );
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain("world\nshell");
      expect(await fs.readFile(path.join(cwd, "hello.txt"), "utf8")).toBe("world");
      expect(result.details).toMatchObject({
        calls: [
          { name: "write", status: "ok" },
          { name: "edit", status: "ok" },
          { name: "read", status: "ok" },
          { name: "bash", status: "ok" },
        ],
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("discovers declarations, excludes itself, and has no ambient host access", async () => {
    const result = await run(`
      text(ALL_TOOLS.find(t => t.name === "read").description);
      return [typeof process, typeof require, typeof fetch, "codemode" in tools];
    `);
    expect(textOf(result)).toContain("path: string");
    expect(textOf(result)).toContain('["undefined","undefined","undefined",false]');
  });

  it("validates nested input and applies guards instead of bypassing the registry", async () => {
    const guard = definePlugin({
      id: "test-guard",
      requires: [Tools],
      layer: Layer.effectDiscard(
        Effect.flatMap(Tools, (registry) =>
          registry.guard("bash", (call) => Effect.succeed(call.name === "bash" ? { _tag: "deny", reason: "shell denied" } : { _tag: "allow" })),
        ),
      ),
    });
    const result = await run(
      `
      for (const call of [() => tools.read({}), () => tools.bash({command: "echo forbidden"})]) {
        try { await call(); text("unexpected success"); } catch (e) { text(e.message); }
      }
    `,
      process.cwd(),
      [guard],
    );
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("shell denied");
    expect(textOf(result)).toContain("path");
    expect(textOf(result)).not.toContain("unexpected success");
  });

  it("returns script errors with earlier output", async () => {
    const result = await run('text("before"); throw new Error("broken script")');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("before");
    expect(textOf(result)).toContain("broken script");
  });

  it("cancels nested calls when the outer call is aborted", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const slow = definePlugin({
      id: "slow",
      requires: [Tools],
      layer: Layer.effectDiscard(
        Effect.flatMap(Tools, (registry) =>
          registry.register({
            name: "slow",
            description: "wait",
            input: Schema.Struct({}),
            execute: async (_, { signal }) =>
              new Promise<ToolResult>((resolve) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    cancelled = true;
                    resolve(new ToolResult({ content: [] }));
                  },
                  { once: true },
                );
                controller.abort();
              }),
          }),
        ),
      ),
    });
    await expect(run("await tools.slow({})", process.cwd(), [slow], controller.signal)).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
  it("reaches only the tools the request offered", async () => {
    const result = await call(`text(ALL_TOOLS.map((t) => t.name)); await tools.bash({ command: "echo unoffered" });`, { offered: ["codemode", "read"] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('["read"]');
    expect(textOf(result)).toContain("tools.bash does not exist");
  });

  it("shows nested output as its own, never under nested ids", async () => {
    const received: string[] = [];
    const published: unknown[] = [];
    const result = await call(`await tools.bash({ command: "printf nested-out" }); return "ok";`, { update: (chunk) => received.push(chunk), published });
    expect(result.isError).not.toBe(true);
    expect(received.join("")).toContain("nested-out");
    expect(published).toEqual([]);
  });

  it("runs nested calls in the turn's context, so their interaction requests keep its origin", async () => {
    const origin = definePlugin({
      id: "origin",
      requires: [Tools],
      layer: Layer.effectDiscard(
        Effect.flatMap(Tools, (registry) =>
          registry.register({
            name: "origin",
            description: "the caller's interaction origin",
            input: Schema.Struct({}),
            execute: () => Effect.map(Effect.service(InteractionOrigin), (value) => new ToolResult({ content: [{ type: "text", text: String(value) }] })),
          }),
        ),
      ),
    });
    const result = await call(`return await tools.origin({});`, { extra: [origin], origin: "session:s" });
    expect(textOf(result)).toContain("session:s");
  });

  it("cuts its output to fit the registry's cap, so the note naming the full output survives", async () => {
    const result = await call(`text("x".repeat(20_000));`, { maxResultChars: 3_000 });
    const text = textOf(result);
    expect(text.length).toBeLessThanOrEqual(3_000);
    expect(text).not.toContain("[Output truncated:");
    const saved = (result.details as { fullOutputPath?: string }).fullOutputPath!;
    expect(text).toContain(`[Full output: ${saved}`);
    expect(await fs.readFile(saved, "utf8")).toBe("x".repeat(20_000));
    await fs.rm(saved, { force: true });
  });

  it("takes a deadline from its options line, and refuses unknown options", async () => {
    const timedOut = await call(`// @options: {"timeout_ms": 200}\nwhile (true) {}`);
    expect(timedOut.isError).toBe(true);
    expect(textOf(timedOut)).toContain("timed out");
    const refused = await call(`// @options: {"bogus": 1}\nreturn 1;`);
    expect(refused.isError).toBe(true);
  });

  it("finds tools by words in their name and description", async () => {
    const result = await call(`return (await searchTools("shell command")).map((t) => t.name);`);
    expect(textOf(result)).toContain("bash");
  });
});
