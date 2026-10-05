import { describe, expect, it } from "vitest";
import { MCP_HIDDEN, parseMcpInput } from "@lemma/contracts";
import type { McpServerInfo, McpServerSpec, McpToolInfo } from "@lemma/contracts";
import {
  describeStatus,
  humanize,
  listWords,
  matchServers,
  matchTools,
  needsAttention,
  readEdit,
  secretChanges,
  serverTarget,
  shortStatus,
  specText,
  toolCallSummary,
} from "../src/model/mcp.ts";

const tool = (name: string, extra: Partial<McpToolInfo> = {}): McpToolInfo => ({
  name,
  tool: `mcp__server__${name}`,
  enabled: true,
  hints: {},
  ...extra,
});

const server = (spec: McpServerSpec, extra: Partial<McpServerInfo> = {}): McpServerInfo => ({
  id: spec.id,
  spec,
  type: spec.command === undefined ? "http" : "stdio",
  scope: "user",
  status: "ready",
  since: 0,
  tools: [],
  resources: 0,
  prompts: 0,
  secrets: [],
  missing: [],
  ...extra,
});

const playwright = server(
  { id: "playwright", name: "Playwright", command: "npx", args: ["@playwright/mcp@0.0.41"] },
  {
    server: { name: "playwright", title: "Playwright", version: "0.0.41" },
    tools: [tool("browser_navigate", { description: "Navigate to a URL" }), tool("browser_click", { enabled: false })],
  },
);
const github = server(
  { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } },
  { tools: [tool("create_issue", { title: "Create issue" }), tool("search_code")], secrets: ["GITHUB_TOKEN"] },
);

describe("naming", () => {
  it("shows a command line or a URL's host and path", () => {
    expect(serverTarget(playwright.spec)).toBe("npx @playwright/mcp@0.0.41");
    expect(serverTarget({ id: "x", command: "uvx", args: ["mcp-server", "--root", "/my docs"] })).toBe("uvx mcp-server --root '/my docs'");
    expect(serverTarget(github.spec)).toBe("api.githubcopilot.com/mcp");
    expect(serverTarget({ id: "x", url: "https://${HOST}/mcp" })).toBe("${HOST}/mcp");
  });

  it("puts tool names in words", () => {
    expect([humanize("create_issue"), humanize("getUserProfile"), humanize("browser-take-screenshot"), humanize("")]).toEqual([
      "Create issue",
      "Get user profile",
      "Browser take screenshot",
      "",
    ]);
  });

  it("titles a call with the server and the tool, and its first short argument", () => {
    expect(toolCallSummary(github, github.tools[0]!, { title: "Fix login", body: "long\ntext" })).toEqual({
      title: "GitHub · Create issue",
      primary: "Fix login",
    });
    expect(toolCallSummary(github, github.tools[1]!, { body: "a\nb", limit: 3 })).toEqual({ title: "GitHub · Search code" });
    // A title says more than the owner before it.
    expect(toolCallSummary(github, github.tools[0]!, { owner: "lemma-dev", repo: "lemma", title: "Login drops ?next=" }).primary).toBe("Login drops ?next=");
  });
});

describe("status", () => {
  it("says what state a server is in", () => {
    expect(describeStatus(playwright)).toBe("Connected · Playwright 0.0.41");
    expect(describeStatus(server({ id: "x", command: "x" }, { status: "auth" }))).toBe("Needs you to sign in");
    const failing = server({ id: "x", command: "x" }, { status: "error", error: "Command not found: x", retryAt: 10_000 });
    expect(describeStatus(failing, 6_200)).toBe("Couldn't connect: Command not found: x · retrying in 4s");
    expect(describeStatus(failing, 11_000)).toBe("Couldn't connect: Command not found: x · retrying now");
  });

  it("counts offered tools, and flags what needs the user", () => {
    expect(shortStatus(playwright)).toBe("1 of 2 tools");
    expect(shortStatus(github)).toBe("2 tools");
    expect(needsAttention(server({ id: "x", url: "https://x" }, { status: "auth" }))).toBe(true);
    expect(needsAttention(server({ id: "x", url: "https://x", enabled: false }, { status: "error" }))).toBe(false);
    expect(needsAttention(playwright)).toBe(false);
  });

  it("lists names in words", () => {
    expect([listWords([]), listWords(["A"]), listWords(["A", "B"]), listWords(["A", "B", "C"])]).toEqual(["", "A", "A and B", "A, B and C"]);
  });
});

