import { describe, expect, it } from "vitest";
import { findChromium } from "../src/index.ts";
import type { ChromiumLookup } from "../src/index.ts";

const lookup = (executables: readonly string[], options: Partial<ChromiumLookup> = {}): ChromiumLookup => ({
  env: {},
  platform: "linux",
  isExecutable: (path) => executables.includes(path),
  playwright: () => undefined,
  ...options,
});

describe("findChromium", () => {
  it("takes the configured executable first, then LEMMA_CHROMIUM", () => {
    const env = { LEMMA_CHROMIUM: "/nix/chromium", PATH: "/usr/bin" };
    expect(findChromium(lookup(["/opt/chrome", "/nix/chromium", "/usr/bin/chromium"], { configured: "/opt/chrome", env }))).toEqual({
      path: "/opt/chrome",
      source: "config",
    });
    expect(findChromium(lookup(["/nix/chromium", "/usr/bin/chromium"], { env }))).toEqual({ path: "/nix/chromium", source: "LEMMA_CHROMIUM" });
  });

  it("says a named executable is wrong rather than launching another", () => {
    const found = findChromium(lookup(["/usr/bin/chromium"], { configured: "/opt/typo", env: { PATH: "/usr/bin" } }));
    expect(found).toEqual({ problem: "browser.chromium's executablePath names /opt/typo, which is not an executable file" });
  });

  it("looks on PATH by name, most specific first, then for Playwright's download", () => {
    const env = { PATH: "/a:/b" };
    expect(findChromium(lookup(["/b/chromium", "/a/google-chrome"], { env }))).toEqual({ path: "/b/chromium", source: "PATH" });
    expect(findChromium(lookup(["/a/google-chrome"], { env }))).toEqual({ path: "/a/google-chrome", source: "PATH" });
    expect(findChromium(lookup(["/cache/chrome"], { env, playwright: () => "/cache/chrome" }))).toEqual({ path: "/cache/chrome", source: "playwright" });
  });

  it("looks in the macOS app folders there", () => {
    const app = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    expect(findChromium(lookup([app], { platform: "darwin" }))).toEqual({ path: app, source: "PATH" });
    expect(findChromium(lookup([app]))).toHaveProperty("problem");
  });

  it("says how to provide one when there is none", () => {
    const found = findChromium(lookup([], { env: { PATH: "/usr/bin" }, playwright: () => "/cache/chrome" }));
    expect(found).toHaveProperty("problem", expect.stringMatching(/executablePath.*LEMMA_CHROMIUM.*npx playwright install chromium/));
  });
});
