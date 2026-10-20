import { describe, expect, it, test } from "vitest";
import type { ModelInfo } from "@lemma/llm";
import { formatModels, signInPrinter, stepLines } from "../src/index.ts";
import type { SignIn } from "@lemma/llm";

describe("a sign-in's steps", () => {
  test("a sign-in's link prints alone on its line, so it copies whole, and a paste is asked of a browser elsewhere", () => {
    const url = "https://auth.test/oauth/authorize?client_id=app&state=s";
    const page = stepLines({ type: "browser", url }, "OpenAI");
    expect(page).toEqual({
      link: url,
      lines: ["", "Sign in to OpenAI in your browser:", "", url, "", "Open it in any browser, on this machine or another.", ""],
    });
    expect(stepLines({ type: "browser", url, paste: { placeholder: "http://127.0.0.1:1455/cb" } }, "OpenAI").ask).toEqual({
      type: "text",
      title: "If the browser cannot reach this machine, paste the address it ended on",
      placeholder: "http://127.0.0.1:1455/cb",
    });
  });

  test("a device code prints alone on its line, before where to enter it", () => {
    const device = stepLines({ type: "code", code: "ABCD-1234", url: "https://github.com/login/device" }, "GitHub Copilot");
    expect(device.link).toBe("https://github.com/login/device");
    expect(device.lines).toContain("First copy your one-time code: ABCD-1234");
    expect(device.lines).toContain("Then enter it at https://github.com/login/device");
  });

  test("a key is asked masked, after why the last was refused; progress says itself", () => {
    expect(stepLines({ type: "key", label: "Anthropic API key", problem: "Anthropic refused this key (401)" }, "Anthropic")).toEqual({
      lines: ["Anthropic refused this key (401)"],
      ask: { type: "text", title: "Paste your Anthropic API key", secret: true },
    });
    expect(stepLines({ type: "working", message: "Enabling models" }, "GitHub Copilot")).toEqual({ lines: ["Enabling models…"] });
    expect(stepLines({ type: "choice", title: "Sign in to Radius", options: [{ value: "browser", label: "Browser" }] }, "Radius").ask).toEqual({
      type: "choice",
      title: "Sign in to Radius",
      options: [{ value: "browser", label: "Browser" }],
    });
  });
});

describe("following a sign-in at the terminal", () => {
  const signIn = (seq: number, step: SignIn["step"], fields: Partial<SignIn> = {}): SignIn => ({
    provider: "openai",
    method: "oauth",
    seq,
    step,
    startedAt: 0,
    ...fields,
  });
  const url = "https://auth.test/authorize";

  it("opens the page from the step that takes a paste when the plain one went by unseen, and never again once the paste goes", () => {
    const next = signInPrinter("OpenAI");
    // The plain browser step was replaced before this client heard of it.
    const paste = next(signIn(3, { type: "browser", url, paste: { placeholder: "http://127.0.0.1:1455/cb" } }));
    expect(paste).toMatchObject({ fresh: true, open: { url }, ask: { type: "text" } });
    expect(paste?.lines).toContain(url);
    // Withdrawn, the page shows again under a new number: nothing to print or open.
    expect(next(signIn(4, { type: "browser", url }))).toEqual({ fresh: true, lines: [] });
    expect(next(signIn(5, { type: "working", message: "Finishing sign-in" }))).toEqual({ fresh: true, lines: ["Finishing sign-in…"] });
    // The same list heard again: nothing new.
    expect(next(signIn(5, { type: "working", message: "Finishing sign-in" }))).toBeUndefined();
  });

  it("prints progress when it changes, a refused key's reason with its question again, and documentation once", () => {
    const next = signInPrinter("Anthropic");
    const info = { message: "Keys live in the console", links: [{ url: "https://console.test/keys", label: "Keys" }] };
    expect(next(signIn(1, { type: "key", label: "Anthropic API key" }, { info }))).toMatchObject({
      lines: ["Keys live in the console", "Keys: https://console.test/keys"],
      ask: { type: "text", secret: true },
    });
    expect(next(signIn(2, { type: "working", message: "Checking the key" }, { info }))?.lines).toEqual(["Checking the key…"]);
    expect(next(signIn(3, { type: "key", label: "Anthropic API key", problem: "Anthropic refused this key (401)" }, { info }))).toMatchObject({
      lines: ["Anthropic refused this key (401)"],
      ask: { type: "text" },
    });
    expect(next(signIn(4, { type: "working", message: "Checking the key" }, { info }))?.lines).toEqual(["Checking the key…"]);
  });

  it("opens a device code's page after Enter, once", () => {
    const next = signInPrinter("GitHub Copilot");
    expect(next(signIn(1, { type: "code", code: "ABCD-1234", url: "https://github.com/login/device" }))?.open).toEqual({
      url: "https://github.com/login/device",
      prompt: "Press Enter to open github.com in your browser… ",
    });
    expect(next(signIn(2, { type: "code", code: "ABCD-1234", url: "https://github.com/login/device" }))).toEqual({ fresh: true, lines: [] });
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
