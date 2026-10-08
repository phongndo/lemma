import { describe, expect, test } from "vitest";
import { Effect, Fiber } from "effect";
import { AgentChannels, emptyUsage, FileChannels, HostError, SessionChannels } from "@lemma/contracts";
import type { AgentActivity, SessionsChange } from "@lemma/contracts";
import { settled } from "../../../scripts/e2e.ts";
import { again, call, refined } from "../src/channels.ts";
import { CliError, ExitCode } from "../src/command.ts";
import type { Io, Options } from "../src/command.ts";
import { eventsCommand } from "../src/live.ts";
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

  test("a withdrawn call is made again once its channel is served, through a moment when nothing serves it", async () => {
    let calls = 0;
    const host = fakeHost({
      calls: {
        "agent.cancel": () => {
          calls++;
          if (calls === 1) return refused("Withdrawn", "agent.cancel")();
          // The replacement is listed before it answers, as the old one leaves.
          if (calls === 2) return refused("NotFound", "agent.cancel")();
          return Effect.void;
        },
      },
    });
    await Effect.runPromise(again(host.rpc, AgentChannels.cancel.id, call(host.rpc, AgentChannels.cancel, { sessionId: "s1" })));
    expect(calls).toBe(3);
    // Not found without having been withdrawn is an answer, not a wait.
    expect(await failure(again(host.rpc, SessionChannels.list.id, call(host.rpc, SessionChannels.list, {})))).toMatchObject({ code: "NotFound" });
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
