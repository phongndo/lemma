import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AuthProvider,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { McpOAuthConfig } from "@lemma/mcp";
import { loadedSdk, loadSdk } from "./sdk.ts";
import type { Sdk } from "./sdk.ts";

/** What Lemma keeps of one server's sign-in, in `<home>/mcp-auth.json`. */
export interface StoredSignIn {
  /** The server's address it was made for: a sign-in for another address is not used. */
  readonly url: string;
  /** The client Lemma registered with the authorization server, and the address it registered to come back to. */
  readonly client?: StoredOAuthClientInformation;
  readonly redirectUrl?: string;
  readonly tokens?: StoredOAuthTokens;
  readonly discovery?: OAuthDiscoveryState;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The sign-ins Lemma holds, by server name, in a file of their own (mode 0600). Read once; this host is the only
 * writer, so what it holds in memory is the file, and each write replaces the file whole, atomically, one at a time.
 */
export class SignInStore {
  readonly path: string;
  private servers: Record<string, StoredSignIn> = {};
  /** Why the file could not be read: it is never written over then. */
  private problem: string | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") this.problem = `Could not read ${this.path}: ${(cause as Error).message}`;
      return;
    }
    try {
      const json: unknown = text.trim() === "" ? {} : JSON.parse(text);
      const servers = isObject(json) ? json["servers"] : undefined;
      if (servers !== undefined && !isObject(servers)) throw new Error('"servers" is not an object');
      this.servers = Object.fromEntries(
        Object.entries(servers ?? {}).filter((entry): entry is [string, StoredSignIn] => isObject(entry[1]) && typeof entry[1]["url"] === "string"),
      );
    } catch (cause) {
      this.problem = `${this.path} is not valid: ${(cause as Error).message}. Fix or remove it to sign in again`;
    }
  }

  /** The server's sign-in, when it was made for `url`. */
  get(name: string, url: string): StoredSignIn | undefined {
    const stored = this.servers[name];
    return stored?.url === url ? stored : undefined;
  }

  /** Sets or (`undefined`) removes the server's sign-in, and writes the file. */
  set(name: string, value: StoredSignIn | undefined): Promise<void> {
    if (this.problem !== undefined) return Promise.reject(new Error(this.problem));
    if (value === undefined) delete this.servers[name];
    else this.servers[name] = value;
    const json = `${JSON.stringify({ servers: this.servers }, null, 2)}\n`;
    const run = this.queue.then(() => this.write(json));
    this.queue = run.catch(() => {});
    return run;
  }

  private async write(json: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, json, { mode: 0o600 });
      await rename(temporary, this.path);
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => {});
      throw cause;
    }
  }
}

/** A server needs the person to sign in: Lemma holds no sign-in it accepts, and cannot renew one on its own. */
export class NeedsSignIn extends Error {
  constructor() {
    super("The server asks to be signed in to");
    this.name = "NeedsSignIn";
  }
}

/**
 * Renewing a sign-in failed for now: the authorization server could not be reached, or answered with a fault of its
 * own rather than refusing the refresh token, which Lemma keeps for another try.
 */
