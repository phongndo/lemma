// A remote MCP server that asks to be signed in to, with its own authorization server, for the tests: the protected
// resource and authorization server metadata, Dynamic Client Registration, an authorization page that approves at
// once (redirecting the "browser" back with a code), and a token endpoint for codes (PKCE checked) and refresh tokens,
// each bound to the client it was issued to and good once, as an authorization server that rotates them has it.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export interface OAuthOptions {
  readonly port?: number;
  /** Where the protected resource metadata is, which only the `WWW-Authenticate` header names: none at the well-known address. */
  readonly metadataPath?: string;
  /** A client registered ahead of time: no registration endpoint, and its secret checked at the token endpoint. */
  readonly client?: { readonly id: string; readonly secret: string };
  /** Asks no sign-in, and offers none: no metadata at all. */
  readonly open?: boolean;
}

export interface OAuthFixture {
  readonly base: string;
  readonly url: string;
  /** Refuses every access token Lemma holds, as an expired one is: its refresh token still renews it. */
  readonly expire: () => void;
  /** Refuses every token, refresh tokens too: only a new sign-in works. */
  readonly revoke: () => void;
  /** The token endpoint answers refreshes with a fault of its own (`503`) while this is set. */
  failRefreshes: boolean;
  /** The MCP endpoint answers `500` with the address it was asked at while this is set. */
  broken: boolean;
  /** The MCP endpoint refuses every request with a `403` that asks for no scope (no `WWW-Authenticate`) while this is set. */
  forbidden: boolean;
  /** The authorization server forgets the clients it registered: a refresh with one is refused `invalid_client`. */
  readonly forgetClients: () => void;
  readonly counts: { registrations: number; refreshes: number; refusals: number };
  /** The scope each authorization asked for, in order. */
  readonly scopes: (string | null)[];
  /** Settles once the MCP endpoint has refused `count` requests for want of a token it accepts. */
  readonly refusals: (count: number) => Promise<void>;
  /** Holds every refresh at the token endpoint until `release`; `arrived` settles once one is held. */
  readonly holdRefreshes: () => { readonly release: () => void; readonly arrived: Promise<void> };
  readonly close: () => Promise<void>;
}

/** The tool `admin` needs the scope `admin`: a token without it is refused with `403 insufficient_scope`. */
const make = () => {
  const server = new McpServer({ name: "oauth-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.registerTool("echo", { description: "Says its text back", inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
    content: [{ type: "text", text }],
  }));
  server.registerTool("admin", { description: "Needs more access", inputSchema: z.object({}) }, async () => ({ content: [{ type: "text", text: "admin" }] }));
  return server;
};

const bodyOf = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const json = (response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
};

/** Whether a JSON-RPC request body calls the tool `name`. */
const calls = (body: Buffer, name: string) => {
  try {
    const message = JSON.parse(body.toString("utf8")) as { method?: string; params?: { name?: string } };
    return message.method === "tools/call" && message.params?.name === name;
  } catch {
    return false;
  }
};

