import { describe, expect, test } from "vitest";
import { Deferred, Duration, Effect, Fiber, Option, Stream } from "effect";
import { RpcClientError } from "effect/rpc";
import { HostError } from "@lemma/contracts";
import type { InteractionRequest, RuntimeEvent } from "@lemma/contracts";
import { settled } from "../../../scripts/e2e.ts";
import { builtins, run } from "../src/cli.ts";
import { CliError, ExitCode } from "../src/command.ts";
import type { Connection, Failure, Globals, Io, Output } from "../src/command.ts";
import { fakeHost, fed, info } from "./fake.ts";
import type { Fed } from "./fake.ts";

/*
 * The runtime's commands that reach the host's channels, `channels call` and
 * `events`, and the question handling of a command that watches the host,
 * against a fake host (fake.ts).
 */

const refused = (code: string, subject: string) => () => Effect.fail(new HostError({ code, subject, message: `${code}: ${subject}` }));
const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

/** Runs one of lemma's own commands with `connection`. */
const builtin = (path: string, connection: Connection, io: Io, globals: Globals, args: Record<string, unknown> = {}, flags: Record<string, unknown> = {}) =>
  Effect.scoped(
    builtins.find((command) => command.path.join(" ") === path)!.run({ args, flags, io, globals, connect: Effect.succeed(connection), rerun: run }),
  ) as Effect.Effect<Output | undefined, Failure>;
const channelCall = (connection: Connection, id: string, payload?: string) => builtin("channels call", connection, quiet, options, { id, payload });
/** `lemma events`, watching until interrupted. */
const eventsCommand = (connection: Connection, io: Io, globals: Globals, channel: readonly string[] = []) =>
  builtin("events", connection, io, globals, {}, { channel });

/** The agent's and the sessions' stream elements, as JSON: this command knows no domain's types. */
type AgentActivity = { readonly type: string; readonly [field: string]: unknown };
type SessionsChange = AgentActivity;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const quiet: Io = { env: {}, cwd: "/", out: () => {}, err: () => {} };
const options: Globals = { json: true, quiet: false, answers: [], help: false };

describe("a channel's failure", () => {
  test("Unavailable naming the channel is the host still starting, and exits 3; a domain's own names what it concerns", async () => {
    const host = fakeHost({ calls: { "sessions.list": refused("Unavailable", "sessions.list"), "files.search": refused("Unavailable", "/work") } });
    expect(await failure(channelCall(host, "sessions.list", "{}"))).toMatchObject({
      code: "Unavailable",
      subject: "sessions.list",
      exit: ExitCode.unavailable,
    });
    const own = await failure(channelCall(host, "files.search", '{"cwd": "/work", "query": ""}'));
    expect(own).toBeInstanceOf(HostError);
    expect(own).toMatchObject({ code: "Unavailable", subject: "/work" });
  });

  test("NotFound naming the channel says nothing serves it; one naming a session is the session's", async () => {
    const host = fakeHost({ calls: { "sessions.get": refused("NotFound", "s1") } });
    const unserved = await failure(channelCall(host, "sessions.list"));
    expect(unserved).toBeInstanceOf(CliError);
    expect(unserved).toMatchObject({ code: "NotFound", subject: "sessions.list", exit: ExitCode.failed });
    expect(unserved.message).toContain("lemma plugins");
    expect(await failure(channelCall(host, "sessions.get", '{"sessionId": "s1"}'))).toMatchObject({ code: "NotFound", subject: "s1" });
  });

  test("a stream called is not said to be unserved", async () => {
    const host = fakeHost({ streams: { "agent.activity": () => fed({ type: "subscribed", running: [] }).stream } });
    expect(await failure(channelCall(host, "agent.activity"))).toMatchObject({
      code: "NotFound",
      subject: "agent.activity",
      message: '"agent.activity" is a stream, not a call: open it',
    });
  });

  test("Withdrawn naming the channel is its plugin reloading: the command says to run it again, and exits 1", async () => {
    const host = fakeHost({ calls: { "agent.cancel": refused("Withdrawn", "agent.cancel") } });
    const withdrawn = await failure(channelCall(host, "agent.cancel", '{"sessionId": "s1"}'));
    expect(withdrawn).toBeInstanceOf(CliError);
    expect(withdrawn).toMatchObject({ code: "Withdrawn", subject: "agent.cancel", exit: ExitCode.failed });
    expect(withdrawn.message).toContain("run the command again");
  });

  test("a call answers its result, and one with none null", async () => {
    const host = fakeHost({ calls: { "x.nothing": () => Effect.void, "x.list": () => Effect.succeed([1, 2]) } });
    expect(await Effect.runPromise(channelCall(host, "x.nothing"))).toEqual({ json: null, text: "called x.nothing: no result" });
    expect(await Effect.runPromise(channelCall(host, "x.list"))).toMatchObject({ json: [1, 2] });
  });
});

