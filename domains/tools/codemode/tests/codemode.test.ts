import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect, Fiber, Layer, Schema, Stream } from "effect";
import type { Context } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CoreClosed, Events, definePlugin, Hooks, makeCore, PluginContext, Registries } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { InteractionOrigin, Paths } from "@lemma/contracts";
import { AgentRequestHook, PromptSections } from "@lemma/agent";
import type { RequestDraft } from "@lemma/agent";
import { Llm, LlmError } from "@lemma/llm";
import type { ClassifierAnswer, ClassifierContext, ClassifierResult, ImagesContext } from "@lemma/llm";
import { Sessions } from "@lemma/sessions";
import sessions from "@lemma/sessions-files";
import { Guards, ToolError, ToolInvocation, ToolNamespaces, ToolOutput, ToolResult, ToolRunner, Tools } from "@lemma/tools";
import { tempDir, textOf } from "@lemma/tools/testing";
import tools from "@lemma/tools-registry";
import bash from "@lemma/tools-bash";
import edit from "@lemma/tools-edit";
import read from "@lemma/tools-read";
import write from "@lemma/tools-write";
import codemode, { codemodeTool } from "../src/index.ts";
import { Journals } from "../src/journal.ts";
import type { CodemodeDetails } from "../src/index.ts";

/** What the fake classifier was asked, by ref. */
const asked: { ref: string; context: ClassifierContext }[] = [];
/** What the fake image model was asked. */
const painted: ImagesContext[] = [];
/** A 1×1 PNG. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * An `Llm` with one classifier, `faux/judge`, that answers every question as its first label (or `true`), costing a
 * cent a call; `faux/broken` answers with a provider's error. Its image model, `faux/painter`, paints one pixel.
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
      imageModels: () =>
        Effect.succeed([
          {
            ref: "faux/painter",
            provider: "faux",
            id: "painter",
            name: "Painter",
            api: "faux",
            input: ["text"],
            output: ["image"],
            cost: { input: 0, output: 0 },
          },
        ]),
      generateImages: (ref, context) =>
        ref === "faux/painter"
          ? Effect.sync(() => {
              painted.push(context);
              return {
                provider: "faux",
                model: "painter",
                output: [{ type: "image", data: PIXEL, mimeType: "image/png" }],
                usage,
                stopReason: "stop" as const,
              };
            })
          : Effect.fail(new LlmError({ reason: "UnknownModel", message: `Unknown model: ${ref}` })),
      login: () => Effect.void,
      signIns: Stream.make([]),
      answerSignIn: () => Effect.void,
      logout: () => Effect.void,
      addCustom: (spec) => Effect.succeed(spec.name),
      removeCustom: () => Effect.void,
      setLogo: () => Effect.void,
    });
  }),
});

const builtin = [llm, sessions, read, write, edit, bash, codemode];

/** The host's home for every test: its sessions, and codemode's journals. */
let home: string;
beforeAll(async () => {
  home = await tempDir();
});
afterAll(() => fs.rm(home, { recursive: true, force: true }));

/** A core of the registry, the builtin tools, and `extra`, with the test's home. */
const coreOf = (extra: readonly Plugin[] = [], configs: Record<string, unknown> = {}) =>
  makeCore([tools, ...builtin, ...extra], {
    configs,
    provide: {
      provides: [Paths],
      layer: Layer.succeed(Paths, {
        home,
        root: home,
        userConfig: path.join(home, "config.jsonc"),
        projectConfig: path.join(home, "project.jsonc"),
        cwd: home,
      }),
    },
  });

/** Every call gets an id of its own: a journal answers a call the same id makes again. */
let calls = 0;
const callId = () => `c${++calls}`;

