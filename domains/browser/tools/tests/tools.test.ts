import { Effect } from "effect";
import type { Context } from "effect";
import { describe, expect, it } from "vitest";
import { definePlugin, makeCore, Registries } from "@lemma/core";
import { Browser, BrowserError } from "@lemma/browser";
import type { BrowserTab } from "@lemma/browser";
import { ToolNamespaces, ToolRunner } from "@lemma/tools";
import { call, context, textOf } from "@lemma/tools/testing";
import registry from "@lemma/tools-registry";
import tools, { browserTools, htmlPreviewTool } from "../src/index.ts";

type Service = Context.Service.Shape<typeof Browser>;

const TAB: BrowserTab = { tabId: "t1", url: "https://example.com/", title: "Example", current: true };

/** A `Browser` that answers every call at once, recording what it was asked. */
const fake = (overrides: Partial<Service> = {}) => {
  const calls: [string, unknown][] = [];
  const tab = (name: string) => (sessionId: string, options: unknown) => {
    calls.push([name, { sessionId, ...(options as object) }]);
    return Effect.succeed(TAB);
  };
  const service: Service = {
    open: tab("open"),
    tabs: () => Effect.succeed([TAB]),
    close: () => Effect.succeed([]),
    navigate: tab("navigate"),
    snapshot: () =>
      Effect.succeed({
        ...TAB,
        generation: 2,
        tree: '- button "Save" [ref=s2-e3]',
        truncated: false,
        console: [{ level: "error", text: "Uncaught boom" }],
      }),
    click: tab("click"),
    type: tab("type"),
    press: tab("press"),
    hover: tab("hover"),
    select: tab("select"),
    scroll: tab("scroll"),
    evaluate: () => Effect.succeed({ value: { n: 2 }, truncated: false }),
    screenshot: () => Effect.succeed({ data: "iVBORw0KGgo=", mimeType: "image/png", width: 1280, height: 800 }),
    waitFor: tab("waitFor"),
    render: (html, options) => {
      calls.push(["render", { html, ...options }]);
      return Effect.succeed({
        width: options.width,
        contentHeight: 320,
        capturedHeight: 320,
        screenshot: { data: "iVBORw0KGgo=", mimeType: "image/png", width: options.width, height: 320 },
        console: [{ level: "log", text: "checked" }],
      });
    },
    ...overrides,
  };
  return { service, calls };
};

const byName = (service: Service, name: string) => [...browserTools(service), htmlPreviewTool(service)].find((tool) => tool.name === name)!;
const ctx = context("/tmp");