describe("a command that watches the host", () => {
  test("holds the host's questions if and only if it can answer them: watching, or leaving them to others, it holds none", async () => {
    const subscribed = async (terminal: Partial<Io>, fields: Partial<Globals>) => {
      const host = fakeHost({});
      const running = Effect.runFork(eventsCommand(host, { ...quiet, ...terminal }, { ...options, ...fields }));
      if ((await settled(async () => host.subscriptions().length > 0 || undefined)) === undefined) throw new Error("never subscribed");
      await Effect.runPromise(Fiber.interrupt(running));
      return host.subscriptions();
    };
    const ask = { ask: () => new Promise<string>(() => {}) };
    expect(await subscribed(ask, {})).toEqual([false]);
    expect(await subscribed(ask, { questions: "ignore" })).toEqual([false]);
    expect(await subscribed(ask, { questions: "ask" })).toEqual([true]);
    // Asked to ask, with no terminal to ask at: it cannot answer, so it holds none.
    expect(await subscribed({}, { questions: "ask" })).toEqual([false]);
    expect(await subscribed({}, { questions: "dismiss" })).toEqual([true]);
    expect(await subscribed({}, { questions: "ignore", answers: ["yes"] })).toEqual([true]);
    // `--answer` alone would answer every client's questions: it takes --questions too.
    expect(await failure(eventsCommand(fakeHost({}), quiet, { ...options, answers: ["yes"] }))).toMatchObject({ code: "Usage" });
  });

  test("fails at once when its first connection fails, saying why as a one-shot command would", async () => {
    // HTTP says why (a refused connection, a rejected token), where a WebSocket that fails does not.
    const refusedHttp = new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({ message: "connect ECONNREFUSED", cause: undefined }),
    });
    const unreachable = fakeHost({ rpcs: { "Host.Info": () => Effect.fail(refusedHttp) } });
    unreachable.drop();
    expect(await failure(eventsCommand(unreachable, quiet, options))).toBe(refusedHttp);

    // HTTP answers: the socket's own reason is all there is.
    const socketOnly = fakeHost({});
    socketOnly.drop();
    const failed = await failure(eventsCommand(socketOnly, quiet, options));
    expect(failed).toMatchObject({ code: "Unreachable", exit: ExitCode.unavailable });
    expect(failed.message).toContain("not over its WebSocket");
  });
});

