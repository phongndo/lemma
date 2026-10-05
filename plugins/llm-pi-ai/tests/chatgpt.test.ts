import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Effect, Either } from "effect";
import type { LoginUi, OAuthCredential } from "../src/auth.ts";
import { chatgptSignIn } from "../src/chatgpt.ts";
import { deviceId } from "../src/device.ts";

const PLAN = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** An ID token as OpenAI issues one; the sign-in reads its claims, not its signature. */
const idToken = (claims: Record<string, unknown>) => `${b64({ alg: "RS256" })}.${b64(claims)}.signature`;

type Answer = (url: string, form: URLSearchParams, authorize: URL | undefined) => { readonly status?: number; readonly body: unknown };

/** What OpenAI's token endpoint grants: a plan token for the client asked with, naming account `sub`. */
const grant =
  (claims: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Answer =>
  (url, form, authorize) =>
    url.endsWith("/revoke")
      ? { body: {} }
      : {
          body: {
            access_token: "access-1",
            refresh_token: "refresh-1",
            token_type: "Bearer",
            expires_in: 3600,
            scope: PLAN,
            id_token: idToken({
              iss: "https://auth.openai.com",
              aud: form.get("client_id"),
              exp: Math.floor(Date.now() / 1000) + 3600,
              sub: "user-1",
              email: "a@example.com",
              ...(form.get("grant_type") === "authorization_code" ? { nonce: authorize?.searchParams.get("nonce") } : {}),
              ...claims,
            }),
            ...extra,
          },
        };

/**
 * A sign-in against OpenAI's auth server (`answer`) and a browser that, given the link the sign-in shows, comes back
 * to the address it names (`browse`), or whose return the user pastes (`paste`).
 */
function harness(home = mkdtempSync(join(tmpdir(), "lemma-chatgpt-")), answer: Answer = grant()) {
  let authorize: URL | undefined;
  const posts: { readonly url: string; readonly form: Record<string, string> }[] = [];
  const method = chatgptSignIn({
    home,
    fetch: async (input, init) => {
      const form = new URLSearchParams(String(init?.body));
      posts.push({ url: String(input), form: Object.fromEntries(form) });
      const { status = 200, body } = answer(String(input), form, authorize);
      return Response.json(body, { status });
    },
  });
  const back = (to: URL, params: Record<string, string>) => `${to.searchParams.get("redirect_uri")}?${new URLSearchParams(params).toString()}`;
  /** What OpenAI returns the browser with: the code, this sign-in's state, and the client issued. */
  const returned = (to: URL, extra: Record<string, string> = { client_id: "oaiapp_1" }) => ({ code: "code-1", state: to.searchParams.get("state")!, ...extra });
  const login = (
    options: {
      readonly browse?: (to: URL, visit: (params: Record<string, string>) => Promise<number>) => Promise<unknown>;
      /** What the user pastes at each time they are asked. */
      readonly paste?: (to: URL, attempt: number) => string;
    } = {},
  ) => {
    const asked: string[] = [];
    const browse = options.browse ?? ((to, visit) => visit(returned(to)));
    const ui: LoginUi = {
      notify: (notice) =>
        Effect.sync(() => {
          authorize = new URL(notice.links![0]!.url);
          const to = authorize;
          if (options.paste === undefined) setTimeout(() => void browse(to, async (params) => (await fetch(back(to, params))).status));
        }),
      ask: (message) =>
        Effect.suspend(() => {
          asked.push(message);
          return options.paste === undefined ? Effect.never : Effect.succeed(options.paste(authorize!, asked.length - 1));
        }),
    };
    return Effect.runPromise(Effect.either(method.login(ui))).then((result) => ({ result, asked, authorize: authorize! }));
  };
  const registration = () => (existsSync(join(home, "chatgpt.json")) ? JSON.parse(readFileSync(join(home, "chatgpt.json"), "utf8")) : undefined);
  return { home, method, posts, login, back, returned, registration };
}

const signedIn = (result: Either.Either<OAuthCredential, unknown>) => {
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};
/** A raw request to the callback server, as any local process could send it. */
const raw = (to: URL, path: string, host?: string) =>
  new Promise<number>((resolve, reject) => {
    const target = new URL(to.searchParams.get("redirect_uri")!);
    request({ host: "127.0.0.1", port: target.port, path, method: "GET", ...(host === undefined ? {} : { headers: { host } }) }, (response) => {
      response.resume();
      resolve(response.statusCode!);
    })
      .on("error", reject)
      .end();
  });

const failure = (result: Either.Either<OAuthCredential, { readonly message: string }>) => (Either.isLeft(result) ? result.left.message : "signed in");

describe("Sign in with ChatGPT", () => {
  it("registers Lemma at the first sign-in, for the plan's scope, with PKCE", async () => {
    const t = harness();
    const { result, asked, authorize } = await t.login();
    const credential = signedIn(result);

    const params = Object.fromEntries(authorize.searchParams);
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(params).toMatchObject({
      client_id: "dynamic_agent_client",
      agent_name_hint: "Lemma",
      ext_agent_host_id: `urn:uuid:${deviceId(t.home)}`,
      response_type: "code",
      scope: PLAN,
      resource: "https://api.openai.com/v1",
      code_challenge_method: "S256",
    });
    expect(params["redirect_uri"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(params).not.toHaveProperty("login_hint");
    // The code is exchanged by the client issued, with the verifier behind the challenge.
    expect(t.posts).toHaveLength(1);
    const exchange = t.posts[0]!;
    expect(exchange.url).toBe("https://auth.openai.com/api/accounts/oauth/token");
    expect(exchange.form).toMatchObject({
      grant_type: "authorization_code",
      client_id: "oaiapp_1",
      code: "code-1",
      redirect_uri: params["redirect_uri"],
      resource: "https://api.openai.com/v1",
    });
    expect(createHash("sha256").update(exchange.form["code_verifier"]!).digest("base64url")).toBe(params["code_challenge"]);
    expect(credential).toMatchObject({
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      clientId: "oaiapp_1",
      subject: "user-1",
      email: "a@example.com",
      scopes: PLAN.split(" "),
    });
    expect(credential.expires).toBeGreaterThan(Date.now() + 3_500_000);
    expect(t.registration()).toEqual({ clientId: "oaiapp_1", subject: "user-1", email: "a@example.com" });
    // The prompt to paste the address was asked, and withdrawn when the browser came back.
    expect(asked).toHaveLength(1);
  });

  it("signs in again with the client it registered, naming the account, not registering another", async () => {
    const t = harness();
    signedIn((await t.login()).result);
    const { result, authorize } = await t.login({ browse: (to, visit) => visit(t.returned(to, {})) });
    signedIn(result);

    expect(authorize.searchParams.get("client_id")).toBe("oaiapp_1");
    expect(authorize.searchParams.has("agent_name_hint")).toBe(false);
    expect(authorize.searchParams.get("login_hint")).toBe("a@example.com");
    expect(t.posts[1]!.form["client_id"]).toBe("oaiapp_1");
  });

  it("takes the address the browser ended on, pasted, when it cannot reach this computer", async () => {
    const t = harness();
    // A mistyped address asks again rather than ending the sign-in.
    const { result, asked } = await t.login({
      paste: (to, attempt) => (attempt === 0 ? "https://example.com/elsewhere" : `  ${t.back(to, t.returned(to))}\n`),
    });
    expect(signedIn(result).access).toBe("access-1");
    expect(asked).toEqual([
      "Sign in with ChatGPT in your browser, or paste the address it ends on",
      expect.stringMatching(/^That is not the address this sign-in ends on\. Paste the one that starts with http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/),
    ]);
  });

  it("waits past a return from another sign-in, and stops when the user declines", async () => {
    const t = harness();
    const statuses: number[] = [];
    const { result } = await t.login({
      browse: async (to, visit) => {
        statuses.push(await visit({ ...t.returned(to), state: "stale" }));
        statuses.push(await visit(t.returned(to)));
      },
    });
    signedIn(result);
    // The browser gets its page even as the sign-in, finished, closes the server.
    await vi.waitFor(() => expect(statuses).toEqual([400, 200]));

    const declined = await harness().login({ browse: (to, visit) => visit({ state: to.searchParams.get("state")!, error: "access_denied" }) });
    expect(failure(declined.result)).toBe("ChatGPT sign-in failed: access was not allowed");
  });

  it("turns away requests that are not the browser's return, without ending the sign-in or the host", async () => {
    const t = harness();
    const statuses: number[] = [];
    const { result } = await t.login({
      browse: async (to, visit) => {
        const state = `state=${to.searchParams.get("state")}`;
        // A request target that is not an address, another name for the server, another path.
        statuses.push(await raw(to, "//["), await raw(to, `/auth/callback?${state}`, "evil.test"), await raw(to, `/elsewhere?${state}`));
        statuses.push(await visit(t.returned(to)));
      },
    });
    signedIn(result);
    await vi.waitFor(() => expect(statuses).toEqual([404, 404, 404, 200]));
  });

  it("asks for consent again after a sign-in that did not allow plan use", async () => {
    const t = harness(undefined, (url, form, authorize) =>
      form.get("grant_type") === "authorization_code" && authorize?.searchParams.get("prompt") !== "consent"
        ? grant({}, { scope: "openid profile email offline_access" })(url, form, authorize)
        : grant()(url, form, authorize),
    );
    const declined = await t.login();
    expect(failure(declined.result)).toContain("Sign in again to be asked again");
    const again = await t.login({ browse: (to, visit) => visit(t.returned(to, {})) });
    signedIn(again.result);
    // The client it registered, asked to show consent; once allowed, it is not asked again.
    expect(Object.fromEntries(again.authorize.searchParams)).toMatchObject({ client_id: "oaiapp_1", prompt: "consent" });
    expect(t.registration()).toEqual({ clientId: "oaiapp_1", subject: "user-1", email: "a@example.com" });
  });

  it("registers anew once OpenAI no longer knows the client", async () => {
    const home = mkdtempSync(join(tmpdir(), "lemma-chatgpt-"));
    writeFileSync(join(home, "chatgpt.json"), JSON.stringify({ clientId: "oaiapp_gone", subject: "user-1", email: "a@example.com" }));
    const t = harness(home, () => ({ status: 401, body: { error: "invalid_client", error_description: "Unknown client" } }));
    const { result } = await t.login({ browse: (to, visit) => visit(t.returned(to, {})) });
    expect(failure(result)).toBe("ChatGPT sign-in failed: Unknown client (HTTP 401, invalid_client)");
    expect(t.registration()).toBeUndefined();
  });

  it("turns down a grant without plan use, and an ID token not issued for this sign-in", async () => {
    const noPlan = await harness(undefined, grant({}, { scope: "openid profile email offline_access" })).login();
    expect(failure(noPlan.result)).toContain("did not allow Lemma to use your plan");
    const otherClient = await harness(undefined, grant({ aud: "oaiapp_other" })).login();
    expect(failure(otherClient.result)).toContain("the ID token was not issued for this sign-in");
    const replayed = await harness(undefined, grant({ nonce: "another" })).login();
    expect(failure(replayed.result)).toContain("the ID token was not issued for this sign-in");
    const expired = await harness(undefined, grant({ exp: Math.floor(Date.now() / 1000) - 3600 })).login();
    expect(failure(expired.result)).toContain("the ID token was not issued for this sign-in");
  });

  it("keeps a client to its account: another account's tokens are revoked, and the next sign-in registers anew", async () => {
    const home = mkdtempSync(join(tmpdir(), "lemma-chatgpt-"));
    writeFileSync(join(home, "chatgpt.json"), JSON.stringify({ clientId: "oaiapp_1", subject: "user-1", email: "a@example.com" }));
    const t = harness(home, grant({ sub: "user-2", email: "b@example.com" }));
    const { result } = await t.login();

    expect(failure(result)).toContain("you chose b@example.com, but Lemma is registered here for a@example.com");
    expect(t.posts[1]).toEqual({
      url: "https://auth.openai.com/api/accounts/oauth/revoke",
      form: { token: "refresh-1", token_type_hint: "refresh_token", client_id: "oaiapp_1" },
    });
    expect(t.registration()).toBeUndefined();
  });

  const stored: OAuthCredential = {
    type: "oauth",
    access: "access-0",
    refresh: "refresh-0",
    expires: Date.now() + 60_000,
    clientId: "oaiapp_1",
    scopes: PLAN.split(" "),
    subject: "user-1",
    email: "a@example.com",
  };

  it("renews with the client it was issued, keeping the grant's scopes when the answer leaves them out", async () => {
    const t = harness(undefined, () => ({ body: { access_token: "access-2", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 3600 } }));
    const renewed = await Effect.runPromise(t.method.refresh(stored));

    expect(t.posts).toEqual([
      {
        url: "https://auth.openai.com/api/accounts/oauth/token",
        form: { grant_type: "refresh_token", client_id: "oaiapp_1", refresh_token: "refresh-0", resource: "https://api.openai.com/v1" },
      },
    ]);
    expect(renewed).toMatchObject({ access: "access-2", refresh: "refresh-2", clientId: "oaiapp_1", scopes: stored["scopes"], subject: "user-1" });
  });

  it("learns the account of a sign-in made before Lemma had its own, and tells the user to sign in when renewal is refused", async () => {
    const { subject: _subject, email: _email, ...older } = stored;
    const named = await Effect.runPromise(harness().method.refresh(older));
    expect(named).toMatchObject({ subject: "user-1", email: "a@example.com" });

    const refused = harness(undefined, () => ({ status: 400, body: { error: "invalid_grant", error_description: "Refresh token expired" } }));
    const error = await Effect.runPromise(Effect.flip(refused.method.refresh(stored)));
    expect(error.reason).toBe("NotConfigured");
    expect(error.message).toBe("ChatGPT sign-in failed: Refresh token expired (HTTP 400, invalid_grant). Run /login openai to sign in again.");
    // A server that is down for now: the next request tries again, signed in as it was.
    const down = harness(undefined, () => ({ status: 503, body: {} }));
    const transient = await Effect.runPromise(Effect.flip(down.method.refresh(stored)));
    expect(transient.message).toBe("ChatGPT sign-in failed: unexpected response (HTTP 503)");
  });

  it("revokes the refresh token at logout", async () => {
    const t = harness();
    await Effect.runPromise(t.method.revoke!(stored));
    expect(t.posts).toEqual([
      { url: "https://auth.openai.com/api/accounts/oauth/revoke", form: { token: "refresh-0", token_type_hint: "refresh_token", client_id: "oaiapp_1" } },
    ]);
    const failing = harness(undefined, () => ({ status: 503, body: {} }));
    expect(Either.isLeft(await Effect.runPromise(Effect.either(failing.method.revoke!(stored))))).toBe(true);
  });
});
