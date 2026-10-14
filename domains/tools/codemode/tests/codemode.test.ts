import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect, Fiber, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Events, definePlugin, makeCore, PluginContext } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { InteractionOrigin } from "@lemma/contracts";
import { Llm, LlmError } from "@lemma/llm";
import type { ClassifierAnswer, ClassifierContext, ClassifierResult } from "@lemma/llm";
import { Guards, ToolInvocation, ToolOutput, ToolResult, ToolRunner, Tools } from "@lemma/tools";
import { tempDir, textOf } from "@lemma/tools/testing";
import tools from "@lemma/tools-registry";
import bash from "@lemma/tools-bash";
import edit from "@lemma/tools-edit";
import read from "@lemma/tools-read";
import write from "@lemma/tools-write";
import codemode from "../src/index.ts";
import type { CodemodeDetails } from "../src/index.ts";

/** What the fake classifier was asked, by ref. */
const asked: { ref: string; context: ClassifierContext }[] = [];

/**
 * An `Llm` with one classifier, `faux/judge`, that answers every question as its first label (or `true`), costing a
 * cent a call; `faux/broken` answers with a provider's error.
 */
const llm = definePlugin({
  id: "llm",
  provides: [Llm],
  layer: Layer.sync(Llm, () => {
    const usage = {
      input: 10,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 11,
      cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    };
    const judge = {
      ref: "faux/judge",
      provider: "faux",
      id: "judge",
      name: "Judge",
      api: "faux",
      input: ["text"] as const,
      contextWindow: 8192,
      cost: { input: 1, output: 0 },
    };
    return Llm.of({
      providers: Effect.succeed([]),
      models: () => Effect.succeed([]),
      model: (ref) => Effect.fail(new LlmError({ reason: "UnknownModel", message: ref })),
      stream: () => Stream.empty,
      classifiers: () => Effect.succeed([judge]),
      classify: (ref, context) =>
        Effect.gen(function* (): Effect.fn.Return<ClassifierResult, LlmError> {
          asked.push({ ref, context });
          if (ref === "faux/broken") return { provider: "faux", model: "broken", answers: {}, stopReason: "error", errorMessage: "No key" };
          if (ref !== judge.ref) return yield* new LlmError({ reason: "UnknownModel", message: `Unknown model: ${ref}` });
          const answers = Object.fromEntries(
            Object.entries(context.questions).map(([id, question]): [string, ClassifierAnswer] => [
              id,
              question.type === "choice"
                ? { type: "choice", choice: Object.keys(question.criteria)[0]!, probabilities: {}, confidence: 0.9 }
                : question.type === "score"
                  ? { type: "score", score: 0, confidence: 0.9 }
                  : { type: "bool", probability: 0.8 },
            ]),
          );
          return { provider: "faux", model: "judge", answers, usage, stopReason: "stop" };
        }),
      login: () => Effect.void,
      logout: () => Effect.void,
      addCustom: (spec) => Effect.succeed(spec.name),
      removeCustom: () => Effect.void,
      setLogo: () => Effect.void,
    });
  }),
});

const builtin = [llm, read, write, edit, bash, codemode];

const run = (code: string, cwd = process.cwd(), extra: readonly Plugin[] = [], signal = new AbortController().signal) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([tools, ...builtin, ...extra]);
        return yield* core.run(
          Effect.flatMap(ToolRunner, (registry) =>
            registry.execute(new ToolInvocation({ sessionId: "s", toolCallId: "c", name: "codemode", input: { code }, cwd }), signal),
          ),
        );
      }),
    ),
  );

describe("a tool only the model calls", () => {
  it("is not offered to a script: its result must be logged as its own", async () => {
    const direct = definePlugin({
      id: "direct",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.add(Tools, {
            name: "notebook",
            description: "Keeps notes in its results",
            input: Schema.Struct({}),
            direct: true,
            execute: () => new ToolResult({ content: [{ type: "text", text: "noted" }] }),
          }),
        ),
      ),
    });
    const result = await run(`text(ALL_TOOLS.map((t) => t.name).includes("notebook") ? "offered" : "not offered");`, process.cwd(), [direct]);
    expect(textOf(result)).toContain("not offered");
  });
});

