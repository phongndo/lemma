import { describe, expect, it } from "vitest";
import { deepLink, deepLinkTarget, profileAddress, profileNameFor, profilePage, profileTitle, titleProblem } from "../src/index.ts";

describe("a profile's address", () => {
  const opened = { name: "desk", url: "http://127.0.0.1:7434", port: 7434, token: "t0k" };

  it("is the host's own from a page on its machine", () => {
    for (const from of ["http://127.0.0.1:7433/threads/a", "http://localhost:7433", "http://[::1]:7433"])
      expect(profileAddress(from, opened)).toBe("http://127.0.0.1:7434");
  });

  it("is the same machine at the profile's port from a page elsewhere", () => {
    expect(profileAddress("https://box.tailnet.ts.net/threads/a", opened)).toBe("https://box.tailnet.ts.net:7434");
    expect(profileAddress("http://192.168.1.5:7433", opened)).toBe("http://192.168.1.5:7434");
  });

  it("is its web app with its token", () => {
    expect(profilePage("https://box.tailnet.ts.net", opened, "/settings")).toBe("https://box.tailnet.ts.net:7434/settings?token=t0k");
  });
});

describe("a deep link", () => {
  it("names the profile a deep link is for, which the address the page sees leaves out", () => {
    expect(deepLink("/threads/s1")).toBe("lemma://threads/s1");
    expect(deepLink("/settings/plugins?plugin=agent", "desk")).toBe("lemma://settings/plugins?plugin=agent&profile=desk");
    expect(deepLinkTarget("lemma://settings/plugins?plugin=agent&profile=desk")).toEqual({ path: "/settings/plugins?plugin=agent", profile: "desk" });
    expect(deepLinkTarget("lemma://threads/s1")).toEqual({ path: "/threads/s1" });
    expect(deepLinkTarget("https://example.com/threads/s1")).toBeUndefined();
  });
});

describe("a profile's name", () => {
  it("is the one it was given, else Core for the default and its name in words for another", () => {
    expect(profileTitle({ name: "default", default: true })).toBe("Core");
    expect(profileTitle({ name: "desk", default: false })).toBe("Desk");
    expect(profileTitle({ name: "trading-desk", default: false })).toBe("Trading desk");
    expect(profileTitle({ name: "default", default: true, title: "Workbench" })).toBe("Workbench");
    expect(profileTitle({ name: "desk", default: false, title: "  " })).toBe("Desk");
  });

  it("can be any text on one line, up to its length", () => {
    expect(titleProblem("Trading desk 📈")).toBeUndefined();
    expect(titleProblem("two\nlines")).toBeDefined();
    expect(titleProblem("x".repeat(61))).toBeDefined();
  });

  it("makes a new profile's command-line name, numbered past those taken", () => {
    expect(profileNameFor("Trading Desk 📈", [])).toBe("trading-desk");
    expect(profileNameFor("Café Société", [])).toBe("cafe-societe");
    expect(profileNameFor("Research", ["default", "research", "research-2"])).toBe("research-3");
    expect(profileNameFor("Default", ["default"])).toBe("default-2");
    expect(profileNameFor("📈", [])).toBe("profile");
    expect(profileNameFor("a".repeat(80), [])).toMatch(/^a{36}$/);
    for (const title of ["Trading Desk 📈", "  --x--  ", "Ünïcödé", "a".repeat(80)]) expect(profileNameFor(title, [])).toMatch(/^[a-z0-9][a-z0-9_-]{0,39}$/);
  });
});
