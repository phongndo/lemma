import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { oauthErrorHtml, oauthSuccessHtml } from "@earendil-works/pi-ai/utils/oauth-page";
import { safeReturn } from "@lemma/credentials";
import { Llm } from "@lemma/llm";
import { accountOf, claimsOf } from "../src/account.ts";
import { chooseWay, tidy } from "../src/auth.ts";
import { keyCheck } from "../src/keycheck.ts";
import { signInPage } from "../src/page.ts";
import { refusedRefresh } from "../src/providers.ts";
import { makeLlmPlugin } from "../src/index.ts";
import { envContext, fakeCredentials, fakeHost, offline, runWith } from "./helpers.ts";

const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

describe("the sign-in page", () => {
  it("says a callback was approved, and that Lemma finishes signing in, with a way back to where the client said", () => {
    const html = signInPage(
      { type: "success", message: "Signed in to OpenAI. You may now close this page." },
      { provider: "OpenAI", returnTo: "lemma://settings/providers" },
    );
    expect(html).toContain("<title>OpenAI approved · Lemma</title>");
    expect(html).toContain("Lemma is finishing signing in to OpenAI. You can close this tab.");
    expect(html).toContain('<a class="back" href="lemma://settings/providers">Return to Lemma</a>');
    // The code leaves the address bar, and no referrer leaves the page.
    expect(html).toContain('history.replaceState(null,"",location.pathname)');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("escapes what a callback's URL can put on it, and offers no way back but to http(s) or Lemma", () => {
    const html = signInPage({ type: "error", message: "<script>alert(1)</script>", details: 'a "quoted" <b>detail</b>' }, { returnTo: "javascript:alert(1)" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("a &quot;quoted&quot; &lt;b&gt;detail&lt;/b&gt;");
    expect(html).not.toContain("Return to Lemma");
    expect(safeReturn("https://lemma.test/settings/providers")).toBe("https://lemma.test/settings/providers");
    // Back to the desktop app the sign-in came from: an installed Lemma's, or a checkout's.
    expect(safeReturn("lemma://settings/providers")).toBe("lemma://settings/providers");
    expect(safeReturn("lemma-dev://settings/providers")).toBe("lemma-dev://settings/providers");
    expect(safeReturn("lemma:/\\evil.com")).toBeUndefined();
    expect(safeReturn("javascript:alert(1)")).toBeUndefined();
    expect(safeReturn("not a url")).toBeUndefined();
  });

  it("is the page pi-ai's callback servers show while the plugin runs, about the sign-in in the browser, and pi's again after", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const browser = createProvider({
      id: "sso",
      name: "SSO",
      auth: {
        oauth: {
          name: "SSO account",
          login: async (flow) => {
            flow.notify({ type: "auth_url", url: "https://sso.test/authorize" });
            await released;
            return { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };
          },
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: [],
      api: openAICompletionsApi(),
    });
    const plugins = [fakeCredentials().plugin, fakeHost().plugin, makeLlmPlugin({ fetch: offline, providers: () => [browser], authContext: envContext() })];
    const pages = await runWith(
      plugins,
      Effect.gen(function* () {
        const llm = yield* Llm;
        const login = yield* Effect.forkChild(llm.login("sso", "oauth", { returnTo: "https://lemma.test/settings/providers" }));
        yield* Stream.runHead(Stream.filter(llm.signIns, (list) => list.some((signIn) => signIn.step.type === "browser")));
        const pages = [oauthSuccessHtml("Signed in."), oauthErrorHtml("State mismatch.", "Use the latest link")];
        release();
        yield* Fiber.join(login);
        return pages;
      }),
    );
    expect(pages[0]).toContain("SSO approved · Lemma");
    expect(pages[0]).toContain('href="https://lemma.test/settings/providers"');
    expect(pages[1]).toContain("<h1>State mismatch</h1>");
    expect(pages[1]).toContain("Use the latest link");
    // Stopped, the plugin puts pi's page back.
    expect(oauthSuccessHtml("Signed in.")).not.toContain("Lemma");
  });
});

describe("who a sign-in is", () => {
  it("reads the account and plan from what the credential holds, or its tokens' claims", () => {
    expect(accountOf({ type: "oauth", access: "a", refresh: "r", expires: 1, email: "you@example.com" })).toEqual({ account: "you@example.com" });
    const access = jwt({ "https://api.openai.com/profile": { email: "plan@example.com" }, "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } });
    expect(accountOf({ type: "oauth", access, refresh: "r", expires: 1 })).toEqual({ account: "plan@example.com", plan: "plus" });
    expect(accountOf({ type: "oauth", access: "opaque", refresh: "r", expires: 1, idToken: jwt({ email: "id@example.com" }) })).toEqual({
      account: "id@example.com",
    });
    expect(accountOf({ type: "oauth", access: "opaque", refresh: "r", expires: 1 })).toEqual({});
    expect(accountOf({ type: "api_key", key: "sk" })).toEqual({});
    expect(claimsOf("not.a-jwt")).toBeUndefined();
  });
});

describe("a sign-in's steps", () => {
  it("takes the code for a browser elsewhere, and leaves the browser here to the person, as a forwarded page looks local", () => {
    const ways = [{ id: "browser" }, { id: "device-code" }];
    expect(chooseWay(ways, "elsewhere")).toBe("device-code");
    expect(chooseWay(ways, "here")).toBeUndefined();
    expect(chooseWay(ways, undefined)).toBeUndefined();
    expect(chooseWay([{ id: "browser" }, { id: "copy_code" }], "elsewhere")).toBe("copy_code");
    expect(chooseWay([{ id: "api-key" }, { id: "adc" }], "elsewhere")).toBeUndefined();
    expect(chooseWay([...ways, { id: "other" }], "elsewhere")).toBeUndefined();
  });

  it("drops what a terminal prompt ends with", () => {
    expect(tidy("Paste the final redirect URL here:")).toBe("Paste the final redirect URL here");
    expect(tidy("Exchanging authorization code for tokens...")).toBe("Exchanging authorization code for tokens");
    expect(tidy("Waiting…")).toBe("Waiting");
  });

  it("counts a refresh against the sign-in only when the provider refused it", () => {
    expect(refusedRefresh('OAuth refresh failed for openai: OpenAI OAuth token request failed (400): {"error":"invalid_grant"}')).toBe(true);
    expect(refusedRefresh("Token refresh failed: 401 Unauthorized")).toBe(true);
    expect(refusedRefresh("OAuth refresh failed for openai: fetch failed (ECONNRESET)")).toBe(false);
    expect(refusedRefresh("OAuth refresh failed: 503 Service Unavailable")).toBe(false);
  });
});

describe("checking a key", () => {
  const provider = (api: string, baseUrl: string) =>
    createProvider({
      id: "p",
      name: "P",
      auth: {},
      models: [
        {
          id: "m",
          name: "M",
          api: api as never,
          provider: "p",
          baseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1,
          maxTokens: 1,
        },
      ],
      api: openAICompletionsApi(),
    });
  const signal = new AbortController().signal;
  const keyed = (init?: RequestInit) => new Headers(init?.headers).has("authorization") || new Headers(init?.headers).has("x-api-key");
  /** A list that refuses a request without a key, answering one with it as `answer` does. */
  const guarded =
    (answer: () => Response): typeof fetch =>
    async (_, init) =>
      keyed(init) ? answer() : Response.json({ error: { message: "No key" } }, { status: 401 });

  it("refuses a key the list refuses, and says nothing of one a public list refuses or takes", async () => {
    const refusing = keyCheck(
      provider("openai-completions", "https://api.test/v1"),
      guarded(() => Response.json({ error: "Invalid credential" }, { status: 401 })),
    );
    expect(await refusing!("sk", signal)).toEqual({ verdict: "refused", problem: "P refused this key (401: Invalid credential)" });
    // Asked without a key, the list answers: it is public, and shows nothing of the key, refused or taken.
    const publicRefusing = keyCheck(provider("openai-completions", "https://open.test/v1"), async (_, init) =>
      keyed(init) ? Response.json({}, { status: 401 }) : Response.json({ data: [] }),
    );
    expect(await publicRefusing!("sk", signal)).toEqual({ verdict: "unknown" });
    const publicTaking = keyCheck(provider("openai-completions", "http://localhost:11434/v1"), async () => Response.json({ data: [{ id: "a" }] }));
    expect(await publicTaking!("sk-mistyped", signal)).toEqual({ verdict: "unknown" });
  });

  it("takes a key the list forbids (a 403) unchecked: it may chat though it may not list models", async () => {
    const restricted = keyCheck(
      provider("openai-completions", "https://api.test/v1"),
      guarded(() => Response.json({ error: { message: "Missing scopes: api.model.read" } }, { status: 403 })),
    );
    expect(await restricted!("sk-restricted", signal)).toEqual({ verdict: "unknown" });
  });

  it("reads Gemini's 400 for a key that is none as a refusal, and no other 400", async () => {
    const gemini = (body: unknown) =>
      keyCheck(provider("google-generative-ai", "https://generativelanguage.googleapis.com/v1beta"), async (_, init) =>
        new Headers(init?.headers).has("x-goog-api-key") ? Response.json(body, { status: 400 }) : Response.json({}, { status: 403 }),
      );
    expect(await gemini({ error: { message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } })!("AIza", signal)).toEqual({
      verdict: "refused",
      problem: "P refused this key (400: API key not valid. Please pass a valid API key.)",
    });
    expect(await gemini({ error: { message: "Bad request" } })!("AIza", signal)).toEqual({ verdict: "unknown" });
  });

  it("asks each wire API's list as it takes a key, and leaves out a provider it cannot ask", async () => {
    const seen: [string, Record<string, string>][] = [];
    const record: typeof fetch = async (url, init) => {
      seen.push([String(url), Object.fromEntries(new Headers(init?.headers))]);
      return keyed(init) ? Response.json({ models: [{}, {}, {}] }) : Response.json({}, { status: 401 });
    };
    expect(await keyCheck(provider("anthropic-messages", "https://api.anthropic.com"), record)!("sk-ant", signal)).toEqual({ verdict: "works", models: 3 });
    expect(seen[0]).toEqual(["https://api.anthropic.com/v1/models", expect.objectContaining({ "x-api-key": "sk-ant", "anthropic-version": "2023-06-01" })]);
    expect(keyCheck(provider("bedrock-converse-stream", "https://bedrock.test"), record)).toBeUndefined();
    expect(keyCheck(provider("openai-completions", "https://{account}.gateway.test/v1"), record)).toBeUndefined();
    // The network failing takes the key unchecked.
    expect(await keyCheck(provider("openai-completions", "https://x.test/v1"), offline)!("sk", signal)).toEqual({ verdict: "unknown" });
  });
});
