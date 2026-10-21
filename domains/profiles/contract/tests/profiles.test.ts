import { describe, expect, it } from "vitest";
import { deepLink, deepLinkTarget, profileAddress, profilePage } from "../src/index.ts";

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