export class RenewalFailed extends Error {
  constructor(cause: unknown) {
    super(`Could not renew the sign-in: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "RenewalFailed";
  }
}

/** Whether `error`, or an error it was caused by, is `NeedsSignIn`. */
export const needsSignIn = (error: unknown): boolean => {
  for (let at: unknown = error, depth = 0; at instanceof Error && depth < 8; at = at.cause, depth++) if (at instanceof NeedsSignIn) return true;
  return false;
};

/** A server Lemma signs in to: its name, address, and `oauth` settings, with their variables read. */
export interface SignInTarget {
  readonly name: string;
  readonly url: string;
  readonly oauth: McpOAuthConfig | undefined;
}

/**
 * What a server said when it last refused: where its protected resource metadata is (its `WWW-Authenticate`'s
 * `resource_metadata`, which discovery would not find at the well-known address on every server), and the scope it
 * asked for (a `403 insufficient_scope`'s, which the next sign-in asks for besides those already granted).
 */
export interface Challenge {
  readonly resourceMetadataUrl?: URL;
  readonly scope?: string;
}

/** The scopes in any of `scopes` (space-separated), each once; `undefined` for none. */
export const unionScopes = (...scopes: readonly (string | undefined)[]): string | undefined => {
  const all = new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter((token) => token !== "") ?? []));
  return all.size === 0 ? undefined : [...all].join(" ");
};

/** The challenge a refusal carries, from its `WWW-Authenticate` header. */
const challengeOf = (sdk: Sdk, response: Response): Challenge => {
  const { resourceMetadataUrl, scope } = sdk.extractWWWAuthenticateParams(response);
  return { ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }), ...(scope === undefined ? {} : { scope }) };
};

/**
 * A browser sign-in under way: where the browser comes back to, the `state` it must bring, and the PKCE verifier; and
 * what it learned on the way (a client registered for `redirectUrl`, the authorization server found), kept here, not
 * stored, until the sign-in succeeds, so one stopped halfway leaves the sign-in Lemma holds as it was.
 */
export interface Flow {
  readonly redirectUrl: string;
  readonly state: string;
  verifier?: string;
  authorizationUrl?: URL;
  client?: StoredOAuthClientInformation | undefined;
  /** The authorization server refused the client stored: the flow registers its own. */
  newClient?: boolean;
  discovery?: OAuthDiscoveryState | undefined;
  /** Set while the code is exchanged: the tokens saved then are the flow's, stored with its client and discovery. */
  exchanging?: boolean;
}

/** A new sign-in's `state`, which the browser brings back with its code. */
export const newState = () => randomBytes(24).toString("base64url");

/** What each scope `invalidateCredentials` names removes of a stored sign-in. */
const INVALIDATED = { client: ["client", "redirectUrl"], tokens: ["tokens"], discovery: ["discovery"] } as const;

/** `stored` without `keys`. */
const without = (stored: StoredSignIn, keys: readonly (keyof StoredSignIn)[]): StoredSignIn =>
  Object.fromEntries(Object.entries(stored).filter(([key]) => !keys.includes(key as keyof StoredSignIn))) as unknown as StoredSignIn;

/**
 * The SDK's OAuth client for one server: what it registers, stores, and sends the browser to. It reads the store
 * afresh each time and writes onto what the store holds then, so two at once never put back what the other replaced.
 * With a `flow`, a browser sign-in is under way: what it learns stays in the flow until its code is exchanged. Without
 * one, Lemma can only renew the sign-in it holds: a renewal the authorization server refuses needs the person
 * (`NeedsSignIn`), and one that failed otherwise, its refresh token kept, is for another try (`RenewalFailed`).
 */
function provider(store: SignInStore, target: SignInTarget, flow: Flow | undefined): OAuthClientProvider {
  const current = () => store.get(target.name, target.url);
  const patch = (fields: Partial<StoredSignIn>) => store.set(target.name, { ...(current() ?? { url: target.url }), ...fields, url: target.url });
  const redirectUrl = flow?.redirectUrl ?? current()?.redirectUrl;
  const { clientId, clientSecret, scopes } = target.oauth ?? {};
  /** The refresh token a renewal starts with: one replaced meanwhile was renewed by another, whose tokens stay. */
  const renewing = current()?.tokens?.refresh_token;
  /** The client the entry configures, the same object each time, so the SDK stamps it once rather than storing it. */
  const configured: StoredOAuthClientInformation | undefined =
    clientId === undefined ? undefined : { client_id: clientId, ...(clientSecret === undefined ? {} : { client_secret: clientSecret }) };
  /** The stored client, when it was registered to come back where this sign-in's browser does. */
  const storedClient = () => {
    const stored = current();
    return stored?.client !== undefined && (flow === undefined || stored.redirectUrl === flow.redirectUrl) ? stored.client : undefined;
  };
  return {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "Lemma",
        redirect_uris: redirectUrl === undefined ? [] : [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: clientSecret === undefined ? "none" : "client_secret_post",
        ...(scopes === undefined ? {} : { scope: scopes }),
      };
    },
    state: () => flow?.state ?? newState(),
    clientInformation: () => configured ?? flow?.client ?? (flow?.newClient === true ? undefined : storedClient()),
    // A configured client, its secret included, is the entry's and is never stored.
    saveClientInformation: async (client) => {
      if (configured !== undefined) {
        Object.assign(configured, client);
        return;
      }
      if (flow !== undefined) flow.client = client;
      // A renewal stamps the client it has; registering one would need the browser.
      else if (current()?.client === undefined) throw new NeedsSignIn();
      else await patch({ client });
    },
    tokens: () => current()?.tokens,
    saveTokens: async (tokens) => {
      if (flow?.exchanging !== true) return patch({ tokens });
      // The sign-in succeeded: its client and what it found replace the stored ones with its tokens.
      const client = configured === undefined ? (flow.client ?? storedClient()) : undefined;
      const discovery = flow.discovery ?? current()?.discovery;
      await store.set(target.name, {
        url: target.url,
        redirectUrl: flow.redirectUrl,
        tokens,
        ...(client === undefined ? {} : { client }),
        ...(discovery === undefined ? {} : { discovery }),
      });
    },
    redirectToAuthorization: (url) => {
      if (flow !== undefined) flow.authorizationUrl = url;
      // Without a flow, a renewal fell back to asking the browser: its refresh token gone, it was refused.
      else if (current()?.tokens?.refresh_token === undefined) throw new NeedsSignIn();
      else throw new RenewalFailed(new Error("the authorization server could not renew it"));
    },
    saveCodeVerifier: (verifier) => {
      if (flow !== undefined) flow.verifier = verifier;
    },
    codeVerifier: () => {
      if (flow?.verifier === undefined) throw new Error("No sign-in is under way");
      return flow.verifier;
    },
    // What the server or the authorization server no longer accepts. A flow forgets what it learned, never the
    // sign-in held; a renewal forgets the stored tokens only while they are the ones it tried to renew.
    invalidateCredentials: async (scope) => {
      if (scope === "verifier") return;
      if (flow !== undefined) {
        if (scope === "client" || scope === "all") {
          flow.client = undefined;
          flow.newClient = true;
        }
        if (scope === "discovery" || scope === "all") flow.discovery = undefined;
        return;
      }
      const stored = current();
      if (stored === undefined || stored.tokens?.refresh_token !== renewing) return;
      await store.set(target.name, scope === "all" ? undefined : without(stored, INVALIDATED[scope]));
    },
    saveDiscoveryState: async (discovery) => {
      if (flow !== undefined) flow.discovery = discovery;
      else await patch({ discovery });
    },
    discoveryState: () => flow?.discovery ?? current()?.discovery,
  };
}

/**
 * The bearer a transport sends a server Lemma signs in to: the token Lemma holds, renewed with its refresh token when
 * the server refuses it, once for every refusal that comes while a renewal runs. Each refusal's challenge is passed to
 * `heard`. Without a refresh token, or when the authorization server refuses it, it fails `NeedsSignIn`; when the
 * renewal fails otherwise, `RenewalFailed`, the sign-in kept.
 */
export function bearer(store: SignInStore, target: SignInTarget, heard: (challenge: Challenge) => void): AuthProvider {
  let renewing: Promise<void> | undefined;
  const renew = async (context: Parameters<NonNullable<AuthProvider["onUnauthorized"]>>[0]) => {
    const sdk = await loadSdk();
    const challenge = challengeOf(sdk, context.response);
    if (store.get(target.name, target.url)?.tokens?.refresh_token === undefined) throw new NeedsSignIn();
    let result;
    try {
      result = await sdk.auth(provider(store, target, undefined), {
        serverUrl: context.serverUrl,
        fetchFn: context.fetchFn,
        ...(challenge.resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl: challenge.resourceMetadataUrl }),
        ...(target.oauth?.scopes === undefined ? {} : { scope: target.oauth.scopes }),
      });
    } catch (cause) {
      if (cause instanceof NeedsSignIn || cause instanceof RenewalFailed) throw cause;
      throw new RenewalFailed(cause);
    }
    if (result !== "AUTHORIZED") throw new NeedsSignIn();
  };
  return {
    token: async () => store.get(target.name, target.url)?.tokens?.access_token,
    onUnauthorized: (context) => {
      // Loaded already: a transport that calls this came of it.
      const sdk = loadedSdk();
      if (sdk !== undefined) heard(challengeOf(sdk, context.response));
      renewing ??= renew(context).finally(() => {
        renewing = undefined;
      });
      return renewing;
    },
  };
}

/**
 * Starts a browser sign-in: finds the server's authorization server (where the server's last refusal pointed, if it
 * did), registers Lemma with it when it holds no client for the flow's address, and records the page the person
 * approves on in `flow`. It asks for the entry's scopes, else, when the server asked for a scope it lacked, that one
 * with those already granted, else those the server says it supports.
 */
export async function startSignIn(store: SignInStore, target: SignInTarget, flow: Flow, challenge: Challenge | undefined): Promise<string> {
  const scope =
    target.oauth?.scopes ?? (challenge?.scope === undefined ? undefined : unionScopes(store.get(target.name, target.url)?.tokens?.scope, challenge.scope));
  const { auth } = await loadSdk();
  await auth(provider(store, target, flow), {
    serverUrl: target.url,
    // A sign-in the person asks for is a new one, not the one held renewed.
    forceReauthorization: true,
    ...(challenge?.resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl: challenge.resourceMetadataUrl }),
    ...(scope === undefined ? {} : { scope }),
  });
  if (flow.authorizationUrl === undefined) throw new Error("The authorization server offered no page to sign in on");
  return flow.authorizationUrl.href;
}

/** Exchanges the code the browser brought back for the server's tokens, and stores them with what the flow learned. */
export async function finishSignIn(store: SignInStore, target: SignInTarget, flow: Flow, code: string, iss: string | undefined): Promise<void> {
  flow.exchanging = true;
  const { auth } = await loadSdk();
  const result = await auth(provider(store, target, flow), {
    serverUrl: target.url,
    authorizationCode: code,
    ...(iss === undefined ? {} : { iss }),
    ...(target.oauth?.scopes === undefined ? {} : { scope: target.oauth.scopes }),
  });
  if (result !== "AUTHORIZED") throw new Error("The authorization server did not accept the sign-in");
}

/**
 * What the browser brought back, from the address it landed on (`http://localhost:…/callback?code=…&state=…`) as the
 * person pasted it, its query alone, or a bare code an authorization server shows to copy.
 */
export function callbackParams(address: string): URLSearchParams {
  const text = address.trim();
  try {
    const url = new URL(text);
    return url.searchParams;
  } catch {
    // Not a whole address: a query, or a bare code.
  }
  if (/(^|[?&])(code|error)=/.test(text)) return new URLSearchParams(text.slice(text.indexOf("?") + 1));
  return new URLSearchParams({ code: text });
}
