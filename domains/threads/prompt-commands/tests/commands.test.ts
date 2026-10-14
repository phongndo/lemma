import { describe, expect, it } from "vitest";
import type { CommandNode, ComposerCompletionAnswer, ComposerSuggestion } from "@lemma/threads";
import { commandSuggestions } from "../src/commands.ts";

const run = () => {};
const commands: readonly CommandNode[] = [
  { name: "new", aliases: ["clear"], description: "Start a new thread", run },
  { name: "compact", description: "Summarize", args: [{ name: "focus", optional: true, rest: true }] },
  {
    name: "thinking",
    description: "Reasoning",
    args: [{ name: "level", values: () => ["off", "low", "high"].map((value) => ({ value, ...(value === "low" ? { detail: "current" } : {}) })) }],
    run,
  },
  {
    name: "model",
    description: "Model",
    args: [{ name: "model", ranked: true, values: ({ query }) => ["b/gpt-4", "a/gpt-4o"].filter((ref) => ref.includes(query)).map((value) => ({ value })) }],
    run,
  },
  { name: "settings", description: "Settings", args: [{ name: "section", optional: true, rest: true, values: () => [{ value: "general" }] }], run },
  {
    name: "mcp",
    description: "Servers",
    subcommands: [
      { name: "list", aliases: ["ls"], description: "Each server", run },
      { name: "reconnect", description: "Connect again", args: [{ name: "server", values: () => [{ value: "github" }, { value: "my server" }] }], run },
      {
        name: "tool",
        description: "One tool",
        args: [
          { name: "server", values: () => [{ value: "github" }] },
          { name: "tool", values: ({ args, path }) => [{ value: `${path.join(".")}:${args[0]}:create` }] },
          { name: "exposure", values: () => [{ value: "hidden" }, { value: "direct" }] },
        ],
        run,
      },
    ],
  },
];

const suggest = (query: string) => commandSuggestions(commands, query, new AbortController().signal);
const rows = (answer: ComposerCompletionAnswer): readonly ComposerSuggestion[] => ("suggestions" in answer ? answer.suggestions : answer);
const hintOf = (answer: ComposerCompletionAnswer) => ("suggestions" in answer ? answer.hint : undefined);

describe("the / menu", () => {
  it("offers every command for a bare /, each hinting at what it takes", async () => {
    const all = rows(await suggest(""));
    expect(all.map((row) => row.label)).toEqual(["/new", "/compact", "/thinking", "/model", "/settings", "/mcp"]);
    expect(all.map((row) => row.hint)).toEqual([undefined, "[focus]", "<level>", "<model>", "[section]", "<list|reconnect|tool>"]);
    expect(all.map((row) => row.submit)).toEqual([true, true, false, false, true, false]);
  });

  it("finds a command by an alias, saying what it is", async () => {
    expect(rows(await suggest("cle"))).toEqual([
      expect.objectContaining({ label: "/clear", insert: "/clear", detail: "/new · Start a new thread", submit: true }),
    ]);
  });

  it("offers a command's subcommands, with their usage, and narrows them by name or alias", async () => {
    const answer = await suggest("mcp ");
    expect(rows(answer).map((row) => [row.label, row.hint, row.submit])).toEqual([
      ["list", undefined, true],
      ["reconnect", "<server>", false],
      ["tool", "<server> <tool> <exposure>", false],
    ]);
    expect(hintOf(answer)).toBe("<list|reconnect|tool>");
    expect(rows(await suggest("mcp rec"))).toEqual([expect.objectContaining({ insert: "/mcp reconnect", hint: "<server>" })]);
    expect(rows(await suggest("mcp ls"))).toEqual([expect.objectContaining({ label: "ls", detail: "list · Each server" })]);
  });

  it("chains a subcommand's arguments, each asked with its path and the ones before, hinting at what is left", async () => {
    expect(rows(await suggest("mcp tool "))).toEqual([expect.objectContaining({ insert: "/mcp tool github", hint: "<tool> <exposure>", submit: false })]);
    expect(rows(await suggest("mcp tool github "))).toEqual([
      expect.objectContaining({ insert: "/mcp tool github mcp.tool:github:create", hint: "<exposure>" }),
    ]);
    expect(rows(await suggest("mcp tool github x h"))).toEqual([
      expect.objectContaining({ insert: "/mcp tool github x hidden", hint: undefined, submit: true }),
    ]);
  });

  it("goes on through an alias typed earlier", async () => {
    expect(rows(await suggest("mcp ls "))).toEqual([]);
    expect(rows(await suggest("thinking h"))).toEqual([expect.objectContaining({ insert: "/thinking high", submit: true, matches: [0] })]);
  });

  it("hints where it has nothing to offer, and says when no value matches", async () => {
    expect(await suggest("compact ")).toEqual({ suggestions: [], hint: "[focus]" });
    expect(await suggest("compact keep the api")).toEqual({ suggestions: [], hint: undefined });
    expect(await suggest("thinking zz")).toEqual({ suggestions: [], note: "No level matches “zz”" });
    expect(await suggest("usr/bin/env node")).toEqual([]);
  });

  it("writes a value with spaces quoted, and completes inside an open quote", async () => {
    expect(rows(await suggest("mcp reconnect my"))).toEqual([expect.objectContaining({ insert: '/mcp reconnect "my server"' })]);
    expect(rows(await suggest('mcp reconnect "my s'))).toEqual([expect.objectContaining({ insert: '/mcp reconnect "my server"' })]);
    expect(rows(await suggest('mcp reconnect "my server" '))).toEqual([]);
  });

  it("keeps a ranked argument's values in the command's own order, given what is typed", async () => {
    expect(rows(await suggest("model gpt-4")).map((row) => row.label)).toEqual(["b/gpt-4", "a/gpt-4o"]);
  });

  it("offers a rest argument's values for its first word, and nothing past it", async () => {
    expect(rows(await suggest("settings ")).map((row) => row.label)).toEqual(["general"]);
    expect(rows(await suggest("settings archived threads"))).toEqual([]);
  });
});
