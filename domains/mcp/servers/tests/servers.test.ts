import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Stream } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";
import { PromptSections } from "@lemma/agent";
import { definePlugin, Events, Hooks, makeCore, PluginContext, Registries } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { eventFeed, Paths } from "@lemma/contracts";
import { Mcp, McpChanged, McpServers } from "@lemma/mcp";
import type { McpServerConfig, McpState } from "@lemma/mcp";
import { declaredTools, ToolInvocation, ToolNamespaces, ToolRunner } from "@lemma/tools";
import { textOf } from "@lemma/tools/testing";
import registry from "@lemma/tools-registry";
import mcpServers from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/server.ts", import.meta.url));
const local: McpServerConfig = { command: process.execPath, args: [fixture] };

/** A core with the tools registry and the plugin, in a home of its own with `servers` in its `mcp.json`. */
const withCore = <A>(
  servers: Readonly<Record<string, unknown>>,
  body: (
    core: { run: <B, E>(effect: Effect.Effect<B, E, Mcp | ToolRunner | Events | Hooks | Registries>) => Effect.Effect<B, E> },
    home: string,
  ) => Effect.Effect<A, unknown, Scope.Scope>,
  extra: readonly Plugin[] = [],
  configs: Readonly<Record<string, unknown>> = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "lemma-mcp-")));
        yield* Effect.promise(() => writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: servers })));
        const paths = { home, userConfig: join(home, "config.jsonc"), projectConfig: join(home, "project.jsonc"), cwd: home };
        const core = yield* makeCore([registry, mcpServers, ...extra], { configs, provide: { provides: [Paths], layer: Layer.succeed(Paths, paths) } });
        return yield* body(core as never, home);
      }),
    ),
  );

/** The state once `check` holds of it: now, or after a change. */
const until = (check: (state: McpState) => boolean) =>
  Effect.gen(function* () {
    const mcp = yield* Mcp;
    const events = yield* Events;
    const found = yield* eventFeed(mcp.state, [events.stream(McpChanged)]).pipe(Stream.filter(check), Stream.runHead);
    return found._tag === "Some" ? found.value : yield* Effect.die(new Error("the state stream ended"));
  }).pipe(Effect.timeout("30 seconds"));

const server = (state: McpState, name: string) => state.servers.find((candidate) => candidate.name === name)!;
const connected = (name: string) => (state: McpState) => server(state, name)?.state === "connected";

const call = (name: string, input: unknown) =>
  Effect.flatMap(ToolRunner, (tools) =>
    tools.execute(new ToolInvocation({ sessionId: "s", toolCallId: "c", name, input, cwd: process.cwd() }), new AbortController().signal),
  );

const listed = Effect.flatMap(ToolRunner, (tools) => tools.list);

