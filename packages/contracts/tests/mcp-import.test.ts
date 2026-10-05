import { describe, expect, it } from "vitest";
import { importMcpConfig, joinCommandLine, looksSecret, looksSecretValue, MCP_HIDDEN, mcpServerId, parseMcpInput, splitCommandLine } from "../src/index.ts";

describe("splitCommandLine", () => {
  it("splits words as a shell does, expanding nothing", () => {
    expect(splitCommandLine(`npx -y @playwright/mcp@latest --flag "a b" 'c d' e\\ f $HOME ""`)).toEqual([
      "npx",
      "-y",
      "@playwright/mcp@latest",
      "--flag",
      "a b",
      "c d",
      "e f",
      "$HOME",
      "",
    ]);
  });

  it("reads back what joinCommandLine writes", () => {
    const words = ["uvx", "mcp-server-git", "--repository", "/tmp/my repo", "it's", ""];
    expect(splitCommandLine(joinCommandLine(words))).toEqual(words);
  });
});

describe("mcpServerId", () => {
  it("makes an id from a name", () => {
    expect(mcpServerId("GitHub Server!")).toBe("github-server");
    expect(mcpServerId("  ")).toBe("server");
    expect(mcpServerId("playwright_mcp")).toBe("playwright_mcp");
  });
});

describe("looksSecret", () => {
  it("knows credential-like names", () => {
    for (const name of [
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "OPENAI_API_KEY",
      "Authorization",
      "X-Api-Key",
      "DB_PASSWORD",
      "AWS_SECRET_ACCESS_KEY",
      "PGPASSWORD",
      "clientSecret",
      "MYSQL_PWD",
    ]) {
      expect(looksSecret(name), name).toBe(true);
    }
    for (const name of ["PATH", "LOG_LEVEL", "KEYTIMEOUT", "Accept", "NODE_ENV", "TOKENIZERS_PARALLELISM"]) expect(looksSecret(name), name).toBe(false);
  });
});

describe("importMcpConfig", () => {
  it("reads Claude-style mcpServers, moving credentials out of the config", () => {
    const { servers, problems } = importMcpConfig(`{
      // From a README
      "mcpServers": {
        "github": {
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-github"],
          "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_123", "LOG_LEVEL": "debug" },
        },
        "Linear": { "type": "http", "url": "https://mcp.linear.app/mcp" },
        "legacy": { "url": "https://example.com/sse" },
      },
    }`);
    expect(problems).toEqual([]);
    expect(servers.map((server) => server.spec)).toEqual([
      {
        id: "github",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}", LOG_LEVEL: "debug" },
      },
      { id: "linear", name: "Linear", type: "http", url: "https://mcp.linear.app/mcp" },
      // No type stated: the host infers it, falling back from Streamable HTTP to SSE.
      { id: "legacy", url: "https://example.com/sse" },
    ]);
    expect(servers[0]!.secrets).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_123" });
  });

  it("notes placeholders and prompted inputs instead of saving them", () => {
    const { servers } = importMcpConfig(
      JSON.stringify({
        servers: {
          api: { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer ${input:api-token}", "X-Api-Key": "<YOUR_KEY>" } },
        },
      }),
    );
    expect(servers[0]!.spec.headers).toEqual({ Authorization: "Bearer ${API_TOKEN}", "X-Api-Key": "${X_API_KEY}" });
    expect(servers[0]!.secrets).toEqual({});
    expect(servers[0]!.notes).toEqual(["Set X_API_KEY: the config has a placeholder (<YOUR_KEY>)", "Set API_TOKEN: the other client prompted for it"]);
  });

  it("reads OpenCode's command arrays, a bare map, and one server object", () => {
    expect(
      importMcpConfig(`{"mcp": {"fs": {"type": "local", "command": ["bunx", "fs-mcp", "."], "environment": {"A": "1"}, "enabled": false}}}`).servers[0]!.spec,
    ).toEqual({
      id: "fs",
      command: "bunx",
      args: ["fs-mcp", "."],
      env: { A: "1" },
      enabled: false,
    });
    expect(importMcpConfig(`{"time": {"command": "uvx", "args": ["mcp-server-time"]}}`).servers[0]!.spec.id).toBe("time");
    expect(importMcpConfig(`{"command": "uvx", "args": ["mcp-server-time"]}`, "Time").servers[0]!.spec).toMatchObject({ id: "time", name: "Time" });
  });

  it("names what it cannot read", () => {
    expect(importMcpConfig("{nope").problems[0]).toMatch(/^Not JSON/);
    expect(importMcpConfig(`{"mcpServers": {"x": {"args": []}, "y": 3}}`).problems).toEqual(['"x" has neither a command nor a URL', '"y" is not an object']);
  });

  it("keeps ids unique", () => {
    const { servers } = importMcpConfig(`{"mcpServers": {"A b": {"command": "a"}, "a-b": {"command": "b"}}}`);
    expect(servers.map((server) => server.spec.id)).toEqual(["a-b", "a-b-2"]);
  });
});

