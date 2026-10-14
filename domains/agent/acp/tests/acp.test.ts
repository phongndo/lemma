import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, Effect, Fiber, Layer, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, Events, makeCore, PluginContext, Registries } from "@lemma/core";
import { Channels, HostControl } from "@lemma/contracts";
import type { ChannelStream } from "@lemma/contracts";
import { callServed, pathsPlugin } from "@lemma/contracts/testing";
import { Agent, AssistantDelta, listHarnesses } from "@lemma/agent";
import { Llm, LlmError } from "@lemma/llm";
import { McpLaunches } from "@lemma/mcp";
import { Sessions } from "@lemma/sessions";
import type { EventData, SessionEvent } from "@lemma/sessions";
import agentLoop from "@lemma/agent-loop";
import sessions from "@lemma/sessions-files";
import tools from "@lemma/tools-registry";
import acpPlugin from "../src/index.ts";
import type { AcpState, PermissionRequest } from "@lemma/agent/acp";

const fixture = fileURLToPath(new URL("./fixtures/agent.ts", import.meta.url));

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-acp-"));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

/** The presets turned off, so only the fake agent runs. */

const writeAgents = (agents: Record<string, unknown>) => fs.writeFile(path.join(home, "agents.json"), JSON.stringify({ agents }));

const fake = (env: Record<string, string> = {}) => ({ title: "Fake", command: process.execPath, args: [fixture], env });

const host = definePlugin({
  id: "host",
  provides: [HostControl],
  layer: Layer.succeed(HostControl, {
    runtime: [HostControl.key],
    process: { pid: process.pid, startedAt: 0 },
    plugins: Effect.succeed([]),
    composition: Effect.succeed({ id: "comp-1", plugins: [] }),
    restart: () => Effect.succeed({}),
    reload: Effect.die("unused"),
    configure: () => Effect.die("unused"),
    web: Effect.succeed({ plugins: {}, enabledIn: {}, configIn: {}, files: [] }),
  }),
});

/** A model the native loop asks: it answers "native answer". */
const llm = definePlugin({
  id: "llm",
  provides: [Llm],
  layer: Layer.succeed(Llm, {
    providers: Effect.succeed([]),
    models: () =>
      Effect.succeed([
        {
          ref: "fake/m1",
          provider: "fake",
          id: "m1",
          name: "m1",
          api: "fake-api",
          reasoning: false,
          thinkingLevels: [],
          input: ["text"],
          contextWindow: 100_000,
          maxTokens: 8_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ]),
    model: () => Effect.fail(new LlmError({ reason: "UnknownModel", message: "unknown" })),
    stream: () =>
      Stream.fromIterable([
        { type: "start" as const },
        { type: "text-delta" as const, index: 0, delta: "native answer" },
        {
          type: "done" as const,
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "native answer" }],
            api: "fake-api",
            provider: "fake",
            model: "m1",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop" as const,
            timestamp: 1,
          },
        },
      ]),
    login: () => Effect.void,
    logout: () => Effect.void,
    addCustom: () => Effect.succeed("custom"),
    removeCustom: () => Effect.void,
    setLogo: () => Effect.void,
  }),
});

/**
 * A client following the agents' permission requests, as the web half does: it answers each with `answer` (a choice's
 * kind), recording what it was shown.
 */
function answering(answer: string) {
  const asked: PermissionRequest[] = [];
  const plugin = definePlugin({
    id: "client",
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const owner = yield* PluginContext;
        const registries = yield* Registries;
        yield* owner.background(
          "answer permissions",
          Effect.gen(function* () {
            yield* registries.settled;
            const channel = (yield* registries.items(Channels)).find(({ item }) => item.id === "acp.permissions")?.item as ChannelStream | undefined;
            if (channel === undefined) return yield* Effect.die(new Error("acp.permissions is not served"));
            const stream = channel.handle(undefined) as Stream.Stream<readonly PermissionRequest[], unknown>;
            yield* Stream.runForEach(stream, (list) =>
              Effect.forEach(list, (request) =>
                asked.some((seen) => seen.id === request.id)
                  ? Effect.void
                  : Effect.gen(function* () {
                      asked.push(request);
                      const choice = request.choices.find((option) => option.kind === answer);
                      yield* callServed(registries, "acp.respond", { id: request.id, choice: choice?.id ?? "" }).pipe(Effect.ignore);
                    }),
              ),
            );
          }),
        );
      }),
    ),
  });
  return { plugin, asked };
}

