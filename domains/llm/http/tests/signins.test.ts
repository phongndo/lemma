import { get } from "node:http";
import { describe, expect, it } from "vitest";
import { Effect, Exit, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Llm, LlmRequest } from "@lemma/llm";
import type { NoticePayload } from "@lemma/contracts";
import { copilot, copilotBaseUrl, copilotHeaders } from "../src/copilot.ts";
import { ProviderError } from "../src/http.ts";
import { kimi } from "../src/kimi.ts";
import { meta } from "../src/meta.ts";
import type { Model } from "../src/model.ts";
import { openrouter } from "../src/openrouter.ts";
import type { LoginContext, OAuthCredential, OAuthMethod } from "../src/providers.ts";
import { builtinProviders } from "../src/providers.ts";
import { makeLlmPlugin } from "../src/index.ts";
import { xai } from "../src/xai.ts";
import { completion, fakeCredentials, fakeInteraction, runWith, sseResponse } from "./helpers.ts";

type Notice = Omit<NoticePayload, "level" | "source" | "origin">;

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

/** A provider answering each request from `answer`, and what it was sent. */
function provider(answer: (sent: Sent, count: number) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
    };
    sent.push(request);
    return answer(request, sent.filter((other) => other.url === request.url).length);
  };
  return { fetchImpl, sent, to: (url: string) => sent.filter((request) => request.url === url) };
}

const form = (sent: Sent) => Object.fromEntries(new URLSearchParams(sent.body));

function context(fetchImpl: typeof fetch, answer: () => Promise<string> = () => new Promise<string>(() => {})) {
  const notices: Notice[] = [];
  const login: LoginContext = {
    notify: (notice) => Effect.sync(() => void notices.push(notice)),
    ask: () => Effect.promise(answer),
    deviceId: () => "0b5c3f6e-6a9f-4a51-9a35-2f6f0e3b8a10",
    fetch: fetchImpl,
  };
  return { notices, login };
}

const grant = {
  device_code: "dev-1",
  user_code: "ABCD-1234",
  verification_uri: "https://example.test/device",
  verification_uri_complete: "https://example.test/device?code=ABCD-1234",
  interval: 5,
  expires_in: 900,
};
const pending = () => Response.json({ error: "authorization_pending" }, { status: 400 });

/**
 * Runs a device-code login on a test clock: each step moves the clock on by its seconds, then waits for the provider to
 * have been polled that many times in all, as the login asks it at the interval it was given.
 */
