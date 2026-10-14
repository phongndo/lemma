import { randomUUID } from "node:crypto";
import { Cause, Duration, Effect, Exit, Fiber, Queue, Schema, Stream } from "effect";
import type { Context, Scope } from "effect";
import { awaitable, definePlugin, PluginContext, Registries } from "@lemma/core";
import type { Awaitable, Contribution } from "@lemma/core";
import { Channels, HostError, Inspectors, InteractionError, InteractionOrigin, withContribution } from "@lemma/contracts";
import { asHostError, CliChecks, CliCommands, CliRunner, closest, describeFailure, InProgress, inputProblem, plainJson, serveCli } from "@lemma/cli";
import type { CheckResult, CliCommand, CliCommandInfo, CliContext, CliElement, CliResult, RunRequest } from "@lemma/cli";

type Service = Context.Service.Shape<typeof CliRunner>;

const Config = Schema.Struct({
  resumeGraceMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 30_000)))
    .annotate({
      description:
        "How long a command runs on once its client's connection drops, for the client to rejoin it; and how long a finished one's output is kept for a client that dropped just before the end.",
    }),
  bufferLimit: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(16))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 10_000)))
    .annotate({ description: "How many of a command's elements are kept for a client to rejoin from; one that fell further behind cannot." }),
});
type Config = typeof Config.Type;

/** How long a check may take before it is reported as failed. */
const CHECK_TIMEOUT = Duration.seconds(10);

const nameOf = (path: readonly string[]) => path.join(" ");

/** What clients see of each command: its spec fields and its plugin, never whatever else a plugin put on it. */
const infoOf = ({ item, pluginId }: Contribution<CliCommand>): CliCommandInfo => ({
  path: item.path,
  summary: item.summary,
  ...(item.description === undefined ? {} : { description: item.description }),
  ...(item.args === undefined ? {} : { args: item.args }),
  ...(item.flags === undefined ? {} : { flags: item.flags }),
  ...(item.examples === undefined ? {} : { examples: item.examples }),
  source: pluginId,
});

/** One run of a command: what it sent so far (the last `bufferLimit` elements), its end once it has one, and who is reading. */
interface Invocation {
  readonly id: string;
  readonly path: string;
  readonly startedAt: number;
  readonly elements: CliElement[];
  /** The position of `elements[0]` among all it sent, `started` being 0. */
  first: number;
  ended: Exit.Exit<void, HostError> | undefined;
  readonly readers: Set<Queue.Queue<CliElement, HostError | Cause.Done>>;
  fiber: Fiber.Fiber<void, unknown> | undefined;
  /** Ends it, or forgets it once ended, unless a reader comes first. */
  expiry: Fiber.Fiber<void> | undefined;
}

const withdrawn = (path: string, pluginId: string) =>
  new HostError({
    code: "Withdrawn",
    subject: path,
    message: `"lemma ${path}" was withdrawn while it ran: ${pluginId}, which added it, stopped or was replaced`,
  });

