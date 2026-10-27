import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer, Stream } from "effect";
import type { Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Events, makeCore } from "@lemma/core";
import { eventFeed, Paths } from "@lemma/contracts";
import { Mcp, McpChanged, summarize } from "@lemma/mcp";
import type { McpServerStatus, McpState } from "@lemma/mcp";
import { ToolInvocation, ToolRunner } from "@lemma/tools";
import { textOf } from "@lemma/tools/testing";
import registry from "@lemma/tools-registry";
import mcpServers from "../src/index.ts";
import { bearer, callbackParams, finishSignIn, needsSignIn, newState, SignInStore, startSignIn } from "../src/auth.ts";
import type { SignInTarget } from "../src/auth.ts";
import { redact, secretsOf } from "../src/config.ts";
import { Servers } from "../src/servers.ts";
import { startOAuthServer } from "./fixtures/oauth.ts";
import type { OAuthFixture, OAuthOptions } from "./fixtures/oauth.ts";

const fixtures: OAuthFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});
const fixture = async (options?: OAuthOptions) => {
  const started = await startOAuthServer(options);
  fixtures.push(started);
  return started;
};

/** A port nothing listens on now. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** Holds `port` (as another program would) until the returned function lets it go. */
const occupy = (port: number) =>
  new Promise<() => Promise<void>>((resolve) => {
    const holder = createServer().listen(port, "127.0.0.1", () => resolve(() => new Promise<void>((done) => holder.close(() => done()))));
  });

const stored = (home: string) =>
  Effect.promise(async () => JSON.parse(await readFile(join(home, "mcp-auth.json"), "utf8")) as { servers: Record<string, any> });

/** A core with the tools registry and the plugin, in a home of its own with `servers` in its `mcp.json`. */
const withCore = <A>(
  servers: Readonly<Record<string, unknown>>,
  body: (
    core: { run: <B, E>(effect: Effect.Effect<B, E, Mcp | ToolRunner | Events>) => Effect.Effect<B, E> },
    home: string,
  ) => Effect.Effect<A, unknown, Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "lemma-mcp-auth-")));
        yield* Effect.promise(() => writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: servers })));
        const paths = { home, root: home, userConfig: join(home, "config.jsonc"), projectConfig: join(home, "project.jsonc"), cwd: home };
        const core = yield* makeCore([registry, mcpServers], { provide: { provides: [Paths], layer: Layer.succeed(Paths, paths) } });
        return yield* body(core as never, home);
      }),
    ),
  );

const until = (check: (state: McpState) => boolean) =>
  Effect.gen(function* () {
    const mcp = yield* Mcp;
    const events = yield* Events;
    const found = yield* eventFeed(mcp.state, [events.stream(McpChanged)]).pipe(Stream.filter(check), Stream.runHead);
    return found._tag === "Some" ? found.value : yield* Effect.die(new Error("the state stream ended"));
  }).pipe(Effect.timeout("30 seconds"));

const remote = (state: McpState): McpServerStatus => state.servers.find((server) => server.name === "remote")!;
const is = (check: (server: McpServerStatus) => boolean) => (state: McpState) => remote(state) !== undefined && check(remote(state));

const call = (name: string, input: unknown) =>
  Effect.flatMap(ToolRunner, (tools) =>
    tools.execute(new ToolInvocation({ sessionId: "s", toolCallId: "c", name, input, cwd: process.cwd() }), new AbortController().signal),
  );

/** What a browser does with the sign-in page: approves (the fixture at once), and follows the redirect back. */
const approve = async (url: string) => {
  const page = await fetch(url, { redirect: "manual" });
  return page.headers.get("location")!;
};

/** Signs in through the browser coming back to Lemma, and waits until the server connects. */
const signIn = Effect.gen(function* () {
  const mcp = yield* Mcp;
  const { url } = yield* mcp.signIn("remote");
  const landed = yield* Effect.promise(() => approve(url));
  const back = yield* Effect.promise(() => fetch(landed));
  expect(back.status).toBe(200);
  expect(yield* Effect.promise(() => back.text())).toContain("Signed in to remote");
  return yield* until(is((server) => server.state === "connected"));
});