const run = (code: string, cwd = process.cwd(), extra: readonly Plugin[] = [], signal = new AbortController().signal) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* coreOf(extra);
        return yield* core.run(
          Effect.flatMap(ToolRunner, (registry) =>
            registry.execute(new ToolInvocation({ sessionId: "s", toolCallId: callId(), name: "codemode", input: { code }, cwd }), signal),
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
          const core = yield* coreOf();
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
        const core = yield* coreOf(options.extra, options.maxResultChars === undefined ? {} : { "tools.registry": { maxResultChars: options.maxResultChars } });
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
              toolCallId: callId(),
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
        return shell.output;
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

  it("cancels the calls still running when the script ends: it returned, or timed out", async () => {
    const cancelled: string[] = [];
    // `slow` tells `running` once it is listening for its cancel, so a script that waits on `running` ends with `slow`
    // running, however slowly the calls start: a call cancelled before it starts never runs its tool at all.
    let listening!: () => void;
    const started = new Promise<void>((resolve) => (listening = resolve));
    const slow = definePlugin({
      id: "slow",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          Effect.andThen(
            owner.add(Tools, {
              name: "slow",
              description: "Waits until cancelled",
              input: Schema.Struct({ name: Schema.String }),
              execute: async ({ name }, { signal }) => {
                const aborted = new Promise((resolve) => (signal.aborted ? resolve(undefined) : signal.addEventListener("abort", resolve, { once: true })));
                listening();
                await aborted;
                cancelled.push(name);
                return new ToolResult({ content: [] });
              },
            }),
            owner.add(Tools, {
              name: "running",
              description: "Answers once slow is running",
              input: Schema.Struct({}),
              execute: async () => {
                await started;
                return new ToolResult({ content: [] });
              },
            }),
          ),
        ),
      ),
    });
    const returned = await run(`tools.slow({ name: "unawaited" }); await tools.running({}); return "ok";`, process.cwd(), [slow]);
    expect(textOf(returned)).toContain("ok");
    await vi.waitFor(() => expect(cancelled).toEqual(["unawaited"]));
    expect((returned.details as CodemodeDetails).calls).toMatchObject([
      { name: "slow", status: "cancelled" },
      { name: "running", status: "ok" },
    ]);
    const timedOut = await run(`// @options: {"timeout_ms": 200}\nawait tools.slow({ name: "timed out" });`, process.cwd(), [slow]);
    expect(textOf(timedOut)).toContain("Script timed out");
    await vi.waitFor(() => expect(cancelled).toEqual(["unawaited", "timed out"]));
  });
  it("reaches only the tools the request offered", async () => {
    const result = await call(`text(ALL_TOOLS.map((t) => t.name)); await tools.bash({ command: "echo unoffered" });`, { offered: ["codemode", "read"] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('["read"]');
    expect(textOf(result)).toContain("tools.bash does not exist");
  });

  it("shows each call it makes as a line of its own output, and nothing under nested ids", async () => {
    const received: string[] = [];
    const published: unknown[] = [];
    const result = await call(`await tools.bash({ command: "printf nested-out" }); await tools.read({}).catch(() => {}); return "ok";`, {
      update: (chunk) => received.push(chunk),
      published,
    });
    expect(result.isError).not.toBe(true);
    const lines = received.join("").trim().split("\n");
    expect(lines[0]).toMatch(/^✓ bash \d+ms {"command":"printf nested-out"}$/);
    expect(lines[1]).toMatch(/^✗ read \d+ms {}$/);
    expect(received.join("")).not.toContain("nested-out\n");
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

  it("declares a tool that declares no output as resolving to text", async () => {
    const result = await run(`return ALL_TOOLS.find((tool) => tool.name === "write").description;`);
    expect(textOf(result)).toMatch(/Promise<string>/);
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

describe("what a script's call resolves to", () => {
  it("is the tool's declared output, on a failure too: bash's whole output and exit code", async () => {
    const result = await run(
      `const r = await tools.bash({ command: "printf 'a\\\\nb'; exit 3" }); return [r.output, r.exitCode, r.truncated, typeof r.wallTimeSeconds];`,
    );
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain('["a\\nb",3,false,"number"]');
  });

  it("is an image block for read, which a classifier judges and image() shows", async () => {
    const cwd = await tempDir();
    try {
      await fs.writeFile(path.join(cwd, "shot.png"), Buffer.from(PIXEL, "base64"));
      asked.length = 0;
      const result = await run(
        `const shot = await tools.read({ path: "shot.png" });
         const r = await models.classify("faux/judge", { state: { task: "check" }, images: [shot], questions: { broken: { type: "bool", instructions: "Broken?", criteria: { true: "Yes", false: "No" } } } });
         image(shot);
         return [shot.type, shot.mimeType, shot.note, r.answers.broken.probability];`,
        cwd,
      );
      expect(textOf(result)).toContain('["image","image/png","Read image file [image/png]",0.8]');
      expect(asked[0]?.context.images).toEqual([{ type: "image", data: PIXEL, mimeType: "image/png" }]);
      // Shown, and saved where a later call can find it.
      expect(result.content.some((part) => part.type === "image")).toBe(true);
      const saved = /\[Image saved to (\S+)\]/.exec(textOf(result))?.[1];
      expect(saved).toBeDefined();
      expect((await fs.readFile(saved!)).toString("base64")).toBe(PIXEL);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("is text and images for a tool that declares no output", async () => {
    const camera = definePlugin({
      id: "camera",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.add(Tools, {
            name: "camera",
            description: "Takes a picture",
            input: Schema.Struct({}),
            execute: () =>
              new ToolResult({
                content: [
                  { type: "text", text: "a picture" },
                  { type: "image", data: PIXEL, mimeType: "image/png" },
                ],
              }),
          }),
        ),
      ),
    });
    const result = await run(`const r = await tools.camera({}); return [r.text, r.images.length, r.images[0].mimeType];`, process.cwd(), [camera]);
    expect(textOf(result)).toContain('["a picture",1,"image/png"]');
  });

  it("keeps the calls of a display tool whole, for the chat to show", async () => {
    const page = definePlugin({
      id: "page",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.add(Tools, {
            name: "page",
            description: "Shows a page",
            input: Schema.Struct({ title: Schema.String }),
            display: true,
            execute: ({ title }) => new ToolResult({ content: [{ type: "text", text: "shown" }], details: { title } }),
          }),
        ),
      ),
    });
    const result = await run(`await tools.page({ title: "Chart" }); await tools.bash({ command: "true" });`, process.cwd(), [page]);
    expect((result.details as CodemodeDetails).displays).toEqual([
      { name: "page", title: "Chart", content: [{ type: "text", text: "shown" }], details: { title: "Chart" } },
    ]);
    // The model is told what the person was shown, which it cannot see.
    expect(textOf(result)).toContain('[Shown to the person outside your reply: page "Chart". Don\'t describe it again.]');
  });

  it("shows at most 20 pages, 10 MiB together, from one script: past that, a call shows nothing and the script hears why", async () => {
    const page = definePlugin({
      id: "page",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.add(Tools, {
            name: "page",
            description: "Shows a page",
            input: Schema.Struct({ title: Schema.String, mib: Schema.optional(Schema.Number) }),
            display: true,
            execute: ({ title, mib }) =>
              new ToolResult({ content: [{ type: "text", text: "shown" }], details: { title, html: "x".repeat((mib ?? 0) * 1024 * 1024) } }),
          }),
        ),
      ),
    });
    const many = await run(
      `const failed = []; for (let i = 0; i < 22; i++) await tools.page({ title: String(i) }).catch((error) => failed.push(error.message)); return failed;`,
      process.cwd(),
      [page],
    );
    expect((many.details as CodemodeDetails).displays).toHaveLength(20);
    expect(textOf(many)).toContain("page showed nothing: one script shows at most 20 pages, 10 MiB together");
    const large = await run(
      `await tools.page({ title: "a", mib: 6 }); return await tools.page({ title: "b", mib: 6 }).then(() => "shown", (error) => error.message);`,
      process.cwd(),
      [page],
    );
    expect((large.details as CodemodeDetails).displays?.map((display) => display.title)).toEqual(["a"]);
    expect(textOf(large)).toContain("page showed nothing");
  });
});

describe("a script of many calls", () => {
  it("keeps the first 500 in its details, in the order it made them, and counts the rest", async () => {
    const result = await run(`for (let i = 0; i < 520; i++) await describeTool(i % 2 === 0 ? "bash" : "read"); return "ok";`);
    const details = result.details as CodemodeDetails;
    expect(details.calls).toHaveLength(500);
    expect(details.callsOmitted).toBe(20);
    expect(details.calls.slice(0, 2).map((call) => call.args)).toEqual(['["bash"]', '["read"]']);
    // 520 calls one after another, each through the sandbox: longer than the default allows on a busy machine.
  }, 30_000);
});

describe("store()", () => {
  it("keeps what a script stored for later scripts on the branch, and only on it", async () => {
    const execute = (code: string, sessionId: string, leafId?: string) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const core = yield* coreOf();
            return yield* core.run(
              Effect.flatMap(ToolRunner, (registry) =>
                registry.execute(
                  new ToolInvocation({
                    sessionId,
                    toolCallId: callId(),
                    name: "codemode",
                    input: { code },
                    cwd: process.cwd(),
                    ...(leafId === undefined ? {} : { leafId }),
                  }),
                  new AbortController().signal,
                ),
              ),
            );
          }),
        ),
      );
    const log = <A>(work: (store: Context.Service.Shape<typeof Sessions>) => Effect.Effect<A, unknown>) =>
      Effect.runPromise(Effect.scoped(Effect.flatMap(coreOf(), (core) => core.run(Effect.flatMap(Sessions, work)))));
    const { id } = await log((store) => store.create({ cwd: process.cwd() }));
    const first = await execute(`store("seen", ["a"]); store("cursor", 7); return load("cursor");`, id);
    expect(textOf(first)).toContain("7");
    expect((first.details as CodemodeDetails).storeWrites).toEqual({ set: { seen: ["a"], cursor: 7 }, delete: [] });
    const appended = await log((store) =>
      store.append(id, {
        type: "message",
        message: { role: "toolResult", toolCallId: "t1", toolName: "codemode", content: [], isError: false, timestamp: 0 },
        details: first.details,
      }),
    );
    const second = await execute(`store("cursor", undefined); return [load("seen"), load("cursor")];`, id, appended.id);
    expect(textOf(second)).toContain('[["a"],null]');
    const later = await log((store) =>
      store.append(id, {
        type: "message",
        message: { role: "toolResult", toolCallId: "t2", toolName: "codemode", content: [], isError: false, timestamp: 0 },
        details: second.details,
      }),
    );
    expect(textOf(await execute(`return [load("seen"), load("cursor") ?? "gone"];`, id, later.id))).toContain('[["a"],"gone"]');
    // Another branch, from before the first script, has none of it.
    expect(textOf(await execute(`return load("seen") ?? "none";`, id))).toContain("none");
  });
});

