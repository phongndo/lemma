import { describe, expect, test } from "vitest";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect";
import type { Context } from "effect";
import {
  Channels,
  CommandChannels,
  Commands,
  CommandsChanged,
  elementsOf,
  InteractionError,
  InteractionOrigin,
  resultOf,
  withdrawnFrom,
} from "@lemma/contracts";
import type { Channel, ChannelCall, ChannelStream, Command, CommandError, CommandInfo } from "@lemma/contracts";
import { callServed, pathsPlugin } from "@lemma/contracts/testing";
import { Admitted, definePlugin, Events, makeCore, makeLoader, Registries } from "@lemma/core";
import type { Plugin } from "@lemma/core";
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

  test("runs a command as part of its plugin's lifetime: what it does finds that plugin in Admitted, within the call that runs it", async () => {
    const whose = command("p.whose", () => Effect.map(Admitted, (admitted) => ({ message: admitted.map((work) => work.pluginId).join(" ") })));
    const ran = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([paths, commands, contributor("p", [whose])]);
          const registries = yield* core.run(Registries);
          const direct = yield* core.run(Effect.flatMap(Commands, (registry) => registry.run("p.whose", { cwd: "/" })));
          return [direct, yield* callServed(registries, "commands.run", { id: "p.whose" })];
        }),
      ),
    );
    // So a change the command asks for that restarts `p` (as `host.reload` may restart `commands-host`) waits for it to end.
    expect(ran).toEqual([{ message: "p" }, { message: "commands p" }]);
  });

  test("a command found just as a reload replaced it runs on the replacement; one found just as its plugin stopped is NotFound", async () => {
    let instances = 0;
    const counted = definePlugin({
      id: "p",
      requires: [Commands],
      layer: Layer.effectDiscard(
        Effect.flatMap(Commands, (registry) => {
          const instance = ++instances;
          return registry.register(command("p.which", () => ({ message: `instance ${instance}` })));
        }),
      ),
    });
    // What the commands plugin found at its last look, and whether its next look finds that again: a look from before a change.
    let last: unknown = [];
    let stale = false;
    const reader = (registries: Context.Service.Shape<typeof Registries>): Context.Service.Shape<typeof Registries> => ({
      items: (registry) => {
        if (registry.name !== "lemma/commands") return registries.items(registry);
        if (stale) return ((stale = false), Effect.succeed(last as never));
        return Effect.map(registries.items(registry), (items) => (last = items));
      },
      changes: registries.changes,
      run: registries.run,
      settled: registries.settled,
    });
    const looking: Plugin = {
      ...commands,
      layer: (config) => Layer.provide(commands.layer(config), Layer.effect(Registries, Effect.map(Registries, reader))),
    };
    const plugins = new Map([paths, looking, counted].map((plugin) => [plugin.id, plugin]));
    const [replaced, gone] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const loader = yield* makeLoader({
            source: { resolve: (id) => Effect.succeed(plugins.get(id)!) },
            composition: { plugins: { paths: {}, commands: {}, p: {} } },
          });
          const which = loader.core.run(Effect.flatMap(Commands, (registry) => registry.run("p.which", { cwd: "/" })));
          expect(yield* which).toEqual({ message: "instance 1" });
          yield* loader.core.restart("p", { force: true });
          stale = true;
          const replaced = yield* which;
          yield* loader.apply({ plugins: { paths: {}, commands: {} } });
          stale = true;
          return [replaced, yield* Effect.flip(which)] as const;
        }),
      ),
    );
    expect(replaced).toEqual({ message: "instance 2" });
    expect(gone).toMatchObject({ reason: "NotFound", command: "p.which" });
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

  test("a client's run ends Withdrawn at once when the command's plugin reloads or stops, despite a long dispose deadline, and that plugin's finalizers run once the command has stopped; run again, it reaches the replacement", async () => {
    let instances = 0;
    const log: string[] = [];
    const started = Effect.runSync(Queue.unbounded<number>());
    const waiting = definePlugin({
      id: "p",
      requires: [Commands],
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const instance = ++instances;
          yield* Effect.addFinalizer(() => Effect.sync(() => void log.push(`p ${instance} finalized`)));
          // Waits for good, as on a question nobody answers.
          const waits = Effect.andThen(Queue.offer(started, instance), Effect.never).pipe(
            Effect.onInterrupt(() => Effect.sync(() => void log.push(`p ${instance} stopped`))),
          );
          yield* (yield* Commands).register(command("p.waits", () => waits));
        }),
      ),
    });
    const plugins = new Map([paths, commands, waiting].map((plugin) => [plugin.id, plugin]));
    const ended = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const loader = yield* makeLoader({
            source: { resolve: (id) => Effect.succeed(plugins.get(id)!) },
            composition: { plugins: { paths: {}, commands: {}, p: {} } },
            deadlines: { dispose: Duration.seconds(30) },
          });
          const registries = yield* loader.core.run(Registries);
          // As the transport calls it: within the commands plugin's lifetime, which the command's plugin leaving does not end.
          const run = Effect.forkChild(Effect.flip(callServed(registries, "commands.run", { id: "p.waits" })));
          const reloaded = yield* run;
          expect(yield* Queue.take(started)).toBe(1);
          yield* loader.core.restart("p", { force: true });
          const first = yield* Fiber.join(reloaded);
          const stopped = yield* run;
          expect(yield* Queue.take(started)).toBe(2);
          yield* loader.apply({ plugins: { paths: {}, commands: {} } });
          return [first, yield* Fiber.join(stopped)];
        }),
      ).pipe(Effect.timeout(Duration.seconds(5))),
    );
    // What a client gets when the commands plugin itself leaves.
    expect(ended).toEqual([withdrawnFrom("commands.run", "call"), withdrawnFrom("commands.run", "call")]);
    expect(log).toEqual(["p 1 stopped", "p 1 finalized", "p 2 stopped", "p 2 finalized"]);
  });

  test("a command that outlives its plugin's dispose deadline is withdrawn: a client gets Withdrawn, and a caller in the host the CommandError, caused by the expiry", async () => {
    const started = Effect.runSync(Queue.unbounded<void>());
    const release = Deferred.makeUnsafe<void>();
    // Stops for nothing, its plugin leaving included, until the test lets it.
    const stuck = command("p.stuck", () => Effect.uninterruptible(Effect.andThen(Queue.offer(started, undefined), Deferred.await(release))));
    const [client, caller] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([paths, commands, contributor("p", [stuck])], { deadlines: { dispose: Duration.millis(20) } });
          const registries = yield* core.run(Registries);
          const registry = yield* core.run(Commands);
          // Both outside `core.run`, as the transport calls: a restart drains `core.run` work too.
          const served = yield* Effect.forkChild(Effect.flip(callServed(registries, "commands.run", { id: "p.stuck" })));
          const direct = yield* Effect.forkChild(Effect.flip(registry.run("p.stuck", { cwd: "/" })));
          yield* Queue.take(started);
          yield* Queue.take(started);
          // Done once the deadline has passed and the plugin's disposal went on without the work.
          yield* core.restart("p", { force: true });
          yield* Deferred.succeed(release, undefined);
          return [yield* Fiber.join(served), yield* Fiber.join(direct)] as const;
        }),
      ),
    );
    expect(client).toEqual(withdrawnFrom("commands.run", "call"));
    expect(caller).toMatchObject({ _tag: "CommandError", reason: "Withdrawn", command: "p.stuck", cause: { _tag: "RegistryError", reason: "Expired" } });
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

  test("a client that falls behind the changes stream receives the latest list, skipping the ones in between", async () => {
    const contributors = ["a", "b", "c", "d", "e", "f"].map((id) => contributor(id, [command(`${id}.run`)]));
    const plugins = new Map([paths, commands, ...contributors].map((plugin) => [plugin.id, plugin]));
    const ids = (list: readonly CommandInfo[]) => list.map((info) => info.id);
    const only = (id: string) => ({ plugins: { paths: {}, commands: {}, [id]: {} } });
    const lists = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const loader = yield* makeLoader({ source: { resolve: (id) => Effect.succeed(plugins.get(id)!) }, composition: only("a") });
          const changes = (yield* loader.core.run(served)).get("commands.changes") as ChannelStream;
          const pull = yield* Stream.toPull(elementsOf(changes, undefined));
          expect((yield* pull).map((list) => ids(list as readonly CommandInfo[]))).toEqual([["a.run"]]);
          // What the plugin publishes, heard at once, so the test knows when the last change has been published.
          const published = yield* Queue.unbounded<readonly string[]>();
          const events = yield* loader.core.run(Events);
          yield* Effect.forkScoped(
            Stream.runForEach(events.stream(CommandsChanged, { buffer: 64 }), ({ commands }) => Queue.offer(published, ids(commands))),
            { startImmediately: true },
          );
          // Five changes, each a different list, while the client reads none of them.
          for (const id of ["b", "c", "d", "e", "f"]) yield* loader.apply(only(id));
          let heard: readonly string[] = [];
          while (heard[0] !== "f.run") heard = yield* Queue.take(published);
          const read: string[][] = [];
          while (read.at(-1)?.[0] !== "f.run") read.push(...(yield* pull).map((list) => ids(list as readonly CommandInfo[])));
          return read;
        }),
      ),
    );
    // At most what the client and the stream's source each hold, and one on its way between them.
    expect(lists.length).toBeLessThanOrEqual(3);
    expect(lists.at(-1)).toEqual(["f.run"]);
  });
});