describe("a server in mcp.json", () => {
  it("connects, and adds its tools for code mode alone, which call it", async () => {
    await withCore({ fixture: local }, (core) =>
      core.run(
        Effect.gen(function* () {
          const state = yield* until(connected("fixture"));
          const status = server(state, "fixture");
          expect(status.server).toMatchObject({ name: "fixture", version: "1.2.3" });
          expect(status.protocolVersion).toBe("2026-07-28");
          expect(status.icon).toBe(
            "data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAyNCAyNCc+PGNpcmNsZSBjeD0nMTInIGN5PScxMicgcj0nMTAnIGZpbGw9JyMxMGEzN2YnLz48L3N2Zz4=",
          );
          expect(status.instructions).toBe("Tools for the tests.");
          expect(status.stderr).toContain("fixture: started");
          expect(status.tools.map((tool) => [tool.name, tool.tool, tool.exposure])).toContainEqual(["add-numbers", "mcp__fixture__add_numbers", "codemode"]);

          const tools = yield* listed;
          const echo = tools.find((tool) => tool.spec.name === "mcp__fixture__echo")!;
          expect(echo).toMatchObject({ source: "mcp.servers", nested: true });
          expect(echo.spec.description).toBe('Echo: Says its text back (MCP server "fixture")');
          expect(echo.spec.parameters).toMatchObject({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });

          expect(textOf(yield* call("mcp__fixture__echo", { text: "hello" }))).toBe("hello");
          const sum = yield* call("mcp__fixture__add_numbers", { a: 2, b: 3 });
          expect(textOf(sum)).toBe('{"sum":5}');
          expect(sum.details).toMatchObject({ server: "fixture", tool: "add-numbers", structuredContent: { sum: 5 } });
          // A script gets the whole result, typed by the tool's output schema, and finds the server's tools by its namespace.
          expect(sum.structured).toEqual({ content: [{ type: "text", text: '{"sum":5}' }], structuredContent: { sum: 5 } });
          expect(tools.find((tool) => tool.spec.name === "mcp__fixture__add_numbers")).toMatchObject({
            namespace: "mcp__fixture",
            output: { type: "object", required: ["content"], properties: { structuredContent: { type: "object", properties: { sum: { type: "number" } } } } },
          });
          const namespaces = (yield* (yield* Registries).items(ToolNamespaces)).map(({ item }) => item);
          expect(namespaces).toEqual([
            { name: "mcp__fixture", description: "Tools for the tests.", instructions: "Tools for the tests.", aliases: ["fixture"] },
          ]);
          const failed = yield* call("mcp__fixture__fail", {});
          expect([failed.isError, textOf(failed)]).toEqual([true, "it failed"]);
        }),
      ),
    );
  });

  it("speaks the 2025 protocol to a server that knows only it", async () => {
    const legacy = { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/legacy.ts", import.meta.url))] };
    await withCore({ legacy }, (core) =>
      core.run(
        Effect.gen(function* () {
          const state = yield* until(connected("legacy"));
          expect(server(state, "legacy")).toMatchObject({ protocolVersion: "2025-11-25", server: { name: "legacy", version: "0.9.0" } });
          expect(textOf(yield* call("mcp__legacy__ping", {}))).toBe("pong");
        }),
      ),
    );
  });

  it("keeps a long result's start and end, and the whole of it in a file", async () => {
    await withCore({ fixture: local }, (core) =>
      core.run(
        Effect.gen(function* () {
          yield* until(connected("fixture"));
          const result = yield* call("mcp__fixture__big", { chars: 100_000 });
          const text = textOf(result);
          expect(text).toContain("\n\nstartx");
          expect(text).toContain("tokens truncated");
          const path = (result.details as { fullOutputPath: string }).fullOutputPath;
          expect(text).toContain(path);
          expect((yield* Effect.promise(() => readFile(path, "utf8"))).length).toBe(100_008);
        }),
      ),
    );
  });

  it("cuts a long result to fit the registry's cap, so the note naming the whole of it survives", async () => {
    await withCore(
      { fixture: local },
      (core) =>
        core.run(
          Effect.gen(function* () {
            yield* until(connected("fixture"));
            const result = yield* call("mcp__fixture__big", { chars: 100_000 });
            const text = textOf(result);
            expect(text.length).toBeLessThanOrEqual(5_000);
            expect(text).not.toContain("[Output truncated:");
            expect(text).toContain(`[Full output: ${(result.details as { fullOutputPath: string }).fullOutputPath}`);
          }),
        ),
      [],
      { "tools.registry": { maxResultChars: 5_000 } },
    );
  });

  it("adds a tool the server adds later, when it says its tools changed", async () => {
    await withCore({ fixture: local }, (core) =>
      core.run(
        Effect.gen(function* () {
          yield* until(connected("fixture"));
          yield* call("mcp__fixture__grow", {});
          yield* until((state) => server(state, "fixture").tools.some((tool) => tool.name === "later"));
          expect(textOf(yield* call("mcp__fixture__later", {}))).toBe("late");
        }),
      ),
    );
  });

  it("changes exposure and turns off through configure, writing the file", async () => {
    await withCore({ fixture: local }, (core, home) =>
      core.run(
        Effect.gen(function* () {
          const mcp = yield* Mcp;
          yield* until(connected("fixture"));
          yield* mcp.configure("fixture", { tools: { echo: "direct", "add-*": "hidden" } });
          const tools = yield* listed;
          expect(tools.find((tool) => tool.spec.name === "mcp__fixture__echo")?.nested).toBeUndefined();
          expect(tools.some((tool) => tool.spec.name === "mcp__fixture__add_numbers")).toBe(false);
          expect(JSON.parse(yield* Effect.promise(() => readFile(join(home, "mcp.json"), "utf8"))).mcpServers.fixture.toolExposure).toEqual({
            echo: "direct",
            "add-*": "hidden",
          });

          yield* mcp.configure("fixture", { enabled: false });
          expect(server(yield* mcp.state, "fixture")).toMatchObject({ state: "off", enabled: false });
          expect((yield* listed).some((tool) => tool.source === "mcp.servers")).toBe(false);

          yield* mcp.configure("fixture", { enabled: true });
          yield* until(connected("fixture"));
          expect((yield* listed).some((tool) => tool.spec.name === "mcp__fixture__echo")).toBe(true);
        }),
      ),
    );
  });

  it("adds, replaces, and removes a whole entry through put, keeping what another client keeps beside it", async () => {
    await withCore({ fixture: { ...local, alwaysAllow: ["echo"] } }, (core, home) =>
      core.run(
        Effect.gen(function* () {
          const mcp = yield* Mcp;
          yield* until(connected("fixture"));
          yield* mcp.put("second", { ...local, description: "Another copy" });
          const added = yield* until(connected("second"));
          expect(server(added, "second")).toMatchObject({ sourceKind: "file", entry: { ...local, description: "Another copy" } });
          yield* mcp.put("fixture", { ...local, exposure: "direct" });
          const file = () => Effect.promise(async () => JSON.parse(await readFile(join(home, "mcp.json"), "utf8")).mcpServers);
          expect((yield* file()).fixture).toEqual({ alwaysAllow: ["echo"], ...local, exposure: "direct" });
          yield* mcp.put("second", null);
          expect(Object.keys(yield* file())).toEqual(["fixture"]);
          expect((yield* mcp.state).servers.map((status) => status.name)).toEqual(["fixture"]);
          expect(yield* Effect.flip(mcp.put("bad name", local))).toMatchObject({ reason: "Invalid" });
          expect(yield* Effect.flip(mcp.put("both", { command: "x", url: "https://x" }))).toMatchObject({
            reason: "Invalid",
            message: "An entry has a command or a url, not both",
          });
        }),
      ),
    );
  });

  it("applies the file when it changes", async () => {
    await withCore({}, (core, home) =>
      core.run(
        Effect.gen(function* () {
          yield* until((state) => state.servers.length === 0);
          yield* Effect.promise(() => writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: local } })));
          yield* until(connected("fixture"));
          yield* Effect.promise(() => writeFile(join(home, "mcp.json"), "{ not json"));
          const broken = yield* until((state) => state.fileError !== undefined);
          // The servers it had stay.
          expect(server(broken, "fixture").state).toBe("connected");
        }),
      ),
    );
  });

  it("says why a server cannot start", async () => {
    await withCore(
      {
        missing: { command: "lemma-no-such-command-for-mcp" },
        variable: { ...local, env: { TOKEN: "${LEMMA_MCP_TEST_UNSET}" } },
        bad: { url: "https://example.com/mcp", type: "sse" },
        unschemed: { url: "example.com/mcp" },
      },
      (core) =>
        core.run(
          Effect.gen(function* () {
            const state = yield* until((current) => current.servers.every((status) => status.state === "failed"));
            expect(server(state, "missing").error).toBe("Command not found: lemma-no-such-command-for-mcp");
            expect(server(state, "variable").error).toBe("${LEMMA_MCP_TEST_UNSET} is not set in the host's environment");
            expect(server(state, "bad").error).toContain("SSE transport is not supported");
            expect(server(state, "unschemed").error).toBe("Not a URL: example.com/mcp (write it whole, as https://example.com/mcp)");
          }),
        ),
    );
  });

  it("turns off a server that never answers at once, rather than when its connect times out", async () => {
    const silent = { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], timeout: 30 };
    await withCore({ silent }, (core) =>
      core.run(
        Effect.gen(function* () {
          const mcp = yield* Mcp;
          yield* until((state) => server(state, "silent").state === "connecting");
          const started = Date.now();
          yield* mcp.configure("silent", { enabled: false });
          expect(Date.now() - started).toBeLessThan(5_000);
          expect(server(yield* mcp.state, "silent").state).toBe("off");
        }),
      ),
    );
  });
});