describe("looksSecretValue", () => {
  it("knows credentials by their look, whatever they are called", () => {
    for (const value of ["postgres://me:hunter2@db/app", "ghp_abc", "github_pat_11", "sk-proj-x", "xoxb-1", "AKIAABCDEFGHIJKLMNOP"])
      expect(looksSecretValue(value), value).toBe(true);
    for (const value of ["postgres://db/app", "https://example.com", "debug", "skeleton"]) expect(looksSecretValue(value), value).toBe(false);
  });
});

describe("parseMcpInput", () => {
  const specs = (text: string, taken?: string[]) => {
    const { servers, problems } = parseMcpInput(text, taken === undefined ? {} : { taken });
    expect(problems).toEqual([]);
    return servers.map((server) => server.spec);
  };

  it("adds a server at a URL, named after its host", () => {
    expect(specs("https://mcp.linear.app/mcp")).toEqual([{ id: "linear", url: "https://mcp.linear.app/mcp" }]);
    expect(specs("https://example.com/sse")).toEqual([{ id: "example", url: "https://example.com/sse" }]);
    expect(specs("http://127.0.0.1:3000/mcp")[0]!.id).toBe("server");
  });

  it("adds a command, named after the package it runs, its leading assignments as environment", () => {
    expect(specs("npx -y @playwright/mcp@latest")).toEqual([{ id: "playwright", command: "npx", args: ["-y", "@playwright/mcp@latest"] }]);
    expect(specs("npx -y @modelcontextprotocol/server-everything")[0]!.id).toBe("everything");
    expect(specs("uvx mcp-server-git --repository '/tmp/my repo'")[0]).toEqual({
      id: "git",
      command: "uvx",
      args: ["mcp-server-git", "--repository", "/tmp/my repo"],
    });
    expect(specs("docker run -i --rm -e GITHUB_TOKEN ghcr.io/github/github-mcp-server:latest")[0]!.id).toBe("github");
    expect(specs("node servers/notes/index.js")[0]!.id).toBe("notes");
    const { servers } = parseMcpInput("GITHUB_TOKEN=ghp_123 LOG_LEVEL=debug npx -y @modelcontextprotocol/server-github");
    expect(servers[0]!.spec.env).toEqual({ GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG_LEVEL: "debug" });
    expect(servers[0]!.secrets).toEqual({ GITHUB_TOKEN: "ghp_123" });
  });

  it("moves credentials out by name or by look, arguments included", () => {
    const { servers } = parseMcpInput("PGPASSWORD=hunter2 npx -y @modelcontextprotocol/server-postgres postgres://me:hunter2@localhost/app");
    expect(servers[0]!.spec).toMatchObject({
      id: "postgres",
      env: { PGPASSWORD: "${PGPASSWORD}" },
      args: ["-y", "@modelcontextprotocol/server-postgres", "${POSTGRES_URL}"],
    });
    expect(servers[0]!.secrets).toEqual({ PGPASSWORD: "hunter2", POSTGRES_URL: "postgres://me:hunter2@localhost/app" });
    const oauth = parseMcpInput(JSON.stringify({ url: "https://x.example/mcp", oauth: { clientId: "c", clientSecret: "s3cret" } }), { name: "x" }).servers[0]!;
    expect(oauth.spec.oauth).toEqual({ clientId: "c", clientSecret: "${OAUTH_CLIENT_SECRET}" });
    expect(oauth.secrets).toEqual({ OAUTH_CLIENT_SECRET: "s3cret" });
  });

  it("reads a config as importMcpConfig does, and never takes an id in use", () => {
    expect(specs(`{ "mcpServers": { "github": { "url": "https://api.githubcopilot.com/mcp/" } } }`, ["github"])[0]!.id).toBe("github-2");
    expect(specs("https://mcp.linear.app/mcp", ["linear"])[0]!.id).toBe("linear-2");
    expect(parseMcpInput("  ")).toEqual({ servers: [], problems: [] });
    expect(parseMcpInput("htps://mcp.linear.app/mcp")).toEqual({ servers: [], problems: ['"htps://mcp.linear.app/mcp" is not an http or https URL'] });
    expect(parseMcpInput("https://mcp.linear.app/mcp", { name: "Linear Work" }).servers[0]!.spec).toMatchObject({ id: "linear-work", name: "Linear Work" });
  });

  it("keeps Lemma's own fields, and hidden values, so a server's config reads back as it was", () => {
    const { servers, problems } = parseMcpInput(
      JSON.stringify({
        url: "https://api.example.com/mcp",
        name: "Example",
        headers: { Authorization: MCP_HIDDEN, "X-Team": "core" },
        disabledTools: ["delete_everything"],
        toolTimeoutMs: 60000,
        startupTimeoutMs: 5000,
        enabled: false,
        oauth: { clientId: "lemma", scopes: ["read"], callbackPort: 8765 },
      }),
      { name: "example" },
    );
    expect(problems).toEqual([]);
    expect(servers).toEqual([
      {
        spec: {
          id: "example",
          name: "Example",
          url: "https://api.example.com/mcp",
          headers: { Authorization: MCP_HIDDEN, "X-Team": "core" },
          enabled: false,
          toolTimeoutMs: 60000,
          startupTimeoutMs: 5000,
          disabledTools: ["delete_everything"],
          oauth: { clientId: "lemma", scopes: ["read"], callbackPort: 8765 },
        },
        secrets: {},
        notes: [],
      },
    ]);
  });
});