export async function startOAuthServer(options: OAuthOptions = {}): Promise<OAuthFixture> {
  const mcp = createMcpHandler(make);
  /** Access tokens and the scope each grants; refresh tokens and the client and scope each is for. */
  const access = new Map<string, string>();
  const refresh = new Map<string, { readonly client: string; readonly scope: string }>();
  const codes = new Map<string, { readonly challenge: string; readonly redirect: string; readonly client: string; readonly scope: string }>();
  const counts = { registrations: 0, refreshes: 0, refusals: 0 };
  const scopes: (string | null)[] = [];
  let next = 0;
  const issue = (client: string, scope: string) => {
    next++;
    access.set(`token-${next}`, scope);
    refresh.set(`refresh-${next}`, { client, scope });
    return { access_token: `token-${next}`, token_type: "Bearer", expires_in: 3600, refresh_token: `refresh-${next}`, scope };
  };
  const clients = new Set<string>();
  let base = "";
  let held: Promise<void> = Promise.resolve();
  let holding: (() => void) | undefined;
  const waiters: { readonly count: number; readonly resolve: () => void }[] = [];
  const refuse = () => {
    counts.refusals++;
    for (const waiter of waiters.filter(({ count }) => counts.refusals >= count)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  const metadataUrl = () => `${base}${options.metadataPath ?? "/.well-known/oauth-protected-resource/mcp"}`;

  const http = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", base);
    const body = await bodyOf(request);
    if (url.pathname === "/mcp" && fixture.broken) {
      response.writeHead(500, { "content-type": "text/plain" });
      return response.end(`refused ${request.url}`);
    }
    if (url.pathname === "/mcp" && fixture.forbidden) return json(response, 403, { error: "forbidden" });
    if (options.open === true && url.pathname !== "/mcp") return json(response, 404, { error: "not_found" });
    if (
      url.pathname === (options.metadataPath ?? "") ||
      (options.metadataPath === undefined && url.pathname.startsWith("/.well-known/oauth-protected-resource"))
    )
      return json(response, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["read"] });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(response, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(options.client === undefined ? { registration_endpoint: `${base}/register` } : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: options.client === undefined ? ["none"] : ["client_secret_post"],
      });
    if (url.pathname === "/register" && options.client === undefined) {
      counts.registrations++;
      clients.add(`client-${counts.registrations}`);
      return json(response, 201, { ...JSON.parse(body.toString("utf8")), client_id: `client-${counts.registrations}` });
    }
    if (url.pathname === "/authorize") {
      const redirect = url.searchParams.get("redirect_uri")!;
      const code = `code-${codes.size + 1}-${next}`;
      scopes.push(url.searchParams.get("scope"));
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge")!,
        redirect,
        client: url.searchParams.get("client_id")!,
        scope: url.searchParams.get("scope") ?? "read",
      });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state")!);
      response.writeHead(302, { location: back.href });
      return response.end();
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(body.toString("utf8"));
      const client = form.get("client_id") ?? "";
      if (options.client === undefined ? !clients.has(client) : client !== options.client.id || form.get("client_secret") !== options.client.secret)
        return json(response, 401, { error: "invalid_client" });
      if (form.get("grant_type") === "refresh_token") {
        holding?.();
        await held;
        if (fixture.failRefreshes) return json(response, 503, { error: "temporarily_unavailable" });
        const granted = refresh.get(form.get("refresh_token") ?? "");
        refresh.delete(form.get("refresh_token") ?? "");
        if (granted === undefined || granted.client !== client) return json(response, 400, { error: "invalid_grant" });
        counts.refreshes++;
        return json(response, 200, issue(client, granted.scope));
      }
      const granted = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      if (granted === undefined || granted.challenge !== challenge || granted.redirect !== form.get("redirect_uri") || granted.client !== client)
        return json(response, 400, { error: "invalid_grant" });
      return json(response, 200, issue(client, granted.scope));
    }
    if (url.pathname === "/mcp") {
      const token = request.headers.authorization?.replace(/^Bearer /, "");
      const scope = options.open === true ? "admin" : token === undefined ? undefined : access.get(token);
      if (scope === undefined) refuse();
      if (scope === undefined) return json(response, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${metadataUrl()}"` });
      if (calls(body, "admin") && !scope.split(" ").includes("admin"))
        return json(
          response,
          403,
          { error: "insufficient_scope" },
          { "www-authenticate": `Bearer error="insufficient_scope", scope="admin", resource_metadata="${metadataUrl()}"` },
        );
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
      const answer = await mcp.fetch(
        new Request(url, { method: request.method!, headers, ...(request.method === "GET" || request.method === "HEAD" ? {} : { body }) }),
      );
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      // Streamed as it comes: a subscription's response stays open.
      const reader = answer.body?.getReader();
      response.on("close", () => void reader?.cancel().catch(() => {}));
      for (let chunk = await reader?.read(); chunk !== undefined && !chunk.done; chunk = await reader!.read()) response.write(chunk.value);
      response.end();
      return;
    }
    json(response, 404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => http.listen(options.port ?? 0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const fixture: OAuthFixture = {
    base,
    url: `${base}/mcp`,
    expire: () => access.clear(),
    revoke: () => {
      access.clear();
      refresh.clear();
    },
    failRefreshes: false,
    broken: false,
    forbidden: false,
    forgetClients: () => clients.clear(),
    counts,
    scopes,
    refusals: (count) => (counts.refusals >= count ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ count, resolve }))),
    holdRefreshes: () => {
      let release!: () => void;
      held = new Promise<void>((resolve) => (release = resolve));
      const arrived = new Promise<void>((resolve) => (holding = resolve));
      return {
        arrived,
        release: () => {
          held = Promise.resolve();
          holding = undefined;
          release();
        },
      };
    },
    close: async () => {
      await mcp.close();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    },
  };
  return fixture;
}
