import { Effect } from "effect";
import type { LlmRequest } from "@lemma/llm";
import { refused } from "./http.ts";
import type { Model } from "./model.ts";
import type { LoginContext, OAuthCredential, OAuthMethod } from "./providers.ts";
import { deviceFlow, json } from "./signin.ts";
import type { Auth } from "./wire.ts";

/**
 * Sign in with GitHub Copilot: GitHub's device-code grant for VS Code's Copilot client gives a GitHub token, kept as the
 * refresh token, which Copilot exchanges for a token of its own that lasts about half an hour. That token names the
 * account's API host (`proxy-ep`): an individual's, a business's, or an enterprise's. Copilot asks requests to say who
 * sent them, as its Chat extension does.
 */
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const API_VERSION = "2026-06-01";
/** Copilot Chat's own headers, which Copilot's API asks of a client. */
export const COPILOT_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};
const INDIVIDUAL = "https://api.individual.githubcopilot.com";
/** A token is exchanged again this long before it lapses. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 30_000;

/** A GitHub Enterprise domain, from what the person typed (a URL or a host); undefined for github.com. */
function domainOf(input: string): string | undefined {
  const value = input.trim();
  if (value === "") return undefined;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    throw new Error("That is not a GitHub Enterprise URL or domain");
  }
}

/** Where an account's requests go: the host its token names, else its enterprise's, else an individual's. */
export function copilotBaseUrl(token: string, enterprise: string | undefined): string {
  const proxy = /proxy-ep=([^;]+)/.exec(token)?.[1];
  if (proxy !== undefined) return `https://${proxy.replace(/^proxy\./, "api.")}`;
  return enterprise === undefined ? INDIVIDUAL : `https://copilot-api.${enterprise}`;
}

const enterpriseOf = (credential: OAuthCredential) =>
  typeof credential.enterpriseUrl === "string" && credential.enterpriseUrl !== "" ? credential.enterpriseUrl : undefined;

/** Copilot's token for a GitHub token. */
async function copilotToken(fetchImpl: typeof fetch, github: string, enterprise: string | undefined, signal: AbortSignal): Promise<OAuthCredential> {
  const response = await fetchImpl(`https://api.${enterprise ?? "github.com"}/copilot_internal/v2/token`, {
    headers: { accept: "application/json", authorization: `Bearer ${github}`, ...COPILOT_HEADERS },
    signal,
  });
  if (!response.ok) throw await refused(response, "GitHub's Copilot token request failed");
  const body = await json(response);
  if (typeof body.token !== "string" || typeof body.expires_at !== "number") throw new Error("GitHub's Copilot token answer is not one");
  return {
    type: "oauth",
    access: body.token,
    refresh: github,
    expires: body.expires_at * 1000 - EXPIRY_MARGIN_MS,
    ...(enterprise === undefined ? {} : { enterpriseUrl: enterprise }),
  };
}

interface Listed {
  readonly id: string;
  readonly picker: boolean;
  readonly policy: unknown;
}

/** The models an account lists, with the tools an agent needs: their ids, and which its owner has yet to turn on. */
async function listed(
  fetchImpl: typeof fetch,
  token: string,
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ readonly available: string[]; readonly unconfigured: string[] }> {
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: { accept: "application/json", authorization: `Bearer ${token}`, ...COPILOT_HEADERS, "X-GitHub-Api-Version": API_VERSION },
    signal,
  });
  if (!response.ok) throw await refused(response, "Copilot's model list request failed");
  const data = (await json(response)).data;
  if (!Array.isArray(data)) throw new Error("Copilot's model list is not one");
  const models: Listed[] = data.flatMap((item: unknown) => {
    const entry = item as {
      id?: unknown;
      model_picker_enabled?: unknown;
      policy?: { state?: unknown };
      capabilities?: { supports?: { tool_calls?: unknown } };
    };
    if (typeof entry?.id !== "string" || entry.capabilities?.supports?.tool_calls === false) return [];
    return [{ id: entry.id, picker: entry.model_picker_enabled === true, policy: entry.policy?.state }];
  });
  const picked = models.filter((model) => model.picker && model.policy !== "disabled");
  // Some individual accounts mark no model for the picker though their policies turn models on: those count then.
  const fallback = picked.length === 0 && baseUrl === INDIVIDUAL;
  const available = (fallback ? models.filter((model) => model.policy === "enabled") : picked).map((model) => model.id);
  const unconfigured = models.filter((model) => model.policy === "unconfigured" && (model.picker || fallback)).map((model) => model.id);
  return { available, unconfigured };
}

