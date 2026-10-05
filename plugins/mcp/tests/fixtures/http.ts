import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { makeFixture } from "./fixture.ts";

export interface HttpFixture {
  /** The MCP endpoint. */
  readonly url: string;
  readonly close: () => Promise<void>;
  /** Access tokens issued so far. */
  readonly issued: string[];
  /** Clients registered (dynamic client registration). */
  readonly clients: string[];
}

const body = (request: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

const json = (response: ServerResponse, status: number, value: unknown) =>
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));

/**
 * The fixture over Streamable HTTP. With `auth`, the endpoint wants a bearer
 * token and the same server is a minimal OAuth authorization server:
 * protected-resource and authorization-server metadata, dynamic client
 * registration, an authorize endpoint that signs in at once (redirecting
 * with a code), and a token endpoint that checks PKCE.
 */
export async function startHttpFixture(
  options: { readonly auth?: boolean; readonly legacy?: boolean; readonly forgetOnce?: boolean } = {},
): Promise<HttpFixture> {
  let forget = options.forgetOnce === true;
  const handler = createMcpHandler(() => makeFixture(options.legacy === undefined ? {} : { legacy: options.legacy }));
  const issued: string[] = [];
  const clients: string[] = [];
  const challenges = new Map<string, string>();
  let base = "";
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", base);
      if (options.auth) {
        if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
          return json(response, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["tools"] });
        }
        if (url.pathname === "/.well-known/oauth-authorization-server") {
          return json(response, 200, {
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
        }
        if (url.pathname === "/register" && request.method === "POST") {
          const metadata = JSON.parse((await body(request)).toString()) as Record<string, unknown>;
          const id = `client-${clients.length + 1}`;
          clients.push(id);
          return json(response, 201, { ...metadata, client_id: id });
        }
        if (url.pathname === "/authorize") {
          const code = `code-${challenges.size + 1}`;
          challenges.set(code, url.searchParams.get("code_challenge") ?? "");
          const redirect = new URL(url.searchParams.get("redirect_uri")!);
          redirect.searchParams.set("code", code);
          redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
          return response.writeHead(302, { location: redirect.href }).end();
        }
        if (url.pathname === "/token" && request.method === "POST") {
          const form = new URLSearchParams((await body(request)).toString());
          if (form.get("grant_type") === "authorization_code") {
            const challenge = challenges.get(form.get("code") ?? "");
            const verifier = createHash("sha256")
              .update(form.get("code_verifier") ?? "")
              .digest("base64url");
            if (challenge === undefined || challenge !== verifier) return json(response, 400, { error: "invalid_grant" });
          }
          const token = `token-${issued.length + 1}`;
          issued.push(token);
          return json(response, 200, { access_token: token, token_type: "Bearer", expires_in: 3600, refresh_token: `refresh-${issued.length}` });
        }
        const authorization = request.headers.authorization ?? "";
        if (url.pathname === "/mcp" && !issued.some((token) => authorization === `Bearer ${token}`)) {
          return response
            .writeHead(401, {
              "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
              "content-type": "application/json",
            })
            .end(JSON.stringify({ error: "unauthorized" }));
        }
      }
      if (url.pathname !== "/mcp") return response.writeHead(404).end();
      const payload = request.method === "GET" || request.method === "HEAD" ? undefined : await body(request);
      // A server that restarted and lost its sessions answers the next call 404.
      if (forget && payload?.toString().includes('"tools/call"')) {
        forget = false;
        return json(response, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
      const answer = await handler.fetch(
        new Request(url, { method: request.method ?? "GET", headers, ...(payload === undefined ? {} : { body: new Uint8Array(payload) }) }),
      );
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      if (answer.body !== null) for await (const chunk of answer.body) response.write(chunk);
      response.end();
    })().catch((error) => {
      if (!response.headersSent) response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  return {
    url: `${base}/mcp`,
    issued,
    clients,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