describe("lemma events", () => {
  /** The streams a host serves that take no payload, and one that takes one (a session's log), refusing none. */
  const streams = (activities: Fed<AgentActivity>[]) => ({
    "agent.activity": () => {
      const opened = fed<AgentActivity>({ type: "subscribed", running: [] });
      activities.push(opened);
      return opened.stream;
    },
    "sessions.changes": () => fed<SessionsChange>({ type: "subscribed" }, { type: "session-removed", sessionId: "s1" }).stream,
    "llm.changes": () => fed({ type: "subscribed" }).stream,
    "commands.changes": () => fed([]).stream,
    "sessions.log": () => Stream.fail(new HostError({ code: "InvalidPayload", subject: "sessions.log", message: "Expected { sessionId }" })),
  });
  const until = async (done: () => boolean, lines: unknown) => {
    if ((await settled(async () => done() || undefined)) === undefined) throw new Error(`timed out: ${JSON.stringify(lines)}`);
  };

  test("prints each stream's elements with where they came from, following one its plugin withdrew again", async () => {
    const activities: Fed<AgentActivity>[] = [];
    const host = fakeHost({ streams: streams(activities) });
    const lines: { from: string; element: { type?: string } }[] = [];
    const io: Io = { ...quiet, out: (text) => void lines.push(JSON.parse(text)) };
    const following = Effect.runFork(eventsCommand(host, io, options));
    await until(() => activities.length === 1 && lines.some((line) => line.from === "commands.changes"), lines);
    activities[0]!.push({ type: "turn-started", sessionId: "s1", turnId: "t1", requestIds: [] });
    activities[0]!.fail(new HostError({ code: "Withdrawn", subject: "agent.activity", message: "withdrawn" }));
    await until(() => activities.length === 2, lines);
    activities[1]!.push({ type: "turn-ended", sessionId: "s1", turnId: "t1", usage, reason: "done" });
    await until(() => lines.some((line) => line.element.type === "turn-ended"), lines);
    await Effect.runPromise(Fiber.interrupt(following));
    const from = (source: string) => lines.filter((line) => line.from === source).map((line) => line.element.type ?? "list");
    expect(from("agent.activity")).toEqual(["subscribed", "turn-started", "subscribed", "turn-ended"]);
    expect(from("sessions.changes")).toEqual(["subscribed", "session-removed"]);
    expect(from("llm.changes")).toEqual(["subscribed"]);
    expect(from("commands.changes")).toEqual(["list"]);
    // A stream that takes a payload is left out.
    expect(from("sessions.log")).toEqual([]);
  });

  test("--channel follows only those streams, and says which take a payload", async () => {
    const activities: Fed<AgentActivity>[] = [];
    const host = fakeHost({ streams: streams(activities) });
    const lines: string[] = [];
    const io: Io = { ...quiet, out: (text) => void lines.push(text) };
    const following = Effect.runFork(eventsCommand(host, io, { ...options, json: false }, ["agent.activity", "sessions.log"]));
    await until(() => activities.length === 1 && lines.some((line) => line.startsWith("sessions.log takes a payload")), lines);
    activities[0]!.push({ type: "turn-started", sessionId: "s1", turnId: "t1", requestIds: [] });
    await until(() => lines.some((line) => line.includes("turn-started")), lines);
    await Effect.runPromise(Fiber.interrupt(following));
    // Each stream in its own order.
    expect(lines).toHaveLength(3);
    expect(lines).toEqual(
      expect.arrayContaining([
        "sessions.log takes a payload: lemma channels open sessions.log '<json>'",
        'agent.activity: {"type":"subscribed","running":[]}',
        'agent.activity: {"type":"turn-started","sessionId":"s1","turnId":"t1","requestIds":[]}',
      ]),
    );
  });

  test("answers a question already open, which the host sends as it subscribes, before its connection is confirmed", async () => {
    const approval: InteractionRequest = { type: "confirm", id: "q1", title: "Delete the branch?" };
    const waiting = [approval];
    const answered = Deferred.makeUnsafe<unknown>();
    const host: ReturnType<typeof fakeHost> = fakeHost({
      rpcs: {
        // The connect probe answers only once the client has passed on the question: it comes before the connection is confirmed.
        "Host.Info": () => Effect.andThen(host.heard(1), Effect.succeed(info)),
        "Interaction.List": () => Effect.sync(() => [...waiting]),
        "Interaction.Answer": (given: unknown) =>
          Effect.sync(() => {
            waiting.length = 0;
            Deferred.doneUnsafe(answered, Effect.succeed(given));
          }),
      },
    });
    const lines: { from: string; element: unknown }[] = [];
    const io: Io = { ...quiet, out: (text) => void lines.push(JSON.parse(text)) };
    const watching = Effect.runFork(eventsCommand(host, io, { ...options, questions: "ignore", answers: ["yes"] }));
    const given = await Effect.runPromise(Deferred.await(answered).pipe(Effect.timeoutOption(Duration.seconds(2))));
    await Effect.runPromise(Fiber.interrupt(watching));
    expect(given).toEqual(Option.some({ id: "q1", answer: { type: "confirm", value: true } }));
    expect(lines).toContainEqual({ from: "host", element: { type: "interaction", request: approval } });
  });

  test("goes on after its connection drops: each stream says it is subscribed anew", async () => {
    const activities: Fed<AgentActivity>[] = [];
    const host = fakeHost({ streams: streams(activities) });
    const lines: { from: string; element: { type?: string } }[] = [];
    const said: string[] = [];
    const io: Io = { ...quiet, out: (text) => void lines.push(JSON.parse(text)), err: (text) => void said.push(text) };
    const following = Effect.runFork(eventsCommand(host, io, options));
    const subscribed = (source: string) => lines.filter((line) => line.from === source && line.element.type === "subscribed").length;
    const sources = ["agent.activity", "sessions.changes", "llm.changes"];
    await until(() => sources.every((source) => subscribed(source) === 1), lines);
    host.drop();
    await until(() => said.length === 1, said);
    host.restore();
    await until(() => sources.every((source) => subscribed(source) === 2), lines);
    // Heard on the new connection.
    activities[1]!.push({ type: "turn-started", sessionId: "s1", turnId: "t1", requestIds: [] });
    await until(() => lines.some((line) => line.element.type === "turn-started"), lines);
    await Effect.runPromise(Fiber.interrupt(following));
    expect(said).toEqual(["lemma: lost the connection to the host; reconnecting…", "lemma: reconnected to the host"]);
  });
});

