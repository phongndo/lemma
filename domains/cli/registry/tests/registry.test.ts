import { describe, expect, test } from "vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { InteractionError, InteractionOrigin } from "@lemma/contracts";
import { CliChecks, CliRunner, CliCommands, defineCliCommand } from "@lemma/cli";
import type { CliCheck, CliCommand, CliElement, RunRequest } from "@lemma/cli";
import { definePlugin, makeCore, makeLoader, PluginContext } from "@lemma/core";
import cli from "../src/index.ts";

const contributor = (id: string, commands: readonly CliCommand[], checks: readonly CliCheck[] = []) =>
  definePlugin({
    id,
    layer: Layer.effectDiscard(
      Effect.flatMap(PluginContext, (owner) =>
        Effect.andThen(
          Effect.forEach(commands, (command) => owner.add(CliCommands, command), { discard: true }),
          Effect.forEach(checks, (check) => owner.add(CliChecks, check), { discard: true }),
        ),
      ),
    ),
  });

const request = (path: readonly string[], input: Partial<RunRequest["input"]> = {}, rest: Partial<RunRequest> = {}): RunRequest => ({
  path,
  input: { args: {}, flags: {}, ...input },
  cwd: "/work",
  json: false,
  origin: "cli:test",
  ...rest,
});

/** Runs `body` against a core of `plugins`, on the test clock: the registry's grace passes when a test adjusts it. */
const run = <A, E>(plugins: Parameters<typeof makeCore>[0], body: Effect.Effect<A, E, CliRunner>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(makeCore(plugins), (core) => core.run(body))).pipe(Effect.provide(TestClock.layer())));

const collect = (stream: Stream.Stream<CliElement, unknown>) => Effect.map(Stream.runCollect(stream), (chunk) => [...chunk]);

/** A test's config for the registry: a minute's grace, which a test on the test clock passes at once, and a small buffer. */
const registry = { ...cli, layer: () => cli.layer({ resumeGraceMs: 60_000, bufferLimit: 16 }) };

/** Yields until `done` holds: what a fiber forked meanwhile does happens without waiting on a clock. */
const until = (done: () => boolean): Effect.Effect<void> =>
  done()
    ? Effect.void
    : Effect.andThen(
        Effect.yieldNow,
        Effect.suspend(() => until(done)),
      );

const greet = defineCliCommand({
  path: ["greet"],
  summary: "Greet someone",
  args: [{ name: "name", description: "Who", required: true }],
  flags: { loud: { type: "boolean", description: "Shout" } },
  run: ({ args, flags, cwd, out }) => {
    out.line(`in ${cwd}`, { err: true });
    const text = `hello, ${args.name}`;
    return { json: { greeted: args.name }, text: flags.loud ? text.toUpperCase() : text, ids: [args.name] };
  },
});