describe("a server a plugin adds", () => {
  const adding = (server: Partial<McpServerConfig>) =>
    definePlugin({
      id: "adds-fixture",
      layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.add(McpServers, { name: "bundled", ...local, ...server }))),
    });
  const adds = adding({ exposure: "direct" });

  it("can be turned on, and moved to code mode, when the plugin has it off and direct", async () => {
    await withCore(
      {},
      (core) =>
        core.run(
          Effect.gen(function* () {
            const mcp = yield* Mcp;
            expect(server(yield* until((state) => state.servers.length === 1), "bundled").state).toBe("off");
            yield* mcp.configure("bundled", { enabled: true });
            yield* until(connected("bundled"));
            yield* mcp.configure("bundled", { exposure: "codemode" });
            expect(server(yield* mcp.state, "bundled")).toMatchObject({ enabled: true, exposure: "codemode" });
            expect((yield* listed).find((tool) => tool.spec.name === "mcp__bundled__echo")?.nested).toBe(true);
          }),
        ),
      [adding({ enabled: false, exposure: "direct" })],
    );
  });

  it("keeps the plugin's exposures for its tools when one is changed, and says where each comes from", async () => {
    await withCore(
      {},
      (core) =>
        core.run(
          Effect.gen(function* () {
            const mcp = yield* Mcp;
            yield* until(connected("bundled"));
            yield* mcp.configure("bundled", { tools: { echo: "direct" } });
            const tools = yield* listed;
            expect(tools.find((tool) => tool.spec.name === "mcp__bundled__echo")?.nested).toBeUndefined();
            // Still hidden, as the plugin has it.
            expect(tools.some((tool) => tool.spec.name === "mcp__bundled__add_numbers")).toBe(false);
            const info = server(yield* mcp.state, "bundled").tools;
            expect(info.find((tool) => tool.name === "echo")).toMatchObject({ exposure: "direct", own: "direct", rule: "echo" });
            expect(info.find((tool) => tool.name === "add-numbers")).toMatchObject({ exposure: "hidden", rule: "add-*" });
            expect(info.find((tool) => tool.name === "add-numbers")?.own).toBeUndefined();
            expect(info.find((tool) => tool.name === "fail")?.rule).toBeUndefined();
          }),
        ),
      [adding({ toolExposure: { "add-*": "hidden" } })],
    );
  });

  it("runs beside the file's, and the file can turn it off", async () => {
    await withCore(
      {},
      (core) =>
        core.run(
          Effect.gen(function* () {
            const mcp = yield* Mcp;
            const state = yield* until(connected("bundled"));
            expect(server(state, "bundled")).toMatchObject({ source: "adds-fixture", sourceKind: "plugin", exposure: "direct" });
            expect((yield* listed).find((tool) => tool.spec.name === "mcp__bundled__echo")?.nested).toBeUndefined();
            yield* mcp.configure("bundled", { enabled: false });
            expect(server(yield* mcp.state, "bundled").state).toBe("off");
          }),
        ),
      [adds],
    );
  });
});

