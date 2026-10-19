import { describe, expect, test } from "vitest";
import { addressOf, hostOf } from "../src/address.ts";

describe("addressOf", () => {
  test("a web address goes as it is", () => {
    expect(addressOf("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(addressOf("  http://localhost:5173/  ")).toBe("http://localhost:5173/");
    expect(addressOf("about:blank")).toBe("about:blank");
  });

  test("this machine, numbered addresses, and a machine with a port over http; domains over https", () => {
    expect(addressOf("localhost:3000")).toBe("http://localhost:3000");
    expect(addressOf("localhost")).toBe("http://localhost");
    expect(addressOf("127.0.0.1:8080/app")).toBe("http://127.0.0.1:8080/app");
    expect(addressOf("192.168.1.20:3000")).toBe("http://192.168.1.20:3000");
    expect(addressOf("[::1]:4000")).toBe("http://[::1]:4000");
    expect(addressOf("example.com")).toBe("https://example.com");
    expect(addressOf("docs.example.co.uk/guide#top")).toBe("https://docs.example.co.uk/guide#top");
    expect(addressOf("devbox:8080")).toBe("http://devbox:8080");
  });

  test("a name only this machine or network answers to, as a dev server has, over http", () => {
    expect(addressOf("app.localhost:5173")).toBe("http://app.localhost:5173");
    expect(addressOf("site.test:3000/login")).toBe("http://site.test:3000/login");
    expect(addressOf("printer.local")).toBe("http://printer.local");
    expect(addressOf("router.home.arpa")).toBe("http://router.home.arpa");
    expect(addressOf("localhost.example.com")).toBe("https://localhost.example.com");
  });

  test("anything else is searched for", () => {
    expect(addressOf("solid js signals")).toBe("https://duckduckgo.com/?q=solid%20js%20signals");
    expect(addressOf("lemma")).toBe("https://duckduckgo.com/?q=lemma");
    expect(addressOf("mailto:me@example.com")).toBe("https://duckduckgo.com/?q=mailto%3Ame%40example.com");
    expect(addressOf("what?", "https://www.google.com/search?q=")).toBe("https://www.google.com/search?q=what%3F");
  });

  test("nothing typed goes nowhere", () => {
    expect(addressOf("   ")).toBeUndefined();
  });
});

describe("hostOf", () => {
  test("names a page by its host", () => {
    expect(hostOf("http://localhost:5173/x")).toBe("localhost:5173");
    expect(hostOf("about:blank")).toBeUndefined();
    expect(hostOf(undefined)).toBeUndefined();
  });
});
