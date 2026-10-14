import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Stream } from "effect";
import type { Scope } from "effect";
import { RpcClientError } from "effect/rpc";
import { describe, expect, test } from "vitest";
import { HostError } from "@lemma/contracts";
import type { InteractionRequest, RuntimeEvent } from "@lemma/contracts";
import type { CliCommandInfo, CliElement, RunRequest } from "@lemma/cli";
import { settled } from "../../../scripts/e2e.ts";
import { builtins } from "../src/cli.ts";
import { CliError, ExitCode } from "../src/command.ts";
import type { Failure, Globals, Io, Output } from "../src/command.ts";
import { toCliError } from "../src/connect.ts";
import { hostedCommand } from "../src/hosted.ts";
import { fakeHost, fed } from "./fake.ts";

/*
 * The commands host plugins add, as `lemma` runs them (`hosted.ts`): listed
 * by the host (`cli.commands`), parsed here with their spec, and run there
 * (`cli.run`), against a fake host that serves both as a test says.
 */

const commands: CliCommandInfo[] = [
  {
    path: ["greet"],
    summary: "Greet someone",
    args: [{ name: "who", description: "Whom", required: true }],
    flags: {
      loud: { type: "boolean", description: "Shout" },
      photo: { type: "file", accept: ["image/png"], description: "A photo" },
    },
    source: "greeter",
  },
  { path: ["tools", "list"], summary: "List tools", source: "greeter" },
  { path: ["tools", "show"], summary: "Show a tool", source: "greeter" },
];

/** A host whose `cli.run` answers each request with what `run` gives; `requests` are what it was sent, `cancelled` the invocations cancelled. */
const hostWith = (
  run: (request: RunRequest, index: number) => Stream.Stream<CliElement, HostError>,
  options: { readonly events?: Stream.Stream<RuntimeEvent, HostError>; readonly answered?: (id: string, answer: unknown) => void } = {},
) => {
  const requests: RunRequest[] = [];
  const cancelled: string[] = [];
  const connection = fakeHost({
    calls: {
      "cli.commands": () => Effect.succeed(commands),
      "cli.cancel": ({ invocation }: { invocation: string }) => Effect.sync(() => (cancelled.push(invocation), true)),
    },
    streams: {
      "cli.run": (request: RunRequest) => {
        requests.push(request);
        return run(request, requests.length - 1);
      },
    },
    ...(options.events === undefined ? {} : { events: options.events }),
    rpcs: {
      "Interaction.Answer": ({ id, answer }: { id: string; answer: unknown }) => Effect.sync(() => options.answered?.(id, answer)),
    },
  });
  return { connection, requests, cancelled };
};

const globals = (fields: Partial<Globals> = {}): Globals => ({ json: false, quiet: false, answers: [], help: false, ...fields });

/** A terminal that keeps what is printed to it, and what it asks and opens; `browser: false` has none to open pages in. */
const terminal = (fields: Partial<Io> = {}, browser = true) => {
  const tty = { out: "", err: [] as string[], opened: [] as string[] };
  const io: Io = {
    env: {},
    cwd: "/work",
    out: (text) => void (tty.out += `${text}\n`),
    write: (text) => void (tty.out += text),
    err: (text) => void tty.err.push(text),
    ...(browser ? { open: (url: string) => void tty.opened.push(url) } : {}),
    ...fields,
  };
  return { io, tty };
};

const hosted = (connection: ReturnType<typeof hostWith>["connection"], io: Io, given: Globals, argv: readonly string[]) =>
  Effect.scoped(hostedCommand(connection, io, given, argv, builtins)) as Effect.Effect<Output | undefined, Failure>;
const failure = (effect: Effect.Effect<unknown, Failure>) => Effect.runPromise(Effect.flip(effect));
const until = async (done: () => boolean) => {
  if ((await settled(async () => done() || undefined)) === undefined) throw new Error("timed out");
};
const elements = (...list: readonly CliElement[]) => Stream.fromIterable(list);