describe("finding tools", () => {
  const browser = definePlugin({
    id: "browser-fake",
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const owner = yield* PluginContext;
        yield* owner.add(ToolNamespaces, {
          name: "browser",
          description: "Drives a headless web browser",
          instructions: "Take a snapshot first, then act by ref.",
          aliases: ["web"],
        });
        for (const [name, description] of [
          ["browser_snapshot", "The page's accessibility tree, with refs to act on"],
          ["browser_click", "Clicks an element of the page"],
        ] as const)
          yield* owner.add(Tools, {
            name,
            description,
            namespace: "browser",
            nested: true,
            input: Schema.Struct({ ref: Schema.optional(Schema.String) }),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: () => new ToolResult({ content: [{ type: "text", text: "ok" }], structured: { ok: true } }),
          });
      }),
    ),
  });

  it("ranks tools by their names and descriptions, within a namespace when asked", async () => {
    const result = await run(
      `return [
        (await searchTools("click element"))[0].name,
        (await searchTools("page", { namespace: "web" })).map((t) => t.name).sort(),
        (await searchTools("page", { namespace: "browser", limit: 1 })).length,
        await searchTools("click", { namespace: "nope" }).catch((e) => e.message),
      ];`,
      process.cwd(),
      [browser],
    );
    expect(textOf(result)).toContain(
      '["browser_click",["browser_click","browser_snapshot"],1,"searchTools(): no namespace \\"nope\\"; the system prompt names them"]',
    );
  });

  it("describes a tool's declaration and a namespace's instructions", async () => {
    const result = await run(
      `const tool = await describeTool("browser_click");
       const space = await describeNamespace("browser");
       return [tool.namespace, tool.declaration, space.instructions, space.tools, await describeTool("nope") ?? "none", await describeNamespace("nope") ?? "none"];`,
      process.cwd(),
      [browser],
    );
    const text = textOf(result);
    expect(text).toContain('"browser"');
    expect(text).toMatch(/browser_click\(args: \{.*ref\?: string.*\}\): Promise<\{.*ok: boolean.*\}>/);
    expect(text).toContain('"Take a snapshot first, then act by ref.",["browser_click","browser_snapshot"],"none","none"]');
  });

  it("names the namespaces of the tools only scripts call in the system prompt, where codemode is offered", async () => {
    const texts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* coreOf([browser]);
          return yield* core.run(
            Effect.gen(function* () {
              const registries = yield* Registries;
              const listed = yield* Effect.flatMap(ToolRunner, (registry) => registry.list);
              const section = (yield* registries.items(PromptSections)).find(({ item }) => item.id === "codemode-namespaces")!.item;
              const ask = (tools: typeof listed) =>
                Effect.promise(async () => section.text({ sessionId: "s", turnId: "t", cwd: home, model: "faux/m", tools, branch: [] }));
              return [yield* ask(listed), yield* ask(listed.filter((tool) => tool.spec.name !== "codemode"))];
            }),
          );
        }),
      ),
    );
    expect(texts[0]).toContain("- browser: Drives a headless web browser");
    expect(texts[1]).toBeUndefined();
  });

  it("settles that section once a request's tools are chosen: it goes with codemode, or with the last tool it names", async () => {
    // As a thread's profile keeps some of the tools on offer.
    let keeps = (_: string) => true;
    const profile = definePlugin({
      id: "profile-fake",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.on(AgentRequestHook, (draft, next) => next({ ...draft, tools: draft.tools.filter((tool) => keeps(tool.spec.name)) }), { phase: "select" }),
        ),
      ),
    });
    const sent = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* coreOf([browser, profile]);
          return yield* core.run(
            Effect.gen(function* () {
              const hooks = yield* Hooks;
              const tools = yield* Effect.flatMap(ToolRunner, (registry) => registry.list);
              const section = (yield* (yield* Registries).items(PromptSections)).find(({ item }) => item.id === "codemode-namespaces")!.item;
              // Written as a string: codemode's section is no promise or Effect.
              const text = (yield* Effect.promise(async () =>
                section.text({ sessionId: "s", turnId: "t", cwd: home, model: "faux/m", tools, branch: [] }),
              )) as string;
              const draft: RequestDraft = {
                sessionId: "s",
                turnId: "t",
                cwd: home,
                model: "faux/m",
                sections: [
                  { id: "codemode-namespaces", source: "tools.codemode", text },
                  { id: "other", source: "other", text: "Other" },
                ],
                tools,
                branch: [],
                history: [],
                append: () => Effect.die("not appended"),
              };
              const ask = (keep: (name: string) => boolean) => {
                keeps = keep;
                return hooks.invoke(AgentRequestHook, draft, ({ model, sections, tools }) => Effect.succeed({ model, sections, tools }));
              };
              return [yield* ask(() => true), yield* ask((name) => name !== "codemode"), yield* ask((name) => !name.startsWith("browser_"))].map((plan) =>
                plan.sections.map((each) => each.id),
              );
            }),
          );
        }),
      ),
    );
    expect(sent).toEqual([["codemode-namespaces", "other"], ["other"], ["other"]]);
  });
});