describe("a tool only scripts call", () => {
  const nested = definePlugin({
    id: "nested",
    layer: Layer.effectDiscard(
      Effect.flatMap(PluginContext, (owner) =>
        owner.add(Tools, {
          name: "mcp__docs__lookup",
          description: "Looks a word up in the docs",
          input: Schema.Struct({ word: Schema.String }),
          nested: true,
          execute: ({ word }) => new ToolResult({ content: [{ type: "text", text: `${word}: found` }] }),
        }),
      ),
    ),
  });

  it("is found by searching, and called, when the request offers it", async () => {
    const result = await run(
      `const [found] = await searchTools("docs lookup"); text(found.name); text(await tools.mcp__docs__lookup({ word: "effect" }));`,
      process.cwd(),
      [nested],
    );
    expect(textOf(result)).toContain("mcp__docs__lookup\neffect: found");
  });

  it("is reached from the model's call, which the request held to the tools declared to it", async () => {
    const result = await call(`return await tools.mcp__docs__lookup({ word: "effect" });`, {
      offered: ["codemode", "mcp__docs__lookup"],
      declared: ["codemode"],
      extra: [nested],
    });
    expect(textOf(result)).toContain("effect: found");
  });

  it("cannot also be one only the model calls", async () => {
    const both = definePlugin({
      id: "both",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.add(Tools, {
            name: "both",
            description: "Both",
            input: Schema.Struct({}),
            direct: true,
            nested: true,
            execute: () => new ToolResult({ content: [] }),
          }),
        ),
      ),
    });
    const failed = await run("text('x')", process.cwd(), [both]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(JSON.stringify(failed)).toContain("cannot be both direct");
  });
});

describe("codemode's registration", () => {
  it("registers under its name, with its plugin as the source and a clean schema", async () => {
    const listed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([tools, ...builtin]);
          return yield* core.run(Effect.flatMap(ToolRunner, (registry) => registry.list));
        }),
      ),
    );
    const own = listed.find((tool) => tool.spec.name === "codemode");
    expect([own?.spec.name, own?.source, own?.nests]).toEqual(["codemode", "tools.codemode", true]);
    expect(JSON.stringify(own)).not.toContain("$schema");
  });
});

/** One codemode call, with what the agent passes: the request's tools, an origin, and the registry's config. */
const call = (
  code: string,
  options: {
    readonly offered?: readonly string[];
    readonly declared?: readonly string[];
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
          configs: options.maxResultChars === undefined ? {} : { "tools.registry": { maxResultChars: options.maxResultChars } },
        });
        return yield* core.run(
          Effect.gen(function* () {
            const events = yield* Events;
            const watching = yield* Effect.forkChild(
              Stream.runForEach(events.stream(ToolOutput), (payload) => Effect.sync(() => options.published?.push(payload))),
            );
            yield* Effect.yieldNow;
            const registry = yield* ToolRunner;
            const invocation = new ToolInvocation({
              sessionId: "s",
              toolCallId: "c",
              name: "codemode",
              input: { code },
              cwd: process.cwd(),
              ...(options.offered === undefined ? {} : { offered: options.offered }),
              ...(options.declared === undefined ? {} : { declared: options.declared }),
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
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.add(Guards, {
            tool: "bash",
            guard: (call) => Effect.succeed(call.name === "bash" ? { _tag: "deny", reason: "shell denied" } : { _tag: "allow" }),
          }),
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
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.add(Tools, {
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
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.add(Tools, {
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

describe("classifier models", () => {
  const sentiment = {
    type: "choice",
    instructions: "How does the user feel?",
    criteria: { positive: "Happy", negative: "Unhappy" },
  };

  it("are listed, and asked through Llm, with what each call used in the details", async () => {
    asked.length = 0;
    const result = await run(`
      const [judge] = await models.classifiers({ available: true });
      const results = await Promise.all(["great", "awful"].map((message) =>
        models.classify(judge, { state: { message }, questions: { sentiment: ${JSON.stringify(sentiment)}, urgent: { type: "bool", instructions: "Urgent?", criteria: { true: "Yes", false: "No" } } } })));
      return results.map((r) => [r.stopReason, r.answers.sentiment.choice, r.answers.urgent.probability]);
    `);
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('[["stop","positive",0.8],["stop","positive",0.8]]');
    expect(asked.map(({ ref, context }) => [ref, context.state])).toEqual([
      ["faux/judge", { message: "great" }],
      ["faux/judge", { message: "awful" }],
    ]);
    expect((result.details as CodemodeDetails).usage?.cost.total).toBeCloseTo(0.02);
  });

  it("report a provider's failure in the result, which the script checks", async () => {
    const result = await run(
      `const r = await models.classify("faux/broken", { state: {}, questions: { s: ${JSON.stringify(sentiment)} } }); return [r.stopReason, r.errorMessage];`,
    );
    expect(textOf(result)).toContain('["error","No key"]');
  });

  it("fail the script on an unknown ref or a context they cannot use, before asking", async () => {
    asked.length = 0;
    const unknown = await run(`await models.classify("faux/nope", { state: {}, questions: { s: ${JSON.stringify(sentiment)} } });`);
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("Unknown model: faux/nope");
    const shapeless = await run(`await models.classify("faux/judge", { state: {}, questions: { s: { type: "choice", criteria: ["a", "b"] } } });`);
    expect(shapeless.isError).toBe(true);
    expect(textOf(shapeless)).toContain("models.classify() got a context it cannot use");
    expect(asked.map(({ ref }) => ref)).toEqual(["faux/nope"]);
  });
});
