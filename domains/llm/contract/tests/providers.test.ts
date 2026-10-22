import { describe, expect, it } from "vitest";
import type { ProviderInfo } from "@lemma/llm";
import { usesPlan } from "../src/llm.ts";
import { customProviderProblem, customProviderSpec, describeProvider, providerGroups, signInReturn, timeLeft } from "../src/web/providers.ts";

const key = { type: "api_key", name: "API key", interactive: true } as const;
const oauth = { type: "oauth", name: "Sign in", interactive: true } as const;
const provider = (id: string, name: string, configured = false, auth: ProviderInfo["auth"] = [key]): ProviderInfo => ({ id, name, auth, configured });
const ids = (groups: ReturnType<typeof providerGroups>) => groups.map((group) => [group.title, group.providers.map((p) => p.id)]);

const all = [
  provider("groq", "Groq"),
  provider("opencode-go", "OpenCode Go"),
  provider("anthropic", "Anthropic", true),
  provider("opencode", "OpenCode Zen"),
  provider("baseten", "Baseten"),
  provider("github-copilot", "GitHub Copilot", false, [oauth, key]),
  provider("openai", "OpenAI", false, [key, oauth]),
];

describe("providerGroups", () => {
  it("lists connected, then the popular ways to start in their order, then the rest by name", () => {
    expect(ids(providerGroups(all))).toEqual([
      ["Connected", ["anthropic"]],
      ["Popular", ["openai", "github-copilot", "opencode", "opencode-go"]],
      ["All providers", ["baseten", "groq"]],
    ]);
  });

  it("keeps the providers that offer the chosen way in", () => {
    expect(ids(providerGroups(all, "", "oauth"))).toEqual([["Popular", ["openai", "github-copilot"]]]);
    expect(ids(providerGroups(all, "open", "api_key"))).toEqual([["Results", ["openai", "opencode-go", "opencode"]]]);
  });

  it("searches every word, connected first, in one list", () => {
    expect(ids(providerGroups(all, "open"))).toEqual([["Results", ["openai", "opencode-go", "opencode"]]]);
    expect(ids(providerGroups(all, "chatgpt"))).toEqual([["Results", ["openai"]]]);
    expect(ids(providerGroups(all, "opencode zen"))).toEqual([["Results", ["opencode"]]]);
    expect(ids(providerGroups(all, "claude"))).toEqual([["Results", ["anthropic"]]]);
    expect(providerGroups(all, "nothing like it")).toEqual([]);
  });
});

describe("customProviderSpec", () => {
  const draft = {
    name: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1/",
    api: "openai-completions",
    models: "qwen3:8b, llama3.2\nqwen3:8b",
    hasKey: false,
  } as const;

  it("asks the host for the draft's provider, with each model once; the host picks its id and key variable", () => {
    expect(customProviderSpec(draft)).toEqual({
      name: "Ollama (local)",
      api: "openai-completions",
      baseUrl: "http://localhost:11434/v1/",
      models: ["qwen3:8b", "llama3.2"],
      key: false,
    });
  });

  it("says what a draft is missing", () => {
    expect(customProviderProblem(draft)).toBeUndefined();
    expect(customProviderProblem({ ...draft, baseUrl: "localhost:11434" })).toMatch(/http/);
    expect(customProviderProblem({ ...draft, models: " " })).toMatch(/model/);
  });
});

describe("a provider's connection, as the page says it", () => {
  const signedIn = (fields: Partial<ProviderInfo>): ProviderInfo => ({
    ...provider("openai", "OpenAI", true, [key, { ...oauth, subscription: true }]),
    source: "OAuth",
    ...fields,
  });

  it("says who it is signed in as and on what plan, or that its sign-in expired", () => {
    expect(describeProvider(signedIn({ account: "you@example.com", plan: "plus" }))).toBe("Signed in as you@example.com · Plus plan");
    expect(describeProvider(signedIn({}))).toBe("Signed in · uses your plan");
    expect(describeProvider(signedIn({ account: "you@example.com", expired: "invalid_grant" }))).toBe("Sign-in expired: sign in again");
    expect(describeProvider({ ...provider("anthropic", "Anthropic", true), source: "ANTHROPIC_API_KEY" })).toBe("From $ANTHROPIC_API_KEY");
    expect(usesPlan(signedIn({}))).toBe(true);
    expect(usesPlan({ ...signedIn({}), source: "stored credential" })).toBe(false);
  });
});

describe("a sign-in from this page", () => {
  it("says where to come back to", () => {
    // A web tab opened from the page has no host token: only the desktop app is offered, the one the person came from.
    expect(signInReturn(undefined)).toBeUndefined();
    expect(signInReturn({ deepLinkScheme: "lemma" })).toBe("lemma://settings/providers");
    expect(signInReturn({ deepLinkScheme: "lemma-dev" })).toBe("lemma-dev://settings/providers");
    // An app from before it said its scheme is an installed Lemma's.
    expect(signInReturn({})).toBe("lemma://settings/providers");
  });

  it("counts a device code down, and says nothing once it has expired", () => {
    expect(timeLeft(1_000 + 845_000, 1_000)).toBe("14:05");
    expect(timeLeft(1_000 + 400, 1_000)).toBe("0:01");
    expect(timeLeft(1_000, 1_000)).toBeUndefined();
  });
});
