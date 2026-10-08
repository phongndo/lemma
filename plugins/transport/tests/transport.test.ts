import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Duration, Effect, Exit, Fiber, Layer, Option, Schedule, Scope, Stream } from "effect";
import { CommandsChanged, HOST_PROTOCOL, HostError, Inspectors, Interaction, InteractionError, Notice, SUBSCRIBED_HEADER } from "@lemma/contracts";
import { readDiscovery } from "@lemma/contracts/discovery";
import { definePlugin, Events, PluginContext } from "@lemma/core";
import { loadToken } from "../src/token.ts";
import { prompted, fakeFileSearch } from "./fakes.ts";
import { failure, hostError, subscribe, waitFor, withHost } from "./harness.ts";

const interactionError = (exit: Exit.Exit<unknown, unknown>): InteractionError => {
  const error = failure(exit);
  if (error instanceof InteractionError) return error;
  throw new Error(`Expected an InteractionError, got ${String(exit)}`);
};

const text = (value: string) => [{ type: "text" as const, text: value }];

describe("transport", () => {
  test("requires the token on /rpc and /api, by header or query", () =>
    withHost((host) =>
      Effect.gen(function* () {
        const get = (path: string, init?: RequestInit) => Effect.promise(() => fetch(`${host.url}${path}`, init));
        expect((yield* get("/api/health")).status).toBe(401);
        expect((yield* get("/api/health?token=nope")).status).toBe(401);
        expect((yield* get("/rpc/http", { method: "POST", body: "" })).status).toBe(401);
        const byHeader = yield* get("/api/health", { headers: { authorization: `Bearer ${host.token}` } });
        expect(byHeader.status).toBe(200);
        expect(yield* Effect.promise(() => byHeader.json())).toEqual({ ok: true, version: "0.1.0", protocol: HOST_PROTOCOL });
        expect((yield* get(`/api/health?token=${encodeURIComponent(host.token)}`)).status).toBe(200);
        // Without staticDir there is no web app, but no token is asked for either.
        expect((yield* get("/")).status).toBe(404);

        const client = yield* host.connect("http", "wrong");
        const exit = yield* Effect.exit(client["Session.List"]({}));
        expect(Option.getOrUndefined(Exit.findErrorOption(exit))?._tag).toBe("RpcClientError");

        // The WebSocket upgrade itself is refused; the RPC client would only keep retrying.
        const socket = (token: string) =>
          Effect.callback<"open" | "refused">((resume) => {
            const ws = new WebSocket(`${host.url.replace(/^http/, "ws")}/rpc?token=${encodeURIComponent(token)}`);
            ws.onopen = () => {
              ws.close();
              resume(Effect.succeed("open"));
            };
            ws.onerror = () => resume(Effect.succeed("refused"));
          });
        expect(yield* socket("wrong")).toBe("refused");
        expect(yield* socket(host.token)).toBe("open");
      }),
    ));

  test("serves listed UI files with the token, and tells clients when the UI composition changes", () =>
    withHost((host) =>
      Effect.gen(function* () {
        const dir = join(host.home, "ui");
        yield* Effect.promise(() => mkdir(dir, { recursive: true }));
        yield* Effect.promise(() => writeFile(join(dir, "panel.js"), "export default () => [];"));
        yield* Effect.promise(() => writeFile(join(dir, "secret.js"), "unlisted"));
        host.holder.ui = {
          ...host.holder.ui,
          files: [{ name: "panel.js", source: "user", kind: "script", path: join(dir, "panel.js"), url: "/api/ui/user/panel.js?v=1" }],
        };
        const get = (path: string) => Effect.promise(() => fetch(`${host.url}${path}`));
        const token = `token=${encodeURIComponent(host.token)}`;
        expect((yield* get("/api/ui/user/panel.js?v=1")).status).toBe(401);
        const served = yield* get(`/api/ui/user/panel.js?v=1&${token}`);
        expect(served.status).toBe(200);
        expect(served.headers.get("content-type")).toMatch(/javascript/);
        expect(yield* Effect.promise(() => served.text())).toBe("export default () => [];");
        // Only listed files are served, whatever else is in the directory.
        expect((yield* get(`/api/ui/user/secret.js?${token}`)).status).toBe(404);
        expect((yield* get(`/api/ui/user/..%2Fconfig.jsonc?${token}`)).status).toBe(404);

        const client = yield* host.connect("websocket");
        const events = yield* subscribe(client);
        expect((yield* client["Ui.Composition"]()).files.map((file) => file.name)).toEqual(["panel.js"]);
        const written = yield* client["Ui.Configure"]({ plugins: { composer: { enabled: false } } });
        expect(written.plugins).toEqual({ composer: { enabled: false } });
        const [changed] = (yield* waitFor(events, (event) => event.type === "ui-changed")).slice(-1);
        expect(changed?.type === "ui-changed" && changed.ui.plugins).toEqual({ composer: { enabled: false } });
      }),
    ));

  test("pins, archives, and deletes sessions, telling subscribers", () =>
    withHost((host) =>
      Effect.gen(function* () {
        const client = yield* host.connect("websocket");
        const events = yield* subscribe(client);
        const session = yield* client["Session.Create"]({});
        expect(yield* client["Session.Mark"]({ sessionId: session.id, pinned: true })).toMatchObject({ id: session.id, pinned: true });
        const archived = yield* client["Session.Mark"]({ sessionId: session.id, archived: true });
        expect(archived).toMatchObject({ pinned: true, archived: true });
        yield* waitFor(events, (event) => event.type === "session-changed" && event.info.archived === true);
        yield* client["Session.Delete"]({ sessionId: session.id });
        yield* waitFor(events, (event) => event.type === "session-removed" && event.sessionId === session.id);
        expect(yield* client["Session.List"]({})).toEqual([]);
        const missing = yield* Effect.flip(client["Session.Delete"]({ sessionId: session.id }));
        expect(missing).toMatchObject({ _tag: "HostError", code: "NotFound" });
      }),
    ));

  test(
    "serves sessions, turns, models, and host control over WebSocket",
    () =>
      withHost((host) =>
        Effect.gen(function* () {
          const client = yield* host.connect("websocket");
          const events = yield* subscribe(client);

          const session = yield* client["Session.Create"]({});
          expect(session.cwd).toBe("/work");
          yield* waitFor(events, (event) => event.type === "session-changed" && event.info.id === session.id);
          expect((yield* client["Session.List"]({})).map((info) => info.id)).toEqual([session.id]);
          expect(yield* client["Session.List"]({ cwd: "/elsewhere" })).toEqual([]);

          yield* client["Agent.Prompt"]({ sessionId: session.id, content: text("hi"), requestId: "r1", whenBusy: "steer" });
          expect(prompted.at(-1)).toEqual({ requestId: "r1", whenBusy: "steer" });
          // Kinds are observed independently, so `turn-ended` may overtake the last delta: wait for both.
          let ended = false;
          let streamed = "";
          const turn = yield* waitFor(events, (event) => {
            if (event.type === "turn-ended") ended = true;
            if (event.type === "delta" && event.event.type === "text-delta") streamed += event.event.delta;
            return ended && streamed === "echo: hi";
          });
          expect(turn.some((event) => event.type === "turn-started" && event.sessionId === session.id)).toBe(true);
          // Deltas carry their number in the step, so a client seeded from `Agent.View` can skip what it already shows.
          expect(turn.flatMap((event) => (event.type === "delta" ? [event.seq] : []))).toEqual([1, 2]);
          expect(yield* client["Agent.Running"]()).toEqual([]);
          expect(yield* client["Agent.View"]({ sessionId: session.id })).toEqual({ output: [], queue: [], queueRevision: 0 });
          expect(yield* client["Agent.Queue"]({ sessionId: session.id })).toEqual([]);
          expect(yield* client["Agent.Withdraw"]({ sessionId: session.id, requestId: "r1" })).toBe(false);

          const logged = yield* client["Session.Events"]({ sessionId: session.id });
          expect(logged.map((event) => (event.data.type === "message" ? event.data.message.role : event.data.type))).toEqual(["user", "assistant"]);
          expect((yield* client["Session.Events"]({ sessionId: session.id, after: 1 })).map((event) => event.seq)).toEqual([2]);

          const titled = yield* client["Session.SetTitle"]({ sessionId: session.id, title: "Hello" });
          expect(titled).toMatchObject({ id: session.id, title: "Hello", lastSeq: 3 });
          yield* waitFor(events, (event) => event.type === "session-appended" && event.event.data.type === "title");
          expect((yield* client["Session.Checkout"]({ sessionId: session.id, eventId: logged[0]!.id })).leaf).toBe(logged[0]!.id);

          const missing = hostError(yield* Effect.exit(client["Session.Get"]({ sessionId: "missing" })));
          expect(missing).toMatchObject({ code: "NotFound", subject: "missing" });
          expect(hostError(yield* Effect.exit(client["Agent.Prompt"]({ sessionId: "missing", content: text("x") })))).toMatchObject({
            code: "Session",
            subject: "missing",
          });

          expect((yield* client["Llm.Models"]({})).map((model) => model.ref)).toEqual(["fake/echo"]);
          expect(yield* client["Llm.Models"]({ available: false })).toEqual([]);
          expect((yield* client["Llm.Providers"]()).map((provider) => provider.id)).toEqual(["fake"]);
          expect(hostError(yield* Effect.exit(client["Llm.Login"]({ provider: "nope", type: "api_key" })))).toMatchObject({ code: "UnknownProvider" });

          expect(yield* client["Host.Info"]()).toEqual({
            version: "0.1.0",
            cwd: "/work",
            home: host.home,
            composition: { id: "c0ffee", plugins: [{ id: "transport", version: "0.1.0" }] },
          });
          const plugins = yield* client["Host.Plugins"]();
          expect(plugins.find((plugin) => plugin.id === "transport")).toEqual({
            id: "transport",
            version: "0.1.0",
            source: "bundled",
            enabled: true,
            state: "active",
            provides: [],
            requires: ["lemma/Paths", "lemma/Sessions", "lemma/Agent", "lemma/Llm", "lemma/HostControl", "lemma/Workspace", "lemma/Commands"],
          });
          yield* client["Host.RestartPlugin"]({ pluginId: "llm" });
          yield* client["Host.RestartPlugin"]({ pluginId: "llm", force: true });
          expect(host.holder.restarted).toEqual(["llm", "llm!"]);
          const [changed] = (yield* waitFor(events, (event) => event.type === "plugins-changed")).slice(-1);
          expect(changed?.type === "plugins-changed" && changed.plugins.some((plugin) => plugin.id === "llm")).toBe(true);
          const unknown = hostError(yield* Effect.exit(client["Host.RestartPlugin"]({ pluginId: "nope" })));
          expect(unknown.code).toBe("ReloadError");
          expect(unknown.subject).toBe("nope");
          expect(unknown.message).toContain('error [nope]: No plugin "nope" (Check the id)');
          expect(yield* client["Host.Reload"]()).toEqual({ started: ["x"], restarted: [], stopped: [] });

          // Configure writes rows and reports the change; a disabled plugin stays in the list as "disabled".
          expect(yield* client["Host.Configure"]({ plugins: { greeter: { enabled: false } }, scope: "project" })).toEqual({
            started: [],
            restarted: [],
            stopped: ["greeter"],
          });
          expect(host.holder.off).toEqual({ greeter: "project" });
          const afterConfigure = yield* client["Host.Plugins"]();
          expect(afterConfigure.find((plugin) => plugin.id === "greeter")).toMatchObject({ enabled: false, state: "disabled", scope: "project" });
          const pinnedOff = hostError(yield* Effect.exit(client["Host.Configure"]({ plugins: { transport: { enabled: false } } })));
          expect(pinnedOff).toMatchObject({ code: "ReloadError", subject: "transport" });
        }),
      ),
    30_000,
  );

  test("lists host plugins' inspectors and serves their snapshots; a failing one is an error, not a crash", () => {
    // Adds inspectors without requiring anything: a registry contribution, as any plugin may make.
    const inspected = definePlugin({
      id: "inspected",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          Effect.all([
            owner.add(Inspectors, { id: "inspected.state", title: "State", snapshot: Effect.succeed([{ key: "a", value: 1 }]) }),
            owner.add(Inspectors, { id: "inspected.broken", title: "Broken", snapshot: Effect.die(new Error("no state here")) }),
            // A count kept as a BigInt, which JSON cannot carry.
            owner.add(Inspectors, { id: "inspected.big", title: "Big", snapshot: () => [{ count: 1n }] }),
            owner.add(Inspectors, { id: "inspected.nothing", title: "Nothing", snapshot: () => undefined }),
          ]),
        ).pipe(Effect.orDie),
      ),
    });
    return withHost(
      (host) =>
        Effect.gen(function* () {
          const client = yield* host.connect("websocket");
          const listed = yield* client["Host.Inspectors"]();
          expect(listed).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: "commands.registered", title: "Commands", source: "commands" }),
              { id: "inspected.state", title: "State", source: "inspected" },
            ]),
          );
          expect(yield* client["Host.Inspect"]({ id: "inspected.state" })).toEqual([{ key: "a", value: 1 }]);
          expect(yield* client["Host.Inspect"]({ id: "commands.registered" })).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: "test.greet", plugin: "greeter" })]),
          );
          expect(hostError(yield* Effect.exit(client["Host.Inspect"]({ id: "inspected.broken" })))).toMatchObject({ code: "Failed", message: "no state here" });
          expect(hostError(yield* Effect.exit(client["Host.Inspect"]({ id: "nothing" })))).toMatchObject({ code: "NotFound" });
          // A snapshot JSON cannot carry fails its own request, never the connection: the subscription goes on.
          const events = yield* Effect.forkChild(Stream.runDrain(client["Host.Events"]()));
          expect(hostError(yield* Effect.exit(client["Host.Inspect"]({ id: "inspected.big" })))).toMatchObject({
            code: "Failed",
            subject: "inspected.big",
            message: expect.stringContaining("Expected JSON value"),
          });
          // One with nothing to show is no value.
          expect(yield* client["Host.Inspect"]({ id: "inspected.nothing" })).toBeNull();
          // The transport is still serving.
          expect((yield* client["Host.Info"]()).version).toBeDefined();
          expect(events.pollUnsafe()).toBeUndefined();
        }),
      {},
      undefined,
      [inspected],
    );
  }, 30_000);

  test(
    "serves the same surface over streaming HTTP",
    () =>
      withHost((host) =>
        Effect.gen(function* () {
          const client = yield* host.connect("http");
          const events = yield* subscribe(client);
          const session = yield* client["Session.Create"]({ cwd: "/elsewhere" });
          expect(session.cwd).toBe("/elsewhere");
          yield* client["Agent.Prompt"]({ sessionId: session.id, content: text("yo") });
          yield* waitFor(events, (event) => event.type === "turn-ended" && event.sessionId === session.id);
          expect((yield* client["Session.Events"]({ sessionId: session.id })).length).toBe(2);
          expect(hostError(yield* Effect.exit(client["Session.Get"]({ sessionId: "missing" })))).toMatchObject({ code: "NotFound" });
        }),
      ),
    30_000,
  );

  test(
    "serves workspace status, branches, and checkout",
    () =>
      withHost((host) =>
        Effect.gen(function* () {
          const client = yield* host.connect("websocket");
          expect(yield* client["Workspace.Status"]({ path: "/elsewhere" })).toEqual({ path: "/elsewhere", exists: true });
          expect((yield* client["Workspace.Branches"]({ path: "/work" })).map((branch) => [branch.name, branch.current])).toEqual([
            ["main", true],
            ["dev", false],
          ]);
          expect((yield* client["Workspace.Checkout"]({ path: "/work", branch: "dev" })).git?.branch).toBe("dev");
          expect((yield* client["Workspace.Checkout"]({ path: "/work", branch: "topic", create: true })).git?.branch).toBe("topic");
          expect(hostError(yield* Effect.exit(client["Workspace.Branches"]({ path: "/elsewhere" })))).toMatchObject({
            code: "NotRepository",
            subject: "/elsewhere",
          });
          expect(hostError(yield* Effect.exit(client["Workspace.Checkout"]({ path: "/work", branch: "nope" })))).toEqual(
            new HostError({ code: "Failed", message: "fatal: invalid reference: nope", subject: "/work" }),
          );
        }),
      ),
    30_000,
  );

  test(
    "searches files with the caller's options, through the first searcher",
    () =>
      withHost(
        (host) =>
          Effect.gen(function* () {
            const client = yield* host.connect("websocket");
            expect(yield* client["Files.Search"]({ cwd: "/work", query: "src" })).toEqual({
              root: "/work",
              entries: [
                { path: "src/app.ts", kind: "file" },
                { path: "src", kind: "directory" },
              ],
              truncated: false,
            });
            expect(yield* client["Files.Search"]({ cwd: "/work", query: "src", limit: 1, kind: "directory" })).toEqual({
              root: "/work",
              entries: [{ path: "src", kind: "directory" }],
              truncated: false,
            });
            expect(hostError(yield* Effect.exit(client["Files.Search"]({ cwd: "/elsewhere", query: "" })))).toEqual(
              new HostError({ code: "NotFound", message: '"/elsewhere" is not a directory', subject: "/elsewhere" }),
            );
            expect((yield* client["Files.Search"]({ cwd: "/work", query: "", within: "src" })).entries).toEqual([{ path: "src/app.ts", kind: "file" }]);
          }),
        {},
        undefined,
        [fakeFileSearch],
      ),
    30_000,
  );

  test(
    "answers Unavailable with no file searcher, and keeps serving",
    () =>
      withHost((host) =>
        Effect.gen(function* () {
          const client = yield* host.connect("websocket");
          expect(hostError(yield* Effect.exit(client["Files.Search"]({ cwd: "/work", query: "" })))).toMatchObject({ code: "Unavailable", subject: "/work" });
          expect((yield* client["Workspace.Status"]({ path: "/work" })).exists).toBe(true);
        }),
      ),
    30_000,
  );

  test(
    "routes interactions to subscribed clients",
    () =>
      withHost((host) =>
        Effect.gen(function* () {
          const client = yield* host.connect("websocket");
          const events = yield* subscribe(client);
          const interaction = yield* host.core.run(Interaction);

          const confirm = yield* Effect.forkChild(host.core.run(interaction.confirm("Proceed?", "details")));
          const [request] = (yield* waitFor(events, (event) => event.type === "interaction")).slice(-1);
          expect(request).toEqual({ type: "interaction", request: { type: "confirm", id: "i1", title: "Proceed?", detail: "details" } });
          // A client that was not listening when it was asked can still read it.
          expect(yield* client["Interaction.List"]()).toEqual([{ type: "confirm", id: "i1", title: "Proceed?", detail: "details" }]);

          expect(hostError(yield* Effect.exit(client["Interaction.Answer"]({ id: "i1", answer: { type: "ask", value: "x" } })))).toMatchObject({
            code: "Mismatch",
            subject: "i1",
          });
          expect(hostError(yield* Effect.exit(client["Interaction.Answer"]({ id: "zzz", answer: { type: "confirm", value: true } })))).toMatchObject({
            code: "NotFound",
          });
          yield* client["Interaction.Answer"]({ id: "i1", answer: { type: "confirm", value: true } });
          expect(yield* Fiber.join(confirm)).toBe(true);
          expect(yield* client["Interaction.List"]()).toEqual([]);
          yield* waitFor(events, (event) => event.type === "interaction-closed" && event.id === "i1");
          expect(hostError(yield* Effect.exit(client["Interaction.Answer"]({ id: "i1", answer: { type: "confirm", value: false } })))).toMatchObject({
            code: "NotFound",
          });

          const ask = yield* Effect.forkChild(host.core.run(interaction.ask("Name?")));
          yield* waitFor(events, (event) => event.type === "interaction" && event.request.id === "i2");
          yield* client["Interaction.Dismiss"]({ id: "i2" });
          expect(interactionError(yield* Fiber.await(ask))).toMatchObject({ reason: "Dismissed" });

          // Interrupting the asker withdraws the question from every client.
          const withdrawn = yield* Effect.forkChild(host.core.run(interaction.confirm("Still?")));
          yield* waitFor(events, (event) => event.type === "interaction" && event.request.id === "i3");
          yield* Fiber.interrupt(withdrawn);
          yield* waitFor(events, (event) => event.type === "interaction-closed" && event.id === "i3");
        }),
      ),
    30_000,
  );

  test(
    "sends subscribed only to a subscriber that asks for it, so a client from before it is unaffected",
    () =>
      withHost((host) =>
        Effect.gen(function* () {
          yield* subscribe(yield* host.connect("websocket"));
          const older = yield* (yield* host.connect("websocket"))["Host.Events"](undefined, { asQueue: true });
          // Published until the subscriber that did not ask sees one, so it has joined.
          const publish = host.core.run(Effect.flatMap(Events, (bus) => bus.publish(Notice, { level: "info", message: "hello" })));
          const pinger = yield* Effect.forkChild(Effect.repeat(publish, Schedule.spaced(Duration.millis(20))));
          const seen = yield* waitFor(older, (event) => event.type === "notice");
          yield* Fiber.interrupt(pinger);
          expect(seen.map((event) => event.type)).not.toContain("subscribed");
        }),
      ),
    30_000,
  );

  test(
    "replays open interactions to a client that subscribes later",
    () =>
      withHost((host) =>
        Effect.gen(function* () {
          const first = yield* subscribe(yield* host.connect("websocket"));
          const interaction = yield* host.core.run(Interaction);
          const select = yield* Effect.forkChild(
            host.core.run(
              interaction.select("Model?", [
                { value: "a", label: "A" },
                { value: "b", label: "B" },
              ]),
            ),
          );
          yield* waitFor(first, (event) => event.type === "interaction");
          const second = yield* host.connect("websocket");
          const secondEvents = yield* second["Host.Events"](undefined, { asQueue: true, headers: { [SUBSCRIBED_HEADER]: "1" } });
          const [subscribed, replayed] = yield* waitFor(secondEvents, (event) => event.type === "interaction");
          // A subscription opens with `subscribed`; the question open before it is replayed next.
          expect(subscribed).toEqual({ type: "subscribed" });
          expect(replayed).toMatchObject({ type: "interaction", request: { type: "select", id: "i1" } });
          expect(hostError(yield* Effect.exit(second["Interaction.Answer"]({ id: "i1", answer: { type: "select", value: "z" } })))).toMatchObject({
            code: "Mismatch",
          });
          yield* second["Interaction.Answer"]({ id: "i1", answer: { type: "select", value: "b" } });
          expect(yield* Fiber.join(select)).toBe("b");
        }),
      ),
    30_000,
  );

  test(
    "lists commands and runs one, asking its question through the event stream",
    () =>
      withHost((host) =>
        Effect.gen(function* () {
          const client = yield* host.connect("websocket");
          const events = yield* subscribe(client);
          expect(yield* client["Command.List"]()).toEqual([{ id: "test.greet", title: "Greet…", category: "Test", source: "greeter" }]);

          const answered = yield* Effect.forkChild(client["Command.Run"]({ id: "test.greet", cwd: "/project", sessionId: "s1" }));
          const [asked] = (yield* waitFor(events, (event) => event.type === "interaction")).slice(-1);
          if (asked?.type !== "interaction") throw new Error("expected an interaction");
          yield* client["Interaction.Answer"]({ id: asked.request.id, answer: { type: "ask", value: "Ada" } });
          expect(yield* Fiber.join(answered)).toEqual({ message: "Hello, Ada, in /project (s1)" });

          const dismissed = yield* Effect.forkChild(client["Command.Run"]({ id: "test.greet" }));
          const [again] = (yield* waitFor(events, (event) => event.type === "interaction")).slice(-1);
          if (again?.type !== "interaction") throw new Error("expected an interaction");
          yield* client["Interaction.Dismiss"]({ id: again.request.id });
          expect(hostError(yield* Fiber.await(dismissed))).toMatchObject({ code: "Cancelled", subject: "test.greet" });

          expect(hostError(yield* Effect.exit(client["Command.Run"]({ id: "nope" })))).toMatchObject({ code: "NotFound", subject: "nope" });

          yield* host.core.run(Effect.flatMap(Events, (bus) => bus.publish(CommandsChanged, { commands: [] })));
          yield* waitFor(events, (event) => event.type === "commands-changed" && event.commands.length === 0);
        }),
      ),
    30_000,
  );

  test(
    "a login RPC asks its question through the event stream",
    () =>
      withHost((host) =>
        Effect.gen(function* () {
          const client = yield* host.connect("websocket");
          const events = yield* subscribe(client);
          const login = yield* Effect.forkChild(client["Llm.Login"]({ provider: "fake", type: "api_key" }));
          const [asked] = (yield* waitFor(events, (event) => event.type === "interaction")).slice(-1);
          if (asked?.type !== "interaction") throw new Error("expected an interaction");
          yield* client["Interaction.Answer"]({ id: asked.request.id, answer: { type: "ask", value: "good" } });
          expect(Exit.isSuccess(yield* Fiber.await(login))).toBe(true);
        }),
      ),
    30_000,
  );

  test(
    "cancelling a login withdraws its question and fails the RPC Cancelled",
    () =>
      withHost((host) =>
        Effect.gen(function* () {
          const client = yield* host.connect("websocket");
          const events = yield* subscribe(client);
          expect(yield* client["Llm.CancelLogin"]({ provider: "fake" })).toBe(false);
          const login = yield* Effect.forkChild(client["Llm.Login"]({ provider: "fake", type: "api_key" }));
          const [asked] = (yield* waitFor(events, (event) => event.type === "interaction")).slice(-1);
          if (asked?.type !== "interaction") throw new Error("expected an interaction");
          // Another client may cancel it: the login is the plugin's, not the caller's.
          const other = yield* host.connect("websocket");
          expect(yield* other["Llm.CancelLogin"]({ provider: "fake" })).toBe(true);
          expect(hostError(yield* Fiber.await(login))).toMatchObject({ code: "Cancelled" });
          yield* waitFor(events, (event) => event.type === "interaction-closed" && event.id === asked.request.id);
          expect(yield* client["Llm.CancelLogin"]({ provider: "fake" })).toBe(false);
        }),
      ),
    30_000,
  );

  test(
    "a login outlives a dropped RPC, so a returning client answers its replayed question",
    () =>
      withHost(
        (host) =>
          Effect.gen(function* () {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const client = yield* host.connect("websocket");
                const events = yield* subscribe(client);
                yield* Effect.forkChild(client["Llm.Login"]({ provider: "fake", type: "api_key" }));
                yield* waitFor(events, (event) => event.type === "interaction");
              }),
            );
            // The page reloaded: the old socket is gone, but the question is still open.
            const client = yield* host.connect("websocket");
            const events = yield* client["Host.Events"](undefined, { asQueue: true });
            const replayed = (yield* waitFor(events, (event) => event.type === "interaction")).at(-1);
            if (replayed?.type !== "interaction") throw new Error("expected an interaction");
            // Retrying joins the login in flight instead of starting another; a different method is refused.
            const retry = yield* Effect.forkChild(client["Llm.Login"]({ provider: "fake", type: "api_key" }));
            expect(hostError(yield* Effect.exit(client["Llm.Login"]({ provider: "fake", type: "oauth" })))).toMatchObject({ code: "Busy", subject: "fake" });
            yield* client["Interaction.Answer"]({ id: replayed.request.id, answer: { type: "ask", value: "good" } });
            expect(Exit.isSuccess(yield* Fiber.await(retry))).toBe(true);
            yield* waitFor(events, (event) => event.type === "interaction-closed" && event.id === replayed.request.id);
          }),
        { interactionGraceMs: 5_000 },
      ),
    30_000,
  );

  test("keeps a generated token in <home>/token across restarts and host starts; a configured token wins", async () => {
    const home = await mkdtemp(join(tmpdir(), "lemma-transport-"));
    const file = join(home, "token");
    try {
      const token = await withHost(
        (host) =>
          Effect.gen(function* () {
            yield* host.core.restart("transport");
            const found = yield* readDiscovery(host.home);
            expect(found?.token).toBe(host.token);
            expect(yield* Effect.promise(() => fetch(`${found!.url}/api/health?token=${encodeURIComponent(host.token)}`).then((r) => r.status))).toBe(200);
            return host.token;
          }),
        {},
        home,
      );
      expect((await readFile(file, "utf8")).trim()).toBe(token);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      // A new host with the same home: the clients it served before still hold a valid token.
      expect(await withHost((host) => Effect.succeed(host.token), {}, home)).toBe(token);
      expect(await withHost((host) => Effect.succeed(host.token), { token: "configured" }, home)).toBe("configured");
      expect((await readFile(file, "utf8")).trim()).toBe(token);
      // Deleting the file rotates the token at the next start.
      await rm(file);
      const rotated = await withHost((host) => Effect.succeed(host.token), {}, home);
      expect(rotated).not.toBe(token);
      expect((await readFile(file, "utf8")).trim()).toBe(rotated);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("hosts creating the token file at once agree on one token; an empty file is an error, not a new token", async () => {
    const home = join(await mkdtemp(join(tmpdir(), "lemma-transport-")), "home");
    try {
      const tokens = await Effect.runPromise(
        Effect.all(
          Array.from({ length: 8 }, () => loadToken(home)),
          { concurrency: "unbounded" },
        ),
      );
      expect(new Set(tokens).size).toBe(1);
      expect(tokens[0]).toMatch(/^[\w-]{32}$/);
      expect(await readdir(home)).toEqual(["token"]);
      expect((await stat(home)).mode & 0o777).toBe(0o700);
      await writeFile(join(home, "token"), "  \n");
      const exit = await Effect.runPromiseExit(loadToken(home));
      expect(Option.getOrUndefined(Exit.findErrorOption(exit))?.message).toBe(
        `${join(home, "token")} is empty; delete it and restart the host to generate a new token`,
      );
    } finally {
      await rm(join(home, ".."), { recursive: true, force: true });
    }
  });

  test("without subscribers the question falls through to the terminal", () =>
    withHost((host) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(host.core.run(Effect.flatMap(Interaction, (interaction) => interaction.confirm("Anyone?"))));
        expect(interactionError(exit)).toMatchObject({ reason: "Unavailable", message: "No answerer is attached" });
      }),
    ));

  test(
    "fails Unavailable when every client stays away past the grace period",
    () =>
      withHost((host) =>
        Effect.gen(function* () {
          const interaction = yield* host.core.run(Interaction);
          const confirm = yield* Effect.scoped(
            Effect.gen(function* () {
              const events = yield* subscribe(yield* host.connect("websocket"));
              const confirm = yield* Effect.forkChild(host.core.run(interaction.confirm("Still there?")));
              yield* waitFor(events, (event) => event.type === "interaction");
              return confirm;
            }),
          );
          const error = interactionError(yield* Fiber.await(confirm));
          expect(error).toMatchObject({ reason: "Unavailable" });
          expect(error.message).toContain("disconnected");
        }),
      ),
    30_000,
  );

  test("serves a static web app with SPA fallback and no token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lemma-web-"));
    try {
      await mkdir(join(dir, "assets"));
      await writeFile(join(dir, "index.html"), "<!doctype html><title>lemma</title>");
      await writeFile(join(dir, "assets", "app.js"), "console.log(1)");
      await writeFile(join(dir, "..well-known.txt"), "dots");
      await writeFile(join(tmpdir(), "lemma-secret.txt"), "secret");
      await withHost(
        (host) =>
          Effect.gen(function* () {
            const get = (path: string) =>
              Effect.promise(async () => {
                const response = await fetch(`${host.url}${path}`);
                return { status: response.status, type: response.headers.get("content-type"), body: await response.text() };
              });
            expect(yield* get("/")).toMatchObject({ status: 200, body: "<!doctype html><title>lemma</title>" });
            expect(yield* get("/assets/app.js")).toMatchObject({ status: 200, body: "console.log(1)" });
            expect((yield* get("/assets/app.js")).type).toContain("javascript");
            expect(yield* get("/sessions/s1")).toMatchObject({ status: 200, body: "<!doctype html><title>lemma</title>" });
            expect((yield* get("/assets/missing.js")).status).toBe(404);
            expect((yield* get("/%2e%2e/lemma-secret.txt")).status).toBe(404);
            expect((yield* get("/..%2flemma-secret.txt")).status).toBe(404);
            // A name starting with ".." is still inside.
            expect(yield* get("/..well-known.txt")).toMatchObject({ status: 200, body: "dots" });
          }),
        { staticDir: dir },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(join(tmpdir(), "lemma-secret.txt"), { force: true });
    }
  });

  test("removes the discovery file and releases the port on shutdown, even with a client attached", async () => {
    const home = await mkdtemp(join(tmpdir(), "lemma-transport-"));
    try {
      const started = Date.now();
      const url = await withHost(
        (host) =>
          Effect.gen(function* () {
            yield* subscribe(yield* host.connect("websocket"));
            expect(yield* readDiscovery(host.home)).toMatchObject({ url: host.url, token: host.token, pid: process.pid });
            expect((yield* Effect.promise(() => stat(join(host.home, "transport.json")))).mode & 0o777).toBe(0o600);
            return host.url;
          }),
        {},
        home,
      );
      expect(Date.now() - started).toBeLessThan(5000);
      expect(existsSync(join(home, "transport.json"))).toBe(false);
      const port = Number(new URL(url).port);
      await expect(fetch(`${url}/api/health`)).rejects.toThrow();
      await new Promise<void>((resolve, reject) => {
        const server = createServer()
          .once("error", reject)
          .listen(port, "127.0.0.1", () => server.close(() => resolve()));
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  test("stops promptly and frees the port while a client is still connected", async () => {
    // The client outlives the host, as a browser tab does when a reload restarts the transport.
    const clientScope = await Effect.runPromise(Scope.make());
    try {
      const started = Date.now();
      const url = await withHost((host) =>
        Effect.gen(function* () {
          const client = yield* Scope.provide(host.connect("websocket"), clientScope);
          yield* Effect.forkIn(Stream.runDrain(client["Host.Events"]()), clientScope);
          yield* client["Host.Info"]();
          return host.url;
        }),
      );
      expect(Date.now() - started).toBeLessThan(5000);
      const port = Number(new URL(url).port);
      await new Promise<void>((resolve, reject) => {
        const server = createServer()
          .once("error", reject)
          .listen(port, "127.0.0.1", () => server.close(() => resolve()));
      });
    } finally {
      await Effect.runPromise(Scope.close(clientScope, Exit.void));
    }
  });
});
