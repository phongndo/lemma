import { describe, expect, test } from "vitest";
import { appUrl, deepLinkPath } from "../src/addresses.ts";
import { NewThreadRoute, ThreadRoute } from "../src/sessions.ts";

describe("addresses", () => {
  test("threads have readable paths", () => {
    expect(NewThreadRoute.href({})).toBe("/");
    expect(ThreadRoute.href({ id: "s1" })).toBe("/threads/s1");
    expect(ThreadRoute.href({ id: "s1", view: "trajectory" })).toBe("/threads/s1/trajectory");
  });

  test("appUrl puts the token in the query", () => {
    expect(appUrl("http://127.0.0.1:7433", "/threads/s1", "t k")).toBe("http://127.0.0.1:7433/threads/s1?token=t+k");
    expect(appUrl("http://127.0.0.1:7433/", "/settings/plugins?plugin=agent")).toBe("http://127.0.0.1:7433/settings/plugins?plugin=agent");
  });

  test("appUrl refuses an address on another host, so the token never leaves this one", () => {
    // `\` reads as `/` in an http address: `/\evil.com` is `//evil.com`.
    expect(() => appUrl("http://127.0.0.1:7433", "/\\evil.com/x", "secret")).toThrow();
    expect(() => appUrl("http://127.0.0.1:7433", "//evil.com/x", "secret")).toThrow();
    expect(() => appUrl("http://127.0.0.1:7433", "https://evil.com/x", "secret")).toThrow();
  });

  test("deep links name the app's own paths", () => {
    expect(deepLinkPath("lemma://threads/s1")).toBe("/threads/s1");
    expect(deepLinkPath("lemma:///threads/s1/trajectory")).toBe("/threads/s1/trajectory");
    expect(deepLinkPath("lemma://settings/plugins?plugin=agent#x")).toBe("/settings/plugins?plugin=agent");
    expect(deepLinkPath("lemma://threads/s1?token=stolen")).toBe("/threads/s1");
    expect(deepLinkPath("lemma://")).toBe("/");
    expect(deepLinkPath("https://example.com/threads/s1")).toBeUndefined();
    expect(deepLinkPath("not a url")).toBeUndefined();
  });

  test("a deep link cannot name another host", () => {
    // `\` reads as `/` in an http address: `/\evil.com` is `//evil.com`.
    for (const link of ["lemma:/\\evil.com/x", "lemma:\\\\evil.com/x", "lemma:/\t\\evil.com"]) expect(deepLinkPath(link)).toBeUndefined();
    expect(deepLinkPath("lemma:////evil.com/x")).toBe("/evil.com/x");
  });
});
