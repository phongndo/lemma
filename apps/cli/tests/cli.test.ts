import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode, parseOffset, run } from "../src/cli.ts";
import { loginLines, toAnswer } from "../src/live.ts";
import { formatQuestions } from "../src/format.ts";
import { invoke } from "./invoke.ts";

describe("without a host", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "lemma-cli-"));
  });
  afterAll(() => rm(home, { recursive: true, force: true }));

  test("reports a missing host as unavailable", async () => {
    const result = await invoke(["status", "--json"], home);
    expect(result.code).toBe(ExitCode.unavailable);
    expect(JSON.parse(result.err).error.code).toBe("NoHost");
  });

  test("an interrupted command exits 130", async () => {
    const interrupt = new AbortController();
    interrupt.abort();
    const code = await run(["status"], { env: { LEMMA_HOME: home }, cwd: "/", out: () => {}, err: () => {}, interrupt: interrupt.signal });
    expect(code).toBe(ExitCode.interrupted);
  });

  test("rejects bad usage before connecting", async () => {
    for (const argv of [
      [],
      ["bogus"],
      ["status", "extra"],
      ["session", "show"],
      ["session", "list", "--all", "--cwd", "/x"],
      ["--nope"],
      ["inspect", "s", "--system"],
      ["inspect", "s", "--request", "1", "--system", "--diff"],
      ["inspect", "s", "--request", "1", "--records"],
      ["inspect", "s", "--request", "1", "--step", "2"],
      ["inspect", "s", "--sort", "bogus"],
      ["inspect", "s", "--range", "5"],
      ["run"],
      ["run", "s"],
      ["run", "s", "hi", "--thinking", "huge"],
      ["answer", "q"],
      ["login"],
      ["logout"],
      ["cancel"],
      ["workspace", "checkout"],
      ["workspace", "nope"],
      ["workspace", "files", "--limit", "0"],
      ["session", "title", "s"],
      ["session", "checkout", "s"],
      ["events", "x"],
      ["events", "--questions", "maybe"],
      ["plugins", "config"],
      ["plugins", "show"],
      ["plugins", "config", "agent", "maxSteps"],
      ["plugins", "config", "agent", "maxSteps", "5", "--unset"],
      ["ui", "bogus"],
      ["ui", "enable"],
      ["ui", "config", "theme"],
      ["ui", "config", "theme", "accent"],
      ["remote", "bogus"],
      ["remote", "clear", "x"],
      ["remote", "set"],
      ["remote", "set", "https://box.example.ts.net/lemma", "--token", "t"],
      ["remote", "set", "ftp://box.example.ts.net", "--token", "t"],
      ["remote", "set", "https://box.example.ts.net?token=t", "--token", "t"],
      ["remote", "set", "https://box.example.ts.net", "x", "--token", "t"],
      // No token, and no terminal to ask at.
      ["remote", "set", "https://box.example.ts.net"],
      ["token", "x"],
    ]) {
      expect((await invoke(argv, home)).code, argv.join(" ")).toBe(ExitCode.usage);
    }
    // LEMMA_URL names the host only together with its token.
    expect((await invoke(["status"], home, "/", { LEMMA_URL: "https://box.example.ts.net" })).code).toBe(ExitCode.usage);
    expect((await invoke(["remote"], home, "/", { LEMMA_URL: "box", LEMMA_TOKEN: "t" })).code).toBe(ExitCode.usage);
  });

  test("remote and token say there is no host, without one", async () => {
    expect(JSON.parse((await invoke(["remote", "--json"], home)).out)).toMatchObject({ source: "local", tokenSet: false });
    expect((await invoke(["remote"], home)).out).toContain("No remote host is set and no local host runs");
    const token = await invoke(["token", "--json"], home);
    expect(token.code).toBe(ExitCode.unavailable);
    expect(JSON.parse(token.err).error.code).toBe("NoHost");
  });

  test("prints help", async () => {
    const result = await invoke(["--help"], home);
    expect(result.code).toBe(ExitCode.ok);
    expect(result.out).toContain("session show <id>");
  });
});

describe("argument parsing", () => {
  test("offsets accept seconds, units, and combinations", () => {
    expect(parseOffset("90")).toBe(90_000);
    expect(parseOffset("1m30s")).toBe(90_000);
    expect(parseOffset("500ms")).toBe(500);
    expect(parseOffset("2h")).toBe(7_200_000);
    expect(parseOffset("soon")).toBeUndefined();
  });

  test("answers are checked against the question", () => {
    const select = {
      type: "select" as const,
      id: "q",
      title: "Pick",
      options: [
        { value: "api_key", label: "API key" },
        { value: "oauth", label: "Subscription" },
      ],
    };
    expect(toAnswer(select, "oauth")).toEqual({ type: "select", value: "oauth" });
    expect(toAnswer(select, "api key")).toEqual({ type: "select", value: "api_key" });
    expect(toAnswer(select, "2")).toEqual({ type: "select", value: "oauth" });
    expect(toAnswer(select, "other")).toContain("Choose one of");
    expect(toAnswer({ type: "confirm", id: "c", title: "Go?" }, "Yes")).toEqual({ type: "confirm", value: true });
    expect(toAnswer({ type: "confirm", id: "c", title: "Go?" }, "maybe")).toContain("yes or no");
    expect(toAnswer({ type: "ask", id: "a", title: "Key" }, " sk ")).toEqual({ type: "ask", value: " sk " });
  });

  test("a login's link and code print alone on their lines, so they copy whole; a documentation link is not a sign-in", () => {
    const url = "https://auth.test/oauth/authorize?client_id=app&state=s";
    const link = loginLines({ level: "info", kind: "sign-in", message: "Complete sign-in in your browser.", links: [{ url }] }, "OpenAI", false);
    expect(link.link).toBe(url);
    expect(link.lines).toContain(url);
    expect(link.lines).toContain("Open it in any browser, on this machine or another.");
    expect(loginLines({ level: "info", kind: "sign-in", message: "", links: [{ url }] }, "OpenAI", true).lines.join("\n")).toContain(
      "Opened it in your browser here",
    );

    const device = loginLines(
      { level: "info", kind: "device-code", message: "Enter code", code: "ABCD-1234", links: [{ url: "https://github.com/login/device" }] },
      "GitHub Copilot",
      true,
    );
    expect(device.lines).toContain("First copy your one-time code: ABCD-1234");
    expect(device.lines).toContain("Then enter it at https://github.com/login/device");
    expect(loginLines({ level: "info", kind: "progress", message: "Enabling models..." }, "GitHub Copilot", true)).toEqual({ lines: ["Enabling models..."] });

    const docs = loginLines(
      { level: "info", message: "Bedrock supports AWS profiles.", links: [{ url: "https://docs.aws.test", label: "AWS profiles" }] },
      "Bedrock",
      true,
    );
    expect(docs).toEqual({ lines: ["Bedrock supports AWS profiles.", "AWS profiles: https://docs.aws.test"] });
    // The command's result says it, once.
    expect(loginLines({ level: "info", kind: "signed-in", message: "Logged in to Bedrock" }, "Bedrock", true).lines).toEqual([]);
  });

  test("open questions show what they are about before their choices", () => {
    const approval = {
      type: "select" as const,
      id: "q1",
      title: "Run this command?",
      detail: "rm -rf build\nls",
      options: [
        { value: "once", label: "Allow once" },
        { value: "deny", label: "Deny" },
      ],
    };
    expect(formatQuestions([approval])).toBe("q1  select  Run this command?\n    rm -rf build\n    ls\n    1. once (Allow once)\n    2. deny (Deny)");
  });
});
