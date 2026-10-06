import { execFile } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { run as cli } from "@lemma/cli/src/cli.ts";
import { settled, startLemma } from "../../../scripts/e2e.ts";
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
});