describe("a remote server that asks to be signed in to", () => {
  it("needs signing in, and once signed in through the browser connects, its tools working, the sign-in kept privately", async () => {
    const oauth = await fixture();
    await withCore({ remote: { url: oauth.url } }, (core, home) =>
      core.run(
        Effect.gen(function* () {
          const waiting = remote(yield* until(is((server) => server.state === "needs-sign-in")));
          expect(waiting.auth).toEqual({ state: "signed-out" });
          expect(waiting.error).toBeUndefined();

          const mcp = yield* Mcp;
          const { url } = yield* mcp.signIn("remote");
          expect(url.startsWith(`${oauth.base}/authorize?`)).toBe(true);
          const signing = remote(yield* mcp.state);
          expect(signing.auth).toEqual({ state: "signing-in", url });
          expect(new URL(url).searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/callback$/);

          const landed = yield* Effect.promise(() => approve(url));
          const back = yield* Effect.promise(() => fetch(landed));
          expect(yield* Effect.promise(() => back.text())).toContain("Signed in to remote");
          const connected = remote(yield* until(is((server) => server.state === "connected")));
          expect(connected.auth).toEqual({ state: "signed-in" });
          expect(textOf(yield* call("mcp__remote__echo", { text: "hi" }))).toBe("hi");

          const file = join(home, "mcp-auth.json");
          expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o600);
          const stored = JSON.parse(yield* Effect.promise(() => readFile(file, "utf8")));
          expect(stored.servers.remote).toMatchObject({ url: oauth.url, client: { client_id: "client-1" }, tokens: { access_token: "token-1" } });
          expect(oauth.counts.registrations).toBe(1);
        }),
      ),
    );
  });

  it("renews a token the server refuses with its refresh token, and needs signing in again once that is refused too", async () => {
    const oauth = await fixture();
    await withCore({ remote: { url: oauth.url } }, (core) =>
      core.run(
        Effect.gen(function* () {
          yield* until(is((server) => server.state === "needs-sign-in"));
          yield* signIn;

          oauth.expire();
          expect(textOf(yield* call("mcp__remote__echo", { text: "renewed" }))).toBe("renewed");
          expect(oauth.counts.refreshes).toBe(1);

          oauth.revoke();
          const refused = yield* call("mcp__remote__echo", { text: "refused" });
          expect(refused.isError).toBe(true);
          expect(textOf(refused)).toContain('MCP server "remote" needs the person to sign in');
          const state = yield* until(is((server) => server.state === "needs-sign-in"));
          expect(remote(state).auth?.state).toBe("signed-out");
          // An agent reads it without where the server is.
          expect(summarize(state).find((server) => server.name === "remote")).toEqual({
            name: "remote",
            state: "needs-sign-in",
            enabled: true,
            tools: 2,
            auth: "signed-out",
          });
        }),
      ),
    );
  });

  it("finishes with the address a browser elsewhere landed on, refusing one from another sign-in", async () => {
    const oauth = await fixture();
    await withCore({ remote: { url: oauth.url } }, (core) =>
      core.run(
        Effect.gen(function* () {
          yield* until(is((server) => server.state === "needs-sign-in"));
          const mcp = yield* Mcp;
          const { url } = yield* mcp.signIn("remote");
          const landed = yield* Effect.promise(() => approve(url));

          const other = new URL(landed);
          other.searchParams.set("state", "another");
          expect(yield* Effect.flip(mcp.finishSignIn("remote", other.href))).toMatchObject({ reason: "Invalid" });
          expect(remote(yield* mcp.state).auth?.state).toBe("signing-in");

          yield* mcp.finishSignIn("remote", `  ${landed}  `);
          expect(remote(yield* until(is((server) => server.state === "connected"))).auth).toEqual({ state: "signed-in" });
          // Nothing listens for the browser once the sign-in is done.
          expect(
            yield* Effect.promise(() =>
              fetch(landed).then(
                () => "answered",
                () => "refused",
              ),
            ),
          ).toBe("refused");
        }),
      ),
    );
  });

  it("stops a sign-in when cancelled, and forgets the sign-in when signed out", async () => {
    const oauth = await fixture();
    await withCore({ remote: { url: oauth.url } }, (core, home) =>
      core.run(
        Effect.gen(function* () {
          yield* until(is((server) => server.state === "needs-sign-in"));
          const mcp = yield* Mcp;
          const { url } = yield* mcp.signIn("remote");
          const callback = new URL(new URL(url).searchParams.get("redirect_uri")!);
          yield* mcp.cancelSignIn("remote");
          expect(remote(yield* mcp.state).auth).toEqual({ state: "signed-out" });
          const refused = yield* Effect.promise(() =>
            fetch(callback).then(
              () => "answered",
              () => "refused",
            ),
          );
          expect(refused).toBe("refused");

          yield* signIn;
          yield* mcp.signOut("remote");
          yield* until(is((server) => server.state === "needs-sign-in"));
          const stored = JSON.parse(yield* Effect.promise(() => readFile(join(home, "mcp-auth.json"), "utf8")));
          expect(stored.servers.remote).toBeUndefined();
        }),
      ),
    );
  });

  it("is not signed in to when it sends its own Authorization header, which it says it refused", async () => {
    const oauth = await fixture();
    await withCore({ remote: { url: oauth.url, headers: { Authorization: "Bearer wrong" } } }, (core) =>
      core.run(
        Effect.gen(function* () {
          const state = yield* until(is((server) => server.state === "failed"));
          expect(remote(state).error).toContain("refused the token in the Authorization header");
          expect(remote(state).auth).toBeUndefined();
          expect(yield* Effect.flip((yield* Mcp).signIn("remote"))).toMatchObject({ reason: "Invalid" });
        }),
      ),
    );
  });
});