const onClock = <A>(login: Effect.Effect<A, unknown>, polled: () => number, steps: readonly (readonly [seconds: number, polls: number])[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.exit(login));
      for (const [seconds, polls] of steps) {
        yield* TestClock.adjust(`${seconds} seconds`);
        yield* Effect.promise(() => expect.poll(() => polled()).toBe(polls));
      }
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

describe("device-code sign-ins", () => {
  const XAI_DEVICE = "https://auth.x.ai/oauth2/device/code";
  const XAI_TOKEN = "https://auth.x.ai/oauth2/token";

  it("shows the code, asks at the interval given, slows down when told, and signs in", async () => {
    const answers = [
      pending,
      () => Response.json({ error: "slow_down", interval: 7 }, { status: 400 }),
      () => Response.json({ access_token: "acc", refresh_token: "ref", expires_in: 3600 }),
    ];
    const { fetchImpl, to } = provider((sent, count) => (sent.url === XAI_DEVICE ? Response.json(grant) : answers[count - 1]!()));
    const { notices, login } = context(fetchImpl);
    const polls = () => to(XAI_TOKEN).length;
    // Five seconds each, then the seven the provider asked for.
    const exit = await onClock(xai.login(login), polls, [
      [5, 1],
      [5, 2],
      [7, 3],
    ]);
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({ type: "oauth", access: "acc", refresh: "ref" });
    expect(notices[0]).toMatchObject({ kind: "device-code", code: "ABCD-1234", links: [{ url: "https://example.test/device?code=ABCD-1234" }] });
    expect(form(to(XAI_DEVICE)[0]!)).toMatchObject({ client_id: "b1a00492-073a-47ea-816f-4c329264a828", referrer: "lemma" });
    expect(form(to(XAI_TOKEN)[0]!)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      device_code: "dev-1",
    });
  });

  it("keeps asking through the provider failing a while, and ends a denied sign-in or an expired code", async () => {
    const run = (answers: readonly (() => Response)[], steps: readonly (readonly [number, number])[], expiresIn = 900) => {
      const { fetchImpl, to } = provider((sent, count) =>
        sent.url === XAI_DEVICE ? Response.json({ ...grant, expires_in: expiresIn }) : answers[Math.min(count, answers.length) - 1]!(),
      );
      return onClock(xai.login(context(fetchImpl).login), () => to(XAI_TOKEN).length, steps);
    };
    const outage = await run(
      [() => new Response("down", { status: 503 }), () => Response.json({ access_token: "acc", refresh_token: "ref" })],
      [
        [5, 1],
        [5, 2],
      ],
    );
    expect(Exit.isSuccess(outage)).toBe(true);
    const denied = await run([() => Response.json({ error: "access_denied" }, { status: 400 })], [[5, 1]]);
    expect(Exit.isFailure(denied) && String(Exit.isFailure(denied) ? denied.cause : "")).toContain("xAI sign-in was denied");
    // Its code good for twelve seconds: asked twice, then expired.
    const expired = await run(
      [pending],
      [
        [5, 1],
        [5, 2],
        [5, 2],
      ],
      12,
    );
    expect(String(Exit.isFailure(expired) ? expired.cause : "")).toContain("code expired before it was entered");
  });

  it("refreshes an xAI sign-in, keeping a refresh token xAI did not rotate, and fails a refused one with its status", async () => {
    const stored: OAuthCredential = { type: "oauth", access: "old", refresh: "keep", expires: 0 };
    const { fetchImpl, sent } = provider(() => Response.json({ access_token: "new", expires_in: 3600 }));
    expect(await xai.refresh(stored, fetchImpl, new AbortController().signal)).toMatchObject({ access: "new", refresh: "keep" });
    expect(form(sent[0]!)).toMatchObject({ grant_type: "refresh_token", refresh_token: "keep" });
    const refused = await xai
      .refresh(stored, provider(() => Response.json({ error: "invalid_grant" }, { status: 401 })).fetchImpl, new AbortController().signal)
      .catch((error) => error);
    expect(refused).toBeInstanceOf(ProviderError);
    expect(refused).toMatchObject({ status: 401 });
  });

  it("signs in to Kimi Code, and refreshes it", async () => {
    const DEVICE = "https://auth.kimi.com/api/oauth/device_authorization";
    const TOKEN = "https://auth.kimi.com/api/oauth/token";
    const { fetchImpl, to } = provider((sent) =>
      sent.url === DEVICE ? Response.json(grant) : Response.json({ access_token: "acc", refresh_token: "ref", expires_in: 900 }),
    );
    const exit = await onClock(kimi.login(context(fetchImpl).login), () => to(TOKEN).length, [[5, 1]]);
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({ access: "acc", refresh: "ref" });
    expect(form(to(DEVICE)[0]!)).toEqual({ client_id: "17e5f671-d194-4dfb-9706-5516cb48c098" });
    const fresh = await kimi.refresh({ type: "oauth", access: "acc", refresh: "ref", expires: 0 }, fetchImpl, new AbortController().signal);
    expect(fresh).toMatchObject({ access: "acc" });
    expect(form(to(TOKEN).at(-1)!)).toMatchObject({ grant_type: "refresh_token", refresh_token: "ref" });
  });

  it("signs in to Meta by minting a key with the identity the device code gives, and mints again to refresh", async () => {
    const DEVICE = "https://auth.meta.com/oidc/device/authorization/";
    const TOKEN = "https://auth.meta.com/oidc/device/token/";
    const MINT = "https://api.meta.ai/muse-code/key";
    const { fetchImpl, to } = provider((sent) =>
      sent.url === DEVICE ? Response.json(grant) : sent.url === TOKEN ? Response.json({ access_token: "identity" }) : Response.json({ api_key: "minted" }),
    );
    const { notices, login } = context(fetchImpl);
    const exit = await onClock(meta.login(login), () => to(TOKEN).length, [[5, 1]]);
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({ access: "minted", refresh: "identity" });
    expect(to(MINT)[0]!.headers.get("authorization")).toBe("Bearer identity");
    expect(to(MINT)[0]!.headers.get("x-api-version")).toBe("1.0.0");
    expect(notices.map((notice) => notice.kind)).toEqual(["device-code", "progress"]);
    await meta.refresh({ type: "oauth", access: "minted", refresh: "identity", expires: 0 }, fetchImpl, new AbortController().signal);
    expect(to(MINT)).toHaveLength(2);
    const unset = provider(() => Response.json({ action_url: "https://meta.test/setup" })).fetchImpl;
    await expect(meta.refresh({ type: "oauth", access: "x", refresh: "identity", expires: 0 }, unset, new AbortController().signal)).rejects.toThrow(
      "https://meta.test/setup",
    );
    const dead = await meta
      .refresh(
        { type: "oauth", access: "x", refresh: "identity", expires: 0 },
        provider(() => new Response("no", { status: 401 })).fetchImpl,
        new AbortController().signal,
      )
      .catch((error) => error);
    expect(dead).toMatchObject({ status: 401 });
  });
});

