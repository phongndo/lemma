import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright-core";
import type { BrowserError } from "@lemma/browser";
import { findChromium, isExecutableFile, makeChromium } from "../src/index.ts";

/** A Chromium to drive, as the plugin would find it: these tests need one, and skip without it (`nix develop .#browser`). */
const found = findChromium({
  env: process.env,
  platform: process.platform,
  isExecutable: isExecutableFile,
  playwright: () => {
    try {
      return chromium.executablePath();
    } catch {
      return undefined;
    }
  },
});
const missing = "problem" in found;
/**
 * How long a hook or test that starts a Chromium may take: a cold start on a busy machine (CI runs every package's tests
 * at once) outlasts the defaults. Each group starts its browser in a hook, so its tests meet a warm one.
 */
const LAUNCH_MS = 60_000;

const page = (body: string) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><title>Test</title></head><body>${body}</body></html>`)}`;

const FORM = page(`
  <h1>Sign in</h1>
  <label>Email <input id="email" type="email"></label>
  <label>Password <input id="password" type="password" value="hunter2"></label>
  <label>Passphrase <input type="password" value="p@ss: word #1"></label>
  <label>Pin <input type="text" style="-webkit-text-security: disc" value="9876"></label>
  <label>Spaced <input type="password" value="  lead"></label>
  <button id="save" onclick="document.querySelector('#status').textContent = 'Saved ' + document.querySelector('#email').value">Save</button>
  <button>Other</button>
  <p id="status">Not saved</p>
  <select id="color"><option value="r">Red</option><option value="g">Green</option></select>
  <button id="later" onclick="setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p>Arrived</p>'), 50)">Later</button>
`);

const run = <A>(effect: Effect.Effect<A, BrowserError>) => Effect.runPromise(effect);
const failure = (effect: Effect.Effect<unknown, BrowserError>) => Effect.runPromise(Effect.flip(effect));

/** The ref the tree gives the line that matches `line`. */
const refOf = (tree: string, line: RegExp) => {
  const ref = tree
    .split("\n")
    .find((text) => line.test(text))
    ?.match(/\[ref=(s\d+-[a-z0-9]+)\]/)?.[1];
  if (ref === undefined) throw new Error(`no ref for ${line} in:\n${tree}`);
  return ref;
};

