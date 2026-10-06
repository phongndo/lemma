import { describe, expect, test } from "vitest";
import { Effect, Exit, Fiber, Layer, Stream } from "effect";
import { Commands, CommandsChanged, InteractionError } from "@lemma/contracts";
import type { Command } from "@lemma/contracts";
import { definePlugin, Events, makeCore, makeLoader } from "@lemma/core";
import commands from "../src/index.ts";

const contributor = (id: string, contributed: readonly Command[]) =>
  definePlugin({
    id,
    requires: [Commands],
    layer: Layer.effectDiscard(Effect.flatMap(Commands, (registry) => Effect.forEach(contributed, registry.register, { discard: true }))),
  });

const command = (id: string, run: Command["run"] = () => Effect.void, fields: Partial<Command> = {}): Command => ({ id, title: id, ...fields, run });

const run = <A, E>(plugins: Parameters<typeof makeCore>[0], body: Effect.Effect<A, E, Commands>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(makeCore(plugins), (core) => core.run(body))));

describe("commands", () => {
  test("lists what each plugin registered, with its source, by category then title", async () => {
    const listed = await run(
      [
        commands,
        contributor("git", [command("git.b", undefined, { title: "Branch", category: "Git" }), command("git.a", undefined, { title: "Add", category: "Git" })]),
        contributor("host", [command("host.reload", undefined, { title: "Reload", category: "Host", keywords: ["config"] })]),
      ],
      Effect.flatMap(Commands, (registry) => registry.list),
    );
    expect(listed).toEqual([
      { id: "git.a", title: "Add", category: "Git", source: "git" },
      { id: "git.b", title: "Branch", category: "Git", source: "git" },
      { id: "host.reload", title: "Reload", category: "Host", keywords: ["config"], source: "host" },
    ]);
  });

  test("rejects a duplicate id, naming who registered it first", async () => {
    const exit = await Effect.runPromiseExit(Effect.scoped(makeCore([commands, contributor("first", [command("x")]), contributor("second", [command("x")])])));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("is already registered by first");
  });

  test("runs a command written with promises, or returning its result at once", async () => {
    const results = await run(
      [
        commands,
        contributor("plain", [
          command("async", async ({ cwd }) => ({ message: `async in ${cwd}` })),
          command("sync", () => ({ message: "at once" })),
          command("rejects", async () => Promise.reject(new Error("broke"))),
        ]),
      ],
      Effect.flatMap(Commands, (registry) =>
        Effect.all([registry.run("async", { cwd: "/w" }), registry.run("sync", { cwd: "/w" }), Effect.flip(registry.run("rejects", { cwd: "/w" }))]),
      ),
    );
    expect(results[0]).toEqual({ message: "async in /w" });
    expect(results[1]).toEqual({ message: "at once" });
    expect(results[2].reason).toBe("Failed");
  });

  test("runs a command with the caller's context; a void result is an empty one", async () => {
    const seen: unknown[] = [];
    const results = await run(
      [
        commands,
        contributor("p", [command("greet", (context) => Effect.sync(() => (seen.push(context), { message: "hi" }))), command("quiet", () => Effect.void)]),
      ],
      Effect.flatMap(Commands, (registry) => Effect.all([registry.run("greet", { cwd: "/w", sessionId: "s1" }), registry.run("quiet", { cwd: "/w" })])),
    );
    expect(results).toEqual([{ message: "hi" }, {}]);
    expect(seen).toEqual([{ cwd: "/w", sessionId: "s1" }]);
  });

  test("reports unknown ids, failures, defects, and dismissed questions as CommandError", async () => {
    const errors = await run(
      [
        commands,
        contributor("p", [
          command("fails", () => Effect.fail(new Error("disk full"))),
          command("dies", () => Effect.die("boom")),
          command("asks", () => Effect.fail(new InteractionError({ reason: "Dismissed", message: "closed" })), { title: "Ask me" }),
          command("unanswered", () => Effect.fail(new InteractionError({ reason: "Unavailable", message: "No client is attached" }))),
        ]),
      ],
      Effect.flatMap(Commands, (registry) =>
        Effect.all(["missing", "fails", "dies", "asks", "unanswered"].map((id) => Effect.flip(registry.run(id, { cwd: "/" })))),
      ),
    );
    expect(errors.map(({ command, reason, message }) => ({ command, reason, message }))).toEqual([
      { command: "missing", reason: "NotFound", message: 'No command "missing"' },
      { command: "fails", reason: "Failed", message: "disk full" },
      { command: "dies", reason: "Failed", message: "boom" },
      { command: "asks", reason: "Cancelled", message: "Ask me was cancelled" },
      { command: "unanswered", reason: "Failed", message: "No client is attached" },
    ]);
  });

  test("interrupting the caller interrupts the command", async () => {
    let interrupted = false;
    await run(
      [commands, contributor("p", [command("forever", () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (interrupted = true)))))])],
      Effect.gen(function* () {
        const registry = yield* Commands;
        const fiber = yield* Effect.forkChild(registry.run("forever", { cwd: "/" }));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      }),
    );
    expect(interrupted).toBe(true);
  });

  test("publishes the list when commands come and go with their plugin", async () => {
    const plugins = new Map([commands, contributor("p", [command("p.one")])].map((plugin) => [plugin.id, plugin]));
    const published = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const loader = yield* makeLoader({ source: { resolve: (id) => Effect.succeed(plugins.get(id)!) }, composition: { plugins: { commands: {} } } });
          const events = yield* loader.core.run(Events);
          const collected = yield* Effect.forkChild(Stream.runCollect(Stream.take(events.stream(CommandsChanged), 2)));
          // Let the subscription start before anything is published.
          yield* Effect.yieldNow;
          yield* loader.apply({ plugins: { commands: {}, p: {} } });
          yield* loader.apply({ plugins: { commands: {} } });
          return [...(yield* Fiber.join(collected))].map((event) => event.commands.map((info) => info.id));
        }),
      ),
    );
    expect(published).toEqual([["p.one"], []]);
  });
});