describe("a plugin's command", () => {
  test("is parsed here and run there: what it prints shows as it comes, then its result", async () => {
    const host = hostWith(() =>
      elements(
        { type: "started", invocation: "i1" },
        { type: "text", text: "Hello, " },
        { type: "text", text: "a note\n", err: true },
        { type: "text", text: "bob" },
        { type: "result", text: "greeted bob", json: { greeted: "bob" }, ids: ["bob"] },
      ),
    );
    const { io, tty } = terminal({ columns: 80 });
    const output = await Effect.runPromise(hosted(host.connection, io, globals(), ["greet", "bob", "--loud"]));
    // A line left open is ended before the result.
    expect(tty.out).toBe("Hello, bob\n");
    expect(tty.err).toEqual(["a note"]);
    expect(output).toEqual({ json: { greeted: "bob" }, text: "greeted bob", compact: false, ids: ["bob"] });
    expect(host.requests).toEqual([
      {
        path: ["greet"],
        input: { args: { who: "bob" }, flags: { loud: true } },
        cwd: "/work",
        json: false,
        columns: 80,
        origin: expect.stringMatching(/^cli:/),
      },
    ]);
  });

  test("streamed as JSON, each value prints on its line and the result on one line too; a failed one exits 1", async () => {
    const host = hostWith(() =>
      elements({ type: "started", invocation: "i1" }, { type: "json", value: { step: 1 } }, { type: "result", json: { done: false }, failed: true }),
    );
    const { io, tty } = terminal();
    const output = await Effect.runPromise(hosted(host.connection, io, globals({ json: true }), ["greet", "bob"]));
    expect(tty.out).toBe('{"step":1}\n');
    expect(output).toEqual({ json: { done: false }, text: "", compact: true, exit: ExitCode.failed });
    expect(host.requests[0]!.json).toBe(true);
  });

  test("reads a file flag here, so the host gets its content wherever it runs; one of a type it does not take is a usage error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lemma-cli-hosted-"));
    try {
      await writeFile(join(dir, "me.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await writeFile(join(dir, "me.txt"), "hi");
      const host = hostWith(() => elements({ type: "started", invocation: "i1" }, { type: "result" }));
      const { io } = terminal({ cwd: dir });
      await Effect.runPromise(hosted(host.connection, io, globals(), ["greet", "bob", "--photo", "me.png"]));
      expect(host.requests[0]!.input.flags).toEqual({ loud: false, photo: { name: "me.png", mimeType: "image/png", data: "iVBORw==" } });
      const wrong = await failure(hosted(host.connection, io, globals(), ["greet", "bob", "--photo", "me.txt"]));
      expect(wrong).toMatchObject({ code: "Usage", exit: ExitCode.usage });
      expect(await failure(hosted(host.connection, io, globals(), ["greet", "bob", "--photo", "gone.png"]))).toMatchObject({ code: "NotFound" });
      expect(host.requests).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a usage error exits 2 without running it; a typo is named; a group lists its commands; --help is its help", async () => {
    const host = hostWith(() => Stream.never);
    const { io } = terminal();
    for (const argv of [["greet"], ["greet", "bob", "--nope"], ["greet", "bob", "carol"]])
      expect(await failure(hosted(host.connection, io, globals(), argv)), argv.join(" ")).toMatchObject({ code: "Usage", exit: ExitCode.usage });
    const typo = await failure(hosted(host.connection, io, globals(), ["gret", "bob"]));
    expect(typo).toMatchObject({ code: "UnknownCommand", exit: ExitCode.usage });
    expect(typo.message).toContain('did you mean "lemma greet"?');
    // Among lemma's own, too.
    expect((await failure(hosted(host.connection, io, globals(), ["statsu"]))).message).toContain('did you mean "lemma status"?');
    const group = await Effect.runPromise(hosted(host.connection, io, globals(), ["tools"]));
    expect(group).toMatchObject({ ids: ["tools list", "tools show"], text: expect.stringMatching(/^lemma tools <command>\n\n {2}tools list +List tools\n/) });
    expect((await Effect.runPromise(hosted(host.connection, io, globals({ help: true }), ["greet"])))!.text).toContain("lemma greet <who>");
    expect(host.requests).toEqual([]);
  });

  test("with nothing on the host to serve them, says so", async () => {
    const connection = fakeHost({});
    const { io } = terminal();
    const unknown = await failure(hosted(connection as ReturnType<typeof hostWith>["connection"], io, globals(), ["greet", "bob"]));
    expect(unknown).toMatchObject({ code: "UnknownCommand", exit: ExitCode.usage });
    expect(unknown.message).toContain("cli.registry is off");
  });

  test("its failure keeps the host's code; one after it said how to run it again carries that", async () => {
    const refused = hostWith(() =>
      Stream.concat(elements({ type: "started", invocation: "i1" }), Stream.fail(new HostError({ code: "NotFound", subject: "bob", message: "No bob" }))),
    );
    const { io } = terminal();
    expect(await failure(hosted(refused.connection, io, globals(), ["greet", "bob"]))).toMatchObject({ code: "NotFound", subject: "bob" });

    const withdrawn = hostWith(() =>
      Stream.concat(
        elements({ type: "started", invocation: "i1" }, { type: "rerun", args: ["greet", "bob", "--request-id", "r1"] }),
        Stream.fail(new HostError({ code: "Withdrawn", subject: "greet", message: "withdrawn" })),
      ),
    );
    expect(await failure(hosted(withdrawn.connection, io, globals(), ["greet", "bob"]))).toMatchObject({
      code: "Withdrawn",
      exit: ExitCode.unavailable,
      rerun: ["greet", "bob", "--request-id", "r1"],
    });
  });

  test("whose request the host refused as too large fails TooLarge: it never arrived, so running it again would not help", async () => {
    const host: ReturnType<typeof hostWith> = hostWith(() =>
      Stream.suspend(() => {
        host.connection.refuseTooLarge();
        return Stream.never;
      }),
    );
    const { io } = terminal();
    expect(toCliError(await failure(hosted(host.connection, io, globals(), ["greet", "bob"])))).toMatchObject({ code: "TooLarge", exit: ExitCode.failed });
  });
});

