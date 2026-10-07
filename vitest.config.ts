import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// `pnpm test`: every package's tests in one run, each package a project with its own config. One pool takes files
// from all of them, so a slow package's files spread over the workers rather than holding a turn of their own. Many
// tests wait on processes they start, so twice as many workers as cores keeps the cores busy.
export default defineConfig({
  test: {
    projects: ["packages/*", "plugins/*", "apps/*", "examples/*"],
    maxWorkers: 2 * availableParallelism(),
  },
});