describe("models", () => {
  it("lists models of a type by pi's names, and runs a classifier named by its entry", async () => {
    const result = await run(`
      const [judge] = await models.getAvailableOfType("classifier");
      const found = await models.getModelOfType("classifier", "faux", "judge");
      const none = await models.getModelOfType("classifier", "faux", "nope");
      const r = await models.classify({ provider: found.provider, id: found.id }, { state: {}, questions: { ok: { type: "bool", instructions: "Ok?", criteria: { true: "Yes", false: "No" } } } });
      return [judge.ref, judge.type, found.name, none ?? "none", (await models.getModelsOfType("image", "faux")).map((m) => m.ref), r.stopReason];
    `);
    expect(textOf(result)).toContain('["faux/judge","classifier","Judge","none",["faux/painter"],"stop"]');
  });

  it("generate images, which the script shows", async () => {
    painted.length = 0;
    const result = await run(`
      const [painter] = await models.getAvailableOfType("image");
      const r = await models.generateImages(painter, { input: [{ type: "text", text: "a fox" }] });
      for (const block of r.output) if (block.type === "image") image(block);
      return r.stopReason;
    `);
    expect(painted).toEqual([{ input: [{ type: "text", text: "a fox" }] }]);
    expect(result.content.filter((part) => part.type === "image")).toEqual([{ type: "image", data: PIXEL, mimeType: "image/png" }]);
    expect((result.details as CodemodeDetails).usage?.cost.total).toBeCloseTo(0.01);
    const unknown = await run(`await models.getModelsOfType("video");`);
    expect(textOf(unknown)).toContain('models: the type is one of "chat", "image", "classifier", not "video"');
  });
});