/** As a browser would visit a page, on a connection of its own. */
const visit = (url: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const { hostname, port, pathname, search } = new URL(url);
    get({ host: hostname, port, path: `${pathname}${search}`, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    }).on("error", reject);
  });

describe("Sign in with OpenRouter", () => {
  const KEYS = "https://openrouter.ai/api/v1/auth/keys";

  it("takes the browser back on a port and path of its own, and exchanges the code for a key that never expires", async () => {
    const { fetchImpl, to } = provider(() => Response.json({ key: "sk-or-user" }));
    const { notices, login } = context(fetchImpl);
    let page: { status: number; body: string } | undefined;
    const credential = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(openrouter.login(login));
        yield* Effect.promise(() => expect.poll(() => notices.length).toBeGreaterThan(0));
        const link = new URL(notices[0]!.links![0]!.url);
        const callback = link.searchParams.get("callback_url")!;
        expect(callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\/[\w-]+$/);
        // Another path on the port is no callback.
        expect((yield* Effect.promise(() => visit(new URL("/oauth/callback/guess?code=x", callback).toString()))).status).toBe(404);
        page = yield* Effect.promise(() => visit(`${callback}?code=the-code`));
        return yield* Fiber.join(fiber);
      }),
    );
    expect(credential).toMatchObject({ type: "oauth", access: "sk-or-user", expires: Number.MAX_SAFE_INTEGER });
    expect(page).toMatchObject({ status: 200 });
    expect(page!.body).toContain("Signed in to OpenRouter");
    const body = JSON.parse(to(KEYS)[0]!.body) as Record<string, string>;
    expect(body).toMatchObject({ code: "the-code", code_challenge_method: "S256" });
    expect(body.code_verifier).toBeTypeOf("string");
    expect(await openrouter.refresh(credential, fetchImpl, new AbortController().signal)).toBe(credential);
  });

  it("takes the code pasted alone, when the browser cannot reach this machine", async () => {
    const { fetchImpl, to } = provider(() => Response.json({ key: "sk-or-pasted" }));
    const credential = await Effect.runPromise(openrouter.login(context(fetchImpl, async () => "pasted-code").login));
    expect(credential).toMatchObject({ access: "sk-or-pasted" });
    expect(JSON.parse(to(KEYS)[0]!.body)).toMatchObject({ code: "pasted-code" });
  });
});