describe("renewing and replacing a sign-in", () => {
  it("renews once for refusals that come together, every call they cut off working", async () => {
    const oauth = await fixture();
    await withCore({ remote: { url: oauth.url } }, (core) =>
      core.run(
        Effect.gen(function* () {
          yield* until(is((server) => server.state === "needs-sign-in"));
          yield* signIn;
          oauth.expire();
          // Both refused before the renewal answers: the second finds it under way.
          const { release } = oauth.holdRefreshes();
          const before = oauth.counts.refusals;
          const calls = yield* Effect.forkChild(
            Effect.all([call("mcp__remote__echo", { text: "a" }), call("mcp__remote__echo", { text: "b" })], { concurrency: "unbounded" }),
          );
          yield* Effect.promise(() => oauth.refusals(before + 2));
          release();
          const results = yield* Fiber.join(calls);
          expect(results.map(textOf)).toEqual(["a", "b"]);
          expect(oauth.counts.refreshes).toBe(1);
          expect(remote(yield* (yield* Mcp).state).auth).toEqual({ state: "signed-in" });
        }),
      ),
    );
  });

  it("keeps its sign-in when renewing it fails for now, and renews it once it can", async () => {
    const oauth = await fixture();
    await withCore({ remote: { url: oauth.url } }, (core, home) =>
      core.run(
        Effect.gen(function* () {
          yield* until(is((server) => server.state === "needs-sign-in"));
          yield* signIn;
          oauth.expire();
          oauth.failRefreshes = true;
          const failed = yield* call("mcp__remote__echo", { text: "later" });
          expect(failed.isError).toBe(true);
          expect(textOf(failed)).toContain("Could not renew the sign-in");
          const status = remote(yield* (yield* Mcp).state);
          expect(status.state).not.toBe("needs-sign-in");
          expect(status.auth).toEqual({ state: "signed-in" });
          expect((yield* stored(home)).servers["remote"].tokens.refresh_token).toBe("refresh-1");

          oauth.failRefreshes = false;
          expect(textOf(yield* call("mcp__remote__echo", { text: "now" }))).toBe("now");
        }),
      ),
    );
  });

  it("needs signing in again when the authorization server no longer knows its client, registering no other on its own", async () => {
    const oauth = await fixture();
    await withCore({ remote: { url: oauth.url } }, (core) =>
      core.run(
        Effect.gen(function* () {
          yield* until(is((server) => server.state === "needs-sign-in"));
          yield* signIn;
          oauth.forgetClients();
          oauth.expire();
          const refused = yield* call("mcp__remote__echo", { text: "x" });
          expect(textOf(refused)).toContain('MCP server "remote" needs the person to sign in');
          expect(oauth.counts.registrations).toBe(1);
          yield* until(is((server) => server.state === "needs-sign-in"));
          // A sign-in in the browser registers the client it needs.
          yield* signIn;
          expect(oauth.counts.registrations).toBe(2);
        }),
      ),
    );
  });

  it("fails a call the server forbids without asking for a scope, rather than asking to sign in again", async () => {
    const oauth = await fixture();
    await withCore({ remote: { url: oauth.url } }, (core) =>
      core.run(
        Effect.gen(function* () {
          yield* until(is((server) => server.state === "needs-sign-in"));
          yield* signIn;
          oauth.forbidden = true;
          const forbidden = yield* call("mcp__remote__echo", { text: "x" });
          expect(forbidden.isError).toBe(true);
          expect(textOf(forbidden)).not.toContain("needs the person to sign in");
          const mcp = yield* Mcp;
          expect(remote(yield* mcp.state)).toMatchObject({ state: "connected", auth: { state: "signed-in" } });
          // Connecting again fails as any client error does: not tried again, and not taken for a refused header.
          yield* mcp.reconnect("remote");
          const failed = remote(yield* until(is((server) => server.state === "failed")));
          expect(failed.retryIn).toBeUndefined();
          expect(failed.error).not.toContain("Authorization header");
        }),
      ),
    );
  });

  it("finds its authorization server where the server's refusal points, not only at the well-known address", async () => {
    const oauth = await fixture({ metadataPath: "/meta/resource" });
    await withCore({ remote: { url: oauth.url } }, (core) =>
      core.run(
        Effect.gen(function* () {
          yield* until(is((server) => server.state === "needs-sign-in"));
          yield* signIn;
          expect(textOf(yield* call("mcp__remote__echo", { text: "found" }))).toBe("found");
        }),
      ),
    );
  });

  it("asks for a scope the server needs besides those granted, without trying again on its own", async () => {
    const oauth = await fixture();
    await withCore({ remote: { url: oauth.url } }, (core) =>
      core.run(
        Effect.gen(function* () {
          yield* until(is((server) => server.state === "needs-sign-in"));
          yield* signIn;
          const refused = yield* call("mcp__remote__admin", {});
          expect(textOf(refused)).toContain('MCP server "remote" needs the person to sign in');
          const state = remote(yield* until(is((server) => server.state === "needs-sign-in")));
          expect(state.retryIn).toBeUndefined();

          yield* signIn;
          expect(oauth.scopes.at(-1)?.split(" ").sort()).toEqual(["admin", "read"]);
          expect(textOf(yield* call("mcp__remote__admin", {}))).toBe("admin");
        }),
      ),
    );
  });

  it("replaces a sign-in waiting on a fixed port with another on the same port", async () => {
    const oauth = await fixture();
    const port = await freePort();
    await withCore({ remote: { url: oauth.url, oauth: { callbackPort: port } } }, (core) =>
      core.run(
        Effect.gen(function* () {
          yield* until(is((server) => server.state === "needs-sign-in"));
          const mcp = yield* Mcp;
          yield* mcp.signIn("remote");
          const { url } = yield* mcp.signIn("remote");
          expect(new URL(url).searchParams.get("redirect_uri")).toBe(`http://localhost:${port}/callback`);
          yield* Effect.promise(async () => fetch(await approve(url)));
          yield* until(is((server) => server.state === "connected"));
        }),
      ),
    );
  });

  it("keeps the client its sign-in was made with when a sign-in that registered another is stopped", async () => {
    const oauth = await fixture();
    await withCore({ remote: { url: oauth.url } }, (core, home) =>
      core.run(
        Effect.gen(function* () {
          yield* until(is((server) => server.state === "needs-sign-in"));
          yield* signIn;
          const before = (yield* stored(home)).servers["remote"];
          // Its port taken, the next sign-in listens on another, and registers a client for it.
          const release = yield* Effect.promise(() => occupy(Number(new URL(before.redirectUrl).port)));
          const mcp = yield* Mcp;
          const { url } = yield* mcp.signIn("remote");
          expect(new URL(url).searchParams.get("client_id")).toBe("client-2");
          yield* mcp.cancelSignIn("remote");
          yield* Effect.promise(release);

          const after = (yield* stored(home)).servers["remote"];
          expect(after.client.client_id).toBe("client-1");
          expect(after.redirectUrl).toBe(before.redirectUrl);
          oauth.expire();
          expect(textOf(yield* call("mcp__remote__echo", { text: "still" }))).toBe("still");
        }),
      ),
    );
  });

  it("turns away a browser that is not this sign-in's, and waits on for the one that is", async () => {
    const oauth = await fixture();
    await withCore({ remote: { url: oauth.url } }, (core) =>
      core.run(
        Effect.gen(function* () {
          yield* until(is((server) => server.state === "needs-sign-in"));
          const mcp = yield* Mcp;
          const { url } = yield* mcp.signIn("remote");
          const callback = new URL(url).searchParams.get("redirect_uri")!;
          for (const stray of [`${callback}?code=stolen&state=another`, `${callback}?code=stolen`, `${callback}?error=access_denied`])
            expect((yield* Effect.promise(() => fetch(stray))).status).toBe(400);
          expect(remote(yield* mcp.state).auth?.state).toBe("signing-in");

          const back = yield* Effect.promise(async () => fetch(await approve(url)));
          expect(back.status).toBe(200);
          yield* until(is((server) => server.state === "connected"));
        }),
      ),
    );
  });

  it("never stores the secret of a client its entry configures", async () => {
    const oauth = await fixture({ client: { id: "pre-1", secret: "configured-secret" } });
    process.env["LEMMA_TEST_MCP_CLIENT_SECRET"] = "configured-secret";
    try {
      await withCore({ remote: { url: oauth.url, oauth: { clientId: "pre-1", clientSecret: "${LEMMA_TEST_MCP_CLIENT_SECRET}" } } }, (core, home) =>
        core.run(
          Effect.gen(function* () {
            yield* until(is((server) => server.state === "needs-sign-in"));
            yield* signIn;
            oauth.expire();
            expect(textOf(yield* call("mcp__remote__echo", { text: "renewed" }))).toBe("renewed");
            const file = yield* Effect.promise(() => readFile(join(home, "mcp-auth.json"), "utf8"));
            expect(file).not.toContain("configured-secret");
            expect(JSON.parse(file).servers.remote.client).toBeUndefined();
          }),
        ),
      );
    } finally {
      delete process.env["LEMMA_TEST_MCP_CLIENT_SECRET"];
    }
  });
});

