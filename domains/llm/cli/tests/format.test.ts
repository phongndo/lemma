import { describe, expect, test } from "vitest";
import type { ModelInfo } from "@lemma/llm";
import { formatModels, loginLines } from "../src/index.ts";

describe("a login's notices", () => {
  test("a sign-in's link prints alone on its line, so it copies whole; it names the page to open", () => {
    const url = "https://auth.test/oauth/authorize?client_id=app&state=s";
    const link = loginLines({ level: "info", kind: "sign-in", message: "Complete sign-in in your browser.", links: [{ url }] }, "OpenAI");
    expect(link.link).toBe(url);
    expect(link.lines).toEqual(["", "Sign in to OpenAI in your browser:", "", url, "", "Open it in any browser, on this machine or another.", ""]);
    // With no link to show, what it says.
    expect(loginLines({ level: "info", kind: "sign-in", message: "Waiting for the browser" }, "OpenAI")).toEqual({ lines: ["Waiting for the browser"] });
  });

  test("a device code prints alone on its line, before where to enter it", () => {
    const device = loginLines(
      { level: "info", kind: "device-code", message: "Enter code", code: "ABCD-1234", links: [{ url: "https://github.com/login/device" }] },
      "GitHub Copilot",
    );
    expect(device.link).toBe("https://github.com/login/device");
    expect(device.lines).toContain("First copy your one-time code: ABCD-1234");
    expect(device.lines).toContain("Then enter it at https://github.com/login/device");
    expect(loginLines({ level: "info", kind: "device-code", message: "Enter code" }, "GitHub Copilot")).toEqual({ lines: ["Enter code"] });
  });

  test("progress says itself; a documentation link is no sign-in, under what it explains; success and the end say nothing", () => {
    expect(loginLines({ level: "info", kind: "progress", message: "Enabling models..." }, "GitHub Copilot")).toEqual({ lines: ["Enabling models..."] });
    const docs = loginLines(
      { level: "info", message: "Bedrock supports AWS profiles.", links: [{ url: "https://docs.aws.test", label: "AWS profiles" }] },
      "Bedrock",
    );
    expect(docs).toEqual({ lines: ["Bedrock supports AWS profiles.", "AWS profiles: https://docs.aws.test"] });
    // The command's result says it, once.
    expect(loginLines({ level: "info", kind: "signed-in", message: "Logged in to Bedrock" }, "Bedrock")).toEqual({ lines: [] });
    expect(loginLines({ level: "info", kind: "ended", message: "Done" }, "Bedrock")).toEqual({ lines: [] });
  });
});

describe("formatModels", () => {
  const model: ModelInfo = {
    ref: "mock/scripted",
    provider: "mock",
    id: "scripted",
    name: "Scripted",
    api: "openai-completions",
    reasoning: true,
    thinkingLevels: ["low", "high"],
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 8_000,
    cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  };

  test("a row per model: its reference, context, thinking levels, input, and price", () => {
    const [header, row, free] = formatModels([
      model,
      { ...model, ref: "local/m", reasoning: false, input: ["text"], cost: { ...model.cost, input: 0, output: 0 } },
    ]).split("\n");
    expect(header).toMatch(/^model +name +context +thinking +input +\$\/M in\/out$/);
    expect(row).toMatch(/^mock\/scripted +Scripted +200k +low,high +text,image +3\/15$/);
    expect(free).toMatch(/^local\/m +Scripted +200k +no +text$/);
  });

  test("with none, says how to get some", () => {
    expect(formatModels([])).toContain("lemma login <provider>");
  });
});
