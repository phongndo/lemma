import { describe, expect, it } from "vitest";
import {
  commandInvocation,
  commandProblem,
  commandUsage,
  commandWord,
  commandWords,
  complete,
  missingArgument,
  resolveCommand,
  runsHere,
} from "../src/commands.ts";
import type { CommandNode } from "../src/commands.ts";

const run = () => {};
const mcp: CommandNode = {
  name: "mcp",
  description: "Servers",
  subcommands: [
    { name: "list", aliases: ["ls"], description: "List", run },
    { name: "reconnect", description: "Reconnect", args: [{ name: "server" }], run },
    { name: "tool", description: "One tool", args: [{ name: "server" }, { name: "tool" }, { name: "exposure" }], run },
  ],
};
const commands: readonly CommandNode[] = [
  mcp,
  { name: "new", aliases: ["clear"], description: "New", run },
  { name: "compact", description: "Summarize", args: [{ name: "focus", optional: true, rest: true }] },
  { name: "tag", description: "Tags", args: [{ name: "tags", repeats: true }], run },
];

describe("resolveCommand", () => {
  it("follows the words down the subcommands, by name or alias, and keeps the rest as arguments", () => {
    expect(resolveCommand(commands, ["mcp", "tool", "github", "x"])).toMatchObject({ path: ["mcp", "tool"], named: 2, args: ["github", "x"] });
    expect(resolveCommand(commands, ["mcp", "ls"])).toMatchObject({ path: ["mcp", "list"], args: [] });
    expect(resolveCommand(commands, ["clear"])).toMatchObject({ path: ["new"] });
    expect(resolveCommand(commands, ["mcp", "nope"])).toMatchObject({ path: ["mcp"], args: ["nope"] });
    expect(resolveCommand(commands, ["usr/bin"])).toBeUndefined();
  });
});

describe("commandUsage", () => {
  it("is the subcommands to choose before any argument, then what is left of the arguments", () => {
    expect(commandUsage(mcp)).toBe("<list|reconnect|tool>");
    const tool = mcp.subcommands![2]!;
    expect(commandUsage(tool)).toBe("<server> <tool> <exposure>");
    expect(commandUsage(tool, 2)).toBe("<exposure>");
    expect(commandUsage(tool, 3)).toBe("");
    expect(commandUsage(commands[2]!)).toBe("[focus]");
    expect(commandUsage(commands[3]!, 5)).toBe("<tags...>");
  });
});

describe("what a command needs", () => {
  it("says which argument is missing, and whether sending it as it is would run it", () => {
    const reconnect = mcp.subcommands![1]!;
    expect(missingArgument(reconnect, 0)?.name).toBe("server");
    expect(missingArgument(reconnect, 1)).toBeUndefined();
    expect(complete(mcp, mcp, 0)).toBe(false);
    expect(complete(mcp, reconnect, 1)).toBe(true);
    // The host's: nothing in it runs here, so it goes as typed.
    expect(runsHere(commands[2]!)).toBe(false);
    expect(complete(commands[2]!, commands[2]!, 0)).toBe(true);
  });
});

describe("commandInvocation", () => {
  it("reads a prompt that is a command: what it names, and the text after its path", () => {
    expect(commandInvocation("  /mcp tool github create_issue hidden ", commands)).toMatchObject({
      path: ["mcp", "tool"],
      args: ["github", "create_issue", "hidden"],
      text: "github create_issue hidden",
    });
    expect(commandInvocation("/compact keep the\nAPI", commands)).toMatchObject({ path: ["compact"], text: "keep the\nAPI" });
    expect(commandInvocation("/ new", commands)).toBeUndefined();
    expect(commandInvocation("see /new", commands)).toBeUndefined();
    expect(commandInvocation("/usr/bin/env node", commands)).toBeUndefined();
  });
});

describe("commandWords", () => {
  it("splits on spaces, holds a quoted word's spaces, and leaves an unclosed quote open to the end", () => {
    expect(commandWords('mcp  reconnect "my server" x')).toEqual([
      { text: "mcp", start: 0, end: 3, open: false },
      { text: "reconnect", start: 5, end: 14, open: false },
      { text: "my server", start: 15, end: 26, open: false },
      { text: "x", start: 27, end: 28, open: false },
    ]);
    expect(commandWords('a "say \\"hi\\"" "my s')).toEqual([
      { text: "a", start: 0, end: 1, open: false },
      { text: 'say "hi"', start: 2, end: 14, open: false },
      { text: "my s", start: 15, end: 20, open: true },
    ]);
  });

  it("writes a word with spaces or quotes quoted, so it reads back the same", () => {
    expect(commandWord("github")).toBe("github");
    expect(commandWord("my server")).toBe('"my server"');
    expect(commandWords(commandWord('say "hi"'))[0]!.text).toBe('say "hi"');
  });
});

describe("commandProblem", () => {
  const problem = (prompt: string) => commandProblem(commandInvocation(prompt, commands)!);

  it("refuses words a command does not take, rather than dropping them", () => {
    expect(problem("/new fix the login bug")).toBe("/new takes nothing after it, not “fix”");
    expect(problem("/mcp nope")).toBe("/mcp has no subcommand “nope”: <list|reconnect|tool>");
    expect(problem("/mcp reconnect github extra")).toBe("/mcp reconnect takes <server>, not “extra” too");
  });

  it("says what is missing, and nothing for a command that can run", () => {
    expect(problem("/mcp")).toBe("/mcp needs <list|reconnect|tool>");
    expect(problem("/mcp reconnect")).toBe("/mcp reconnect needs <server>");
    expect(problem('/mcp reconnect "my server"')).toBeUndefined();
    expect(problem("/tag a b c")).toBeUndefined();
  });
});