describe("a renewal and a sign-in at once", () => {
  /** Signs in as the browser would, on a store of its own, asking for `scope` besides those granted. */
  const signInTo = async (store: SignInStore, target: SignInTarget, scope?: string) => {
    const flow = { redirectUrl: "http://localhost:1/callback", state: newState() };
    const landed = new URL(await approve(await startSignIn(store, target, flow, scope === undefined ? undefined : { scope })));
    await finishSignIn(store, target, flow, landed.searchParams.get("code")!, undefined);
  };

  it("needs signing in again when its client is another authorization server's, registering none on its own", async () => {
    const oauth = await fixture();
    const store = new SignInStore(join(await mkdtemp(join(tmpdir(), "lemma-mcp-auth-")), "mcp-auth.json"));
    await store.load();
    const target: SignInTarget = { name: "remote", url: oauth.url, oauth: undefined };
    await signInTo(store, target);
    // Its authorization server's issuer moved since the client was registered.
    const stored = store.get("remote", oauth.url)!;
    await store.set("remote", { ...stored, client: { ...stored.client!, issuer: "https://moved.example/" } });
    oauth.expire();
    const renewal = bearer(store, target, () => {}).onUnauthorized!({
      response: new Response(null, { status: 401 }),
      serverUrl: new URL(oauth.url),
      fetchFn: fetch,
    });
    await expect(renewal).rejects.toSatisfy(needsSignIn);
    expect(oauth.counts.registrations).toBe(1);
  });

  it("keeps the sign-in that finished while a renewal was under way, and the scope it was granted", async () => {
    const oauth = await fixture();
    const store = new SignInStore(join(await mkdtemp(join(tmpdir(), "lemma-mcp-auth-")), "mcp-auth.json"));
    await store.load();
    const target: SignInTarget = { name: "remote", url: oauth.url, oauth: undefined };
    await signInTo(store, target);
    oauth.expire();
    const { release, arrived } = oauth.holdRefreshes();
    const renewal = bearer(store, target, () => {}).onUnauthorized!({
      response: new Response(null, { status: 401 }),
      serverUrl: new URL(oauth.url),
      fetchFn: fetch,
    });
    await arrived;
    // Signed in again, for more, while the renewal waits on the authorization server.
    await signInTo(store, target, "admin");
    const signedIn = store.get("remote", oauth.url)?.tokens;
    release();
    await renewal;
    expect(oauth.counts.refreshes).toBe(1);
    expect(store.get("remote", oauth.url)?.tokens).toEqual(signedIn);
    expect(signedIn?.scope?.split(" ").sort()).toEqual(["admin", "read"]);
  });
});

