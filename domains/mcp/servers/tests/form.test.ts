import { describe, expect, it } from "vitest";
import { draftOf, entryOf, isImageAddress, joinCommand, parsePasted, splitCommand } from "../src/form.ts";

describe("the server form", () => {
  it("splits a command line into words, quotes and escapes kept together, and joins them back", () => {
    expect(splitCommand(`npx -y @modelcontextprotocol/server-filesystem "/my docs" 'it''s' a\\ b ""`)).toEqual([
      "npx",
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/my docs",
      "its",
      "a b",
      "",
    ]);
    const words = ["node", "server.js", "/my docs", 'say "hi"', ""];
    expect(splitCommand(joinCommand(words))).toEqual(words);
  });

  it("makes an entry from what was typed, keeping the settings of the entry it edits", () => {
    const base = { command: "old", args: ["x"], enabled: false, exposure: "direct" as const, toolExposure: { "*": "hidden" as const }, cwd: "/w" };
    const draft = {
      ...draftOf("files", base),
      command: 'npx -y server "/a b"',
      env: [
        { name: "TOKEN", value: "${TOKEN}" },
        { name: " ", value: "dropped" },
      ],
    };
    expect(entryOf(draft, base)).toEqual({
      entry: {
        enabled: false,
        exposure: "direct",
        toolExposure: { "*": "hidden" },
        command: "npx",
        args: ["-y", "server", "/a b"],
        env: { TOKEN: "${TOKEN}" },
        cwd: "/w",
      },
    });
    expect(entryOf({ ...draft, transport: "http", url: "https://example.com/mcp", headers: [{ name: "Authorization", value: "Bearer x" }] })).toEqual({
      entry: { url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } },
    });
    expect(entryOf({ ...draft, name: "no spaces" })).toEqual({ error: "A name is letters, digits, _, and -" });
    expect(entryOf({ ...draft, command: "  " })).toEqual({ error: "Give the command that starts the server" });
    expect(entryOf({ ...draft, transport: "http", url: "example.com" })).toMatchObject({ error: expect.stringContaining("http://") });
    expect(entryOf({ ...draft, icon: " https://example.com/icon.svg " })).toMatchObject({ entry: { icon: "https://example.com/icon.svg" } });
    expect(entryOf({ ...draftOf("files", { ...base, icon: "https://example.com/old.svg" }), command: "x", icon: "" })).not.toMatchObject({
      entry: { icon: expect.anything() },
    });
    expect(entryOf({ ...draft, icon: "http://example.com/icon.png" })).toEqual({ error: "The icon is an https: address or a data:image/ URL" });
  });

  it("reads servers pasted from another client: a whole config, servers by name, a fragment, or one server", () => {
    const github = { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] };
    expect(parsePasted(JSON.stringify({ mcpServers: { github, other: { note: "no command" } } }))).toEqual({ servers: [{ name: "github", entry: github }] });
    expect(parsePasted(JSON.stringify({ servers: { docs: { type: "http", url: "https://x/mcp" } } }))).toEqual({
      servers: [{ name: "docs", entry: { type: "http", url: "https://x/mcp" } }],
    });
    expect(parsePasted(`"github": ${JSON.stringify(github)},`)).toEqual({ servers: [{ name: "github", entry: github }] });
    expect(parsePasted(JSON.stringify(github), "gh")).toEqual({ servers: [{ name: "gh", entry: github }] });
    expect(parsePasted(JSON.stringify(github))).toEqual({ error: "This is one server: give it a name" });
    expect(parsePasted("{ nope")).toMatchObject({ error: expect.stringMatching(/^Not JSON/) });
    // Another client's `disabled`, in this plugin's terms, so the server stays off.
    expect(parsePasted(JSON.stringify({ mcpServers: { off: { command: "srv", disabled: true } } }))).toEqual({
      servers: [{ name: "off", entry: { command: "srv", enabled: false } }],
    });
  });

  it("takes an SVG file of the user's as its icon, written into the entry as an image's address", () => {
    // As `svgSource` (`@lemma/look`) writes one.
    const icon = `data:image/svg+xml;base64,${Buffer.from('<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>').toString("base64")}`;
    expect(isImageAddress(icon)).toBe(true);
    expect(entryOf({ ...draftOf("files", undefined), command: "x", icon })).toMatchObject({ entry: { icon } });
  });
});
