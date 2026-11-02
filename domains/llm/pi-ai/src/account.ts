import { Predicate } from "effect";
import type * as Pi from "@earendil-works/pi-ai";
import type { Credential } from "@lemma/credentials";

/** Who a sign-in is, as its credential says: the account (an email), and the plan it uses. */
export interface Account {
  readonly account?: string;
  readonly plan?: string;
}

/** The claims of a JWT, read without checking its signature: only to show who signed in, never to trust it. */
export const claimsOf = (token: unknown): Record<string, unknown> | undefined => {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
    return Predicate.isObject(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
};

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const field = (record: unknown, key: string): unknown => (typeof record === "object" && record !== null ? (record as Record<string, unknown>)[key] : undefined);

/** OpenAI's claims: the profile's email, and the ChatGPT plan. */
const OPENAI_PROFILE = "https://api.openai.com/profile";
const OPENAI_AUTH = "https://api.openai.com/auth";

/**
 * Who a sign-in is, from what its credential holds: fields a provider's flow stores (an email, a login), else the
 * claims of its tokens (an ID token's, the access token's, where they are JWTs, as OpenAI's are). Nothing for an API key,
 * or for a credential that says neither.
 */
export function accountOf(credential: Credential | Pi.Credential | undefined): Account {
  if (credential?.type !== "oauth") return {};
  const tokens = [credential.idToken, credential.id_token, credential.access].map(claimsOf).filter((claims) => claims !== undefined);
  const account =
    text(credential.email) ??
    text(credential.login) ??
    text(credential.username) ??
    tokens.map((claims) => text(claims.email) ?? text(field(claims[OPENAI_PROFILE], "email")) ?? text(claims.preferred_username)).find(Boolean);
  const plan = text(credential.plan) ?? tokens.map((claims) => text(field(claims[OPENAI_AUTH], "chatgpt_plan_type"))).find(Boolean);
  return { ...(account === undefined ? {} : { account }), ...(plan === undefined ? {} : { plan }) };
}