describe("a dropped connection", () => {
  test("rejoins the running command where this one left it: nothing shows twice, and it never runs twice", async () => {
    const host: ReturnType<typeof hostWith> = hostWith((request, index) =>
      index === 0
        ? Stream.concat(elements({ type: "started", invocation: "i1" }, { type: "text", text: "one " }), Stream.never)
        : elements({ type: "text", text: "two" }, { type: "result", text: "done" }),
    );
    const { io, tty } = terminal();
    const running = Effect.runFork(hosted(host.connection, io, globals(), ["greet", "bob"]));
    await until(() => tty.out === "one ");
    host.connection.drop();
    await until(() => tty.err.length > 0);
    host.connection.restore();
    const output = await Effect.runPromise(Fiber.join(running));
    expect(tty.out).toBe("one two\n");
    expect(output).toMatchObject({ text: "done" });
    expect(tty.err).toEqual(["lemma: lost the connection to the host; reconnecting…", "lemma: reconnected to the host"]);
    // `started` and the text: the second request rejoins from the third element, with the first's origin.
    expect(host.requests[1]).toMatchObject({ resume: { invocation: "i1", received: 2 }, origin: host.requests[0]!.origin });
    expect(host.cancelled).toEqual([]);
  });

  test("before the command started, it fails as the connection did", async () => {
    const host: ReturnType<typeof hostWith> = hostWith(() =>
      Stream.suspend(() => {
        host.connection.drop();
        return Stream.never;
      }),
    );
    const { io } = terminal();
    expect(await failure(hosted(host.connection, io, globals(), ["greet", "bob"]))).toBeInstanceOf(RpcClientError.RpcClientError);
    expect(host.requests).toHaveLength(1);
  });
});

describe("Ctrl+C", () => {
  test("cancels the command on the host, which would otherwise run it on for this command to rejoin", async () => {
    const host = hostWith(() => Stream.concat(elements({ type: "started", invocation: "i1" }, { type: "text", text: "working\n" }), Stream.never));
    const { io, tty } = terminal();
    const running = Effect.runFork(hosted(host.connection, io, globals(), ["greet", "bob"]));
    await until(() => tty.out === "working\n");
    await Effect.runPromise(Fiber.interrupt(running));
    expect(host.cancelled).toEqual(["i1"]);
  });

  test("once it has its result, cancels nothing", async () => {
    const host = hostWith(() => elements({ type: "started", invocation: "i1" }, { type: "result" }));
    const { io } = terminal();
    await Effect.runPromise(hosted(host.connection, io, globals(), ["greet", "bob"]));
    expect(host.cancelled).toEqual([]);
  });
});