describe("a script a host restart cut off", () => {
  /**
   * `count` counts its calls (an effect not safe to repeat); `wait` waits until `released`, and is `safe` to repeat when
   * asked; `page` shows a page.
   */
  const fixture = (state: { counted: number; waited: number; shown?: number; release?: () => void; waiting?: () => void }, safe: boolean) =>
    definePlugin({
      id: "fixture",
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          yield* owner.add(Tools, {
            name: "count",
            description: "Counts",
            input: Schema.Struct({}),
            execute: () => new ToolResult({ content: [{ type: "text", text: String(++state.counted) }] }),
          });
          yield* owner.add(Tools, {
            name: "wait",
            description: "Waits",
            input: Schema.Struct({}),
            ...(safe ? { replay: "safe" as const } : {}),
            execute: async (_, { signal }) => {
              state.waited++;
              if (state.release === undefined) {
                state.waiting?.();
                await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
              }
              return new ToolResult({ content: [{ type: "text", text: "waited" }] });
            },
          });
          yield* owner.add(Tools, {
            name: "page",
            description: "Shows a page",
            input: Schema.Struct({ title: Schema.String }),
            display: true,
            execute: ({ title }) => {
              state.shown = (state.shown ?? 0) + 1;
              return new ToolResult({ content: [{ type: "text", text: "shown" }], details: { title } });
            },
          });
        }),
      ),
    });

  const execute = (code: string, toolCallId: string, extra: readonly Plugin[], at: { sessionId?: string; leafId?: string } = {}) =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* coreOf(extra);
        return yield* core.run(
          Effect.flatMap(ToolRunner, (registry) =>
            registry.execute(
              new ToolInvocation({
                sessionId: at.sessionId ?? "s",
                toolCallId,
                name: "codemode",
                input: { code },
                cwd: process.cwd(),
                ...(at.leafId === undefined ? {} : { leafId: at.leafId }),
              }),
              new AbortController().signal,
            ),
          ),
        );
      }),
    );
  const log = <A>(work: (store: Context.Service.Shape<typeof Sessions>) => Effect.Effect<A, unknown>) =>
    Effect.runPromise(Effect.scoped(Effect.flatMap(coreOf(), (core) => core.run(Effect.flatMap(Sessions, work)))));
  /** The result of codemode call `toolCallId`, logged in `sessionId`. */
  const logResult = (sessionId: string, toolCallId: string) =>
    log((store) =>
      store.append(sessionId, {
        type: "message",
        message: { role: "toolResult", toolCallId, toolName: "codemode", content: [], isError: true, timestamp: 0 },
      }),
    );
  const journalOf = (sessionId: string, toolCallId: string) => new Journals(home).open(sessionId, toolCallId).file;
  const exists = (file: string) =>
    fs.access(file).then(
      () => true,
      () => false,
    );

  /** Runs `code` until `wait` is waiting, then stops the host under it, as a restart would. */
  const cutOff = async (code: string, toolCallId: string, state: Parameters<typeof fixture>[0], safe: boolean, at: { sessionId?: string } = {}) => {
    const waiting = new Promise<void>((resolve) => (state.waiting = resolve));
    const fiber = Effect.runFork(execute(code, toolCallId, [fixture(state, safe)], at));
    await waiting;
    await Effect.runPromise(Fiber.interrupt(fiber));
  };

  const code = `const n = await tools.count({}); const w = await tools.wait({}); return [n, w, Math.random() < 2, typeof Date.now()];`;

  it("resumes: what had settled is answered as it was, and a call safe to repeat runs again", async () => {
    const state: Parameters<typeof fixture>[0] = { counted: 0, waited: 0 };
    const id = callId();
    await cutOff(code, id, state, true);
    expect(state).toMatchObject({ counted: 1, waited: 1 });
    state.release = () => {};
    const received: string[] = [];
    const resumed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* coreOf([fixture(state, true)]);
          return yield* core.run(
            Effect.flatMap(ToolRunner, (registry) =>
              registry.execute(
                new ToolInvocation({ sessionId: "s", toolCallId: id, name: "codemode", input: { code }, cwd: process.cwd() }),
                new AbortController().signal,
                { update: (chunk) => void received.push(chunk) },
              ),
            ),
          );
        }),
      ),
    );
    expect(resumed.isError).not.toBe(true);
    expect(textOf(resumed)).toContain("Script completed (resumed after a host restart)");
    expect(textOf(resumed)).toContain('["1","waited",true,"number"]');
    expect(state).toMatchObject({ counted: 1, waited: 2 });
    expect(received.join("")).toContain("✓ count 0ms {} (from before the restart)");
    expect((resumed.details as CodemodeDetails).resumed).toBe(true);
    // Asked again once it finished, as when the host stops before the agent logs its result: the same result, nothing
    // run, though the resumed turn has moved on (it logged that it resumed) and so asks from another place.
    const again = await Effect.runPromise(execute(code, id, [fixture(state, true)], { leafId: "after-the-restart" }));
    expect(textOf(again)).toBe(textOf(resumed));
    expect(state).toMatchObject({ counted: 1, waited: 2 });
  });

  it("shows again on resuming what the script showed before the restart", async () => {
    const state: Parameters<typeof fixture>[0] = { counted: 0, waited: 0 };
    const id = callId();
    const showing = `await tools.page({ title: "Chart" }); return await tools.wait({});`;
    await cutOff(showing, id, state, true);
    state.release = () => {};
    const resumed = await Effect.runPromise(execute(showing, id, [fixture(state, true)]));
    expect(textOf(resumed)).toContain("Script completed (resumed after a host restart)");
    expect((resumed.details as CodemodeDetails).displays).toEqual([
      { name: "page", title: "Chart", content: [{ type: "text", text: "shown" }], details: { title: "Chart" } },
    ]);
    expect(textOf(resumed)).toContain('[Shown to the person outside your reply: page "Chart". Don\'t describe it again.]');
    expect(state.shown).toBe(1);
  });

  it("deletes a call's journal once its result is logged", async () => {
    const { id: sessionId } = await log((store) => store.create({ cwd: process.cwd() }));
    const state: Parameters<typeof fixture>[0] = { counted: 0, waited: 0 };
    const id = callId();
    await cutOff(code, id, state, true, { sessionId });
    expect(await exists(journalOf(sessionId, id))).toBe(true);
    await logResult(sessionId, id);
    await vi.waitFor(async () => expect(await exists(journalOf(sessionId, id))).toBe(false));
  });

  it("runs from the start a call under the id of one whose result the branch logs: cancelled, or an id reused", async () => {
    const state: Parameters<typeof fixture>[0] = { counted: 0, waited: 0 };
    const id = callId();
    // Cut off, and its journal left behind (the result logged while this host did not hear it).
    await cutOff(code, id, state, false);
    state.release = () => {};
    const again = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* coreOf([fixture(state, false)]);
          return yield* core.run(
            Effect.gen(function* () {
              const tool = codemodeTool({
                registry: yield* ToolRunner,
                llm: yield* Llm,
                namespaces: () => [],
                branch: () => Effect.succeed({ store: {}, answered: new Set([id]) }),
                journals: new Journals(home),
              });
              return yield* tool.execute(
                { code },
                { sessionId: "s", toolCallId: id, cwd: process.cwd(), signal: new AbortController().signal, leafId: "later" },
              ) as Effect.Effect<ToolResult>;
            }),
          );
        }),
      ),
    );
    expect(again.isError).not.toBe(true);
    expect(textOf(again)).not.toContain("resumed");
    expect(textOf(again)).toContain('["2","waited",true,"number"]');
    expect(state).toMatchObject({ counted: 2, waited: 2 });
  });

  it("does not run again a call cut off mid-way that is not safe to repeat: the script hears why", async () => {
    const state: Parameters<typeof fixture>[0] = { counted: 0, waited: 0 };
    const id = callId();
    await cutOff(code, id, state, false);
    state.release = () => {};
    const resumed = await Effect.runPromise(execute(code, id, [fixture(state, false)]));
    expect(resumed.isError).toBe(true);
    expect(textOf(resumed)).toContain("wait was cut off by a host restart while it ran, so it may or may not have had its effect; it was not run again");
    expect(state).toMatchObject({ counted: 1, waited: 1 });
  });

  it("does not resume on a sandbox of another version, which would not make the same calls", async () => {
    const state: Parameters<typeof fixture>[0] = { counted: 0, waited: 0 };
    const id = callId();
    await cutOff(code, id, state, true);
    // As a journal an older pi-codemode wrote reads.
    const dir = path.join(home, "codemode", "journals");
    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name);
      const text = await fs.readFile(file, "utf8");
      if (text.includes(JSON.stringify(code))) await fs.writeFile(file, text.replace(/"fingerprint":"[^"]*"/, '"fingerprint":"another-engine"'));
    }
    state.release = () => {};
    const refused = await Effect.runPromise(execute(code, id, [fixture(state, true)]));
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("cannot resume on this version of the sandbox");
    expect(state).toMatchObject({ counted: 1, waited: 1 });
  });

  it("runs a new script under a reused call id from the start", async () => {
    const state: Parameters<typeof fixture>[0] = { counted: 0, waited: 0, release: () => {} };
    const id = callId();
    await Effect.runPromise(execute(`return await tools.count({});`, id, [fixture(state, false)]));
    const other = await Effect.runPromise(execute(`return [await tools.count({}), "other"];`, id, [fixture(state, false)]));
    expect(textOf(other)).toContain('["2","other"]');
  });
});