describe("a remote server that asks no sign-in", () => {
  it("is not said to need one after a sign-in tried on it fails", async () => {
    const open = await fixture({ open: true });
    await withCore({ remote: { url: open.url } }, (core) =>
      core.run(
        Effect.gen(function* () {
          yield* until(is((server) => server.state === "connected"));
          const mcp = yield* Mcp;
          expect(yield* Effect.flip(mcp.signIn("remote"))).toMatchObject({ reason: "Failed" });
          const status = remote(yield* mcp.state);
          expect(status.state).toBe("connected");
          expect(status.auth).toBeUndefined();
        }),
      ),
    );
  });

  it("tells the model of a failed call without what a ${VAR} in its entry holds", async () => {
    const open = await fixture({ open: true });
    process.env["LEMMA_TEST_MCP_KEY"] = "key-in-the-address";
    try {
      await withCore({ remote: { url: `${open.url}?key=\${LEMMA_TEST_MCP_KEY}` } }, (core) =>
        core.run(
          Effect.gen(function* () {
            yield* until(is((server) => server.state === "connected"));
            open.broken = true;
            const failed = yield* call("mcp__remote__echo", { text: "x" });
            expect(failed.isError).toBe(true);
            expect(textOf(failed)).toContain("key=${LEMMA_TEST_MCP_KEY}");
            expect(textOf(failed)).not.toContain("key-in-the-address");
          }),
        ),
      );
    } finally {
      delete process.env["LEMMA_TEST_MCP_KEY"];
    }
  });
});