/** Hands one MCP server to other agents, as `mcp.servers` would. */
const launches = definePlugin({
  id: "launches",
  layer: Layer.effectDiscard(
    Effect.flatMap(PluginContext, (owner) =>
      owner.add(McpLaunches, { name: "docs", transport: "stdio", command: "docs-server", args: [], env: {}, headers: {} }),
    ),
  ),
});

const run = <A, E>(
  body: Effect.Effect<A, E, Agent | Sessions | Registries | Events>,
  extra: { readonly answer?: string; readonly plugins?: readonly unknown[] } = {},
) => {
  const asking = answering(extra.answer ?? "allow_once");
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([
          pathsPlugin(home),
          host,
          asking.plugin,
          sessions,
          tools,
          llm,
          agentLoop,
          acpPlugin,
          ...((extra.plugins ?? []) as never[]),
        ]);
        return yield* core.run(body);
      }),
    ),
  ).then((value) => ({ value, asked: asking.asked }));
};

const ofType = <T extends EventData["type"]>(events: readonly SessionEvent[], type: T) =>
  events.flatMap((event) => (event.data.type === type ? [event.data as Extract<EventData, { type: T }>] : []));
const text = (value: string) => [{ type: "text" as const, text: value }];
const call = (id: string, payload: unknown) =>
  Effect.gen(function* () {
    return yield* callServed(yield* Registries, id, payload);
  });
/** The first state `acp.changes` reports that `pass` holds for. */
const stateWhere = (pass: (state: AcpState) => boolean) =>
  Effect.gen(function* () {
    const channel = (yield* (yield* Registries).items(Channels)).find(({ item }) => item.id === "acp.changes")!.item as ChannelStream;
    const stream = channel.handle(undefined) as Stream.Stream<AcpState, unknown>;
    return yield* Stream.runHead(Stream.filter(stream, pass));
  });