describe("search", () => {
  it("finds servers by name and target, or by a tool", () => {
    expect(matchServers([playwright, github], "").map((found) => found.id)).toEqual(["playwright", "github"]);
    expect(matchServers([playwright, github], "copilot").map((found) => found.id)).toEqual(["github"]);
    expect(matchServers([playwright, github], "navigate").map((found) => found.id)).toEqual(["playwright"]);
    expect(matchServers([playwright, github], "github issue").map((found) => found.id)).toEqual(["github"]);
  });

  it("shows every tool of a server the search names, else the matching ones", () => {
    expect(matchTools(github, "github").length).toBe(2);
    expect(matchTools(github, "issue").map((found) => found.name)).toEqual(["create_issue"]);
    expect(matchTools(playwright, "url").map((found) => found.name)).toEqual(["browser_navigate"]);
  });
});

describe("the add and edit dialog", () => {
  const linear: McpServerSpec = {
    id: "linear",
    name: "Linear",
    type: "http",
    url: "https://mcp.linear.app/mcp",
    headers: { Authorization: MCP_HIDDEN, "X-Team": "core" },
    enabled: false,
    disabledTools: ["delete_issue"],
    toolTimeoutMs: 60_000,
    startupTimeoutMs: 5_000,
    oauth: { clientId: "lemma", clientSecret: MCP_HIDDEN, scopes: ["read"], callbackPort: 8765 },
  };

  it("opens Edit with the spec as its config holds it, less the id, and reads it back as it was", () => {
    const text = specText(linear);
    expect(JSON.parse(text)).toEqual({ ...linear, id: undefined });
    expect(text).not.toContain('"id"');
    expect(text.split("\n").length).toBeGreaterThan(5);
    expect(parseMcpInput(text, { name: "linear" })).toEqual({ servers: [{ spec: linear, secrets: {}, notes: [] }], problems: [] });
    expect(readEdit(text, linear)).toEqual({ servers: [{ spec: linear, secrets: {}, notes: [] }], problems: [] });
    // A stdio server's environment, a reference and a hidden value included.
    const files: McpServerSpec = {
      id: "files",
      type: "stdio",
      command: "npx",
      args: ["-y", "server"],
      cwd: "/tmp",
      env: { API_KEY: MCP_HIDDEN, ROOT: "${HOME}" },
    };
    expect(parseMcpInput(specText(files), { name: "files" }).servers[0]!.spec).toEqual(files);
  });

  it("leaves the transport to the host unless the text names it", () => {
    const github: McpServerSpec = { id: "github", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } };
    expect(readEdit(specText(github), github).servers[0]!.spec).toEqual(github);
    const sse = readEdit(JSON.stringify({ type: "sse", url: github.url }), github).servers[0]!.spec;
    expect(sse).toEqual({ id: "github", type: "sse", url: github.url });
  });

  it("removes the stored secrets an edit no longer reads", () => {
    const found = readEdit(JSON.stringify({ url: "https://x.example/mcp", headers: { Authorization: "Bearer ${TOKEN}", "X-Api-Key": "k3y" } }), {
      id: "x",
      url: "",
    }).servers[0]!;
    expect(secretChanges(found, ["TOKEN", "OLD", "X_API_KEY"])).toEqual({ X_API_KEY: "k3y", OLD: null });
    expect(secretChanges(found)).toEqual({ X_API_KEY: "k3y" });
  });

  it("keeps the server's id, and moves a credential typed in to its secrets", () => {
    const before: McpServerSpec = { id: "My_DB", command: "postgres-mcp" };
    expect(readEdit(specText(before), before).servers[0]!.spec).toEqual(before);
    const edited = readEdit(JSON.stringify({ name: "Postgres", command: "postgres-mcp", env: { DB_PASSWORD: "hunter2", DB_USER: "app" } }), before);
    expect(edited).toEqual({
      servers: [
        {
          spec: { id: "My_DB", name: "Postgres", command: "postgres-mcp", env: { DB_PASSWORD: "${DB_PASSWORD}", DB_USER: "app" } },
          secrets: { DB_PASSWORD: "hunter2" },
          notes: [],
        },
      ],
      problems: [],
    });
  });

  it("edits one server at a time, and says why it cannot read the text", () => {
    const two = readEdit(`{ "mcpServers": { "a": { "command": "a" }, "b": { "command": "b" } } }`, linear);
    expect(two.servers).toEqual([]);
    expect(two.problems).toEqual(["That is 2 servers: edit one here, and add the others with Add server"]);
    expect(readEdit("{ nope", linear).problems[0]).toMatch(/^Not JSON/);
    expect(readEdit("  ", linear)).toEqual({ servers: [], problems: [] });
  });
});
