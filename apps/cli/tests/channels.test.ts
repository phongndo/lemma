import { describe, expect, test } from "vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { AgentChannels, emptyUsage, FileChannels, HostError, SessionChannels } from "@lemma/contracts";
import type { AgentActivity, SessionsChange } from "@lemma/contracts";
import { settled } from "../../../scripts/e2e.ts";
import { call, follow, followable, refined } from "../src/channels.ts";
import { CliError, ExitCode } from "../src/command.ts";
import type { Io, Options } from "../src/command.ts";
import { doCommand, eventsCommand, hostEvents } from "../src/live.ts";
import { fakeHost, fed } from "./fake.ts";
import type { Fed } from "./fake.ts";

const refused = (code: string, subject: string) => () => Effect.fail(new HostError({ code, subject, message: `${code}: ${subject}` }));
const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

describe("a channel's failure", () => {
  test("Unavailable naming the channel is the host still starting, and exits 3; a subsystem's own names what it concerns", async () => {
    const host = fakeHost({ calls: { "sessions.list": refused("Unavailable", "sessions.list"), "files.search": refused("Unavailable", "/work") } });
    expect(await failure(call(host.rpc, SessionChannels.list, {}))).toMatchObject({
      code: "Unavailable",
      subject: "sessions.list",
      exit: ExitCode.unavailable,
    });
    const own = await failure(call(host.rpc, FileChannels.search, { cwd: "/work", query: "" }));
    expect(own).toBeInstanceOf(HostError);
    expect(own).toMatchObject({ code: "Unavailable", subject: "/work" });
  });

  test("NotFound naming the channel says nothing serves it; one naming a session is the session's", async () => {
    const host = fakeHost({ calls: { "sessions.get": refused("NotFound", "s1") } });
    const unserved = await failure(call(host.rpc, SessionChannels.list, {}));
    expect(unserved).toBeInstanceOf(CliError);
    expect(unserved).toMatchObject({ code: "NotFound", subject: "sessions.list" });
    expect(unserved.message).toContain("lemma plugins");
    expect(await failure(call(host.rpc, SessionChannels.get, { sessionId: "s1" }))).toMatchObject({ code: "NotFound", subject: "s1" });
  });

  test("a stream called, as `lemma channels call` can, is not said to be unserved", async () => {
    const host = fakeHost({ streams: { "agent.activity": () => fed({ type: "subscribed", running: [] }).stream } });
    const called = await failure(Effect.mapError(host.rpc["Channel.Call"]({ id: "agent.activity" }), refined("agent.activity")));
    expect(called).toMatchObject({ code: "NotFound", subject: "agent.activity", message: '"agent.activity" is a stream, not a call: open it' });
  });

  test("Withdrawn naming the channel is its plugin reloading: the command says to run it again, and exits 1", async () => {
    const host = fakeHost({ calls: { "agent.cancel": refused("Withdrawn", "agent.cancel") } });
    const withdrawn = await failure(call(host.rpc, AgentChannels.cancel, { sessionId: "s1" }));
    expect(withdrawn).toBeInstanceOf(CliError);
    expect(withdrawn).toMatchObject({ code: "Withdrawn", subject: "agent.cancel", exit: ExitCode.failed });
    expect(withdrawn.message).toContain("run the command again");
  });

  test("`lemma do` runs a command once: one its plugin's reload withdrew fails rather than running twice", async () => {
    let runs = 0;
    const host = fakeHost({
      calls: {
        "commands.run": () => {
          runs++;
          return refused("Withdrawn", "commands.run")();
        },
      },
    });
    const io: Io = { env: {}, cwd: "/", out: () => {}, err: () => {} };
    const failed = await failure(Effect.scoped(doCommand("host.toggle-plugin")(host, io, { json: false, answers: [] } as unknown as Options)));
    expect(failed).toMatchObject({ code: "Withdrawn", subject: "commands.run", exit: ExitCode.failed });
    expect(runs).toBe(1);
  });
});

describe("following a stream", () => {
  test("interrupting the fiber that reads it closes the stream, while the command's scope goes on", async () => {
    const closed = Deferred.makeUnsafe<void>();
    const host = fakeHost({
      streams: {
        "agent.activity": () => fed<AgentActivity>({ type: "subscribed", running: [] }).stream.pipe(Stream.ensuring(Deferred.succeed(closed, undefined))),
      },
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rpc = yield* host.live;
          const connection = followable(rpc, yield* hostEvents(rpc, () => Effect.void));
          const reader = yield* follow(
            connection,
            AgentChannels.activity,
            () => undefined,
            () => Effect.void,
          );
          yield* Fiber.interrupt(reader);
          yield* Deferred.await(closed);
        }),
      ),
    );
  });
});

describe("lemma events", () => {
  const options = { json: true, answers: [] } as unknown as Options;

  test("prints each stream's elements with where they came from, following one its plugin withdrew again", async () => {
    const activities: Fed<AgentActivity>[] = [];
    const host = fakeHost({
      calls: { "sessions.get": () => Effect.succeed({ id: "s1", cwd: "/", createdAt: 0, updatedAt: 0, lastSeq: 0 }) },
      streams: {
        "agent.activity": () => {
          const opened = fed<AgentActivity>({ type: "subscribed", running: [] });
          activities.push(opened);
          return opened.stream;
        },
        "sessions.changes": () =>
          fed<SessionsChange>({ type: "subscribed" }, { type: "session-removed", sessionId: "s1" }, { type: "session-removed", sessionId: "s2" }).stream,
        "llm.changes": () => fed({ type: "subscribed" }).stream,
        "commands.changes": () => fed([]).stream,
        "sessions.log": () => fed({ type: "subscribed", events: [] }).stream,
      },
    });
    const lines: { from: string; element: { type?: string } }[] = [];
    const io: Io = { env: {}, cwd: "/", out: (text) => void lines.push(JSON.parse(text)), err: () => {} };
    const following = Effect.runFork(Effect.scoped(eventsCommand(host, io, { ...options, session: "s1" })));
    const until = async (done: () => boolean) => {
      if ((await settled(async () => done() || undefined)) === undefined) throw new Error(`timed out: ${JSON.stringify(lines)}`);
    };
    await until(() => activities.length === 1 && lines.some((line) => line.from === "sessions.log"));
    activities[0]!.push({ type: "turn-started", sessionId: "s1", turnId: "t1" }, { type: "turn-started", sessionId: "s2", turnId: "t2" });
    activities[0]!.fail(new HostError({ code: "Withdrawn", subject: "agent.activity", message: "withdrawn" }));
    await until(() => activities.length === 2);
    activities[1]!.push({ type: "turn-ended", sessionId: "s1", turnId: "t1", usage: emptyUsage, reason: "done" });
    await until(() => lines.some((line) => line.element.type === "turn-ended"));
    await Effect.runPromise(Fiber.interrupt(following));
    const from = (source: string) => lines.filter((line) => line.from === source).map((line) => line.element.type ?? "list");
    expect(from("agent.activity")).toEqual(["subscribed", "turn-started", "subscribed", "turn-ended"]);
    expect(from("sessions.changes")).toEqual(["subscribed", "session-removed"]);
    expect(from("llm.changes")).toEqual(["subscribed"]);
    expect(from("commands.changes")).toEqual(["list"]);
    expect(from("sessions.log")).toEqual(["subscribed"]);
  });
});