describe("agent.acp", () => {
  it("runs a turn on an agent: its thoughts, text, and tool call logged, the permission it asks put to the session's user", async () => {
    await writeAgents({ fake: fake() });
    const { value: events, asked } = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create({ cwd: home });
        const agent = yield* Agent;
        expect(yield* agent.prompt(id, text("hello"), { harness: "fake" })).toEqual({ kind: "placed" });
        return { id, events: yield* store.events(id) };
      }),
      { plugins: [launches] },
    );
    expect(ofType(events.events, "turn-start")[0]).toMatchObject({ harness: "fake" });
    const messages = ofType(events.events, "message").map((data) => data.message);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      provider: "fake",
      content: [
        { type: "thinking", thinking: "Thinking." },
        { type: "text", text: "[fake-1 servers=docs] Heard: hello" },
        { type: "toolCall", id: "t1", name: "acp.execute", arguments: { title: "Run ls", input: { command: "ls" } } },
      ],
    });
    expect(messages[2]).toMatchObject({ role: "toolResult", toolCallId: "t1", isError: false, content: [{ type: "text", text: "a.ts\nb.ts" }] });
    expect(messages[3]).toMatchObject({ role: "assistant", content: [{ type: "text", text: " Done." }] });
    expect(ofType(events.events, "turn-end").map((end) => end.reason)).toEqual(["done"]);
    expect(asked).toMatchObject([
      {
        sessionId: events.id,
        agent: "fake",
        agentTitle: "Fake",
        title: "Run ls",
        kind: "execute",
        command: "ls",
        choices: [
          { id: "allow", name: "Allow once", kind: "allow_once" },
          { id: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    ]);
  });

  it("keeps an access level by the agent's own mode, and offers the levels its modes allow", async () => {
    await writeAgents({ fake: fake() });
    const { value, asked } = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create({ cwd: home });
        const agent = yield* Agent;
        yield* agent.prompt(id, text("full"), { harness: "fake", access: "full" });
        yield* agent.prompt(id, text("watched"), { harness: "fake", access: "supervised" });
        // A level the agent has no mode for, or none, after full access: back in its mode for asking, never left in full.
        yield* agent.prompt(id, text("full again"), { harness: "fake", access: "full" });
        yield* agent.prompt(id, text("auto"), { harness: "fake", access: "auto" });
        yield* agent.prompt(id, text("full once more"), { harness: "fake", access: "full" });
        yield* agent.prompt(id, text("unnamed"), { harness: "fake" });
        const state = (yield* call("acp.state", undefined)) as AcpState;
        return { events: yield* store.events(id), fake: state.agents.find((candidate) => candidate.id === "fake")! };
      }),
    );
    const said = ofType(value.events, "message").flatMap(({ message }) =>
      message.role === "assistant" ? message.content.flatMap((block) => (block.type === "text" && block.text.includes("Heard") ? [block.text] : [])) : [],
    );
    // Full access: the agent's bypass mode, so it asked nothing; supervised: back to its manual mode, and it asked.
    expect(said[0]).toMatch(/^\[fake-1 servers= mode=bypassPermissions\] Heard: /);
    expect(said[1]).toMatch(/^\[fake-1 servers=\] Heard: /);
    expect(said[3]).toMatch(/^\[fake-1 servers=\] Heard: /);
    expect(said[5]).toMatch(/^\[fake-1 servers=\] Heard: /);
    // Supervised and unnamed asked; auto, with no mode of the agent's, is Lemma's to answer, and it asks too.
    expect(asked).toHaveLength(3);
    expect(value.fake.access).toEqual([
      { access: "supervised", mode: "default" },
      { access: "auto-edits", mode: "acceptEdits" },
      { access: "full", mode: "bypassPermissions" },
    ]);
  });

  it("cancels and forgets a deleted thread's session", async () => {
    await writeAgents({ fake: fake() });
    const { value } = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create({ cwd: home });
        yield* (yield* Agent).prompt(id, text("hi"), { harness: "fake", access: "full" });
        const sessionsOf = (state: AcpState) => state.agents.find((agent) => agent.id === "fake")!.sessions;
        const before = sessionsOf((yield* call("acp.state", undefined)) as AcpState);
        // The turn's hold on the session ends just after it does.
        yield* store.remove(id).pipe(Effect.retry({ while: (error) => error.reason === "Busy" }));
        yield* stateWhere((state) => sessionsOf(state) === 0);
        return before;
      }),
    );
    expect(value).toBe(1);
  });

  it("lists the agent's models, and runs a turn on the one it names", async () => {
    await writeAgents({ fake: fake() });
    const { value } = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create({ cwd: home });
        yield* call("acp.check", { id: "fake" });
        const listed = (yield* listHarnesses(yield* Registries)).find((harness) => harness.id === "fake")!;
        yield* (yield* Agent).prompt(id, text("hi"), { harness: "fake", model: "smart", access: "full" });
        return { listed, events: yield* store.events(id) };
      }),
    );
    expect(value.listed.status).toMatchObject({
      model: "fast",
      models: [
        { id: "fast", name: "Fast", description: "Quick answers" },
        { id: "smart", name: "Smart" },
      ],
    });
    const assistant = ofType(value.events, "message").find((data) => data.message.role === "assistant")!.message;
    expect(assistant).toMatchObject({ model: "smart" });
    expect(JSON.stringify(assistant)).toContain("model=smart");
  });

  it("refuses a request when nobody follows them within waitForClientMs", async () => {
    await writeAgents({ fake: fake() });
    const asking = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([pathsPlugin(home), host, sessions, tools, llm, agentLoop, acpPlugin], {
            configs: { "agent.acp": { waitForClientMs: 0 } },
          });
          return yield* core.run(
            Effect.gen(function* () {
              const store = yield* Sessions;
              const { id } = yield* store.create({ cwd: home });
              yield* (yield* Agent).prompt(id, text("hello"), { harness: "fake" });
              return yield* store.events(id);
            }),
          );
        }),
      ),
    );
    expect(ofType(asking, "message")[2]?.message).toMatchObject({ role: "toolResult", isError: true, content: [{ type: "text", text: "Refused" }] });
  });

  it("refuses the call when the user picks so", async () => {
    await writeAgents({ fake: fake() });
    const { value: events } = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create({ cwd: home });
        yield* (yield* Agent).prompt(id, text("hello"), { harness: "fake" });
        return yield* store.events(id);
      }),
      { answer: "reject_once" },
    );
    expect(ofType(events, "message")[2]?.message).toMatchObject({ role: "toolResult", isError: true, content: [{ type: "text", text: "Refused" }] });
  });

  it("continues its own session, told what was said meanwhile; and opens one, told everything, after a restart", async () => {
    await writeAgents({ fake: fake() });
    const { value: id } = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create({ cwd: home });
        const agent = yield* Agent;
        yield* agent.prompt(id, text("one"), { harness: "fake" });
        yield* agent.prompt(id, text("two"));
        yield* agent.prompt(id, text("three"), { harness: "fake" });
        return id;
      }),
    );
    const { value: events } = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        yield* (yield* Agent).prompt(id, text("four"), { harness: "fake" });
        return yield* store.events(id);
      }),
    );
    const said = ofType(events, "message").flatMap(({ message }) =>
      message.role === "assistant" ? message.content.flatMap((block) => (block.type === "text" && block.text.includes("Heard") ? [block.text] : [])) : [],
    );
    expect(said[0]).toBe("[fake-1 servers=] Heard: one");
    // The same session, told of the native turn between.
    expect(said[1]).toMatch(/^\[fake-1 servers=\] Heard: <conversation>\n<user>\ntwo\n<\/user>\n\n<assistant>\nnative answer\n<\/assistant>\n<\/conversation>/);
    expect(said[1]).toMatch(/three$/);
    // A new process, which cannot resume it: a new session, told the whole conversation.
    // As the model sees it: the native turn's handoff summary of the first turn, then what followed.
    expect(said[2]).toMatch(/^\[fake-1 servers=\] Heard: <conversation>\n<user>\n<summary>\n/);
    expect(said[2]).toContain("Heard: one");
    expect(said[2]).toContain("<user>\nthree\n</user>");
    expect(said[2]).toMatch(/four$/);
  });

  it("asks to sign in when the agent wants it, and runs once signed in through acp.authenticate", async () => {
    await writeAgents({ fake: fake({ FAKE_ACP_AUTH: "1" }) });
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create({ cwd: home });
        const agent = yield* Agent;
        const failed = yield* Effect.flip(agent.prompt(id, text("hello"), { harness: "fake" }));
        expect(failed.message).toMatch(/^Fake: sign in first \(Settings › Integrations › Fake\)/);
        const checked = (yield* call("acp.check", { id: "fake" })) as AcpState["agents"][number];
        expect(checked.authMethods).toEqual([{ id: "browser", name: "Sign in with a browser", kind: "agent" }]);
        expect(checked.agent).toEqual({ name: "fake-agent", version: "1.2.3" });
        yield* call("acp.authenticate", { id: "fake", method: "browser" });
        expect(yield* agent.prompt(id, text("again"), { harness: "fake" })).toEqual({ kind: "placed" });
      }),
    );
  });

  it("fails a turn the agent ends without saying or doing anything, as one that cannot reach its model does", async () => {
    await writeAgents({ fake: fake() });
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create({ cwd: home });
        const failed = yield* Effect.flip((yield* Agent).prompt(id, text("silent"), { harness: "fake" }));
        expect(failed.message).toMatch(/^Fake: it ended its turn without answering/);
      }),
    );
  });

  it("cancels the agent's prompt when the turn is cancelled", async () => {
    await writeAgents({ fake: fake() });
    const { value: events } = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create({ cwd: home });
        const agent = yield* Agent;
        // Heard once the agent's echo streams: the prompt reached it.
        const echoed = yield* Effect.forkChild(
          Stream.runHead(Stream.filter((yield* Events).stream(AssistantDelta), ({ sessionId, event }) => sessionId === id && event.type === "text-delta")),
        );
        const running = yield* Effect.forkChild(agent.prompt(id, text("hang"), { harness: "fake" }));
        yield* Fiber.join(echoed).pipe(Effect.timeout(Duration.seconds(10)), Effect.orDie);
        yield* agent.cancel(id);
        yield* Fiber.await(running);
        return yield* store.events(id);
      }),
    );
    expect(ofType(events, "turn-end").map((end) => end.reason)).toEqual(["cancelled"]);
  });

  it("lists the agents the file adds, none by default, and adds a supported one and removes one through acp.put", async () => {
    await writeAgents({ fake: fake(), gone: { command: "no-such-command-anywhere", args: ["acp"] } });
    await run(
      Effect.gen(function* () {
        const state = (yield* call("acp.state", undefined)) as AcpState;
        // The supported agents are offered to add, not listed until added.
        expect(state.agents.map((agent) => [agent.id, agent.state])).toEqual([
          ["fake", "ready"],
          ["gone", "missing"],
        ]);
        const registries = yield* Registries;
        const listed = (yield* listHarnesses(registries)).map((harness) => [harness.id, harness.status.state]);
        expect(listed).toEqual([
          ["lemma", "ready"],
          ["fake", "ready"],
          ["gone", "unavailable"],
        ]);
        const store = yield* Sessions;
        const { id } = yield* store.create({ cwd: home });
        const failed = yield* Effect.flip((yield* Agent).prompt(id, text("hi"), { harness: "gone" }));
        expect(failed.message).toBe("gone cannot run turns now: `no-such-command-anywhere` is not on the host's PATH.");

        yield* call("acp.put", { id: "gone", entry: null });
        // An empty entry adds the preset as Lemma knows it; puts at once each keep the other's change.
        yield* Effect.all([call("acp.put", { id: "claude", entry: {} }), call("acp.put", { id: "codex", entry: {} })], { concurrency: "unbounded" });
        yield* call("acp.put", { id: "codex", entry: null });
        const after = (yield* listHarnesses(registries)).map((harness) => harness.id);
        expect(after).toEqual(["lemma", "claude", "fake"]);
        const written = JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(home, "agents.json"), "utf8")));
        expect(Object.keys(written.agents)).toEqual(["fake", "claude"]);
        expect(written.agents.claude).toEqual({});
        const added = (yield* call("acp.state", undefined)) as AcpState;
        expect(added.agents.find((agent) => agent.id === "claude")).toMatchObject({ source: "preset", enabled: true, logo: { color: "#d97757" } });
        // An icon of its own is drawn over the preset's mark.
        yield* call("acp.put", { id: "claude", entry: { icon: "https://example.com/claude.svg" } });
        const own = (yield* call("acp.state", undefined)) as AcpState;
        expect(own.agents.find((agent) => agent.id === "claude")?.logo).toEqual({ image: "https://example.com/claude.svg" });
        expect(yield* Effect.flip(call("acp.put", { id: "lemma", entry: { command: "x" } }))).toMatchObject({
          message: expect.stringContaining("not an agent id"),
        });
      }),
    );
  });
});
