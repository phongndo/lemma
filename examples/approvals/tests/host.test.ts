import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { run as cli } from "@lemma/cli/src/cli.ts";
import { proxy, settled, startLemma } from "../../../scripts/e2e.ts";
import type { Lemma } from "../../../scripts/e2e.ts";

const execFileAsync = promisify(execFile);
const file = fileURLToPath(new URL("../approvals.ts", import.meta.url));
const cliMain = fileURLToPath(new URL("../../../apps/cli/src/main.ts", import.meta.url));

// The user's path: the file dropped into `<home>/plugins`, loaded by a real host, its question answered at the CLI.
describe("as a plugin file in a real host", () => {
  let started: Lemma;
  let home: string;
  const lemma = async (...argv: string[]) => {
    const { stdout } = await execFileAsync(process.execPath, ["--conditions=lemma-source", cliMain, ...argv], { env: { ...process.env, LEMMA_HOME: home } });
    return stdout;
  };

  beforeAll(async () => {
    started = await startLemma("lemma-approvals-", {
      prepare: async (home) => {
        await mkdir(join(home, "plugins"));
        await copyFile(file, join(home, "plugins", "approvals.ts"));
      },
    });
    home = started.home;
  }, 30_000);
  afterAll(() => started?.stop());
  // What went wrong in the host shows only in what it printed.
  beforeEach(({ onTestFailed }) => {
    onTestFailed(() => console.error(started?.output()));
  });

  test("loads, and a command runs or not as the user answers", async () => {
    const status = JSON.parse(await lemma("plugins", "--json"));
    expect(status.find((plugin: { id: string }) => plugin.id === "approvals")).toMatchObject({ source: "user", state: "active" });

    const session = (await lemma("session", "new", "--cwd", home)).trim();
    const allowed = await lemma("run", session, "check the shell", "--model", "mock/scripted", "--answer", "once");
    expect(allowed).toContain("hello from lemma");
    const denied = await lemma("run", session, "again", "--model", "mock/scripted", "--answer", "deny");
    expect(denied).toContain("Tool call denied: the user declined");
    // No terminal and nothing to answer with: the CLI does not attach, so nobody can approve and the call is denied.
    const unattended = await lemma("run", session, "once more", "--model", "mock/scripted");
    expect(unattended).toContain("Tool call denied: nobody could approve it");
    // Following the turn, it watches the host's events but answers no question, so it holds none.
    const followed = await lemma("run", session, "and once more", "--model", "mock/scripted", "--follow");
    expect(followed).toContain("Tool call denied: nobody could approve it");
  }, 60_000);

  test("a question answered elsewhere closes the terminal's prompt", async () => {
    const session = (await lemma("session", "new", "--cwd", home)).trim();
    let withdrawn = false;
    const asking = cli(["run", session, "check the shell", "--model", "mock/scripted"], {
      env: { LEMMA_HOME: home },
      cwd: home,
      out: () => {},
      write: () => {},
      err: () => {},
      // A terminal nobody types into: only withdrawing the prompt ends it.
      ask: (_question, _secret, signal) =>
        new Promise<string>((_, reject) =>
          signal?.addEventListener("abort", () => {
            withdrawn = true;
            reject(signal.reason);
          }),
        ),
    });
    const open = await settled(
      async () => JSON.parse(await lemma("questions", "--json")) as { id: string }[],
      (questions) => questions.length > 0,
    );
    await lemma("answer", open![0]!.id, "once");
    expect(await asking).toBe(0);
    expect(withdrawn).toBe(true);
  }, 60_000);

  test("an approval given while the connection is down goes through once it is back", async () => {
    const discovery = JSON.parse(await readFile(join(home, "transport.json"), "utf8")) as { url: string; token: string };
    const link = await proxy(Number(new URL(discovery.url).port));
    try {
      const session = (await lemma("session", "new", "--cwd", home)).trim();
      let reply: ((value: string) => void) | undefined;
      const said: string[] = [];
      let out = "";
      const running = cli(["run", session, "check the shell", "--model", "mock/scripted"], {
        env: { LEMMA_HOME: home, LEMMA_URL: `http://127.0.0.1:${link.port}`, LEMMA_TOKEN: discovery.token },
        cwd: home,
        out: (text) => {
          out += `${text}\n`;
        },
        err: (text) => void said.push(text),
        ask: () => new Promise<string>((resolve) => (reply = resolve)),
      });
      expect(await settled(async () => reply !== undefined || undefined)).toBe(true);
      link.cut();
      // Answered once the command knows it is cut off: the answer waits for the connection, well within the host's grace.
      expect(await settled(async () => said.some((line) => line.includes("lost the connection")) || undefined)).toBe(true);
      reply!("once");
      link.restore();
      expect(await running).toBe(0);
      expect(out).toContain("hello from lemma");
    } finally {
      await link.close();
    }
  }, 60_000);

  test("a command that only watches holds no approval: an unattended run is denied at once while one watches", async () => {
    const session = (await lemma("session", "new", "--cwd", home)).trim();
    const stop = new AbortController();
    const shown: string[][] = [[], []];
    const watching = (argv: string[], lines: string[]) =>
      cli(argv, { env: { LEMMA_HOME: home }, cwd: home, out: (text) => void lines.push(text), err: () => {}, interrupt: stop.signal });
    const watchers = [watching(["events"], shown[0]!), watching(["channels", "open", "agent.activity"], shown[1]!)];
    // Both are subscribed once each has printed its first line.
    expect(await settled(async () => shown.every((lines) => lines.length > 0) || undefined)).toBe(true);
    const denied = await lemma("run", session, "once more", "--model", "mock/scripted");
    expect(denied).toContain("Tool call denied: nobody could approve it");
    stop.abort();
    await Promise.all(watchers);
  }, 60_000);
});