/** Turns on, for the account, the models its owner has not decided on yet (Claude, Gemini, and others ask it first); best effort. */
async function turnOn(fetchImpl: typeof fetch, token: string, baseUrl: string, ids: readonly string[], signal: AbortSignal): Promise<void> {
  for (const id of ids) {
    const response = await fetchImpl(`${baseUrl}/models/${encodeURIComponent(id)}/policy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...COPILOT_HEADERS,
        "openai-intent": "chat-policy",
        "x-interaction-type": "chat-policy",
      },
      body: JSON.stringify({ state: "enabled" }),
      signal,
    }).catch(() => undefined);
    await response?.body?.cancel();
    // Asked to slow down, the rest wait for another sign-in.
    if (response?.status === 429) return;
  }
}

function login(context: LoginContext) {
  return Effect.gen(function* () {
    // Most accounts are github.com's: only an enterprise's is asked for its domain.
    const where = yield* context.choose("Where is your Copilot subscription?", [
      { value: "github", label: "GitHub.com", description: "A personal, Pro, or Business plan" },
      { value: "enterprise", label: "GitHub Enterprise", description: "Your company's own GitHub, such as company.ghe.com" },
    ]);
    const enterprise =
      where === "enterprise"
        ? yield* context
            .ask("Your GitHub Enterprise URL or domain", { placeholder: "company.ghe.com" })
            .pipe(Effect.flatMap((input) => Effect.try({ try: () => domainOf(input) ?? "github.com", catch: (error) => error })))
        : undefined;
    const domain = enterprise ?? "github.com";
    const github = yield* deviceFlow(context, {
      provider: "GitHub Copilot",
      authorize: `https://${domain}/login/device/code`,
      fields: { client_id: CLIENT_ID, scope: "read:user" },
      token: `https://${domain}/login/oauth/access_token`,
      poll: (deviceCode) => ({ client_id: CLIENT_ID, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      headers: { "User-Agent": COPILOT_HEADERS["User-Agent"]! },
      done: (body) => body.access_token as string,
    });
    yield* context.notify({ kind: "progress", message: "Getting a Copilot token, and turning on the account's models…" });
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
        const credential = await copilotToken(context.fetch, github, enterprise, bounded);
        const baseUrl = copilotBaseUrl(credential.access, enterprise);
        const models = await listed(context.fetch, credential.access, baseUrl, bounded).catch(() => undefined);
        if (models !== undefined) await turnOn(context.fetch, credential.access, baseUrl, models.unconfigured, bounded);
        return credential;
      },
      catch: (error) => error,
    });
  });
}

/**
 * Who a request is from, as Copilot asks: the person (a prompt) or the agent (what follows a tool's result), what it is
 * for, and whether it carries an image.
 */
export function copilotHeaders(request: LlmRequest): Record<string, string> {
  const last = request.messages.at(-1);
  const images = request.messages.some((message) => message.role !== "assistant" && message.content.some((block) => block.type === "image"));
  return {
    ...COPILOT_HEADERS,
    "X-Initiator": last === undefined || last.role === "user" ? "user" : "agent",
    "Openai-Intent": "conversation-edits",
    ...(images ? { "Copilot-Vision-Request": "true" } : {}),
  };
}

/** An account's models: the catalog's that it lists, in the catalog's order. */
const models: NonNullable<OAuthMethod["models"]> = async (known: readonly Model[], auth: Auth, fetchImpl, signal) => {
  const { available } = await listed(fetchImpl, auth.key, auth.baseUrl ?? INDIVIDUAL, signal);
  const allowed = new Set(available);
  return known.filter((model) => allowed.has(model.id));
};

export const copilot: OAuthMethod = {
  id: "copilot",
  name: "Sign in with GitHub Copilot",
  login,
  refresh: (stored, fetchImpl, signal) => copilotToken(fetchImpl, stored.refresh, enterpriseOf(stored), signal),
  baseUrl: (credential) => copilotBaseUrl(credential.access, enterpriseOf(credential)),
  models,
};
