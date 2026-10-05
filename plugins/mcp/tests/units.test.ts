import { describe, expect, it } from "vitest";
import { MCP_HIDDEN } from "@lemma/contracts";
import { toContent, toToolResult } from "../src/content.ts";
import { MAX_TOOL_NAME, toolNames } from "../src/names.ts";
import { inheritedEnvironment, launchOf, masked, unmasked } from "../src/resolve.ts";
import { inputParameters } from "../src/schema.ts";

describe("toolNames", () => {
  it("prefixes the server and keeps names a provider and a script accept", () => {
    const names = toolNames("my-server", ["search", "get.issue", "get_issue"]);
    expect(names.get("search")).toBe("mcp__my_server__search");
    // `get.issue` and `get_issue` read the same once sanitized: the second in name order gets a hash.
    expect(names.get("get.issue")).toBe("mcp__my_server__get_issue");
    expect(names.get("get_issue")).toMatch(/^mcp__my_server__get_issue_[0-9a-f]{6}$/);
    const reordered = toolNames("my-server", ["get_issue", "search", "get.issue"]);
    expect([...reordered.entries()].sort()).toEqual([...names.entries()].sort());
  });

  it("cuts long names to the limit with a stable hash", () => {
    const long = "a_really_long_tool_name_that_goes_on_and_on_and_on_and_on_and_on";
    const name = toolNames("server", [long]).get(long)!;
    expect(name.length).toBe(MAX_TOOL_NAME);
    expect(name).toMatch(/^mcp__server__a_really_long.*_[0-9a-f]{6}$/);
    expect(toolNames("server", [long]).get(long)).toBe(name);
  });
});

describe("inputParameters", () => {
  it("inlines local refs, drops ids and definitions, and keeps data as written", () => {
    expect(
      inputParameters({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { title: { $ref: "#/$defs/Title" }, node: { $ref: "#/$defs/Node" }, kind: { enum: ["$id", "b"], default: { $id: 1 } } },
        $defs: { Title: { type: "string", title: "Title" }, Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } },
      }),
    ).toEqual({
      type: "object",
      properties: {
        title: { type: "string", title: "Title" },
        node: { type: "object", properties: { child: {} } },
        kind: { enum: ["$id", "b"], default: { $id: 1 } },
      },
    });
  });

  it("makes an object schema with properties of whatever the server sent", () => {
    expect(inputParameters(undefined)).toEqual({ type: "object", properties: {} });
    expect(inputParameters({ type: "object" })).toEqual({ type: "object", properties: {} });
  });
});

describe("content", () => {
  it("passes text and images, and describes what a model cannot take", () => {
    expect(toContent({ type: "audio", data: "AAAA", mimeType: "audio/wav" })).toEqual({
      type: "text",
      text: "[Audio: audio/wav, 3 B, not shown: the model does not take audio]",
    });
    expect(toContent({ type: "image", data: "AAAA", mimeType: "image/svg+xml" })).toMatchObject({ type: "text" });
    expect(toContent({ type: "resource_link", uri: "file:///a.txt", name: "a.txt", description: "A file" })).toEqual({
      type: "text",
      text: "[Resource file:///a.txt] a.txt: A file",
    });
    expect(toContent({ type: "resource", resource: { uri: "x://y", blob: "AAAA", mimeType: "application/zip" } })).toEqual({
      type: "text",
      text: "[Resource x://y (application/zip)] binary, 3 B, not shown",
    });
  });

  it("sends structured output as JSON only when there is nothing else", () => {
    expect(toToolResult({ content: [], structuredContent: { a: 1 } }, { server: "s", tool: "t" }).content).toEqual([{ type: "text", text: '{\n  "a": 1\n}' }]);
    expect(toToolResult({ content: [], isError: true }, { server: "s", tool: "t" })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "The tool failed without saying why." }],
    });
  });
});

describe("launchOf", () => {
  it("reads secrets before the environment, and says what is unset", () => {
    const spec = { id: "x", command: "~/bin/server", args: ["--token", "${TOKEN}", "${MODE:-fast}"], env: { HOME_DIR: "${HOME_DIR}" }, cwd: "sub" };
    const resolved = launchOf(spec, { secrets: { TOKEN: "secret" }, cwd: "/work", env: { HOME_DIR: "/h", TOKEN: "env" } });
    expect(resolved.launch).toMatchObject({ type: "stdio", args: ["--token", "secret", "fast"], env: { HOME_DIR: "/h" }, cwd: "/work/sub" });
    expect(resolved.launch?.type === "stdio" && resolved.launch.command.endsWith("/bin/server")).toBe(true);
    const missing = launchOf(spec, { secrets: {}, cwd: "/work", env: {} });
    expect(missing).toMatchObject({ missing: ["TOKEN", "HOME_DIR"] });
    expect(missing.problem).toContain("TOKEN, HOME_DIR are not set");
  });

  it("takes http(s) URLs, falling back to SSE only when the type was not written", () => {
    expect(launchOf({ id: "x", url: "https://a.example/mcp" }, { secrets: {}, cwd: "/" }).launch).toEqual({
      type: "http",
      url: "https://a.example/mcp",
      headers: {},
      fallback: true,
    });
    expect(launchOf({ id: "x", type: "http", url: "https://a.example/mcp" }, { secrets: {}, cwd: "/" }).launch).toMatchObject({ fallback: false });
    expect(launchOf({ id: "x", url: "ftp://a" }, { secrets: {}, cwd: "/" }).problem).toBe('"ftp://a" is not an http or https URL');
  });

  it("leaves credential-like names out of the inherited environment", () => {
    expect(inheritedEnvironment({ PATH: "/bin", OPENAI_API_KEY: "k", GITHUB_TOKEN: "t", HTTPS_PROXY: "p", SSH_AUTH_SOCK: "/s" })).toEqual({
      PATH: "/bin",
      HTTPS_PROXY: "p",
      SSH_AUTH_SOCK: "/s",
    });
  });
});

describe("masked and unmasked", () => {
  const spec = { id: "x", url: "https://a", headers: { Authorization: "Bearer ${TOKEN}", "X-Api-Key": "raw", Accept: "json" }, oauth: { clientSecret: "shh" } };

  it("hides credential-like literals, not references", () => {
    expect(masked(spec)).toEqual({
      ...spec,
      headers: { Authorization: "Bearer ${TOKEN}", "X-Api-Key": MCP_HIDDEN, Accept: "json" },
      oauth: { clientSecret: MCP_HIDDEN },
    });
    const db = { id: "db", command: "pg", env: { DATABASE_URL: "postgres://me:hunter2@db/app", PGPASSWORD: "hunter2", PGHOST: "db" } };
    expect(masked(db).env).toEqual({ DATABASE_URL: MCP_HIDDEN, PGPASSWORD: MCP_HIDDEN, PGHOST: "db" });
    expect(unmasked(masked(db), db)).toEqual(db);
  });

  it("puts hidden values back from the saved spec", () => {
    expect(unmasked(masked(spec), spec)).toEqual(spec);
    expect(unmasked({ id: "x", url: "https://a", headers: { "X-New": MCP_HIDDEN } }, spec)).toBe("X-New is hidden but not in the saved config: send the value");
  });
});
