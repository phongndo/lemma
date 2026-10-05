import { describe, expect, it } from "vitest";
import type { ProviderInfo } from "@lemma/contracts";
import { customProviderProblem, customProviderSpec, logoProblem, logoSource, providerGroups } from "../src/model/providers.ts";

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

describe("custom logos", () => {
  it("takes SVG files and refuses anything else", () => {
    expect(logoProblem(`<?xml version="1.0"?>\n<!-- made by hand -->\n<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>\n`)).toBeUndefined();
    expect(logoProblem("<html><body>no</body></html>")).toMatch(/SVG/);
    expect(logoProblem(`<svg>${"x".repeat(40_000)}</svg>`)).toMatch(/KB/);
  });

  it("draws one as an image", () => {
    expect(logoSource(` <svg viewBox="0 0 1 1"/> `)).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg viewBox="0 0 1 1"/>`)}`);
  });
});
