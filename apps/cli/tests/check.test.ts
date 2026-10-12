import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { invoke } from "./invoke.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/check/${name}`, import.meta.url));
const cliMain = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** The pid of the spawner fixture's child, if it runs. */
const spawned = () =>
  promisify(execFile)("pgrep", ["-f", "^sleep 4329$"]).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  );
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("lemma plugins check", () => {
  // The home commands would otherwise go to: the check uses a home of its own, and leaves this one alone.
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "lemma-cli-check-"));
  });
  afterAll(() => rm(home, { recursive: true, force: true }));

  test("reports a plugin that works as active, with what it takes part in", async () => {
    const { code, out } = await invoke(["plugins", "check", fixture("good"), "--json"], home);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({
      plugins: [{ id: "good", state: "active", hooks: ["lemma/agent.request"], warnings: [] }],
      problems: [],
    });
    const text = await invoke(["plugins", "check", fixture("good")], home);
    expect(text.out).toBe("good: active\n  handles lemma/agent.request\nno problems found");
  }, 60_000);

  test("reports a plugin that fails to start with its fault, and fails", async () => {
    const { code, out } = await invoke(["plugins", "check", fixture("broken.js"), "--json"], home);
    expect(code).toBe(1);
    const report = JSON.parse(out);
    expect(report.plugins).toMatchObject([{ id: "broken", state: "failed", fault: expect.stringContaining("cannot start: no settings") }]);
    expect(report.problems).toEqual([expect.stringMatching(/^broken is failed: .*cannot start: no settings/)]);
  }, 60_000);

  test("reports a plugin that keeps its host from exiting, which it stops all the same", async () => {
    const { code, out } = await invoke(["plugins", "check", fixture("leaky.js"), "--json"], home);
    expect(code).toBe(1);
    expect(JSON.parse(out).problems).toEqual([expect.stringMatching(/^The host stopped but did not exit: something the plugin started/)]);
  }, 90_000);

  test("stops what a plugin started with its host: a child process it left running", async () => {
    const { code, out } = await invoke(["plugins", "check", fixture("spawner.js"), "--json"], home);
    expect(code).toBe(1);
    expect(JSON.parse(out).problems).toEqual([expect.stringMatching(/^The host stopped but did not exit/)]);
    // Its child went with the host's process group.
    expect(await spawned()).toBe("");
  }, 90_000);

  test("stops its host, and what the plugin started, when the check itself is killed", async () => {
    // The check's own temporary home goes in here, as it is left behind.
    const scratch = await mkdtemp(join(tmpdir(), "lemma-cli-check-killed-"));
    const check = spawn(process.execPath, ["--conditions=lemma-source", cliMain, "plugins", "check", fixture("spawner.js")], {
      env: { ...process.env, LEMMA_HOME: home, TMPDIR: scratch },
      stdio: "ignore",
    });
    try {
      // Its host is up, the plugin's child running in the host's process group, which the host leads.
      const host = await vi.waitFor(
        async () => {
          const child = await spawned();
          expect(child).not.toBe("");
          const { stdout } = await promisify(execFile)("ps", ["-o", "pgid=", "-p", child]);
          return Number(stdout.trim());
        },
        { timeout: 60_000, interval: 100 },
      );
      check.kill("SIGKILL");
      await vi.waitFor(() => expect(alive(-host)).toBe(false), { timeout: 30_000, interval: 100 });
      expect(await spawned()).toBe("");
    } finally {
      check.kill("SIGKILL");
      await rm(scratch, { recursive: true, force: true });
    }
  }, 120_000);

  test("reports a folder whose package.json cannot be read, with what the host said, rather than failing", async () => {
    const folder = await mkdtemp(join(tmpdir(), "lemma-cli-check-unreadable-"));
    try {
      await writeFile(join(folder, "package.json"), '{ "name": "unreadable", "lemma": { "host": "./index.js", }, }\n');
      await writeFile(join(folder, "index.js"), "export default undefined;\n");
      const { code, out } = await invoke(["plugins", "check", folder, "--json"], home);
      expect(code).toBe(1);
      const report = JSON.parse(out);
      expect(report.problems).toEqual([expect.stringMatching(/^Its package.json cannot be read: /), expect.stringMatching(/^No host half loaded from /)]);
      expect(report.output.some((line: string) => line.startsWith("lemma: open "))).toBe(true);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 60_000);

  test("says what does not exist", async () => {
    const { code, err } = await invoke(["plugins", "check", fixture("missing")], home);
    expect(code).toBe(1);
    expect(err).toContain("does not exist");
  });
});
