import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeServer, definitions, expand, exposureOf, MissingVariable, readServersFile, ruleOf, writeChange } from "../src/config.ts";
import type { ServersFile } from "../src/config.ts";
import { inputSchema, toContent, toolNames } from "../src/tools.ts";
import { Connection } from "../src/connection.ts";

const file = (entries: Record<string, unknown>): ServersFile => ({
  path: "/home/u/.lemma/mcp.json",
  entries: new Map(Object.entries(entries).map(([name, raw]) => [name, decodeServer(name, raw)])),
});

describe("an entry", () => {
  it("reads other clients' spellings", () => {
    expect(decodeServer("a", { command: "x", disabled: true, alwaysAllow: ["t"] })).toEqual({ config: { command: "x", enabled: false } });
    expect(decodeServer("a", { url: "https://x", exposure: "deferred", toolExposure: { t: "codemode-deferred" } })).toEqual({
      config: { url: "https://x", exposure: "codemode", toolExposure: { t: "codemode" } },
    });
  });

  it("says what is wrong with it", () => {
    expect(decodeServer("a b", { command: "x" })).toEqual({ error: '"a b" is not a server name: use letters, digits, _, and -' });
    expect(decodeServer("a", { command: "x", url: "https://x" })).toEqual({ error: "An entry has a command or a url, not both" });
    expect(decodeServer("a", { command: 1 })).toMatchObject({ error: expect.stringContaining("Invalid entry") });
  });
});

describe("the servers to run", () => {
  const plugin = { item: { name: "docs", url: "https://docs/mcp", exposure: "direct" as const }, pluginId: "docs-plugin" };

  it("lets the file's entry change only what an entry without a command or url may of a plugin's server", () => {
    const [docs] = definitions(file({ docs: { enabled: false, exposure: "codemode", headers: { A: "b" } } }), [plugin]);
    expect(docs).toEqual({
      name: "docs",
      source: { kind: "plugin", id: "docs-plugin", config: { url: "https://docs/mcp", exposure: "direct" } },
      config: { url: "https://docs/mcp", exposure: "codemode", enabled: false },
      file: { enabled: false, exposure: "codemode", headers: { A: "b" } },
    });
  });

  it("adds the file's exposures for a plugin's tools to the plugin's, its patterns first", () => {
    const guarded = { ...plugin, item: { ...plugin.item, toolExposure: { "delete_*": "hidden" as const, "*_repo": "codemode" as const } } };
    const [docs] = definitions(file({ docs: { toolExposure: { search: "direct", "*_repo": "direct" } } }), [guarded]);
    expect(Object.keys(docs!.config.toolExposure!)).toEqual(["search", "*_repo", "delete_*"]);
    expect(exposureOf(docs!.config, "delete_branch")).toBe("hidden");
    expect(exposureOf(docs!.config, "search")).toBe("direct");
    // The file's pattern wins over the plugin's for a tool both match.
    expect(exposureOf(docs!.config, "delete_repo")).toBe("direct");
  });

  it("lets the file's server win over a plugin's of its name", () => {
    const [docs] = definitions(file({ docs: { command: "local-docs" } }), [plugin]);
    expect(docs).toMatchObject({ source: { kind: "file" }, config: { command: "local-docs" } });
  });

  it("refuses an entry that changes no server, and a name whose tools another has", () => {
    const [first, second, lone] = definitions(file({ lone: { enabled: false }, a_b: { command: "y" }, "a-b": { command: "x" } }), []);
    expect(lone?.error).toContain("no plugin adds this one");
    expect([first?.name, first?.error]).toEqual(["a-b", undefined]);
    expect([second?.name, second?.error]).toEqual(["a_b", '"a_b" names the same tools as "a-b": rename one']);
  });
});

describe("a tool's exposure", () => {
  const config = { exposure: "direct" as const, toolExposure: { "get_*": "codemode" as const, get_secret: "hidden" as const, "*": "direct" as const } };
  it("is its own name's, then the first pattern's, then the server's", () => {
    expect(exposureOf(config, "get_secret")).toBe("hidden");
    expect(exposureOf(config, "get_item")).toBe("codemode");
    expect(exposureOf({ exposure: "direct" }, "anything")).toBe("direct");
    expect(exposureOf({}, "anything")).toBe("codemode");
    expect([ruleOf(config, "get_secret"), ruleOf(config, "get_item"), ruleOf({}, "get_item")]).toEqual(["get_secret", "get_*", undefined]);
  });
});

describe("a request's timeout", () => {
  it("is 60 seconds by default, and no longer than a timer can wait", () => {
    const timeout = (seconds?: number) =>
      new Connection({ command: "x", ...(seconds === undefined ? {} : { timeout: seconds }) }, { changed: () => {}, tools: () => {} }, "0").timeoutMs;
    expect(timeout()).toBe(60_000);
    // Past about 24 days a timer fires at once, failing every request.
    expect(timeout(99_999_999)).toBe(2 ** 31 - 1);
  });
});

describe("variables", () => {
  it("read the environment, with defaults, and ~/ in paths", () => {
    expect(expand("Bearer ${TOKEN}", { TOKEN: "t" })).toBe("Bearer t");
    expect(expand("${PORT:-8080}", {})).toBe("8080");
    expect(expand("~/bin/server", {}, true)).toBe(join(homedir(), "bin/server"));
    expect(() => expand("${NOPE}", {})).toThrow(MissingVariable);
  });
});

