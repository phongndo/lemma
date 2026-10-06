import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(core, "package.json"), "utf8"));
const consumer = mkdtempSync(join(tmpdir(), "lemma-package-check-"));
const run = (command: string, args: string[], cwd = consumer) => execFileSync(command, args, { cwd, stdio: "inherit" });

try {
  // Pack invokes prepack, building exactly what a separate application receives.
  run("pnpm", ["pack", "--out", join(consumer, "lemma-core.tgz")], core);
  cpSync(join(core, "scripts/consumer"), consumer, { recursive: true });
  cpSync(join(core, "bench/budgets.ts"), join(consumer, "budgets.ts"));
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        name: "lemma-external-consumer",
        private: true,
        type: "module",
        dependencies: {
          "@lemma/core": "file:./lemma-core.tgz",
          effect: manifest.dependencies.effect,
        },
        devDependencies: {
          typescript: manifest.devDependencies.typescript,
          "@types/node": manifest.devDependencies["@types/node"],
        },
      },
      null,
      2,
    ),
  );
  // This directory has no workspace links or source aliases.
  run("pnpm", ["install", "--ignore-workspace", "--ignore-scripts"]);
  run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);
  run(process.execPath, ["dist/main.js"]);
  run(process.execPath, ["dist/server.js"]);
  if (process.argv.includes("--browser")) {
    const { checkBrowser } = await import("./check-browser.ts");
    await checkBrowser(consumer);
  }
  console.log("Packed library: declarations, Node.js, and HTTP consumer checks passed.");
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