describe.skipIf(missing)("Chromium", () => {
  const browser = makeChromium({ idleMs: 0, headless: true });
  const { service } = browser;
  afterAll(() => browser.close());

  beforeAll(async () => {
    await run(service.open("a", { url: FORM }));
  }, LAUNCH_MS);

  it("reads a page as a tree with refs, its password values hidden, and acts by ref", async () => {
    const snapshot = await run(service.snapshot("a", {}));
    expect(snapshot).toMatchObject({ tabId: "t1", title: "Test", generation: 1, truncated: false });
    expect(snapshot.tree).toContain('heading "Sign in"');
    for (const secret of ["hunter2", "p@ss", "9876", "lead"]) expect(snapshot.tree).not.toContain(secret);
    expect(snapshot.tree).toMatch(/textbox "Pin" \[ref=s1-e\d+\]: ••••••/);
    await run(service.type("a", { ref: refOf(snapshot.tree, /textbox "Email"/), text: "me@example.com" }));
    const tab = await run(service.click("a", { ref: refOf(snapshot.tree, /button "Save"/) }));
    expect(tab).toMatchObject({ tabId: "t1", title: "Test", current: true });
    const after = await run(service.snapshot("a", {}));
    expect(after.generation).toBe(2);
    expect(after.tree).toContain("Saved me@example.com");
  });

  it("refuses a ref from an earlier snapshot, or from before a navigation, saying to take a new one", async () => {
    const first = await run(service.snapshot("a", {}));
    const old = refOf(first.tree, /button "Save"/);
    await run(service.snapshot("a", {}));
    expect(await failure(service.click("a", { ref: old }))).toMatchObject({ reason: "StaleRef", message: expect.stringMatching(/take a new snapshot/) });
    const fresh = refOf((await run(service.snapshot("a", {}))).tree, /button "Save"/);
    await run(service.navigate("a", { url: FORM }));
    expect(await failure(service.click("a", { ref: fresh }))).toMatchObject({ reason: "StaleRef", message: expect.stringMatching(/navigated/) });
  });

  it("targets by locator and selector, and says when one matches several elements", async () => {
    await run(service.select("a", { selector: "#color", values: ["Green"] }));
    expect((await run(service.evaluate("a", { expression: "document.querySelector('#color').value" }))).value).toBe("g");
    await run(service.type("a", { locator: "label=Email", text: "x@y.z" }));
    expect((await run(service.evaluate("a", { expression: "document.querySelector('#email').value" }))).value).toBe("x@y.z");
    expect(await failure(service.click("a", { selector: "button" }))).toMatchObject({
      reason: "InvalidTarget",
      message: expect.stringMatching(/matches 3 elements/),
    });
    expect(await failure(service.click("a", { x: 3 }))).toMatchObject({ reason: "InvalidTarget" });
  });

  it("waits for what a page shows later", async () => {
    await run(service.click("a", { selector: "#later" }));
    await run(service.waitFor("a", { text: "Arrived", timeoutMs: 5_000 }));
    expect(await failure(service.waitFor("a", { text: "Never", timeoutMs: 100 }))).toMatchObject({ reason: "Timeout" });
  });

  it("evaluates expressions, cutting long values", async () => {
    expect(await run(service.evaluate("a", { expression: "Promise.resolve({ n: 1 + 1 })" }))).toEqual({ value: { n: 2 }, truncated: false });
    expect(await run(service.evaluate("a", { expression: "(() => { const a = { big: 2n ** 70n, f: () => 1 }; a.self = a; return a })()" }))).toEqual({
      value: { big: "1180591620717411303424n", self: "[Circular]" },
      truncated: false,
    });
    // An object reached twice, by other paths, is no cycle: written out each time.
    expect(await run(service.evaluate("a", { expression: "(() => { const a = { x: 1 }; return [a, a, { a }]; })()" }))).toEqual({
      value: [{ x: 1 }, { x: 1 }, { a: { x: 1 } }],
      truncated: false,
    });
    expect(await run(service.evaluate("a", { expression: "undefined" }))).toEqual({ value: null, truncated: false });
    const long = await run(service.evaluate("a", { expression: "'x'.repeat(70000)" }));
    expect(long.truncated).toBe(true);
  });

  it("takes screenshots as PNG", async () => {
    const shot = await run(service.screenshot("a", {}));
    expect(shot).toMatchObject({ mimeType: "image/png", width: 1280, height: 800 });
    expect(Buffer.from(shot.data, "base64").subarray(1, 4).toString()).toBe("PNG");
  });

  it("keeps each session's tabs apart, and numbers a session's tabs", async () => {
    expect(await run(service.tabs("b"))).toEqual([]);
    expect(await failure(service.snapshot("b", {}))).toMatchObject({ reason: "NoTab", message: expect.stringMatching(/browser_open/) });
    await run(service.open("b", { url: page("<p>B</p>") }));
    const second = await run(service.open("b", { url: page("<p>B2</p>"), newTab: true }));
    expect(second).toMatchObject({ tabId: "t2", current: true });
    expect((await run(service.tabs("b"))).map((tab) => tab.tabId)).toEqual(["t1", "t2"]);
    expect(await run(service.close("b", { tabId: "t2" }))).toMatchObject([{ tabId: "t1", current: true }]);
    expect((await run(service.tabs("a"))).map((tab) => tab.tabId)).toEqual(["t1"]);
  });

  it("renders a page on its own: its height, a screenshot of it, and what it logged", async () => {
    const rendered = await run(
      service.render(
        `<!doctype html><html><head><style>body { margin: 0 }</style></head><body><div style="height: 300px">Hi</div><script>console.log("checked"); null.boom;</script></body></html>`,
        { width: 400, colorScheme: "dark" },
      ),
    );
    expect(rendered).toMatchObject({ width: 400, contentHeight: 300, capturedHeight: 300, screenshot: { mimeType: "image/png", width: 400, height: 300 } });
    expect(rendered.console[0]).toEqual({ level: "log", text: "checked" });
    expect(rendered.console[1]).toMatchObject({ level: "error", text: expect.stringMatching(/TypeError/) });
  });

  it("measures a page held to its frame's height by what it holds, as the chat's frame does", async () => {
    const rendered = await run(
      service.render(
        `<!doctype html><html><head><style>html, body { height: 100%; margin: 0 } section { height: 1200px }</style></head><body><section>Tall</section></body></html>`,
        { width: 400, colorScheme: "light" },
      ),
    );
    expect(rendered.contentHeight).toBe(1200);
  });
});

