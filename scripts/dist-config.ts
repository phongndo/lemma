import { readFileSync } from "node:fs";

export const version = (JSON.parse(readFileSync(new URL("../apps/cli/package.json", import.meta.url), "utf8")) as { version: string }).version;
export const releaseTag = `v${version}`;
export const repository = "phongndo/lemma";

// Official Node archives, pinned independently of the machine building Lemma.
// https://nodejs.org/dist/v24.20.0/SHASUMS256.txt
export const nodeVersion = "24.20.0";
export const targets = {
  "darwin-arm64": "40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8",
  "darwin-x64": "9e5b2644cf107befb6aefca676b96d3296bc10138096f022ed378d6233ed81f4",
  "linux-arm64": "3515603e2487879a39bc75716f1a2affd027500c64ba50e845cf72cb33219013",
  "linux-x64": "855d581f8a4eb1a8117e3426de25fe02770592febcfb31369aee1ffbfee9e8ec",
} as const;
export type Target = keyof typeof targets;
export const archiveName = (target: Target) => `lemma-${releaseTag}-${target}.tar.gz`;
