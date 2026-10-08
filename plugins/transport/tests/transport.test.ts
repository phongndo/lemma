import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Queue, Scope, Stream } from "effect";
import { Commands, HOST_PROTOCOL, Inspectors, Interaction, InteractionError, InteractionOrigin } from "@lemma/contracts";
import type { CommandInfo } from "@lemma/contracts";
import { readDiscovery } from "@lemma/contracts/discovery";
import { definePlugin, PluginContext } from "@lemma/core";
import { runtimeCapabilities } from "../../../packages/host/src/runtime.ts";
import transport from "../src/index.ts";
import { loadToken } from "../src/token.ts";
import { failure, hostError, subscribe, waitFor, withHost } from "./harness.ts";
import type { HostEvent } from "./harness.ts";

const interactionError = (exit: Exit.Exit<unknown, unknown>): InteractionError => {
  const error = failure(exit);
  if (error instanceof InteractionError) return error;
  throw new Error(`Expected an InteractionError, got ${String(exit)}`);
};

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
        const exit = yield* Effect.exit(client["Host.Info"]());
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

  test(
    "serves the host's control over WebSocket: its info, its plugins, restarts, reloads, and config changes",
    () =>
      withHost((host) =>
        Effect.gen(function* () {
          const client = yield* host.connect("websocket");
          const events = yield* subscribe(client);
          expect(yield* client["Host.Info"]()).toEqual({
            version: "0.1.0",
            cwd: "/work",
            home: host.home,
            composition: { id: "c0ffee", plugins: [{ id: "transport", version: "0.1.0" }] },
            runtime: ["lemma/Paths", "lemma/HostControl"],
          });
          const plugins = yield* client["Host.Plugins"]();
          // It requires the runtime only: each subsystem serves its own calls as channels, so none restarts it.
          expect(plugins.find((plugin) => plugin.id === "transport")).toEqual({
            id: "transport",
            version: "0.1.0",
            source: "bundled",
            enabled: true,
            state: "active",
            provides: [],
            requires: ["lemma/Paths", "lemma/HostControl"],
          });
          yield* client["Host.RestartPlugin"]({ pluginId: "greeter" });
          yield* client["Host.RestartPlugin"]({ pluginId: "greeter", force: true });
          expect(host.holder.restarted).toEqual(["greeter", "greeter!"]);
          const [changed] = (yield* waitFor(events, (event) => event.type === "plugins-changed")).slice(-1);
          expect(changed?.type === "plugins-changed" && changed.plugins.some((plugin) => plugin.id === "greeter")).toBe(true);
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

  test("requires only what the host provides itself", () => {
    const runtime = new Set(runtimeCapabilities.map((tag) => tag.key));
    expect(transport.requires.map((tag) => tag.key).filter((key) => !runtime.has(key))).toEqual([]);
  });

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
          expect((yield* client["Host.Info"]()).cwd).toBe("/work");
          yield* client["Ui.Configure"]({ plugins: { composer: { enabled: false } } });
          yield* waitFor(events, (event) => event.type === "ui-changed");
          expect(yield* client["Channel.Call"]({ id: "commands.list" })).toEqual([{ id: "test.greet", title: "Greet…", category: "Test", source: "greeter" }]);
          expect(hostError(yield* Effect.exit(client["Host.Inspect"]({ id: "missing" })))).toMatchObject({ code: "NotFound" });
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
          const secondEvents = yield* second["Host.Events"](undefined, { asQueue: true });
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

  test("serves the commands plugin's channels: the list, a run where and for whom the caller says, and the list again when it changes", () => {
    const later = Deferred.makeUnsafe<void>();
    // `test.where` answers where it ran and for whom; `test.later` comes once `later` is done.
    const where = definePlugin({
      id: "where",
      requires: [Commands],
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const commands = yield* Commands;
          yield* commands.register({
            id: "test.where",
            title: "Where",
            category: "Test",
            run: ({ cwd, sessionId }) =>
              Effect.map(Effect.service(InteractionOrigin), (origin) => ({ message: [cwd, sessionId ?? "-", origin ?? "-"].join(" ") })),
          });
          const added = commands.register({ id: "test.later", title: "Later", category: "Test", run: () => Effect.void });
          yield* Effect.forkScoped(Effect.andThen(Deferred.await(later), Effect.orDie(added)));
        }),
      ),
    });
    const ids = (list: unknown) => (list as readonly CommandInfo[]).map((info) => info.id);
    return withHost(
      (host) =>
        Effect.gen(function* () {
          const client = yield* host.connect("websocket");
          const events = yield* subscribe(client);
          const changes = yield* Queue.unbounded<unknown>();
          yield* Effect.forkChild(Stream.runForEach(client["Channel.Open"]({ id: "commands.changes" }), (list) => Queue.offer(changes, list)));
          // The first list is every command now: the stream is live, and a client resyncs from it.
          expect(ids(yield* Queue.take(changes))).toEqual(["test.greet", "test.where"]);
          expect(yield* client["Channel.Call"]({ id: "commands.list" })).toEqual([
            { id: "test.greet", title: "Greet…", category: "Test", source: "greeter" },
            { id: "test.where", title: "Where", category: "Test", source: "where" },
          ]);

          // In the host's directory unless the caller names one, and with the caller's origin.
          expect(yield* client["Channel.Call"]({ id: "commands.run", payload: { id: "test.where" } })).toEqual({ message: "/work - -" });
          expect(
            yield* client["Channel.Call"]({ id: "commands.run", payload: { id: "test.where", cwd: "/project", sessionId: "s1", origin: "palette-1" } }),
          ).toEqual({ message: "/project s1 palette-1" });

          // A refused run's reason is the code, and its command the subject.
          const dismissed = yield* Effect.forkChild(client["Channel.Call"]({ id: "commands.run", payload: { id: "test.greet" } }));
          const [asked] = (yield* waitFor(events, (event) => event.type === "interaction")).slice(-1);
          if (asked?.type !== "interaction") throw new Error("expected an interaction");
          yield* client["Interaction.Dismiss"]({ id: asked.request.id });
          expect(hostError(yield* Fiber.await(dismissed))).toMatchObject({ code: "Cancelled", subject: "test.greet" });
          expect(hostError(yield* Effect.exit(client["Channel.Call"]({ id: "commands.run", payload: { id: "nope" } })))).toMatchObject({
            code: "NotFound",
            subject: "nope",
          });

          yield* Deferred.succeed(later, undefined);
          expect(ids(yield* Queue.take(changes))).toEqual(["test.greet", "test.later", "test.where"]);
        }),
      {},
      undefined,
      [where],
    );
  }, 30_000);

  test(
    "a run waiting on its command ends Withdrawn at once when the commands plugin stops, despite a long dispose deadline; run again, it reaches the replacement",
    () =>
      withHost(
        (host) =>
          Effect.gen(function* () {
            const client = yield* host.connect("websocket");
            const events = yield* subscribe(client);
            const asked = (event: HostEvent) => event.type === "interaction";
            const question = (seen: readonly HostEvent[]) => {
              const last = seen.at(-1);
              if (last?.type !== "interaction") throw new Error("expected an interaction");
              return last.request.id;
            };
            // Waits on its question, which only the commands plugin's stopping ends here.
            const run = yield* Effect.forkChild(Effect.exit(client["Channel.Call"]({ id: "commands.run", payload: { id: "test.greet" } })));
            const first = question(yield* waitFor(events, asked));
            const started = Date.now();
            // The transport needs none of it, so the connection stays: nothing but the channel's own plugin restarts.
            yield* host.core.restart("commands", { force: true });
            expect(hostError(yield* Fiber.join(run))).toMatchObject({ code: "Withdrawn", subject: "commands.run" });
            expect(Date.now() - started).toBeLessThan(5_000);
            yield* waitFor(events, (event) => event.type === "interaction-closed" && event.id === first);

            const again = yield* Effect.forkChild(client["Channel.Call"]({ id: "commands.run", payload: { id: "test.greet" } }));
            const second = question(yield* waitFor(events, asked));
            yield* client["Interaction.Answer"]({ id: second, answer: { type: "ask", value: "Ada" } });
            expect(yield* Fiber.join(again)).toEqual({ message: "Hello, Ada, in /work" });
          }),
        {},
        undefined,
        [],
        { dispose: Duration.seconds(30) },
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