describe.skipIf(missing)("Chromium over HTTP", () => {
  const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
  const pages: Record<string, [number, string]> = {
    "/opener": [200, html("Opener", `<a href="/two" target="_blank">Blank</a><button onclick="window.open('/two')">Pop</button>`)],
    "/two": [200, html("Two", "<h1>Two</h1>")],
    "/missing": [404, html("Missing", "<h1>Not here</h1>")],
    "/long": [
      200,
      html(
        "Long",
        `<div id="box" style="height: 200px; width: 300px; overflow: auto"><div style="height: 2000px">inner</div></div><div style="height: 4000px">top</div>`,
      ),
    ],
  };
  /** What the server was asked for. */
  const requested: string[] = [];
  const server = createServer((request, response) => {
    requested.push(request.url ?? "");
    const [status, body] = pages[request.url ?? ""] ?? [404, "nope"];
    response.writeHead(status, { "content-type": "text/html" });
    response.end(body);
  });
  let origin = "";
  /** An address nothing listens at: loading it fails, and Chromium shows its error page. */
  let refused = "";
  const browser = makeChromium({ idleMs: 0, headless: true });
  const { service } = browser;
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    refused = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    // Started here, so the first test does not wait out a cold start; a session of its own touches none of theirs.
    await run(service.open("warm", {}));
  }, LAUNCH_MS);
  afterAll(async () => {
    await browser.close();
    server.close();
  });

  it("says what a failed load was, and loads the next page after it, its error page landing first", async () => {
    await run(service.open("h", { url: `${origin}/two` }));
    for (let i = 0; i < 2; i++) {
      expect(await failure(service.navigate("h", { url: refused }))).toMatchObject({
        reason: "Failed",
        message: expect.stringMatching(/^Could not load the page \(net::ERR_CONNECTION_REFUSED at .*\): check the address/),
      });
      expect(await run(service.navigate("h", { url: `${origin}/two` }))).toMatchObject({ title: "Two", status: 200 });
    }
  });

  it("gives the HTTP status a page came with", async () => {
    expect(await run(service.navigate("h", { url: `${origin}/missing` }))).toMatchObject({ title: "Missing", status: 404 });
  });

  it("makes a tab a link or window.open opens the current one, and says so in the click's result", async () => {
    await run(service.open("p", { url: `${origin}/opener` }));
    expect(await run(service.click("p", { locator: "text=Blank" }))).toMatchObject({ tabId: "t2", title: "Two", current: true });
    await run(service.open("p", { tabId: "t1" }));
    expect(await run(service.click("p", { locator: "text=Pop" }))).toMatchObject({ tabId: "t3", title: "Two", current: true });
  });

  it("fails a page drawn on its own that does not finish loading, saying so", async () => {
    const impatient = makeChromium({ idleMs: 0, headless: true, renderTimeoutMs: 300 });
    try {
      const busy = `<!doctype html><p>x</p><script>const end = Date.now() + 3000; while (Date.now() < end) {}</script>`;
      expect(await failure(impatient.service.render(busy, { width: 400, colorScheme: "dark" }))).toMatchObject({
        reason: "Timeout",
        message: "The page did not finish loading within 0.3 seconds. Leave out what does not load, or load it from an address that answers",
      });
    } finally {
      await impatient.close();
    }
  });

  it("draws a page on its own without anything on this machine or its network, which it never asks for", async () => {
    const local = origin.replace("127.0.0.1", "localhost");
    const html = `<!doctype html><p>x</p><script src="${origin}/script"></script><img src="${local}/image.png">
      <script>fetch("${origin}/fetch", { mode: "no-cors" }).catch(() => {}); new WebSocket("${origin.replace("http", "ws")}/socket");</script>`;
    const rendered = await run(service.render(html, { width: 400, colorScheme: "dark" }));
    const refusals = rendered.console.filter((message) => message.text.startsWith("Not loaded: "));
    expect(refusals.map((message) => message.text.split(" ")[2]).sort()).toEqual(
      [`${origin}/script`, `${local}/image.png`, `${origin}/fetch`, `${origin.replace("http", "ws")}/socket`].sort(),
    );
    expect(refusals[0]?.text).toMatch(/is on this machine or its network, which a preview does not reach$/);
    expect(requested.filter((url) => ["/script", "/image.png", "/fetch", "/socket"].includes(url))).toEqual([]);
  });

  it("returns from a scroll once the page, or the box under the point, has scrolled, whatever came before", async () => {
    await run(service.open("s", { url: `${origin}/long` }));
    for (const before of [
      () => run(service.hover("s", { selector: "#box" })),
      () => run(service.click("s", { selector: "#box", clickCount: 2 })),
      () => run(service.scroll("s", { deltaY: 600 })),
    ]) {
      await before();
      await run(service.evaluate("s", { expression: "window.scrollTo(0, 0)" }));
      await run(service.scroll("s", { deltaY: 600 }));
      expect((await run(service.evaluate("s", { expression: "window.scrollY" }))).value).toBe(600);
    }
    await run(service.evaluate("s", { expression: "window.scrollTo(0, 0)" }));
    await run(service.scroll("s", { x: 50, y: 50, deltaY: 100 }));
    expect((await run(service.evaluate("s", { expression: "[window.scrollY, document.querySelector('#box').scrollTop]" }))).value).toEqual([0, 100]);
  });

  it("says a ref is not from this tab's snapshots when the tab has had fewer", async () => {
    await run(service.open("r", { url: `${origin}/two` }));
    expect(await failure(service.click("r", { ref: "s5-e2" }))).toMatchObject({
      reason: "StaleRef",
      message: expect.stringMatching(/not from a snapshot of t1 \(none has been taken\), perhaps another tab's or session's/),
    });
  });
});

