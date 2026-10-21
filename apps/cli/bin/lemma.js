#!/usr/bin/env -S node --conditions=lemma-source
/*
 * The `lemma` command as `bin`, `pnpm lemma`, and the agent's shell run it.
 * It turns on Node's compile cache for what loads next, then runs the bundle
 * (`dist/lemma.mjs`, from `pnpm build` or `pnpm lemma:build`) when it was built
 * from the sources as they are now, and the sources (`src/main.ts`) otherwise.
 * It is JavaScript so that starting strips no TypeScript: loading the type
 * stripper alone takes 13 ms, a sixth of a bundled command's time.
 */
import { readFileSync, statSync } from "node:fs";
import { enableCompileCache } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

enableCompileCache();

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

/** Whether each file the bundle was built from has the size and modification time the build recorded (`scripts/build.ts`). */
const fresh = () => {
  try {
    const { files } = JSON.parse(readFileSync(join(dist, "lemma.json"), "utf8"));
    for (const [path, [size, mtimeMs]] of Object.entries(files)) {
      const now = statSync(join(dist, path));
      if (now.size !== size || now.mtimeMs !== mtimeMs) return false;
    }
    return true;
  } catch {
    return false;
  }
};

// The host (`serve`) runs from the sources, whose modules it shares: from the bundle it would load a second copy of them.
await import(process.argv[2] !== "serve" && fresh() ? new URL("../dist/lemma.mjs", import.meta.url).href : "../src/main.ts");
