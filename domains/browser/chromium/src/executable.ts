import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Names a Chromium goes by on PATH, most specific first. */
export const CHROMIUM_NAMES = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"] as const;

/** Where macOS keeps the apps, when they are not on PATH. */
const MAC_APPS = ["/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];

/** Where an executable came from: the config, `LEMMA_CHROMIUM`, PATH (or an app folder), or Playwright's own download. */
export type ChromiumSource = "config" | "LEMMA_CHROMIUM" | "PATH" | "playwright";

export interface ChromiumLookup {
  /** The plugin config's `executablePath`. */
  readonly configured?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  /** Whether a file is there and may be run. */
  readonly isExecutable: (path: string) => boolean;
  /** Where Playwright's own Chromium would be, downloaded or not. */
  readonly playwright: () => string | undefined;
}

/** A file there that its owner may run. */
export const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The Chromium to launch: the configured one, else `LEMMA_CHROMIUM` (the `browser` dev shell sets it), else the first
 * of `CHROMIUM_NAMES` on PATH (and the macOS app folders), else Playwright's own when it has been downloaded. A
 * configured or `LEMMA_CHROMIUM` path that is not an executable is an error, not a reason to look further: a typo
 * should not quietly launch another browser.
 */
export const findChromium = (lookup: ChromiumLookup): { readonly path: string; readonly source: ChromiumSource } | { readonly problem: string } => {
  const named = (path: string, source: "config" | "LEMMA_CHROMIUM", where: string) =>
    lookup.isExecutable(path) ? { path, source } : { problem: `${where} names ${path}, which is not an executable file` };
  if (lookup.configured !== undefined && lookup.configured !== "") return named(lookup.configured, "config", "browser.chromium's executablePath");
  const env = lookup.env["LEMMA_CHROMIUM"];
  if (env !== undefined && env !== "") return named(env, "LEMMA_CHROMIUM", "LEMMA_CHROMIUM");
  const dirs = (lookup.env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "");
  for (const name of CHROMIUM_NAMES) {
    for (const dir of dirs) {
      const path = join(dir, name);
      if (lookup.isExecutable(path)) return { path, source: "PATH" };
    }
  }
  if (lookup.platform === "darwin") {
    const app = MAC_APPS.find((path) => lookup.isExecutable(path));
    if (app !== undefined) return { path: app, source: "PATH" };
  }
  const downloaded = lookup.playwright();
  if (downloaded !== undefined && lookup.isExecutable(downloaded)) return { path: downloaded, source: "playwright" };
  return {
    problem: `No Chromium found (looked for ${CHROMIUM_NAMES.join(", ")} on PATH). Set executablePath in browser.chromium's config, set LEMMA_CHROMIUM, put Chromium on PATH, or download Playwright's with \`npx playwright install chromium\``,
  };
};
