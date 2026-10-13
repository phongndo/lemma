import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { failureArtifact } from "../src/artifacts.ts";

let root: string;
const previous = process.env.LEMMA_TEST_ARTIFACTS;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lemma-artifacts-test-"));
  process.env.LEMMA_TEST_ARTIFACTS = join(root, "evidence");
});
afterEach(() => {
  if (previous === undefined) delete process.env.LEMMA_TEST_ARTIFACTS;
  else process.env.LEMMA_TEST_ARTIFACTS = previous;
  rmSync(root, { recursive: true, force: true });
});

test("evidence outlives the run's home, holds what it was given, and leaves out a token in a URL", () => {
  const home = join(root, "home");
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "sessions/s.jsonl"), "durable log");
  writeFileSync(join(home, "token"), "secret");
  const evidence = failureArtifact(
    "fixture",
    { seed: 7, replay: "pnpm sim --seed 7", address: "http://localhost/?token=secret" },
    { "processes.log": "the host died" },
    { sessions: join(home, "sessions"), missing: join(home, "missing") },
  );
  rmSync(home, { recursive: true });
  expect(readFileSync(join(evidence, "sessions/s.jsonl"), "utf8")).toBe("durable log");
  expect(readFileSync(join(evidence, "processes.log"), "utf8")).toBe("the host died");
  const failure = JSON.parse(readFileSync(join(evidence, "failure.json"), "utf8")) as Record<string, unknown>;
  expect(failure).toMatchObject({ kind: "fixture", seed: 7, replay: "pnpm sim --seed 7", address: "http://localhost/?token=<redacted>" });
  expect(() => readFileSync(join(evidence, "token"))).toThrow();
});

test("evidence names stay inside its directory", () => {
  expect(() => failureArtifact("fixture", {}, { "../outside": "x" })).toThrow("Not a relative name");
  expect(() => failureArtifact("fixture", {}, { "/etc/passwd": "x" })).toThrow("Not a relative name");
});