describe("Sign in with GitHub Copilot", () => {
  const TOKEN = "tid=1;exp=2;proxy-ep=proxy.business.githubcopilot.com;sku=x";

  it("signs in with GitHub's device code, takes Copilot's token, and turns on the models the account has yet to", async () => {
    const { fetchImpl, sent, to } = provider((request) => {
      if (request.url === "https://github.com/login/device/code") return Response.json(grant);
      if (request.url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_github" });
      if (request.url === "https://api.github.com/copilot_internal/v2/token") return Response.json({ token: TOKEN, expires_at: 4_000_000_000 });
      if (request.url === "https://api.business.githubcopilot.com/models") {
        return Response.json({
          data: [
            { id: "gpt-6-luna", model_picker_enabled: true, policy: { state: "enabled" } },
            { id: "claude-sonnet-5.5", model_picker_enabled: true, policy: { state: "unconfigured" } },
            { id: "embedder", model_picker_enabled: true, capabilities: { supports: { tool_calls: false } } },
          ],
        });
      }
      return Response.json({});
    });
    const { login } = context(fetchImpl, async () => "");
    const exit = await onClock(copilot.login(login), () => to("https://github.com/login/oauth/access_token").length, [[5, 1]]);
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      type: "oauth",
      access: TOKEN,
      refresh: "gho_github",
      expires: 4_000_000_000 * 1000 - 5 * 60 * 1000,
    });
    expect(to("https://api.github.com/copilot_internal/v2/token")[0]!.headers.get("authorization")).toBe("Bearer gho_github");
    expect(sent.filter((request) => request.url.endsWith("/policy")).map((request) => request.url)).toEqual([
      "https://api.business.githubcopilot.com/models/claude-sonnet-5.5/policy",
    ]);
    expect(form(to("https://github.com/login/device/code")[0]!)).toEqual({ client_id: "Iv1.b507a08c87ecfe98", scope: "read:user" });
  });

  it("asks an enterprise's own GitHub, and its account's host when its token names none", () => {
    expect(copilotBaseUrl(TOKEN, undefined)).toBe("https://api.business.githubcopilot.com");
    expect(copilotBaseUrl("tid=1", "company.ghe.com")).toBe("https://copilot-api.company.ghe.com");
    expect(copilotBaseUrl("tid=1", undefined)).toBe("https://api.individual.githubcopilot.com");
  });

  it("lists the catalog's models the account does, and says who each request is from", async () => {
    const known = [{ id: "gpt-6-luna" }, { id: "claude-sonnet-5.5" }, { id: "not-for-you" }] as Model[];
    const { fetchImpl } = provider(() =>
      Response.json({
        data: [
          { id: "claude-sonnet-5.5", model_picker_enabled: true, policy: { state: "enabled" } },
          { id: "gpt-6-luna", model_picker_enabled: true },
        ],
      }),
    );
    const listed = await copilot.models!(
      known,
      { key: TOKEN, oauth: true, baseUrl: "https://api.business.githubcopilot.com" },
      fetchImpl,
      new AbortController().signal,
    );
    expect(listed?.map((model) => model.id)).toEqual(["gpt-6-luna", "claude-sonnet-5.5"]);
    const user = { role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 1 };
    const shot = {
      role: "toolResult" as const,
      toolCallId: "c",
      toolName: "screenshot",
      content: [{ type: "image" as const, data: "AA==", mimeType: "image/png" }],
      isError: false,
      timestamp: 2,
    };
    expect(copilotHeaders(new LlmRequest({ model: "github-copilot/m", messages: [user] }))).toMatchObject({
      "X-Initiator": "user",
      "Openai-Intent": "conversation-edits",
    });
    const after = copilotHeaders(new LlmRequest({ model: "github-copilot/m", messages: [user, shot] }));
    expect(after).toMatchObject({ "X-Initiator": "agent", "Copilot-Vision-Request": "true", "User-Agent": "GitHubCopilotChat/0.35.0" });
  });

  it("sends a signed-in account's requests to its host, with its token as a bearer token and as Copilot Chat", async () => {
    const sent: { url: string; headers: Headers }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      sent.push({ url: String(input), headers: new Headers(init?.headers) });
      return sseResponse(completion("ok"));
    };
    const credentials = fakeCredentials({ "github-copilot": { type: "oauth", access: TOKEN, refresh: "gho_github", expires: Date.now() + 3_600_000 } });
    const plugins = [
      credentials.plugin,
      fakeInteraction(() => Effect.succeed("")).plugin,
      makeLlmPlugin({ fetch: fetchImpl, providers: () => builtinProviders().filter((entry) => entry.id === "github-copilot"), env: {} }),
    ];
    const model = builtinProviders()
      .find((entry) => entry.id === "github-copilot")!
      .models.find((entry) => entry.api === "openai-completions")!;
    await runWith(
      plugins,
      Effect.flatMap(Llm, (llm) =>
        Stream.runDrain(
          llm.stream(
            new LlmRequest({ model: `github-copilot/${model.id}`, messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }] }),
          ),
        ),
      ),
      { "llm.http": { liveCatalogs: false } },
    );
    const request = sent.find((entry) => entry.url.endsWith("/chat/completions"))!;
    expect(request.url).toBe("https://api.business.githubcopilot.com/chat/completions");
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request.headers.get("user-agent")).toBe("GitHubCopilotChat/0.35.0");
    expect(request.headers.get("x-initiator")).toBe("user");
  });
});

describe("every sign-in", () => {
  it("is offered by its provider, with an id of its own", () => {
    const methods = new Map<string, OAuthMethod>(builtinProviders().flatMap((entry) => (entry.oauth === undefined ? [] : [[entry.id, entry.oauth] as const])));
    expect([...methods.keys()]).toEqual(["openai", "openrouter", "xai", "github-copilot", "kimi-coding", "meta"]);
    expect(new Set([...methods.values()].map((method) => method.id)).size).toBe(methods.size);
  });
});