describe("a command's --answer values", () => {
  const confirm = (id: string): InteractionRequest => ({ type: "confirm", id, title: `${id}?` });

  /**
   * A host asking the questions `open`, answered as the host's are: an answer
   * closes its question, and one for a question no longer open fails
   * `NotFound`. What `meanwhile` is given runs as the next subscription reads
   * what is open, so what it does comes right after what that subscription
   * starts with: a question that closes elsewhere, or another asked, while the
   * command connects. What `whenTaken` is given runs as the host takes the next
   * answer, before it replies. The connect probe answers once the client has
   * passed on `beforeProbe` of the host's events.
   */
  const asking = (open: readonly InteractionRequest[], beforeProbe = 0) => {
    const waiting = new Map(open.map((request) => [request.id, request]));
    const answered: (readonly [string, unknown])[] = [];
    const events = fed<RuntimeEvent>();
    const ask = (request: InteractionRequest) => {
      waiting.set(request.id, request);
      events.push({ type: "interaction", request });
    };
    const close = (id: string) => {
      waiting.delete(id);
      events.push({ type: "interaction-closed", id });
    };
    let next: (() => void) | undefined;
    let taken: (() => void) | undefined;
    const connection: ReturnType<typeof fakeHost> = fakeHost({
      events: events.stream,
      rpcs: {
        "Host.Info": () => Effect.andThen(connection.heard(beforeProbe), Effect.succeed(info)),
        "Interaction.List": () =>
          Effect.sync(() => {
            const now = [...waiting.values()];
            const then = next;
            next = undefined;
            then?.();
            return now;
          }),
        "Interaction.Answer": ({ id, answer }: { id: string; answer: { value: unknown } }) =>
          Effect.suspend(() => {
            if (!waiting.has(id)) return Effect.fail(new HostError({ code: "NotFound", subject: id, message: `No open interaction "${id}"` }));
            answered.push([id, answer.value]);
            close(id);
            const then = taken;
            taken = undefined;
            then?.();
            return Effect.void;
          }),
      },
    });
    return {
      connection,
      answered,
      ask,
      close,
      publish: (event: RuntimeEvent) => events.push(event),
      meanwhile: (run: () => void) => void (next = run),
      whenTaken: (run: () => void) => void (taken = run),
    };
  };

  /** Runs `command` in the background: `until` waits for a condition, two seconds at most, and `stop` ends it. */
  const started = (command: Effect.Effect<unknown, unknown>) => {
    const running = Effect.runFork(command);
    return {
      until: (done: () => boolean) =>
        settled(
          async () => done() || undefined,
          () => true,
          2_000,
        ),
      stop: () => Effect.runPromise(Fiber.interrupt(running)),
    };
  };

  /** Closes the question `old` before the answer to it comes, and asks `live`, as the next subscription starts with what is open. */
  const closingOld = (host: ReturnType<typeof asking>) =>
    host.meanwhile(() => {
      host.close("old");
      host.ask(confirm("live"));
    });

  test("one that reached a question already closed goes to the next question, as the command connects", async () => {
    const host = asking([confirm("old")], 3);
    closingOld(host);
    const command = started(eventsCommand(host.connection, quiet, { ...options, questions: "ignore", answers: ["yes"] }));
    await command.until(() => host.answered.length > 0);
    await command.stop();
    expect(host.answered).toEqual([["live", true]]);
  });

  test("one that reached a question already closed goes to the next question, after a reconnect", async () => {
    const host = asking([]);
    const printed: string[] = [];
    const said: string[] = [];
    const io: Io = { ...quiet, out: (text) => void printed.push(text), err: (text) => void said.push(text) };
    const command = started(eventsCommand(host.connection, io, { ...options, questions: "ignore", answers: ["yes"] }));
    // Connected, and hearing the host: its notice prints.
    host.publish({ type: "notice", notice: { level: "info", message: "hello" } });
    await command.until(() => printed.length > 0);
    host.connection.drop();
    await command.until(() => said.length > 0);
    // Asked while the command is away: the next subscription starts with it.
    host.ask(confirm("old"));
    closingOld(host);
    host.connection.restore();
    await command.until(() => host.answered.length > 0);
    await command.stop();
    expect(host.answered).toEqual([["live", true]]);
  });

  test("one the host may have taken before the connection dropped is used up, though sent again it finds the question closed", async () => {
    const host = asking([confirm("first"), confirm("second")]);
    // The host takes it, and the connection drops before its reply comes: sent again, it finds the question it closed.
    host.whenTaken(() => {
      host.connection.drop();
      host.connection.restore();
    });
    const said: string[] = [];
    const io: Io = { ...quiet, err: (text) => void said.push(text) };
    const command = started(eventsCommand(host.connection, io, { ...options, questions: "ignore", answers: ["yes"] }));
    // With no answer left for it, the next question is left to another client.
    const leftToOthers = () => said.some((line) => line.includes('"second?"'));
    await command.until(() => host.answered.length > 1 || leftToOthers());
    await command.stop();
    expect(host.answered).toEqual([["first", true]]);
    expect(leftToOthers()).toBe(true);
  });

  test("keep their order past a question that closed before its answer came", async () => {
    const host = asking([confirm("first"), confirm("old")], 4);
    closingOld(host);
    const command = started(eventsCommand(host.connection, quiet, { ...options, questions: "ignore", answers: ["yes", "no"] }));
    await command.until(() => host.answered.length > 1);
    await command.stop();
    expect(host.answered).toEqual([
      ["first", true],
      ["live", false],
    ]);
  });

  test("run out, a question whose closing came with it does not stay at the terminal", async () => {
    const host = asking([confirm("old")], 3);
    closingOld(host);
    const asked: { readonly question: string; readonly signal: AbortSignal | undefined }[] = [];
    const io: Io = {
      ...quiet,
      ask: (question, _secret, signal) => {
        asked.push({ question, signal });
        return new Promise<string>(() => {});
      },
    };
    const waiting = () => asked.filter(({ signal }) => signal?.aborted !== true).map(({ question }) => question);
    const command = started(eventsCommand(host.connection, io, { ...options, questions: "ask" }));
    await command.until(() => waiting().length > 0);
    const open = waiting();
    await command.stop();
    expect(open).toEqual(["live? [y/n] "]);
  });
});