describe("cli.registry", () => {
  test("lists commands by path, with the plugin that added each", async () => {
    const listed = await run(
      [registry, contributor("p", [greet, defineCliCommand({ path: ["a", "b"], summary: "AB", run: () => undefined })])],
      Effect.flatMap(CliRunner, (runner) => runner.list),
    );
    expect(listed.map((command) => [command.path.join(" "), command.source])).toEqual([
      ["a b", "p"],
      ["greet", "p"],
    ]);
  });

  test("runs a command: started, what it prints, then its result", async () => {
    const elements = await run(
      [registry, contributor("p", [greet])],
      Effect.flatMap(CliRunner, (runner) => collect(runner.run(request(["greet"], { args: { name: "ada" }, flags: { loud: true } })))),
    );
    expect(elements[0]).toMatchObject({ type: "started" });
    expect(elements.slice(1)).toEqual([
      { type: "text", text: "in /work\n", err: true },
      { type: "result", json: { greeted: "ada" }, text: "HELLO, ADA", ids: ["ada"] },
    ]);
  });

  test("refuses an unknown path, suggesting the one meant, and input the spec rejects", async () => {
    const [unknown, usage] = await run(
      [registry, contributor("p", [greet])],
      Effect.flatMap(CliRunner, (runner) =>
        Effect.all([Effect.flip(collect(runner.run(request(["gret"])))), Effect.flip(collect(runner.run(request(["greet"], { args: {} }))))]),
      ),
    );
    expect(unknown).toMatchObject({ code: "UnknownCommand", message: 'No command "lemma gret"; did you mean "lemma greet"?' });
    expect(usage).toMatchObject({ code: "Usage", message: '"lemma greet" needs <name>' });
  });

  test("a failure keeps its code; a dismissed question is Cancelled; its questions carry the client's origin", async () => {
    const origins: (string | undefined)[] = [];
    const commands = [
      defineCliCommand({
        path: ["fails"],
        summary: "x",
        run: () => Effect.fail({ _tag: "SessionError", reason: "NotFound", message: "No session s", sessionId: "s" }),
      }),
      defineCliCommand({ path: ["asks"], summary: "x", run: () => Effect.fail(new InteractionError({ reason: "Dismissed", message: "closed" })) }),
      defineCliCommand({ path: ["origin"], summary: "x", run: () => Effect.map(InteractionOrigin, (origin) => void origins.push(origin)) }),
    ];
    const errors = await run(
      [registry, contributor("p", commands)],
      Effect.flatMap(CliRunner, (runner) =>
        Effect.all([
          Effect.flip(collect(runner.run(request(["fails"])))),
          Effect.flip(collect(runner.run(request(["asks"])))),
          collect(runner.run(request(["origin"]))),
        ]),
      ),
    );
    expect(errors[0]).toMatchObject({ code: "NotFound", subject: "s", message: "No session s" });
    expect(errors[1]).toMatchObject({ code: "Cancelled" });
    expect(origins).toEqual(["cli:test"]);
  });

  test("an invocation outlives a dropped reader: rejoined, it sends what was missed, then the rest", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    const elements = await run(
      [
        registry,
        contributor("p", [
          defineCliCommand({
            path: ["count"],
            summary: "x",
            run: ({ out }) =>
              Effect.gen(function* () {
                out.json(1);
                // The rest come once its first reader has gone.
                yield* Deferred.await(gate);
                out.json(2);
                out.json(3);
                return { json: "done" };
              }),
          }),
        ]),
      ],
      Effect.gen(function* () {
        const runner = yield* CliRunner;
        // The first reader takes `started` and the first element, then goes, as a dropped connection does.
        const first = yield* collect(Stream.take(runner.run(request(["count"])), 2));
        const invocation = (first[0] as Extract<CliElement, { type: "started" }>).invocation;
        yield* Deferred.succeed(gate, undefined);
        const rest = yield* collect(runner.run(request([], {}, { resume: { invocation, received: 2 } })));
        return [...first, ...rest];
      }),
    );
    expect(elements.slice(1)).toEqual([
      { type: "json", value: 1 },
      { type: "json", value: 2 },
      { type: "json", value: 3 },
      { type: "result", json: "done" },
    ]);
  });

  test("one left without a reader past the grace ends; cancel ends one at once", async () => {
    let interrupted = 0;
    const forever = defineCliCommand({
      path: ["forever"],
      summary: "x",
      run: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void interrupted++))),
    });
    const [expired, cancelled] = await run(
      [registry, contributor("p", [forever])],
      Effect.gen(function* () {
        const runner = yield* CliRunner;
        const left = yield* collect(Stream.take(runner.run(request(["forever"])), 1));
        const leftId = (left[0] as Extract<CliElement, { type: "started" }>).invocation;
        // Past the grace with no reader back: it is interrupted, and forgotten.
        yield* TestClock.adjust("61 seconds");
        yield* until(() => interrupted === 1);
        const expired = yield* Effect.flip(collect(runner.run(request([], {}, { resume: { invocation: leftId, received: 1 } }))));
        const started = yield* Deferred.make<string>();
        const reading = yield* Effect.forkChild(
          Stream.runForEach(runner.run(request(["forever"])), (element) =>
            element.type === "started" ? Deferred.succeed(started, element.invocation) : Effect.void,
          ),
        );
        const id = yield* Deferred.await(started);
        expect(yield* runner.cancel(id)).toBe(true);
        const exit = yield* Fiber.await(reading);
        return [expired, exit] as const;
      }),
    );
    expect(expired).toMatchObject({ code: "Expired" });
    expect(Exit.isFailure(cancelled) && JSON.stringify(cancelled)).toContain("Cancelled");
    expect(interrupted).toBe(2);
  });

  test("a command removed while it runs is Withdrawn", async () => {
    const plugins = new Map(
      [registry, contributor("p", [defineCliCommand({ path: ["wait"], summary: "x", run: () => Effect.never })])].map((plugin) => [plugin.id, plugin]),
    );
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const loader = yield* makeLoader({
            source: { resolve: (id) => Effect.succeed(plugins.get(id)!) },
            composition: { plugins: { "cli.registry": {}, p: {} } },
          });
          const runner = yield* loader.core.run(CliRunner);
          const started = yield* Deferred.make<void>();
          const reading = yield* Effect.forkChild(
            Stream.runCollect(
              Stream.tap(runner.run(request(["wait"])), (element) => (element.type === "started" ? Deferred.succeed(started, undefined) : Effect.void)),
            ),
          );
          yield* Deferred.await(started);
          yield* loader.apply({ plugins: { "cli.registry": {} } });
          return yield* Effect.flip(Fiber.join(reading));
        }),
      ),
    );
    expect(error).toMatchObject({ code: "Withdrawn", subject: "wait" });
  });

  test("runs every check, a failing one reported as fail", async () => {
    const results = await run(
      [
        registry,
        contributor(
          "p",
          [],
          [
            { id: "p.ok", title: "Fine", run: () => ({ status: "ok", message: "all good" }) },
            { id: "p.broken", title: "Broken", run: () => Promise.reject(new Error("no disk")) },
          ],
        ),
      ],
      Effect.flatMap(CliRunner, (runner) => runner.checks),
    );
    expect(results).toEqual([
      { id: "p.ok", title: "Fine", source: "p", status: "ok", message: "all good" },
      { id: "p.broken", title: "Broken", source: "p", status: "fail", message: "The check failed: no disk" },
    ]);
  });
});
