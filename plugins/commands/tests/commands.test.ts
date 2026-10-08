import { describe, expect, test } from "vitest";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect";
import { Channels, CommandChannels, Commands, CommandsChanged, elementsOf, InteractionError, InteractionOrigin, resultOf } from "@lemma/contracts";
import type { Channel, ChannelCall, ChannelStream, Command, CommandError, CommandInfo } from "@lemma/contracts";
import { callServed, pathsPlugin } from "@lemma/contracts/testing";
import { definePlugin, Events, makeCore, makeLoader, Registries } from "@lemma/core";
import commands from "../src/index.ts";

const contributor = (id: string, contributed: readonly Command[]) =>
  definePlugin({
    id,
    requires: [Commands],
    layer: Layer.effectDiscard(Effect.flatMap(Commands, (registry) => Effect.forEach(contributed, registry.register, { discard: true }))),
  });

const command = (id: string, run: Command["run"] = () => Effect.void, fields: Partial<Command> = {}): Command => ({ id, title: id, ...fields, run });

/** The host's paths: its working directory is `/project`. */
const paths = pathsPlugin("/lemma", { cwd: "/project" });

const run = <A, E>(plugins: Parameters<typeof makeCore>[0], body: Effect.Effect<A, E, Commands | Registries>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(makeCore([paths, ...plugins]), (core) => core.run(body))));

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
    const exit = await Effect.runPromiseExit(
      Effect.scoped(makeCore([paths, commands, contributor("first", [command("x")]), contributor("second", [command("x")])])),
    );
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
    const plugins = new Map([paths, commands, contributor("p", [command("p.one")])].map((plugin) => [plugin.id, plugin]));
    const published = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const loader = yield* makeLoader({
            source: { resolve: (id) => Effect.succeed(plugins.get(id)!) },
            composition: { plugins: { paths: {}, commands: {} } },
          });
          const events = yield* loader.core.run(Events);
          const collected = yield* Effect.forkChild(Stream.runCollect(Stream.take(events.stream(CommandsChanged), 2)));
          // Let the subscription start before anything is published.
          yield* Effect.yieldNow;
          yield* loader.apply({ plugins: { paths: {}, commands: {}, p: {} } });
          yield* loader.apply({ plugins: { paths: {}, commands: {} } });
          return [...(yield* Fiber.join(collected))].map((event) => event.commands.map((info) => info.id));
        }),
      ),
    );
    expect(published).toEqual([["p.one"], []]);
  });
});

/**
 * The channels the commands plugin serves, as the transport finds them, to be
 * driven as it drives them (`resultOf`, `elementsOf`). The transport's tests,
 * which run this plugin, drive them over the wire; depending on the transport
 * here would be a cycle.
 */
const served = Effect.map(
  Effect.flatMap(Registries, (registries) => registries.items(Channels)),
  (items) => new Map(items.filter(({ pluginId }) => pluginId === "commands").map(({ item }) => [item.id, item])),
);

const callOf = (channels: ReadonlyMap<string, Channel>, id: string) => channels.get(id) as ChannelCall;

/** A call's domain error, as the transport turns it into the client's code (its reason) and subject (its command). */
const refusal = (effect: Effect.Effect<unknown, unknown>) => Effect.map(Effect.flip(effect), (error) => error as CommandError);

