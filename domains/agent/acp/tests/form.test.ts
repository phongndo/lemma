import { describe, expect, it } from "vitest";
import { entryFrom, idFrom, joinCommand, splitCommand } from "../src/form.ts";

describe("the agent form", () => {
  it("splits a command line and joins it back", () => {
    expect(splitCommand(`npx -y "@scope/my agent" --acp`)).toEqual(["npx", "-y", "@scope/my agent", "--acp"]);
    expect(splitCommand(joinCommand(["a b", 'c"d', ""]))).toEqual(["a b", 'c"d', ""]);
  });

  it("makes an id from a name", () => {
    expect(idFrom("Claude Agent")).toBe("claude-agent");
    expect(idFrom("  Qwen Code!! ")).toBe("qwen-code");
  });

  it("writes over a preset only what differs from it, and keeps the entry's other settings", () => {
    const preset = { title: "Claude Code", command: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.90.0"] };
    const draft = { title: "Claude Code", command: joinCommand(preset.command), env: [{ name: "ANTHROPIC_API_KEY", value: "${KEY}" }], mcp: true };
    expect(entryFrom(draft, { enabled: false }, preset)).toEqual({ entry: { enabled: false, env: { ANTHROPIC_API_KEY: "${KEY}" } } });
    expect(entryFrom({ ...draft, title: "Claude", command: "claude-acp", mcp: false }, {}, preset)).toEqual({
      entry: { title: "Claude", command: "claude-acp", args: [], env: { ANTHROPIC_API_KEY: "${KEY}" }, mcp: false },
    });
    expect(entryFrom({ ...draft, command: " " })).toEqual({ error: "Give the command that starts the agent speaking ACP" });
  });

  it("takes an icon of its own: an https: address or an image as a data: URL", () => {
    const draft = { title: "Mine", command: "mine --acp", env: [], mcp: true };
    expect(entryFrom({ ...draft, icon: " data:image/png;base64,iVBOR " })).toMatchObject({ entry: { icon: "data:image/png;base64,iVBOR" } });
    expect(entryFrom({ ...draft, icon: "" }, { icon: "https://example.com/old.svg" })).toEqual({ entry: { title: "Mine", command: "mine", args: ["--acp"] } });
    expect(entryFrom({ ...draft, icon: "javascript:alert(1)" })).toEqual({ error: "The icon is an https: address or a data:image/ URL" });
  });
});