describe("redact", () => {
  it("replaces a value inside another after the longer one", () => {
    const secrets = secretsOf(
      { command: "x", args: ["${API_HOST}"], env: { API_URL: "${API_URL}" } },
      { API_HOST: "api.example.com", API_URL: "https://api.example.com/mcp?key=SECRET" },
    );
    expect(redact("failed: https://api.example.com/mcp?key=SECRET at api.example.com", secrets)).toBe("failed: ${API_URL} at ${API_HOST}");
  });
});

describe("a remote server that cannot be reached", () => {
  it("is tried again on its own until it connects", async () => {
    const free = await freePort();
    await withCore({ remote: { url: `http://127.0.0.1:${free}/mcp` } }, (core) =>
      core.run(
        Effect.gen(function* () {
          const failed = remote(yield* until(is((server) => server.state === "failed" && server.retryIn !== undefined)));
          expect(failed.retryIn).toBeLessThanOrEqual(2_000);
          yield* Effect.promise(() => fixture({ port: free }));
          // Up now, it asks for a sign-in: what a server Lemma reached says.
          yield* until(is((server) => server.state === "needs-sign-in"));
        }),
      ),
    );
  });

  it("never shows what a ${VAR} in its entry holds", async () => {
    process.env["LEMMA_TEST_MCP_SECRET"] = "very-secret-value";
    try {
      await withCore({ remote: { url: "not a url ${LEMMA_TEST_MCP_SECRET}" } }, (core) =>
        core.run(
          Effect.gen(function* () {
            const state = yield* until(is((server) => server.state === "failed"));
            expect(remote(state).error).toContain("${LEMMA_TEST_MCP_SECRET}");
            expect(JSON.stringify(state)).not.toContain("very-secret-value");
          }),
        ),
      );
    } finally {
      delete process.env["LEMMA_TEST_MCP_SECRET"];
    }
  });
});