describe("a script running as the core shuts down", () => {
  /**
   * Runs `code` as codemode with the core's registry, as the plugin would, except that `shutdown()` makes the core
   * report it is closing and its registry report every tool gone, as a plugin stopping before the agent does leaves it.
   */
  const harness = (state: { counted: number; probed?: number }, refused: "gone" | "closed" = "gone") => {
    let closing = false;
    let held: () => void = () => {};
    const heldNow = () => new Promise<void>((resolve) => (held = resolve));
    const counter = definePlugin({
      id: "counter",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.add(Tools, {
            name: "count",
            description: "Counts",
            input: Schema.Struct({ last: Schema.optional(Schema.Boolean) }),
            execute: ({ last }) => {
              state.counted++;
              if (last === true) closing = true;
              return new ToolResult({ content: [{ type: "text", text: String(state.counted) }] });
            },
          }),
        ),
      ),
    });
    const execute = (code: string, toolCallId: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* coreOf([counter]);
          return yield* core.run(
            Effect.gen(function* () {
              const runner = yield* ToolRunner;
              const tool = codemodeTool({
                registry: {
                  list: runner.list,
                  execute: (invocation, abort, options) => {
                    if (!closing) return runner.execute(invocation, abort, options);
                    // As the registry answers then: the tool gone with its plugin, or every call refused by the core.
                    if (refused === "gone")
                      return Effect.fail(new ToolError({ tool: invocation.name, reason: "NotFound", message: `Tool "${invocation.name}" not found` }));
                    held();
                    return Effect.die(new CoreClosed());
                  },
                },
                llm: yield* Llm,
                namespaces: () => [],
                branch: () => Effect.succeed({ store: {}, answered: new Set<string>() }),
                journals: new Journals(home),
                closing: Effect.sync(() => {
                  state.probed = (state.probed ?? 0) + 1;
                  if (closing) held();
                  return closing;
                }),
              });
              return yield* tool.execute(
                { code },
                { sessionId: "s", toolCallId, cwd: process.cwd(), signal: new AbortController().signal },
              ) as Effect.Effect<ToolResult>;
            }),
          );
        }),
      );
    return {
      execute,
      heldNow,
      restart: () => {
        closing = false;
      },
    };
  };

  it("holds the calls it makes then unanswered, and resumes them after the restart, each run once", async () => {
    const state = { counted: 0 };
    const { execute, heldNow, restart } = harness(state);
    const id = callId();
    const code = `const a = await tools.count({ last: true }); const b = await tools.count({}); return [a, b];`;
    const reached = heldNow();
    const fiber = Effect.runFork(execute(code, id));
    // The second call is not made, nor failed: the script waits on it until the turn is interrupted, as the core stops.
    await reached;
    expect(state.counted).toBe(1);
    await Effect.runPromise(Fiber.interrupt(fiber));
    restart();
    const resumed = await Effect.runPromise(execute(code, id));
    expect(textOf(resumed)).toContain("Script completed (resumed after a host restart)");
    expect(textOf(resumed)).toContain('["1","2"]');
    expect(state.counted).toBe(2);
  });

  it("runs on resume a call that began but never reached its tool, gone as its plugin stopped", async () => {
    const state = { counted: 0 };
    const { execute, heldNow, restart } = harness(state);
    const id = callId();
    // The first call flips the core to closing only after the second has begun: the registry then finds its tool gone.
    const code = `const [a, b] = await Promise.all([tools.count({ last: true }), tools.count({})]); return [a, b];`;
    const reached = heldNow();
    const fiber = Effect.runFork(execute(code, id));
    await reached;
    await Effect.runPromise(Fiber.interrupt(fiber));
    restart();
    const resumed = await Effect.runPromise(execute(code, id));
    expect(resumed.isError).not.toBe(true);
    expect(textOf(resumed)).toContain("Script completed (resumed after a host restart)");
    expect(state.counted).toBe(2);
  });

  it("holds a call the core refused as it shut down, which never reached its tool, without asking whether it is closing", async () => {
    const state = { counted: 0, probed: 0 };
    const { execute, heldNow, restart } = harness(state, "closed");
    const id = callId();
    const code = `const a = await tools.count({ last: true }); const b = await tools.count({}); return [a, b];`;
    const reached = heldNow();
    const fiber = Effect.runFork(execute(code, id));
    await reached;
    await Effect.runPromise(Fiber.interrupt(fiber));
    restart();
    const resumed = await Effect.runPromise(execute(code, id));
    expect(textOf(resumed)).toContain('["1","2"]');
    expect(state.counted).toBe(2);
    // Calls that succeed never ask: only a failure does.
    expect(state.probed).toBe(0);
  });
});