describe("the browser tools", () => {
  it("resolve a script's call to what they did, and tell the model in words", async () => {
    const { service, calls } = fake();
    const clicked = await call(byName(service, "browser_click"), { ref: "s2-e3" }, ctx);
    expect(textOf(clicked)).toBe("Clicked s2-e3. Current tab: t1 · Example — https://example.com/");
    expect(clicked.structured).toEqual(TAB);
    expect(calls).toEqual([["click", { sessionId: "s", ref: "s2-e3" }]]);
  });

  it("say when a page came with an HTTP error status, which loads as any page does", async () => {
    const { service } = fake({ navigate: () => Effect.succeed({ ...TAB, status: 404 }), open: () => Effect.succeed({ ...TAB, status: 200 }) });
    expect(textOf(await call(byName(service, "browser_navigate"), { url: "https://example.com/" }, ctx))).toBe(
      "Loaded t1 · Example — https://example.com/ (HTTP 404)",
    );
    expect(textOf(await call(byName(service, "browser_open"), { url: "https://example.com/" }, ctx))).toBe("Opened t1 · Example — https://example.com/");
  });

  it("keep a screenshot too large for the model out of its result, still giving it to a script", async () => {
    const huge = "A".repeat(6 * 1024 * 1024);
    const { service } = fake({ screenshot: () => Effect.succeed({ data: huge, mimeType: "image/jpeg", width: 1280, height: 8000 }) });
    const shot = await call(byName(service, "browser_screenshot"), { fullPage: true }, ctx);
    expect(shot.content).toEqual([{ type: "text", text: expect.stringMatching(/^Screenshot 1280×8000 \(image\/jpeg\): too large to attach/) }]);
    expect((shot.structured as { data: string }).data).toBe(huge);
  });

  it("read a page as its tree, with its refs' generation and what it logged", async () => {
    const snapshot = await call(byName(fake().service, "browser_snapshot"), {}, ctx);
    expect(textOf(snapshot)).toBe(
      't1 · Example\nURL: https://example.com/\nSnapshot 2: refs s2-…, good until the next snapshot or a navigation\n\n- button "Save" [ref=s2-e3]\n\nConsole since the last snapshot:\n[error] Uncaught boom',
    );
    expect(snapshot.structured).toMatchObject({ generation: 2, tree: '- button "Save" [ref=s2-e3]' });
  });

  it("give a screenshot as an image block for scripts, and an image for the model", async () => {
    const shot = await call(byName(fake().service, "browser_screenshot"), {}, ctx);
    expect(shot.content).toEqual([
      { type: "text", text: "Screenshot 1280×800 (image/png)" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
    expect(shot.structured).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png", note: "Screenshot 1280×800 (image/png)" });
  });

  it("fail with the browser's own words, for the model to act on", async () => {
    const { service } = fake({ click: () => Effect.fail(new BrowserError({ reason: "StaleRef", message: "Ref s1-e3 is from an earlier snapshot" })) });
    await expect(call(byName(service, "browser_click"), { ref: "s1-e3" }, ctx)).rejects.toMatchObject({ message: "Ref s1-e3 is from an earlier snapshot" });
  });

  it("previews a page with the theme and its local images, at the reply column's width by default", async () => {
    const { service, calls } = fake();
    const preview = await call(
      byName(service, "html_preview"),
      { html: "<!doctype html><html><head></head><body><img src='/nonexistent/x.png'></body></html>" },
      ctx,
    );
    const [, rendered] = calls[0] as [string, { html: string; width: number; colorScheme: string }];
    expect(rendered).toMatchObject({ width: 728, colorScheme: "dark" });
    expect(rendered.html).toMatch(/<head><style id="lemma-theme">:root \{ color-scheme: dark; --bg: #0b0b0b;/);
    expect(preview.content[0]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
    expect(preview.structured).toMatchObject({
      width: 728,
      contentHeight: 320,
      console: [{ level: "log", text: "checked" }],
      missingImages: ["/nonexistent/x.png"],
      screenshot: { type: "image", mimeType: "image/png" },
    });
    const text = (preview.content[1] as { text: string }).text;
    expect(text).not.toContain("Taller than");
  });

  it("says when a page is taller than a page in the chat reads well at, at the chat's width", async () => {
    const { service } = fake({
      render: (_html, options) =>
        Effect.succeed({
          width: options.width,
          contentHeight: 9892,
          capturedHeight: 4000,
          screenshot: { data: "iVBORw0KGgo=", mimeType: "image/png", width: options.width, height: 4000 },
          console: [],
        }),
    });
    const preview = await call(byName(service, "html_preview"), { html: "<p>x</p>" }, ctx);
    const text = (preview.content[1] as { text: string }).text;
    expect(text).toMatch(/^Page at 728px, dark: 9892px tall, the first 4000px shown\nTaller than the 1500px a page in the chat reads well at/);
    // At a phone's width a page is taller than in the chat: that is no reason to trim it.
    const phone = await call(byName(service, "html_preview"), { html: "<p>x</p>", width: 390 }, ctx);
    expect((phone.content[1] as { text: string }).text).not.toContain("Taller than");
  });
});

describe("the plugin", () => {
  const browser = definePlugin({ id: "fake.browser", provides: { browser: Browser }, setup: () => Effect.succeed({ browser: fake().service }) });

  it("adds the browser tools for scripts only, in the browser namespace, and html_preview for the model too", async () => {
    const { listed, namespaces } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([registry, browser, tools]);
          return yield* core.run(
            Effect.all({
              listed: Effect.flatMap(ToolRunner, (runner) => runner.list),
              namespaces: Effect.flatMap(Registries, (registries) => registries.items(ToolNamespaces)),
            }),
          );
        }),
      ),
    );
    expect(namespaces.map(({ item }) => item.name)).toEqual(["browser"]);
    const browserOnes = listed.filter((tool) => tool.spec.name.startsWith("browser_"));
    expect(browserOnes).toHaveLength(14);
    for (const tool of browserOnes) expect(tool).toMatchObject({ source: "browser.tools", nested: true, namespace: "browser", output: expect.any(Object) });
    const preview = listed.find((tool) => tool.spec.name === "html_preview")!;
    expect(preview.nested).toBeUndefined();
    expect(preview.output).toMatchObject({ type: "object", required: expect.arrayContaining(["contentHeight", "screenshot"]) });
    expect(JSON.stringify(listed)).not.toContain("$schema");
  });
});

/** The Chromium the `browser` dev shell names: this test draws a real page with it, and skips without it. */
const executable = process.env.LEMMA_CHROMIUM === "" ? undefined : process.env.LEMMA_CHROMIUM;

describe.skipIf(executable === undefined)("html_preview in Chromium", () => {
  it("draws the page as the chat would, reporting its height and console", async () => {
    const { makeChromium } = await import("@lemma/browser-chromium");
    const real = makeChromium({ idleMs: 0, headless: true, executablePath: executable });
    try {
      const preview = await call(
        htmlPreviewTool(real.service),
        {
          html: `<!doctype html><html><head></head><body><div id="box" style="height: 240px; background: var(--chart-1)"></div><script>console.log(getComputedStyle(document.documentElement).getPropertyValue("--bg").trim())</script></body></html>`,
          width: 390,
          appearance: "light",
        },
        ctx,
      );
      expect(preview.structured).toMatchObject({ width: 390, contentHeight: 240, console: [{ level: "log", text: "#fafafa" }], missingImages: [] });
    } finally {
      await real.close();
    }
    // It starts a Chromium, which a busy machine starts slowly.
  }, 60_000);
});