describe("channels", () => {
  test("serves listing, running, and following commands, each with what it does", async () => {
    const channels = await run([commands], served);
    expect([...channels.values()].map(({ id, kind }) => `${kind} ${id}`)).toEqual(Object.values(CommandChannels).map(({ id, kind }) => `${kind} ${id}`));
    for (const channel of channels.values()) expect(channel).toMatchObject({ title: expect.any(String), description: expect.any(String) });
  });

  test("lists commands, and runs one in the caller's directory or the host's, its questions carrying the caller's origin", async () => {
    const seen: unknown[] = [];
    const [listed, here, there] = await run(
      [
        commands,
        contributor("p", [
          command("p.where", (context) =>
            Effect.map(Effect.service(InteractionOrigin), (origin) => {
              seen.push({ context, origin });
              return { message: context.cwd };
            }),
          ),
        ]),
      ],
      Effect.flatMap(served, (channels) =>
        Effect.all([
          resultOf(callOf(channels, "commands.list"), undefined),
          resultOf(callOf(channels, "commands.run"), { id: "p.where" }),
          resultOf(callOf(channels, "commands.run"), { id: "p.where", cwd: "/elsewhere", sessionId: "s1", origin: "palette-1" }),
        ]),
      ),
    );
    expect(listed).toEqual([{ id: "p.where", title: "p.where", source: "p" }]);
    expect([here, there]).toEqual([{ message: "/project" }, { message: "/elsewhere" }]);
    // Strictly: a run with no session has no `sessionId` key at all.
    expect(seen).toStrictEqual([
      { context: { cwd: "/project" }, origin: undefined },
      { context: { cwd: "/elsewhere", sessionId: "s1" }, origin: "palette-1" },
    ]);
  });

  test("a refused run fails with a CommandError naming the command and why", async () => {
    const errors = await run(
      [commands, contributor("p", [command("p.asks", () => Effect.fail(new InteractionError({ reason: "Dismissed", message: "closed" })), { title: "Ask" })])],
      Effect.flatMap(served, (channels) =>
        Effect.all([
          refusal(resultOf(callOf(channels, "commands.run"), { id: "nope" })),
          refusal(resultOf(callOf(channels, "commands.run"), { id: "p.asks" })),
        ]),
      ),
    );
    expect(errors.map(({ _tag, reason, command }) => ({ _tag, reason, command }))).toEqual([
      { _tag: "CommandError", reason: "NotFound", command: "nope" },
      { _tag: "CommandError", reason: "Cancelled", command: "p.asks" },
    ]);
  });

  test("a client's run ends Withdrawn when the commands plugin leaves, despite a long dispose deadline, and stops the command; run again, it reaches the replacement", async () => {
    const started = Deferred.makeUnsafe<void>();
    let runs = 0;
    let stopped = false;
    // The first run waits for good, as on a question nobody answers; later ones answer at once.
    const waits = command("p.waits", () =>
      ++runs === 1
        ? Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(Effect.onInterrupt(() => Effect.sync(() => void (stopped = true))))
        : Effect.succeed({ message: "done" }),
    );
    const [ended, again] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([paths, commands, contributor("p", [waits])], { deadlines: { dispose: Duration.seconds(30) } });
          const registries = yield* core.run(Registries);
          // As the transport calls it: within the plugin's lifetime, which ends only once the call does.
          const running = yield* Effect.forkChild(Effect.exit(callServed(registries, "commands.run", { id: "p.waits" })));
          yield* Deferred.await(started);
          yield* core.restart("commands", { force: true });
          return [yield* Fiber.join(running), yield* callServed(registries, "commands.run", { id: "p.waits" })] as const;
        }),
      ).pipe(Effect.timeout(Duration.seconds(5))),
    );
    expect(Exit.isFailure(ended) && Cause.squash(ended.cause)).toMatchObject({ code: "Withdrawn", subject: "commands.run" });
    expect(stopped).toBe(true);
    expect(again).toEqual({ message: "done" });
  });

  test("the changes stream starts with every command now, then sends the list after each change", async () => {
    const plugins = new Map([paths, commands, contributor("p", [command("p.one")])].map((plugin) => [plugin.id, plugin]));
    const ids = (list: readonly CommandInfo[]) => list.map((info) => info.id);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const loader = yield* makeLoader({
            source: { resolve: (id) => Effect.succeed(plugins.get(id)!) },
            composition: { plugins: { paths: {}, commands: {}, p: {} } },
          });
          const changes = (yield* loader.core.run(served)).get("commands.changes") as ChannelStream;
          const received = yield* Queue.unbounded<readonly CommandInfo[]>();
          yield* Effect.forkScoped(Stream.runForEach(elementsOf(changes, undefined), (list) => Queue.offer(received, list as readonly CommandInfo[])));
          // What a client resyncs from, and how it knows the stream is live.
          expect(ids(yield* Queue.take(received))).toEqual(["p.one"]);
          yield* loader.apply({ plugins: { paths: {}, commands: {} } });
          expect(ids(yield* Queue.take(received))).toEqual([]);
          yield* loader.apply({ plugins: { paths: {}, commands: {}, p: {} } });
          expect(ids(yield* Queue.take(received))).toEqual(["p.one"]);
        }),
      ),
    );
  });
});
