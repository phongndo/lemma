import { describe, expect, test } from "vitest";
import type { PromptCommandShape } from "@lemma/threads";
import { commandTurn } from "../src/command.ts";

const run = () => undefined;
const commands: (PromptCommandShape & { readonly id: string })[] = [
  { id: "new", description: "New chat", aliases: ["clear"], run },
  { id: "rename", description: "Rename", args: [{ name: "title", rest: true }], run },
  { id: "mcp", description: "MCP", subcommands: [{ name: "reconnect", description: "Reconnect", args: [{ name: "server" }], run }] },
  // Runs nothing here: the host answers it.
  { id: "compact", description: "Compact", args: [{ name: "focus", optional: true, rest: true }] },
];

describe("commandTurn", () => {
  test("a prompt that is no command, or one the host answers, is sent as typed", () => {
    expect(commandTurn("hello /new", commands, 0)).toEqual({ kind: "send" });
    expect(commandTurn("/nothing here", commands, 0)).toEqual({ kind: "send" });
    expect(commandTurn("/compact keep the tests", commands, 0)).toEqual({ kind: "send" });
  });

  test("a command that runs here runs, by its name or an alias, with its arguments and the text after its path", () => {
    expect(commandTurn("/clear", commands, 0)).toMatchObject({ kind: "run", name: "/new" });
    expect(commandTurn("/mcp reconnect github", commands, 0)).toMatchObject({
      kind: "run",
      name: "/mcp reconnect",
      command: { args: ["github"], text: "github" },
    });
    expect(commandTurn("/rename A new title", commands, 0)).toMatchObject({ kind: "run", command: { text: "A new title" } });
  });

  test("one missing what it needs, given a word it does not take, or given images, says why instead", () => {
    expect(commandTurn("/mcp reconnect", commands, 0)).toEqual({ kind: "refuse", problem: "/mcp reconnect needs <server>" });
    expect(commandTurn("/new now", commands, 0)).toEqual({ kind: "refuse", problem: "/new takes nothing after it, not “now”" });
    expect(commandTurn("/new", commands, 1)).toEqual({ kind: "refuse", problem: "/new runs here, and takes no images: remove them first" });
  });
});
