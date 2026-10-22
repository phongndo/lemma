import { existsSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { DurationSequencer } from "./scripts/test-shards.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
/** The packages in `group`: its folders with a package.json, so a file beside them (a README, `.DS_Store`) is none. */
const packagesIn = (group: string): string[] =>
  existsSync(join(root, group))
    ? readdirSync(join(root, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(root, group, entry.name, "package.json")))
        .map((entry) => `${group}/${entry.name}`)
    : [];
const domains = existsSync(join(root, "domains")) ? readdirSync(join(root, "domains"), { withFileTypes: true }).filter((entry) => entry.isDirectory()) : [];

// `pnpm test`: every package's tests in one run, each package a project with its own config. One pool takes files
// from all of them, so a slow package's files spread over the workers rather than holding a turn of their own. Many
// tests wait on processes they start, so twice as many workers as cores keeps the cores busy. CI's shards split the
// files by how long each takes (scripts/test-shards.ts). CI retries a failed test (`--retry.count` on the command
// line, which reaches every project, as this file's `retry` would not reach one with a config of its own); one that
// passed only on a retry is a warning on the run, in its summary, and an issue on main (scripts/flaky.ts).
export default defineConfig({
  test: {
    reporters: process.env.GITHUB_ACTIONS === "true" ? ["default", "github-actions", "./scripts/flaky.ts"] : ["default"],
    sequence: { sequencer: DurationSequencer },
    projects: [
      ...packagesIn("packages"),
      ...domains.flatMap((domain) => packagesIn(`domains/${domain.name}`)),
      ...packagesIn("apps"),
      ...packagesIn("examples"),
    ],
    maxWorkers: 2 * availableParallelism(),
  },
});