describe("a remote server that drops its connection", () => {
  it("is tried again later each time it drops as soon as it connects, not every first delay", async () => {
    const open = await fixture({ open: true });
    const home = await mkdtemp(join(tmpdir(), "lemma-mcp-drop-"));
    await writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: open.url } } }));
    let latest: McpState | undefined;
    const waiting = new Set<() => void>();
    const servers = new Servers(
      {
        addTool: async () => async () => {},
        addNamespace: async () => async () => {},
        changed: (state) => {
          latest = state;
          for (const wake of waiting) wake();
        },
        warn: () => {},
      },
      { file: join(home, "mcp.json"), authFile: join(home, "mcp-auth.json"), version: "0", env: {}, retryDelaysMs: [20, 60_000] },
    );
    const reached = (check: (server: McpServerStatus) => boolean) =>
      new Promise<McpServerStatus>((resolve) => {
        const wake = () => {
          const found = latest === undefined ? undefined : remote(latest);
          if (found === undefined || !check(found)) return;
          waiting.delete(wake);
          resolve(found);
        };
        waiting.add(wake);
        wake();
      });
    /** What the transport does when its connection goes: the client it connected closes under it. */
    const drop = () => servers["entries"].get("remote")!.connection!["client"]!.close();
    try {
      await servers.start([]);
      await reached((server) => server.state === "connected");
      await drop();
      expect((await reached((server) => server.state === "failed")).retryIn).toBeLessThanOrEqual(20);
      await reached((server) => server.state === "connected");
      await drop();
      expect((await reached((server) => server.state === "failed")).retryIn).toBeGreaterThan(20);
    } finally {
      await servers.close();
    }
  });
});

describe("callbackParams", () => {
  it("reads a whole address, a query, or a bare code", () => {
    expect(callbackParams("http://localhost:4000/callback?code=abc&state=s").get("code")).toBe("abc");
    expect(callbackParams("?code=abc&state=s").get("state")).toBe("s");
    expect(callbackParams("code=abc").get("code")).toBe("abc");
    expect(callbackParams(" abc ").get("code")).toBe("abc");
  });
});
