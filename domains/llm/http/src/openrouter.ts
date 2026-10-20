import { Effect } from "effect";
import { refused } from "./http.ts";
import type { LoginContext, OAuthCredential, OAuthMethod } from "./providers.ts";
import { callbackOrPaste, json, loopback, pkce, random } from "./signin.ts";

/**
 * Sign in with OpenRouter: its PKCE flow gives a key of the account's own, good until revoked, so the sign-in never
 * expires and has nothing to refresh. OpenRouter sends no state back: the callback's path, random for each login on a
 * port of its own, is what keeps another page from completing it.
 */
const AUTHORIZE_URL = "https://openrouter.ai/auth";
const KEYS_URL = "https://openrouter.ai/api/v1/auth/keys";
const TIMEOUT_MS = 30_000;

/** The code a callback brings, or why there is none. */
function codeOf(url: URL): string {
  const error = url.searchParams.get("error");
  if (error) throw new Error(`OpenRouter sign-in failed: ${url.searchParams.get("error_description") ?? error}`);
  const code = url.searchParams.get("code");
  if (!code) throw new Error("The callback has no authorization code");
  return code;
}

function login(context: LoginContext) {
  return Effect.scoped(
    Effect.gen(function* () {
      const { verifier, challenge } = pkce();
      const exchange = async (code: string): Promise<OAuthCredential> => {
        const response = await context.fetch(KEYS_URL, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) throw await refused(response, "OpenRouter's key request failed");
        const body = await json(response);
        if (typeof body.key !== "string" || body.key === "") throw new Error("OpenRouter's answer carries no key");
        return { type: "oauth", access: body.key, refresh: "", expires: Number.MAX_SAFE_INTEGER };
      };
      const server = yield* loopback({
        provider: "OpenRouter",
        port: 0,
        path: `/oauth/callback/${random(16)}`,
        ours: () => true,
        accept: (url) => exchange(codeOf(url)),
        exchanging: () => Effect.runFork(context.notify({ kind: "progress", message: "Exchanging the authorization code for a key…" })),
      });
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({ callback_url: server.redirectUri, code_challenge: challenge, code_challenge_method: "S256" }).toString();
      yield* context.notify({
        kind: "sign-in",
        message: "Complete sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.",
        links: [{ url: url.toString(), label: "Sign in to OpenRouter" }],
      });
      // A redirect URL, or the code alone.
      const pasted = (input: string): URL => {
        const value = input.trim();
        if (value === "") throw new Error("Paste the final redirect URL, or its code");
        try {
          return new URL(value);
        } catch {
          const into = new URL(server.redirectUri);
          into.searchParams.set("code", value.includes("code=") ? (new URLSearchParams(value).get("code") ?? value) : value);
          return into;
        }
      };
      return yield* callbackOrPaste(context, server, "Complete sign-in in your browser, or paste the final redirect URL here:", pasted);
    }),
  );
}

export const openrouter: OAuthMethod = { id: "openrouter", name: "Sign in with OpenRouter", login, refresh: async (stored) => stored };
