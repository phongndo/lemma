import { describe, expect, it, vi } from "vitest";
import { isLocalUrl } from "../src/local.ts";

// Names resolve as these say, without a network.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (host === "intranet.example") return [{ address: "192.168.1.5", family: 4 }];
    if (host === "public.example") return [{ address: "93.184.216.34", family: 4 }];
    throw new Error(`getaddrinfo ENOTFOUND ${host}`);
  },
}));

describe("isLocalUrl", () => {
  it("is true of this machine and private networks, however the address is written", async () => {
    for (const url of [
      "http://localhost:3000/",
      "http://LocalHost./x",
      "http://app.localhost/",
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://[::1]:8080/",
      "http://[::ffff:127.0.0.1]/",
      "http://0.0.0.0/",
      "http://10.1.2.3/",
      "http://172.20.0.1/",
      "http://192.168.1.1/admin",
      "http://169.254.169.254/latest/meta-data",
      "http://100.100.1.1/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "ws://127.0.0.1:9222/devtools",
      "https://intranet.example/",
    ])
      expect([url, await isLocalUrl(url)]).toEqual([url, true]);
  });

  it("is false of public addresses, names that do not resolve, and what is no web address", async () => {
    for (const url of [
      "https://cdn.jsdelivr.net.invalid/chart.js",
      "https://public.example/",
      "http://8.8.8.8/",
      "http://172.32.0.1/",
      "http://[2001:4860:4860::8888]/",
      "data:text/plain,hi",
      "blob:https://public.example/1",
      "file:///etc/passwd",
      "not a url",
    ])
      expect([url, await isLocalUrl(url)]).toEqual([url, false]);
  });
});
