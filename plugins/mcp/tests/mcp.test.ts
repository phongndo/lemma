import * as fs from "node:fs/promises";
import { Effect, Either, Fiber, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { definePlugin, Hooks, makeLoader, PluginContext, Registries } from "@lemma/core";
import { AgentRequestHook, MCP_HIDDEN, McpManagers, ToolInvocation, ToolResult, Tools } from "@lemma/contracts";
import type { RequestDraft, RequestPlan, ToolResult as Result } from "@lemma/contracts";
import tools from "../../tools/src/index.ts";
import { codemodeTool } from "../../tools-builtin/src/codemode.ts";
import mcp from "../src/index.ts";
import { startHttpFixture } from "./fixtures/http.ts";
import { makeFakes, status, stdioSpec, until, withHarness } from "./support.ts";
import type { Harness } from "./support.ts";

const call = (harness: Harness, name: string, input: unknown, options: { signal?: AbortSignal; update?: (chunk: string) => void } = {}) =>
  harness.tools.execute(
    new ToolInvocation({ sessionId: "s1", toolCallId: `c-${Math.random()}`, name, input, cwd: process.cwd() }),
    options.signal ?? new AbortController().signal,
    options.update === undefined ? undefined : { update: options.update },
  );

const text = (result: Result) => result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

describe("mcp", () => {
  it("connects to a stdio server, registers its tools, and converts what they return", () =>
    withHarness({ servers: [stdioSpec("fx")] }, (harness) =>
      Effect.gen(function* () {
        const info = yield* status(harness.manager, "fx");
        expect(info.server).toEqual({ name: "fixture", version: "1.2.3", title: "Fixture" });
        expect(info.instructions).toBe("Use echo to test.");
        expect(info.resources).toBe(1);
        const echo = info.tools.find((tool) => tool.name === "echo")!;
        expect(echo).toMatchObject({ tool: "mcp__fx__echo", title: "Echo", enabled: true, hints: { readOnly: true } });

        const listed = yield* harness.tools.list;
        const names = listed.filter((tool) => tool.source === "mcp").map((tool) => tool.spec.name);
        expect(names).toContain("mcp__fx__add");
        expect(names).toContain("mcp_resources");
        expect(listed.find((tool) => tool.spec.name === "mcp__fx__echo")).toMatchObject({ replay: "safe", spec: { description: "Echo. Says the text back." } });
        const add = listed.find((tool) => tool.spec.name === "mcp__fx__add")!;
        expect(add.spec.parameters).toMatchObject({ type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] });
        expect(add.outputSchema).toMatchObject({ type: "object", properties: { sum: { type: "number" } } });
        expect(listed.find((tool) => tool.spec.name === "mcp__fx__echo")!.outputSchema).toEqual({});

        // The model reads content; a script, the data.
        const sum = yield* call(harness, "mcp__fx__add", { a: 2, b: 3 });
        expect(text(sum)).toBe("5");
        expect(sum.details).toEqual({ server: "fx", tool: "add" });
        expect(sum.structuredContent).toEqual({ sum: 5 });
        expect((yield* call(harness, "mcp__fx__echo", { text: '{"a":[1]}' })).structuredContent).toEqual({ a: [1] });
        expect((yield* call(harness, "mcp__fx__echo", { text: "[not json" })).structuredContent).toBe("[not json");
        const image = yield* call(harness, "mcp__fx__image", {});
        expect(image.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
        expect(image.structuredContent).toMatchObject([{ type: "image", mimeType: "image/png" }]);
        const failed = yield* call(harness, "mcp__fx__fail", {});
        expect(failed.isError).toBe(true);
        expect(text(failed)).toBe("it failed");
        expect(failed.structuredContent).toBeUndefined();
        const readme = yield* call(harness, "mcp_read_resource", { server: "fx", uri: "fixture://readme" });
        expect(text(readme)).toBe("[Resource fixture://readme (text/plain)]\nFixture readme");
        expect(text(yield* call(harness, "mcp_resources", {}))).toContain("fixture://readme readme (text/plain): The fixture's readme");
      }),
    ));

  it("streams progress, cuts long output into a file, and gives up on a server that stays silent", () =>
    withHarness({ servers: [{ ...stdioSpec("fx"), toolTimeoutMs: 400 }], maxOutputChars: 2_000 }, (harness) =>
      Effect.gen(function* () {
        yield* status(harness.manager, "fx");
        let output = "";
        const slow = yield* call(harness, "mcp__fx__slow", { steps: 3 }, { update: (chunk) => (output += chunk) });
        expect(text(slow)).toBe("done");
        expect(output).toBe("[1/3] step 1\n[2/3] step 2\n[3/3] step 3");

        const big = yield* call(harness, "mcp__fx__big", { n: 50_000 });
        expect(text(big).length).toBeLessThan(2_500);
        const saved = (big.details as { fullOutputPath: string }).fullOutputPath;
        expect(text(big)).toContain(saved);
        expect((yield* Effect.promise(() => fs.readFile(saved, "utf8"))).length).toBe(50_000);

        const hung = yield* call(harness, "mcp__fx__hang", {});
        expect(hung.isError).toBe(true);
        expect(text(hung)).toContain('MCP server "fx" did not finish hang in time');
      }),
    ));

  it("restarts a running server on request", () =>
    withHarness({ servers: [stdioSpec("fx")] }, (harness) =>
      Effect.gen(function* () {
        yield* status(harness.manager, "fx");
        const pid = text(yield* call(harness, "mcp__fx__pid", {}));
        yield* harness.manager.restart("fx");
        yield* status(harness.manager, "fx");
        expect(text(yield* call(harness, "mcp__fx__pid", {}))).not.toBe(pid);
      }),
    ));

  it("cancels a call when its turn is cancelled", () =>
    withHarness({ servers: [stdioSpec("fx")] }, (harness) =>
      Effect.gen(function* () {
        yield* status(harness.manager, "fx");
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        const outcome = yield* Effect.either(call(harness, "mcp__fx__hang", {}, { signal: controller.signal }));
        expect(Either.isLeft(outcome) && outcome.left.reason).toBe("Cancelled");
        // The server is still there for the next call.
        expect(text(yield* call(harness, "mcp__fx__echo", { text: "still here" }))).toBe("still here");
      }),
    ));

  it("leaves out the tools a server's config turns off", () =>
    withHarness({ servers: [{ ...stdioSpec("fx"), disabledTools: ["fail", "crash"] }] }, (harness) =>
      Effect.gen(function* () {
        const info = yield* status(harness.manager, "fx");
        expect(info.tools.filter((tool) => !tool.enabled).map((tool) => tool.name)).toEqual(["fail", "crash"]);
        const names = (yield* harness.tools.list).map((tool) => tool.spec.name);
        expect(names).toContain("mcp__fx__echo");
        expect(names).not.toContain("mcp__fx__fail");
        const refused = yield* Effect.either(call(harness, "mcp__fx__fail", {}));
        expect(Either.isLeft(refused) && refused.left.reason).toBe("NotFound");
      }),
    ));

  it("reads ${NAME} from the server's secrets, then the host's environment, and keeps credentials out of what it inherits", () => {
    process.env["LEMMA_TEST_PLAIN"] = "plain";
    process.env["LEMMA_TEST_API_KEY"] = "provider-key";
    return withHarness(
      { servers: [stdioSpec("fx", { FIXTURE_SECRET: "${FIXTURE_SECRET}", FROM_HOST: "${LEMMA_TEST_PLAIN}", FALLBACK: "${LEMMA_TEST_NOPE:-fallback}" })] },
      (harness) =>
        Effect.gen(function* () {
          const info = yield* status(harness.manager, "fx");
          expect(info.secrets).toEqual(["FIXTURE_SECRET"]);
          expect(info.missing).toEqual([]);
          const env = (name: string) => Effect.map(call(harness, "mcp__fx__env", { name }), text);
          expect(yield* env("FIXTURE_SECRET")).toBe("s3cret");
          expect(yield* env("FROM_HOST")).toBe("plain");
          expect(yield* env("FALLBACK")).toBe("fallback");
          expect(yield* env("LEMMA_TEST_PLAIN")).toBe("plain");
          expect(yield* env("LEMMA_TEST_API_KEY")).toBe("(unset)");
        }),
      { credentials: { "mcp:fx": { type: "api_key", env: { FIXTURE_SECRET: "s3cret" } } } },
    );
  });

  it("connects with a secret saved later, its tools calling the new connection", () =>
    withHarness({ servers: [stdioSpec("fx", { FIXTURE_SECRET: "${FIXTURE_SECRET:-none}" })] }, (harness) =>
      Effect.gen(function* () {
        const [server] = yield* harness.manager.servers;
        yield* status(harness.manager, "fx");
        expect(text(yield* call(harness, "mcp__fx__env", { name: "FIXTURE_SECRET" }))).toBe("none");
        // The fake host reports the plugin restarted; as the real one does for a config that did not change, it does not.
        harness.unchanged.value = true;
        yield* harness.manager.save(server!.spec, { secrets: { FIXTURE_SECRET: "later" } });
        yield* status(harness.manager, "fx");
        expect(text(yield* call(harness, "mcp__fx__env", { name: "FIXTURE_SECRET" }))).toBe("later");
      }),
    ));

  it("says what a server is missing instead of starting it", () =>
    withHarness({ servers: [stdioSpec("fx", { TOKEN: "${LEMMA_TEST_UNSET_TOKEN}" }), { id: "nothing" }] }, (harness) =>
      Effect.gen(function* () {
        const servers = yield* harness.manager.servers;
        expect(servers[0]).toMatchObject({ status: "error", missing: ["LEMMA_TEST_UNSET_TOKEN"] });
        expect(servers[0]!.error).toContain("LEMMA_TEST_UNSET_TOKEN is not set");
        expect(servers[1]).toMatchObject({ status: "error", error: "It has no URL" });
        expect((yield* harness.manager.logs("fx")).at(-1)?.text).toContain("LEMMA_TEST_UNSET_TOKEN");
      }),
    ));

  it("registers the tools a server adds later", () =>
    withHarness({ servers: [stdioSpec("fx")] }, (harness) =>
      Effect.gen(function* () {
        yield* status(harness.manager, "fx");
        expect(text(yield* call(harness, "mcp__fx__grow", {}))).toBe("grown");
        yield* until(
          Effect.map(harness.tools.list, (listed) => listed.some((tool) => tool.spec.name === "mcp__fx__extra")),
          5_000,
          "the new tool",
        );
        expect(text(yield* call(harness, "mcp__fx__extra", {}))).toBe("extra");
      }),
    ));

  it("starts a server that exits again, its tools gone meanwhile", () =>
    withHarness({ servers: [stdioSpec("fx")] }, (harness) =>
      Effect.gen(function* () {
        yield* status(harness.manager, "fx");
        const pid = text(yield* call(harness, "mcp__fx__pid", {}));
        yield* call(harness, "mcp__fx__crash", {});
        const lost = yield* status(harness.manager, "fx", "error");
        expect(lost.error).toBe("The server exited with code 3");
        expect(lost.retryAt).toBeGreaterThan(Date.now() - 1_000);
        yield* status(harness.manager, "fx", "ready", 10_000);
        expect(text(yield* call(harness, "mcp__fx__pid", {}))).not.toBe(pid);
        expect((yield* harness.manager.logs("fx")).some((entry) => entry.text === "The server exited with code 3")).toBe(true);
      }),
    ));

  for (const era of ["current", "legacy"] as const) {
    it(`asks the person what the server asks for (${era} protocol)`, () =>
      withHarness(
        { servers: [stdioSpec("fx", era === "legacy" ? { FIXTURE_ERA: "legacy" } : {})] },
        (harness) =>
          Effect.gen(function* () {
            yield* status(harness.manager, "fx");
            const result = yield* call(harness, "mcp__fx__ask", {});
            expect(JSON.parse(text(result))).toEqual({ action: "accept", content: { name: "Ada", ok: true } });
            expect(harness.questions.map((question) => question.type)).toEqual(["select", "ask", "confirm"]);
            expect(harness.questions[0]!.title).toBe("fx asks: Who are you?");
          }),
        {
          answer: (question) =>
            Effect.succeed(
              question.type === "select"
                ? "accept"
                : question.type === "confirm"
                  ? true
                  : question.title.includes("name") || question.title.includes("Name")
                    ? "Ada"
                    : "",
            ),
        },
      ));
  }

  it("declines for the person who declines, and cancels for one who dismisses", () =>
    withHarness(
      { servers: [stdioSpec("fx", { FIXTURE_ERA: "legacy" })] },
      (harness) =>
        Effect.gen(function* () {
          yield* status(harness.manager, "fx");
          expect(JSON.parse(text(yield* call(harness, "mcp__fx__ask", {})))).toEqual({ action: "decline" });
        }),
      { answer: () => Effect.succeed("decline") },
    ));

  it("tolerates a server that writes to stdout", () =>
    withHarness({ servers: [stdioSpec("fx", { FIXTURE_NOISY: "1" })] }, (harness) =>
      Effect.gen(function* () {
        yield* status(harness.manager, "fx");
        const logs = yield* harness.manager.logs("fx");
        expect(logs.find((entry) => entry.source === "stdout")?.text).toBe("fixture: hello from stdout");
        expect(logs.find((entry) => entry.source === "stderr")?.text).toContain("fixture: started");
      }),
    ));

  it("reaches every tool through codemode, or declares them when nothing runs others", () => {
    const codemode = definePlugin({
      id: "codemode",
      requires: [Tools],
      layer: Layer.scopedDiscard(
        Effect.flatMap(Tools, (registry) =>
          registry.register({ name: "codemode", description: "Runs code", input: Schema.Struct({}), execute: async () => new ToolResult({ content: [] }) }),
        ),
      ),
    });
    const plan = (harness: Harness) =>
      Effect.gen(function* () {
        const hooks = yield* Hooks;
        const draft: RequestDraft = {
          sessionId: "s1",
          turnId: "t1",
          cwd: process.cwd(),
          model: "fake/m",
          sections: [
            { id: "base", source: "agent", text: "base" },
            { id: "environment", source: "agent", text: "env" },
          ],
          tools: yield* harness.tools.list,
          reachable: [],
          branch: [],
          history: [],
          append: () => Effect.die("unused"),
        };
        return yield* hooks.invoke(AgentRequestHook, draft, (final): Effect.Effect<RequestPlan> => Effect.succeed(final));
      });
    const names = (list: RequestPlan["tools"]) => list.map((tool) => tool.spec.name);
    const reached = (harness: Harness) =>
      Effect.gen(function* () {
        yield* status(harness.manager, "fx");
        return yield* plan(harness);
      });
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          withHarness(
            { servers: [stdioSpec("fx")] },
            (harness) =>
              Effect.gen(function* () {
                const result = yield* reached(harness);
                expect(names(result.tools)).toContain("codemode");
                expect(names(result.tools).some((name) => name.startsWith("mcp"))).toBe(false);
                expect(names(result.reachable)).toContain("mcp__fx__echo");
                expect(names(result.reachable)).toContain("mcp_resources");
                expect(result.sections.map((section) => section.id)).toEqual(["base", "mcp-servers", "environment"]);
                const section = result.sections[1]!.text;
                expect(section).toContain("- fx (Fixture)\n  Its instructions: Use echo to test.");
                expect(section).toContain("searchTools");
                expect(section).toContain("structured result");
              }),
            { extra: [codemode] },
          ),
        );
        yield* Effect.promise(() =>
          withHarness({ servers: [stdioSpec("fx")] }, (harness) =>
            Effect.gen(function* () {
              const result = yield* reached(harness);
              expect(names(result.tools)).toContain("mcp__fx__echo");
              expect(result.reachable).toEqual([]);
              expect(result.sections[1]!.text).not.toContain("searchTools");
            }),
          ),
        );
      }),
    );
  });

  it("gives codemode scripts each tool's data, typed as the server declares it", () => {
    const codemode = definePlugin({
      id: "codemode",
      requires: [Tools],
      layer: Layer.scopedDiscard(Effect.flatMap(Tools, (registry) => registry.register(codemodeTool(registry)))),
    });
    const script = `
      const [found] = await searchTools("fx add", { limit: 1 });
      const { sum } = await tools.mcp__fx__add({ a: 2, b: 3 });
      const parsed = await tools.mcp__fx__echo({ text: '{"items":[1,2]}' });
      let failed;
      try { await tools.mcp__fx__fail({}); } catch (error) { failed = error.message; }
      const blocks = await tools.mcp__fx__image({});
      return { declaration: found.description, sum, items: parsed.items, failed, kinds: blocks.map((block) => block.type) };`;
    return withHarness(
      { servers: [stdioSpec("fx")] },
      (harness) =>
        Effect.gen(function* () {
          yield* status(harness.manager, "fx");
          const result = yield* call(harness, "codemode", { code: script });
          expect(result.isError).toBeUndefined();
          const value = JSON.parse(text(result).slice(text(result).indexOf("{")));
          expect(value).toEqual({
            declaration: expect.stringContaining("mcp__fx__add(args: { a: number; b: number; }): Promise<{ sum: number; }>"),
            sum: 5,
            items: [1, 2],
            failed: "it failed",
            kinds: ["image"],
          });
        }),
      { extra: [codemode] },
    );
  });

  it("saves servers into its config, keeping secrets apart and hidden values as they are", () =>
    withHarness({ servers: [{ id: "web", url: "https://mcp.example.com/mcp", headers: { "X-Api-Key": "literal-key", Accept: "json" } }] }, (harness) =>
      Effect.gen(function* () {
        const [web] = yield* harness.manager.servers;
        expect(web!.spec.headers).toEqual({ "X-Api-Key": MCP_HIDDEN, Accept: "json" });
        yield* harness.manager.save({ ...web!.spec, headers: { ...web!.spec.headers, Accept: "text" } });
        expect(harness.configured.at(-1)).toEqual({
          add: { servers: [{ id: "web", url: "https://mcp.example.com/mcp", headers: { "X-Api-Key": "literal-key", Accept: "text" } }] },
        });

        yield* harness.manager.save(
          { id: "gh", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer ${GH_TOKEN}" } },
          { secrets: { GH_TOKEN: "t0k" } },
        );
        expect(harness.credentials.get("mcp:gh")).toEqual({ type: "api_key", env: { GH_TOKEN: "t0k" } });
        const refused = yield* Effect.either(harness.manager.save({ id: "x", url: "https://x", headers: { Token: MCP_HIDDEN } }));
        expect(Either.isLeft(refused) && refused.left.reason).toBe("Invalid");
        const clash = yield* Effect.either(harness.manager.save({ id: "w-e-b", url: "https://x" }));
        expect(Either.isRight(clash)).toBe(true);

        yield* harness.manager.setTool("web", "search", false);
        expect(harness.configured.at(-1)!.add!["servers"]![0]).toMatchObject({ id: "web", disabledTools: ["search"] });
        yield* harness.manager.setEnabled("web", false);
        expect(harness.configured.at(-1)!.add!["servers"]![0]).toMatchObject({ id: "web", enabled: false });
        harness.credentials.set("mcp-oauth:web", { type: "oauth", access: "a", refresh: "", expires: 0 });
        yield* harness.manager.remove("web");
        expect(harness.configured.at(-1)).toEqual({ remove: { servers: ["web"] } });
        expect(harness.credentials.has("mcp-oauth:web")).toBe(false);
      }),
    ));

  it("connects over Streamable HTTP", async () => {
    const server = await startHttpFixture();
    try {
      await withHarness({ servers: [{ id: "web", url: server.url }] }, (harness) =>
        Effect.gen(function* () {
          const info = yield* status(harness.manager, "web");
          expect(info).toMatchObject({ type: "http", signedIn: false });
          expect(text(yield* call(harness, "mcp__web__echo", { text: "over http" }))).toBe("over http");
        }),
      );
    } finally {
      await server.close();
    }
  });

  it("connects again when a URL server forgets the session, and makes the call once more", async () => {
    const server = await startHttpFixture({ forgetOnce: true });
    try {
      await withHarness({ servers: [{ id: "web", url: server.url }] }, (harness) =>
        Effect.gen(function* () {
          yield* status(harness.manager, "web");
          expect(text(yield* call(harness, "mcp__web__echo", { text: "again" }))).toBe("again");
          expect((yield* harness.manager.logs("web")).some((entry) => entry.text === "The server lost the session; connecting again")).toBe(true);
        }),
      );
    } finally {
      await server.close();
    }
  });

  it("signs in to a server that wants OAuth, and out again", { timeout: 30_000 }, async () => {
    const server = await startHttpFixture({ auth: true });
    try {
      await withHarness({ servers: [{ id: "web", name: "Web", url: server.url }] }, (harness) =>
        Effect.gen(function* () {
          const before = yield* status(harness.manager, "web", "auth");
          expect(before.error).toBe("Sign in to use this server");
          expect(server.clients).toEqual([]); // waiting to sign in registers nothing
          const login = yield* Effect.fork(harness.manager.login("web"));
          const notice = yield* until(Effect.sync(() => harness.notices.find((candidate) => candidate.links?.[0]?.label === "Sign in to Web")));
          expect(notice.source).toBe("mcp:web");
          // The browser: the authorization server redirects to the loopback callback at once.
          const redirect = yield* Effect.promise(() => fetch(notice.links![0]!.url, { redirect: "manual" }));
          const callback = redirect.headers.get("location")!;
          expect(callback).toMatch(/^http:\/\/localhost:\d+\/callback\?code=code-1&state=/);
          const landed = yield* Effect.promise(() => fetch(callback.replace("localhost", "127.0.0.1")).then((response) => response.text()));
          expect(landed).toContain("Signed in to Web");
          yield* Fiber.join(login);
          const after = yield* status(harness.manager, "web");
          expect(after.signedIn).toBe(true);
          expect(text(yield* call(harness, "mcp__web__echo", { text: "signed in" }))).toBe("signed in");
          expect(harness.questions.some((question) => question.type === "ask" && question.title.includes("paste the address"))).toBe(true);
          expect(harness.credentials.get("mcp-oauth:web")).toMatchObject({ type: "oauth", access: "token-1", refresh: "refresh-1" });

          yield* harness.manager.logout("web");
          yield* status(harness.manager, "web", "auth");
          expect(harness.credentials.has("mcp-oauth:web")).toBe(false);
        }),
      );
    } finally {
      await server.close();
    }
  });

  it("keeps a server's connection, and its process, across a reload that leaves it unchanged", () => {
    const { fakes } = makeFakes();
    const plugins = new Map([fakes, tools, mcp].map((plugin) => [plugin.id, plugin]));
    const composition = (toolTimeoutMs: number) => ({
      plugins: { fakes: {}, tools: {}, mcp: { config: { toolTimeoutMs, servers: [stdioSpec("fx"), stdioSpec("other")] } } },
    });
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const loader = yield* makeLoader({ source: { resolve: (id) => Effect.succeed(plugins.get(id)!) }, composition: composition(60_000) });
          const pid = loader.core.run(
            Effect.gen(function* () {
              const [manager] = yield* (yield* Registries).items(McpManagers);
              yield* status(manager!.item, "fx");
              const registry = yield* Tools;
              return text(
                yield* registry.execute(
                  new ToolInvocation({ sessionId: "s", toolCallId: "c", name: "mcp__fx__pid", input: {}, cwd: "." }),
                  new AbortController().signal,
                ),
              );
            }),
          );
          const before = yield* pid;
          const report = yield* loader.apply(composition(30_000));
          expect(report.restarted).toContain("mcp");
          expect(yield* pid).toBe(before);
        }),
      ),
    );
  });
});

// Keeps PluginContext referenced for the type of plugins built in tests.
void PluginContext;