describe("what a command asks of the client", () => {
  test("a page elsewhere opens, after asking only when this command answers at the terminal", async () => {
    const url = "https://github.com/login/device";
    const host = hostWith(() =>
      elements({ type: "started", invocation: "i1" }, { type: "open", url, prompt: "Press Enter to open github.com… " }, { type: "result" }),
    );
    for (const [questions, asks] of [
      ["ignore", false],
      ["ask", true],
    ] as const) {
      const asked: string[] = [];
      const { io, tty } = terminal({ ask: async (question) => (asked.push(question), "") });
      await Effect.runPromise(hosted(host.connection, io, globals({ questions }), ["greet", "bob"]));
      await until(() => tty.opened.length > 0);
      expect([asked.length > 0, tty.opened]).toEqual([asks, [url]]);
    }
  });

  test("a page of the web app opens at the host this command reaches, or prints when nothing opens it", async () => {
    const host = hostWith(() => elements({ type: "started", invocation: "i1" }, { type: "open", path: "/threads/s1" }, { type: "result" }));
    const shown = terminal();
    await Effect.runPromise(hosted(host.connection, shown.io, globals(), ["greet", "bob"]));
    expect(shown.tty.opened).toEqual(["http://host.test/threads/s1?token=t"]);
    const printed = terminal({}, false);
    await Effect.runPromise(hosted(host.connection, printed.io, globals(), ["greet", "bob"]));
    expect(printed.tty.err).toEqual(["http://host.test/threads/s1?token=t"]);
  });

  test("its own questions, and those of the origins it names, are answered with --answer; another's are left alone", async () => {
    const events = fed<RuntimeEvent>();
    const answered: (readonly [string, unknown])[] = [];
    const finish = Deferred.makeUnsafe<void>();
    const host = hostWith(
      () =>
        Stream.concat(
          elements({ type: "started", invocation: "i1" }, { type: "answer", origin: "session:s1" }, { type: "text", text: "asking\n" }),
          Stream.fromEffectDrain(Deferred.await(finish)),
        ).pipe(Stream.concat(elements({ type: "result" }))),
      { events: events.stream, answered: (id, answer) => void answered.push([id, answer]) },
    );
    const { io, tty } = terminal();
    const running = Effect.runFork(hosted(host.connection, io, globals({ answers: ["yes", "no"] }), ["greet", "bob"]));
    await until(() => tty.out === "asking\n");
    const ask = (id: string, origin: string): RuntimeEvent => ({
      type: "interaction",
      request: { type: "confirm", id, title: `${id}?`, origin } as InteractionRequest,
    });
    events.push(ask("theirs", "session:s2"), ask("mine", host.requests[0]!.origin), ask("session", "session:s1"));
    await until(() => answered.length === 2);
    Deferred.doneUnsafe(finish, Effect.void);
    await Effect.runPromise(Fiber.join(running));
    expect(answered).toEqual([
      ["mine", { type: "confirm", value: true }],
      ["session", { type: "confirm", value: false }],
    ]);
  });

  test("it holds the host's questions if and only if it can answer them", async () => {
    const subscribed = async (fields: Partial<Io>, given: Globals) => {
      const host = hostWith(() => Stream.never);
      const running = Effect.runFork(hosted(host.connection, terminal(fields).io, given, ["greet", "bob"]));
      await until(() => host.connection.subscriptions().length > 0);
      await Effect.runPromise(Fiber.interrupt(running));
      return host.connection.subscriptions();
    };
    const ask = { ask: () => new Promise<string>(() => {}) };
    expect(await subscribed(ask, globals())).toEqual([true]);
    expect(await subscribed({}, globals())).toEqual([false]);
    expect(await subscribed(ask, globals({ questions: "ignore" }))).toEqual([false]);
    expect(await subscribed({}, globals({ answers: ["main"] }))).toEqual([true]);
    expect(await subscribed({}, globals({ questions: "dismiss" }))).toEqual([true]);
  });
});

describe("a host it cannot reach", () => {
  test("fails at once, saying why as a one-shot command would", async () => {
    const refusedHttp = new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({ message: "connect ECONNREFUSED", cause: undefined }),
    });
    const unreachable = fakeHost({ rpcs: { "Host.Info": () => Effect.fail(refusedHttp) } });
    unreachable.drop();
    const { io } = terminal();
    const run = (connection: typeof unreachable) =>
      Effect.scoped(hostedCommand(connection, io, globals(), ["greet", "bob"], builtins)) as Effect.Effect<unknown, Failure, Scope.Scope>;
    expect(await failure(Effect.scoped(run(unreachable)))).toBe(refusedHttp);
    const socketOnly = fakeHost({});
    socketOnly.drop();
    const failed = await failure(Effect.scoped(run(socketOnly)));
    expect(failed).toBeInstanceOf(CliError);
    expect(failed).toMatchObject({ code: "Unreachable", exit: ExitCode.unavailable });
  });
});
