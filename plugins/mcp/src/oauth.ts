import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

/** A server's `oauth` settings, every `${NAME}` resolved. */
export interface OAuthSettings {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scopes?: readonly string[];
  readonly callbackPort?: number;
}

/** What is kept of a server's sign-in: the client Lemma registered as, and the tokens. */
export interface SignIn {
  /** The server URL it signed in to; a sign-in for another URL is not used. */
  readonly url: string;
  readonly client?: StoredOAuthClientInformation;
  readonly tokens?: StoredOAuthTokens;
  /** The redirect URI the client was registered with; the next sign-in listens on its port again when it can. */
  readonly redirectUrl?: string;
}

/** A server's sign-in in the credential store, mirrored in memory because providers read some of it synchronously. */
export interface SignInStore {
  readonly current: () => SignIn | undefined;
  readonly update: (change: (current: SignIn | undefined) => SignIn | undefined) => Promise<void>;
}

/** What a sign-in in progress lends the provider. */
export interface Flow {
  readonly redirectUrl: string;
  readonly state: string;
  /** Where the server sent the person to sign in. */
  authorizationUrl?: URL;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
}

const CLIENT_NAME = "Lemma";

/**
 * Signs requests to an MCP server with OAuth, keeping what it learns in
 * `store`. Without a `flow` it only uses and refreshes what is stored: a
 * server never signed in to fails `UnauthorizedError` before anything is
 * registered, so a background connection never starts a sign-in. With one,
 * it registers if needed and hands the authorization URL to the flow.
 */
export function signInProvider(options: {
  readonly url: string;
  readonly settings: OAuthSettings;
  readonly store: SignInStore;
  readonly flow?: Flow;
}): OAuthClientProvider {
  const { url, settings, store, flow } = options;
  const stored = () => {
    const current = store.current();
    return current?.url === url ? current : undefined;
  };
  const redirectUrl = () => flow?.redirectUrl ?? stored()?.redirectUrl ?? "http://localhost/callback";
  const save = (change: (current: SignIn) => SignIn) =>
    store.update((current) => change(current?.url === url ? current : { url, ...(flow === undefined ? {} : { redirectUrl: flow.redirectUrl }) }));
  return {
    get redirectUrl() {
      return redirectUrl();
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUrl()],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: settings.clientSecret === undefined ? "none" : "client_secret_post",
        ...(settings.scopes === undefined || settings.scopes.length === 0 ? {} : { scope: settings.scopes.join(" ") }),
      };
    },
    ...(flow === undefined ? {} : { state: () => flow.state }),
    clientInformation: () => {
      if (settings.clientId !== undefined) {
        return { client_id: settings.clientId, ...(settings.clientSecret === undefined ? {} : { client_secret: settings.clientSecret }) };
      }
      const current = stored();
      // A sign-in on another port registers again: the server checks the redirect URI exactly.
      if (current?.client !== undefined && (flow === undefined || current.redirectUrl === flow.redirectUrl)) return current.client;
      if (flow === undefined && current?.tokens === undefined) throw new UnauthorizedError("Sign in to use this server");
      return undefined;
    },
    saveClientInformation: (client) => save((current) => ({ ...current, client, ...(flow === undefined ? {} : { redirectUrl: flow.redirectUrl }) })),
    tokens: () => stored()?.tokens,
    saveTokens: (tokens) => save((current) => ({ ...current, tokens })),
    redirectToAuthorization: (authorizationUrl) => {
      if (flow !== undefined) flow.authorizationUrl = authorizationUrl;
    },
    saveCodeVerifier: (verifier) => {
      if (flow !== undefined) flow.verifier = verifier;
    },
    codeVerifier: () => {
      if (flow?.verifier === undefined) throw new Error("No sign-in is in progress");
      return flow.verifier;
    },
    ...(flow === undefined
      ? {}
      : {
          saveDiscoveryState: (discovery: OAuthDiscoveryState) => {
            flow.discovery = discovery;
          },
          discoveryState: () => flow.discovery,
        }),
    invalidateCredentials: (scope) =>
      store.update((current) => {
        if (current === undefined || scope === "verifier" || scope === "discovery") return current;
        if (scope === "all") return undefined;
        const { [scope === "client" ? "client" : "tokens"]: _, ...rest } = current;
        return rest;
      }),
  };
}

/** What the authorization server sent back to the redirect URI. */
export interface Callback {
  readonly code: string;
  readonly state?: string;
  readonly iss?: string;
}

/** The callback in a redirect URL (`http://localhost:…/callback?code=…&state=…`), as pasted by someone whose browser is not on the host. */
export function parseCallback(text: string): Callback | { readonly error: string } {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { error: "That is not the address your browser was sent to" };
  }
  return fromParams(url.searchParams);
}

function fromParams(params: URLSearchParams): Callback | { readonly error: string } {
  const error = params.get("error");
  if (error !== null) return { error: `The server refused: ${params.get("error_description") ?? error}` };
  const code = params.get("code");
  if (code === null) return { error: "The address has no authorization code" };
  const state = params.get("state");
  const iss = params.get("iss");
  return { code, ...(state === null ? {} : { state }), ...(iss === null ? {} : { iss }) };
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font:15px system-ui;margin:4rem auto;max-width:32rem;color:#222"><h1 style="font-size:1.2rem">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body>`;

export interface CallbackServer {
  readonly port: number;
  /** Settles with the first callback whose `state` matches. */
  readonly result: Promise<Callback>;
  readonly close: () => Promise<void>;
}

/**
 * Listens on the loopback interface for the authorization server's redirect.
 * `port` 0 picks a free one; a busy fixed port fails.
 */
export function listenForCallback(port: number, state: string, server: string): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let settle!: { resolve: (callback: Callback) => void; reject: (error: Error) => void };
    const result = new Promise<Callback>((done, fail) => (settle = { resolve: done, reject: fail }));
    // Unhandled until the flow awaits it.
    result.catch(() => {});
    const http = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const callback = fromParams(url.searchParams);
      if ("error" in callback) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page(`Could not sign in to ${server}`, callback.error));
        settle.reject(new Error(callback.error));
        return;
      }
      if (callback.state !== state) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("This sign-in has expired", "Start signing in again from Lemma."));
        return;
      }
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(page(`Signed in to ${server}`, "You can close this tab and return to Lemma."));
      settle.resolve(callback);
    });
    http.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "EADDRINUSE" ? new Error(`Port ${port} is in use, so Lemma cannot receive the sign-in there`) : error),
    );
    http.listen(port, "127.0.0.1", () => {
      const address = http.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : port,
        result,
        close: () =>
          new Promise<void>((done) => {
            http.closeAllConnections();
            http.close(() => done());
          }),
      });
    });
  });
}

export const randomState = (): string => randomBytes(24).toString("base64url");

/** The loopback redirect URI for a callback port. */
export const redirectUrlFor = (port: number): string => `http://localhost:${port}/callback`;

/** The port a stored redirect URI names, to listen on it again. */
export const portOf = (redirectUrl: string | undefined): number | undefined => {
  if (redirectUrl === undefined) return undefined;
  try {
    const port = Number(new URL(redirectUrl).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
};