describe("what the model is told", () => {
  it("lists the servers code mode reaches, only where code mode is offered", async () => {
    await withCore({ fixture: { ...local, description: "Test tools" }, shown: { ...local, exposure: "direct" } }, (core) =>
      core.run(
        Effect.gen(function* () {
          yield* until(connected("fixture"));
          const registries = yield* Registries;
          const [section] = (yield* registries.items(PromptSections)).filter(({ item }) => item.id === "mcp-servers");
          const request = (tools: readonly string[]) =>
            ({ tools: tools.map((name) => ({ spec: { name }, ...(name === "codemode" ? { nests: true } : {}) })) }) as never;
          const text = (yield* Effect.promise(async () => section!.item.text(request(["codemode"])))) as string;
          expect(text).toContain("- fixture: Test tools");
          expect(text).not.toContain("shown");
          expect(yield* Effect.promise(async () => section!.item.text(request(["read"])))).toBeUndefined();
        }),
      ),
    );
  });

  it("has its tools declared to the model without code mode, as nothing else would call them", async () => {
    await withCore({ fixture: local }, (core) =>
      core.run(
        Effect.gen(function* () {
          yield* until(connected("fixture"));
          const tools = yield* listed;
          expect(tools.some((tool) => tool.nested === true)).toBe(true);
          expect(declaredTools(tools).map((tool) => tool.spec.name)).toContain("mcp__fixture__echo");
        }),
      ),
    );
  });
});
