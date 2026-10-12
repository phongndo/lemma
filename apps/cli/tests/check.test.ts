import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { invoke } from "./invoke.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/check/${name}`, import.meta.url));

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

  test("says what does not exist", async () => {
    const { code, err } = await invoke(["plugins", "check", fixture("missing")], home);
    expect(code).toBe(1);
    expect(err).toContain("does not exist");
  });
});