describe.skipIf(missing)("an idle Chromium", () => {
  it(
    "closes after its last call, its tabs with it, and starts again when called",
    async () => {
      const browser = makeChromium({ idleMs: 50, headless: true });
      try {
        await Effect.runPromise(browser.service.open("s", { url: page("<p>Hi</p>") }));
        await vi.waitFor(async () => expect(await Effect.runPromise(browser.snapshot)).toMatchObject({ running: false }), { timeout: 10_000 });
        expect(await Effect.runPromise(Effect.flip(browser.service.snapshot("s", {})))).toMatchObject({
          reason: "NoTab",
          message: expect.stringMatching(/closes 50 ms after its last call/),
        });
        expect(await Effect.runPromise(browser.service.open("s", {}))).toMatchObject({ tabId: "t1" });
      } finally {
        await browser.close();
      }
    },
    LAUNCH_MS,
  );
});

describe("an unfound Chromium", () => {
  it("fails Unavailable, saying how to provide one", async () => {
    const browser = makeChromium({ idleMs: 0, headless: true, executablePath: "/nonexistent/chromium" });
    expect(await Effect.runPromise(Effect.flip(browser.service.open("s", {})))).toMatchObject({
      reason: "Unavailable",
      message: "browser.chromium's executablePath names /nonexistent/chromium, which is not an executable file",
    });
  });
});