const makeRunner = (
  config: Config,
): Effect.Effect<Service & { readonly running: () => readonly Invocation[] }, never, PluginContext | Registries | Scope.Scope> =>
  Effect.gen(function* () {
    const owner = yield* PluginContext;
    const registries = yield* Registries;
    const scope = yield* Effect.scope;
    const invocations = new Map<string, Invocation>();
    const grace = Duration.millis(config.resumeGraceMs);

    const list = Effect.map(registries.items(CliCommands), (items) => items.map(infoOf).sort((a, b) => nameOf(a.path).localeCompare(nameOf(b.path))));

    const push = (invocation: Invocation, element: CliElement) => {
      if (invocation.ended !== undefined) return;
      invocation.elements.push(element);
      if (invocation.elements.length > config.bufferLimit) {
        invocation.elements.shift();
        invocation.first++;
      }
      for (const reader of invocation.readers) Queue.offerUnsafe(reader, element);
    };

    /** Forgets it after `grace`, ending it first if it still runs: what happens when no reader comes back. */
    const expire = (invocation: Invocation) =>
      Effect.gen(function* () {
        if (invocation.expiry !== undefined) yield* Fiber.interrupt(invocation.expiry);
        invocation.expiry = yield* Effect.forkIn(
          Effect.andThen(
            Effect.sleep(grace),
            Effect.suspend(() => {
              invocations.delete(invocation.id);
              // Its own fiber now: the end it causes schedules no expiry of this one, which would wait on itself.
              invocation.expiry = undefined;
              const fiber = invocation.fiber;
              return fiber === undefined || invocation.ended !== undefined ? Effect.void : Effect.asVoid(Effect.forkIn(Fiber.interrupt(fiber), scope));
            }),
          ),
          scope,
        );
      });

    const finish = (invocation: Invocation, exit: Exit.Exit<void, HostError>) =>
      Effect.suspend(() => {
        invocation.ended = exit;
        for (const reader of invocation.readers) {
          if (Exit.isSuccess(exit)) Queue.endUnsafe(reader);
          else Queue.failCauseUnsafe(reader, exit.cause);
        }
        return expire(invocation);
      });

    /** Its elements from position `from` on, then the rest as they come, until it ends. */
    const attach = (invocation: Invocation, from: number): Stream.Stream<CliElement, HostError> =>
      Stream.callback<CliElement, HostError>((queue) =>
        Effect.acquireRelease(
          // In one step, with nothing between: an element pushed, or the end, after the buffer is copied reaches this reader.
          Effect.suspend(() => {
            if (from < invocation.first)
              return Effect.fail(
                new HostError({
                  code: "Expired",
                  subject: invocation.id,
                  message: `The output of "lemma ${invocation.path}" from where this client left it is no longer kept`,
                }),
              );
            for (const element of invocation.elements.slice(from - invocation.first)) Queue.offerUnsafe(queue, element);
            const ended = invocation.ended;
            if (ended !== undefined) {
              if (Exit.isSuccess(ended)) Queue.endUnsafe(queue);
              else Queue.failCauseUnsafe(queue, ended.cause);
              return Effect.succeed(false);
            }
            invocation.readers.add(queue);
            const expiry = invocation.expiry;
            invocation.expiry = undefined;
            return Effect.as(expiry === undefined ? Effect.void : Fiber.interrupt(expiry), true);
          }),
          (added) =>
            Effect.suspend(() => {
              if (!added) return Effect.void;
              invocation.readers.delete(queue);
              // The last reader gone while it runs: its client dropped. It runs on for a while, for the client to rejoin.
              return invocation.readers.size === 0 && invocation.ended === undefined ? expire(invocation) : Effect.void;
            }),
        ),
      );

    const contextOf = (invocation: Invocation, request: RunRequest): CliContext => {
      const text = (value: string, options?: { readonly err?: boolean }) =>
        push(invocation, { type: "text", text: value, ...(options?.err === true ? { err: true } : {}) });
      return {
        args: request.input.args,
        flags: request.input.flags,
        cwd: request.cwd,
        json: request.json,
        columns: request.columns,
        origin: request.origin,
        out: {
          text,
          line: (value, options) => text(`${value}\n`, options),
          json: (value) => push(invocation, { type: "json", value: plainJson(value) ?? null }),
          open: (target, prompt) => push(invocation, { type: "open", ...target, ...(prompt === undefined ? {} : { prompt }) }),
          answer: (origin) => push(invocation, { type: "answer", origin }),
          rerun: (args) => push(invocation, { type: "rerun", args: [...args] }),
        },
      };
    };

    const resultElement = (result: CliResult | void): CliElement => ({
      type: "result",
      ...(result?.json === undefined ? {} : { json: plainJson(result.json) }),
      ...(result?.text === undefined ? {} : { text: result.text }),
      ...(result?.ids === undefined ? {} : { ids: [...result.ids] }),
      ...(result?.failed === true ? { failed: true } : {}),
    });

    /** What a command's failure reaches its client as: its code kept, a dismissed question `Cancelled`. */
    const failureOf = (path: string, cause: Cause.Cause<unknown>): HostError => {
      const error = Cause.squash(cause);
      if (error instanceof InteractionError && error.reason === "Dismissed")
        return new HostError({ code: "Cancelled", subject: path, message: `"lemma ${path}" was cancelled: a question it asked was dismissed` });
      return asHostError(error, path);
    };

    const start = (contribution: Contribution<CliCommand>, request: RunRequest): Effect.Effect<Invocation> =>
      Effect.gen(function* () {
        const path = nameOf(contribution.item.path);
        const invocation: Invocation = {
          id: randomUUID(),
          path,
          startedAt: Date.now(),
          elements: [],
          first: 0,
          ended: undefined,
          readers: new Set(),
          fiber: undefined,
          expiry: undefined,
        };
        invocation.elements.push({ type: "started", invocation: invocation.id });
        invocations.set(invocation.id, invocation);
        const context = contextOf(invocation, request);
        // Within the lifetime of the plugin that added it, found again if a reload replaced it first; it stops when that
        // plugin leaves rather than hold up its stop, as it may wait on a question for good.
        const work = withContribution(
          registries,
          () => Effect.map(registries.items(CliCommands), (items) => items.find((item) => nameOf(item.item.path) === path)),
          ({ item, pluginId }, left) =>
            Effect.raceFirst(
              awaitable(() => item.run(context)),
              Effect.andThen(left, Effect.fail(withdrawn(path, pluginId))),
            ),
          {
            missing: () => withdrawn(path, contribution.pluginId),
            expired: ({ pluginId }) => withdrawn(path, pluginId),
          },
        ).pipe(Effect.provideService(InteractionOrigin, request.origin));
        invocation.fiber = yield* Effect.forkIn(
          owner.trace(`cli.run ${path}`, work).pipe(
            // A finalizer, so its readers hear of its end however it ended, interrupted (cancelled, or left too long) too.
            Effect.onExit((exit) => {
              if (Exit.isSuccess(exit)) {
                push(invocation, resultElement(exit.value));
                return finish(invocation, Exit.void);
              }
              if (Cause.hasInterruptsOnly(exit.cause)) {
                invocations.delete(invocation.id);
                return finish(invocation, Exit.fail(new HostError({ code: "Cancelled", subject: path, message: `"lemma ${path}" was cancelled` })));
              }
              return finish(invocation, Exit.fail(failureOf(path, exit.cause)));
            }),
            Effect.asVoid,
          ),
          scope,
          { startImmediately: true },
        );
        return invocation;
      });

    const run: Service["run"] = (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (request.resume !== undefined) {
            const invocation = invocations.get(request.resume.invocation);
            if (invocation === undefined)
              return yield* new HostError({
                code: "Expired",
                subject: request.resume.invocation,
                message: "That command is no longer running here: it ended, was cancelled, or its client stayed away too long",
              });
            return attach(invocation, request.resume.received);
          }
          const path = nameOf(request.path);
          const items = yield* registries.items(CliCommands);
          const found = items.find((item) => nameOf(item.item.path) === path);
          if (found === undefined) {
            const near = closest(
              path,
              items.map((item) => nameOf(item.item.path)),
            );
            return yield* new HostError({
              code: "UnknownCommand",
              subject: path,
              message: `No command "lemma ${path}"${near === undefined ? "" : `; did you mean "lemma ${near}"?`}`,
            });
          }
          const problem = inputProblem(found.item, request.input);
          if (problem !== undefined) return yield* new HostError({ code: "Usage", subject: path, message: problem });
          return attach(yield* start(found, request), 0);
        }),
      );

    const cancel: Service["cancel"] = (id) =>
      Effect.suspend(() => {
        const invocation = invocations.get(id);
        if (invocation === undefined) return Effect.succeed(false);
        invocations.delete(id);
        return Effect.as(invocation.fiber === undefined || invocation.ended !== undefined ? Effect.void : Fiber.interrupt(invocation.fiber), true);
      });

    const checks: Service["checks"] = Effect.flatMap(registries.items(CliChecks), (items) =>
      Effect.forEach(
        items,
        ({ item, pluginId }): Effect.Effect<CheckResult> =>
          awaitable(() => item.run()).pipe(
            Effect.timeoutOrElse({
              duration: CHECK_TIMEOUT,
              orElse: () => Effect.fail(new Error(`it took longer than ${Duration.toSeconds(CHECK_TIMEOUT)}s`)),
            }),
            Effect.map((outcome) => ({ id: item.id, title: item.title, source: pluginId, ...outcome })),
            Effect.catchCause((cause) =>
              Effect.succeed({
                id: item.id,
                title: item.title,
                source: pluginId,
                status: "fail" as const,
                message: `The check failed: ${describeFailure(Cause.squash(cause))}`,
              }),
            ),
          ),
        { concurrency: "unbounded" },
      ),
    );

    // A reporter that fails reports nothing: what it would say is a guess, and the rest still are.
    const inProgress: Service["inProgress"] = Effect.flatMap(registries.items(InProgress), (items) =>
      Effect.map(
        Effect.forEach(
          items,
          ({ item, pluginId }) =>
            (Effect.isEffect(item.items) ? item.items : awaitable(() => (item.items as () => Awaitable<readonly string[]>).call(item))).pipe(
              Effect.map((work) => ({ id: item.id, title: item.title, source: pluginId, items: [...work] })),
              Effect.catchCause(() => Effect.succeed({ id: item.id, title: item.title, source: pluginId, items: [] as string[] })),
            ),
          { concurrency: "unbounded" },
        ),
        (reports) => reports.filter((report) => report.items.length > 0),
      ),
    );

    return { list, run, cancel, checks, inProgress, running: () => [...invocations.values()] };
  });