describe("writing a change", () => {
  it("keeps the rest of the file, and writes no default", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "lemma-mcp-config-")), "mcp.json");
    await writeFile(path, JSON.stringify({ other: 1, mcpServers: { a: { command: "x", disabled: true, exposure: "direct" } } }));
    await writeChange(path, "a", { enabled: true, exposure: "codemode", tools: { t: "hidden" } });
    await writeChange(path, "plugins-server", { enabled: false });
    await writeChange(path, "plugins-server", { enabled: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ other: 1, mcpServers: { a: { command: "x", toolExposure: { t: "hidden" } } } });
    expect((await readServersFile(path)).entries.get("a")).toEqual({ config: { command: "x", toolExposure: { t: "hidden" } } });
  });

  it("keeps the file's mode, and writes a new file 0644", async () => {
    const folder = await mkdtemp(join(tmpdir(), "lemma-mcp-config-"));
    const kept = join(folder, "kept.json");
    await writeFile(kept, "{}");
    await chmod(kept, 0o600);
    await writeChange(kept, "a", { enabled: false });
    expect((await lstat(kept)).mode & 0o777).toBe(0o600);
    const made = join(folder, "made.json");
    await writeChange(made, "a", { enabled: false });
    expect((await lstat(made)).mode & 0o777).toBe(0o644);
  });

  it("writes what differs from a plugin's server, which has the plugin's values without it", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "lemma-mcp-config-")), "mcp.json");
    const base = { url: "https://docs/mcp", enabled: false, exposure: "direct" as const };
    await writeChange(path, "docs", { enabled: true, exposure: "codemode" }, base);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcpServers: { docs: { enabled: true, exposure: "codemode" } } });
    // Back to the plugin's values: nothing is left to say.
    await writeChange(path, "docs", { enabled: false, exposure: "direct" }, base);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcpServers: {} });
  });

  it("writes through a link to the file it names, and says so when that cannot be written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lemma-mcp-config-"));
    await mkdir(join(dir, "store"));
    await mkdir(join(dir, "home"));
    await writeFile(join(dir, "store", "mcp.json"), JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    await symlink(join(dir, "store", "mcp.json"), join(dir, "home", "mcp.json"));
    await writeChange(join(dir, "home", "mcp.json"), "a", { enabled: false });
    expect((await lstat(join(dir, "home", "mcp.json"))).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "store", "mcp.json"), "utf8"))).toEqual({ mcpServers: { a: { command: "x", enabled: false } } });
    // As a link into the read-only Nix store is: root writes anyway, so this part is for everyone else.
    if (process.getuid?.() === 0) return;
    await chmod(join(dir, "store"), 0o555);
    try {
      await expect(writeChange(join(dir, "home", "mcp.json"), "a", { enabled: true })).rejects.toThrow(
        "which cannot be written: change it where it is managed",
      );
    } finally {
      await chmod(join(dir, "store"), 0o755);
    }
  });

  it("reads a missing file as no servers, and says what is wrong with a broken one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lemma-mcp-config-"));
    expect(await readServersFile(join(dir, "mcp.json"))).toEqual({ path: join(dir, "mcp.json"), entries: new Map() });
    await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: [] }));
    expect((await readServersFile(join(dir, "mcp.json"))).error).toBe('"mcpServers" is an object of servers by name');
  });
});

describe("a tool's input schema", () => {
  it("has its own references inlined, and an object at its root", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: { Point: { type: "object", properties: { x: { type: "number" } } }, Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } },
      properties: { at: { $ref: "#/$defs/Point", description: "Where" }, list: { $ref: "#/$defs/Node" } },
    };
    expect(inputSchema(schema)).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        at: { type: "object", properties: { x: { type: "number" } }, description: "Where" },
        list: { type: "object", properties: { next: {} } },
      },
    });
    expect(inputSchema(undefined)).toEqual({ type: "object", properties: {} });
  });

  it("keeps a parameter named definitions, and data that looks like a reference", () => {
    const schema = {
      type: "object",
      properties: { definitions: { type: "array", items: { type: "string" } }, mode: { enum: [{ $ref: "#/$defs/x" }], default: { definitions: 1 } } },
      required: ["definitions"],
    };
    expect(inputSchema(schema)).toEqual(schema);
  });
});

describe("a tool's name", () => {
  it("is mcp__<server>__<tool>, shortened with a hash when too long or shared", () => {
    const names = toolNames("my-server", ["get-item", "get_item", "x".repeat(80), "ok"]);
    expect(names.get("ok")).toBe("mcp__my_server__ok");
    expect(names.get("get-item")).toMatch(/^mcp__my_server__get_item_[0-9a-f]{8}$/);
    expect(names.get("get-item")).not.toBe(names.get("get_item"));
    expect(names.get("x".repeat(80))!.length).toBe(64);
  });

  it("stays apart for two servers whose long names begin alike", () => {
    const one = toolNames(`${"a".repeat(60)}x`, ["search"]).get("search");
    const other = toolNames(`${"a".repeat(60)}y`, ["search"]).get("search");
    expect(one).not.toBe(other);
  });
});

describe("a result's content", () => {
  it("keeps text and images, and says what else it had", () => {
    expect(
      toContent({
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "aGk=", mimeType: "image/png" },
          { type: "audio", data: "aGk=", mimeType: "audio/wav" },
          { type: "resource_link", uri: "file:///x", name: "x" },
          { type: "resource", resource: { uri: "file:///y", text: "y text" } },
          { type: "resource", resource: { uri: "file:///z", blob: "aGk=", mimeType: "application/zip" } },
        ],
      }),
    ).toEqual([
      { type: "text", text: "a" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
      { type: "text", text: "[Audio: audio/wav, 3 bytes]" },
      { type: "text", text: "[Resource x at file:///x]" },
      { type: "text", text: "y text" },
      { type: "text", text: "[Resource file:///z: application/zip, 3 bytes]" },
    ]);
    expect(toContent({ content: [], structuredContent: { n: 1 } })).toEqual([{ type: "text", text: '{"n":1}' }]);
  });
});