/**
 * Provides `CliRunner`, which lists and runs the commands plugins add to the
 * `lemma` command (`CliCommands`) and their checks (`CliChecks`), and serves
 * it to clients as channels.
 */
export default definePlugin({
  id: "cli.registry",
  version: "0.1.0",
  config: Config,
  provides: { cli: CliRunner },
  setup: function* (_, owner) {
    const { running, ...cli } = yield* makeRunner(owner.config);
    yield* Effect.forEach(serveCli(cli), (channel) => owner.add(Channels, channel));
    // What the devtools and `lemma inspectors` show of it. Only a view: failing to add it never stops the commands.
    yield* owner
      .add(Inspectors, {
        id: "cli.commands",
        title: "CLI commands",
        description: "The commands plugins add to the lemma command, and those running now",
        snapshot: Effect.map(cli.list, (commands) => ({
          commands: commands.map((command) => ({ command: `lemma ${nameOf(command.path)}`, summary: command.summary, plugin: command.source })),
          running: running().map((invocation) => ({
            invocation: invocation.id,
            command: `lemma ${invocation.path}`,
            startedAt: new Date(invocation.startedAt).toISOString(),
            readers: invocation.readers.size,
            state: invocation.ended === undefined ? "running" : Exit.isSuccess(invocation.ended) ? "done" : "failed",
          })),
        })),
      })
      .pipe(Effect.ignore);
    return { cli };
  },
});
