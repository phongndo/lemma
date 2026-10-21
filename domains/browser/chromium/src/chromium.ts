import { Effect, Semaphore } from "effect";
import type { Context } from "effect";
import type { Browser as PlaywrightBrowser, BrowserContext, BrowserType, Locator, Page } from "playwright-core";
import { BrowserError, hasTarget, parseRef, targetProblem } from "@lemma/browser";
import type { Browser, BrowserImage, BrowserTab, BrowserTarget, ConsoleMessage, InTab, LoadState } from "@lemma/browser";
import { HTML_MEASURE_SOURCE } from "@lemma/tools/html";
import { findChromium, isExecutableFile } from "./executable.ts";
import { isLocalUrl } from "./local.ts";
import { capTree, consoleLevel, consoleMessage, fieldRefs, keepMessage, maskFields, MAX_CONSOLE_MESSAGES, withGeneration } from "./snapshot.ts";

type Service = Context.Service.Shape<typeof Browser>;

/** A session's tab: its page, and which snapshot's refs are good on it now. */
interface Tab {
  readonly id: string;
  readonly page: Page;
  /** Snapshots taken in it. */
  generation: number;
  /** The snapshot whose refs are good: the latest, until the page navigates. */
  valid: number | undefined;
  /** What it logged since its last snapshot. */
  readonly console: ConsoleMessage[];
  /** Windows it asked to open (a link with target=_blank, `window.open`), which an action that caused one waits for. */
  windowOpens: number;
}

/** A session's profile: its own cookies and storage, and its tabs. */
interface Session {
  readonly context: BrowserContext;
  readonly tabs: Map<string, Tab>;
  current: string | undefined;
  /** Tabs it has opened, which numbers the next. */
  opened: number;
  /** Tabs its pages opened themselves (popups), and who waits for the next. */
  popups: number;
  readonly popupWaiters: (() => void)[];
}

export interface ChromiumOptions {
  /** The config's `executablePath`. */
  readonly executablePath?: string | undefined;
  /** How long after its last call the browser closes; 0: never. */
  readonly idleMs: number;
  readonly headless: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** How long `render` waits for a page to load: 20 seconds by default. */
  readonly renderTimeoutMs?: number;
}

/** How long an action waits for its target, and a navigation for its page. */
const ACTION_TIMEOUT_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
/** The longest a `waitFor` may wait. */
const MAX_WAIT_MS = 60_000;
/** A new tab's viewport. */
const VIEWPORT = { width: 1280, height: 800 } as const;
/** The tallest full-page screenshot, and the tallest page `render` captures, in CSS pixels. */
const MAX_SCREENSHOT_HEIGHT = 8_000;
const MAX_RENDER_HEIGHT = 4_000;
/** An expression's value past this many characters of JSON comes back cut. */
const MAX_VALUE_CHARS = 64 * 1024;
/** `render`'s page address: requests to it are answered with the page, so it never reaches a network. */
const RENDER_URL = "http://lemma-page.localhost/page.html";
/** How long an action that asked for a new window waits for it to show as a tab. */
const POPUP_WAIT_MS = 3_000;
/** How long a navigation cut off by one still under way waits for that one to land before going again. */
const INTERRUPTED_WAIT_MS = 5_000;
/** How long `render` waits for a page to load, unless told otherwise. */
const RENDER_TIMEOUT_MS = 20_000;
/** Pages `render` draws at once; more wait. */
const RENDERS_AT_ONCE = 2;

/**
 * Run in a page: scrolls what a wheel at (x, y) would, the innermost element there that can scroll that way, else the
 * page, by (dx, dy) at once. A synthetic wheel event is not delivered after some actions, and scrolls smoothly after it
 * returns, so a scroll is made directly instead, and has happened when the call returns.
 */
const scrollAt = ({ x, y, dx, dy }: { x: number; y: number; dx: number; dy: number }) => {
  const scrolls = (element: Element) => {
    const style = getComputedStyle(element);
    const vertical = dy !== 0 && /auto|scroll|overlay/.test(style.overflowY) && element.scrollHeight > element.clientHeight;
    const horizontal = dx !== 0 && /auto|scroll|overlay/.test(style.overflowX) && element.scrollWidth > element.clientWidth;
    return vertical || horizontal;
  };
  let element = document.elementFromPoint(x, y);
  while (element !== null && element !== document.body && element !== document.documentElement && !scrolls(element)) element = element.parentElement;
  const target =
    element === null || element === document.body || element === document.documentElement ? (document.scrollingElement ?? document.documentElement) : element;
  target.scrollBy({ left: dx, top: dy, behavior: "instant" });
};

const fail = (reason: BrowserError["reason"], message: string, cause?: unknown) =>
  new BrowserError({ reason, message, ...(cause === undefined ? {} : { cause }) });

/** Playwright's first line, without its call log: what went wrong, not every step it took. */
const firstLine = (message: string) =>
  message
    .split("\n")[0]!
    .replace(/^\w+\.\w+: /, "")
    .replace(/\.+$/, "");

/** What `target` names, for an error to say. */
const describe = (target: BrowserTarget) =>
  target.ref !== undefined
    ? `ref ${target.ref}`
    : target.locator !== undefined
      ? `locator ${target.locator}`
      : target.selector !== undefined
        ? `selector ${target.selector}`
        : `point (${target.x}, ${target.y})`;

/** A Playwright failure as a `BrowserError` the model can act on. */
const toBrowserError = (cause: unknown, target?: BrowserTarget): BrowserError => {
  if (cause instanceof BrowserError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  const what = target === undefined || !hasTarget(target) ? "the page" : describe(target);
  if (/strict mode violation/i.test(message)) {
    const count = /resolved to (\d+) elements/.exec(message)?.[1];
    return fail("InvalidTarget", `${what} matches ${count ?? "several"} elements: use a ref from browser_snapshot, or a more specific locator`, cause);
  }
  if ((cause instanceof Error && cause.name === "TimeoutError") || /Timeout \d+ms exceeded/.test(message))
    return fail("Timeout", `Timed out on ${what}: ${firstLine(message)}. Take a snapshot to see what the page shows now`, cause);
  const network = /net::ERR_[A-Z_]+ at \S+/.exec(message)?.[0];
  if (network !== undefined) return fail("Failed", `Could not load the page (${network}): check the address, or whether the site is up`, cause);
  if (/has been closed|Target closed|browser has disconnected/i.test(message))
    return fail("NoTab", "The tab or the browser closed during the call: open a tab again with browser_open", cause);
  return fail("Failed", firstLine(message), cause);
};

/**
 * A value an expression gave as JSON text: a BigInt as its digits with `n`, a reference back into an object that holds
 * it as `"[Circular]"` (one reached twice by other paths is written out each time), and nothing (`undefined`, a
 * function) as `null`, so any value the page has comes back.
 */
export const toJson = (value: unknown): string => {
  // The objects holding the one written now, outermost first: `this` is its holder, so the rest were left behind.
  const holders: object[] = [];
  const json = JSON.stringify(value, function (this: unknown, _, item: unknown) {
    if (typeof item === "bigint") return `${item}n`;
    if (typeof item !== "object" || item === null) return item;
    while (holders.length > 0 && holders.at(-1) !== this) holders.pop();
    if (holders.includes(item)) return "[Circular]";
    holders.push(item);
    return item;
  });
  return json ?? "null";
};

/**
 * Playwright's Chromium, imported by the first call that launches the browser rather than with the plugin: Playwright is
 * most of the code the host would otherwise load at start (about 7 MB), for a browser most runs never open. If it cannot
 * be loaded, that call fails `Unavailable` saying so, as when no Chromium is found, and the next call tries again.
 */
let playwright: Promise<BrowserType> | undefined;
const loadPlaywright = (): Promise<BrowserType> =>
  (playwright ??= import("playwright-core").then(
    (loaded) => loaded.chromium,
    (cause: unknown) => {
      playwright = undefined;
      throw fail(
        "Unavailable",
        `Playwright (playwright-core) could not be loaded: ${firstLine(cause instanceof Error ? cause.message : String(cause))}`,
        cause,
      );
    },
  ));

/** A tab as the contract gives it. */
const tabInfo = async (session: Session, tab: Tab, status?: number): Promise<BrowserTab> => ({
  tabId: tab.id,
  url: tab.page.url(),
  title: await tab.page.title().catch(() => ""),
  current: session.current === tab.id,
  ...(status === undefined ? {} : { status }),
});

/**
 * `Browser` over a Chromium that Playwright launches on first use, headless unless configured otherwise. Each session
 * gets a browser context of its own; the browser closes `idleMs` after its last call ends (the sessions' tabs with it),
 * when it disconnects, and on `close`.
 */
export const makeChromium = (options: ChromiumOptions) => {
  const env = options.env ?? process.env;
  const renderTimeout = options.renderTimeoutMs ?? RENDER_TIMEOUT_MS;
  let launched: Promise<PlaywrightBrowser> | undefined;
  /** Each session's profile, made on its first call. */
  const sessions = new Map<string, Promise<Session>>();
  /** Calls running now: the browser stays open while any does. */
  let active = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let executable: string | undefined;
  const renders = Semaphore.makeUnsafe(RENDERS_AT_ONCE);

  const reset = () => {
    launched = undefined;
    sessions.clear();
  };

  /** The browser, launched by the first call; one that fails to launch is tried again by the next. */
  const browser = (): Promise<PlaywrightBrowser> => {
    if (launched !== undefined) return launched;
    const starting = loadPlaywright()
      .then((chromium) => {
        const found = findChromium({
          configured: options.executablePath,
          env,
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
        if ("problem" in found) throw fail("Unavailable", found.problem);
        executable = found.path;
        return chromium.launch({ executablePath: found.path, headless: options.headless }).catch((cause: unknown) => {
          throw fail("Unavailable", `Chromium at ${found.path} did not start: ${firstLine(cause instanceof Error ? cause.message : String(cause))}`, cause);
        });
      })
      .then(
        (started) => {
          started.on("disconnected", () => {
            if (launched === starting) reset();
          });
          return started;
        },
        (cause: unknown) => {
          if (launched === starting) reset();
          throw cause;
        },
      );
    launched = starting;
    return starting;
  };

  /** Closes the browser, and every session's tabs with it. */
  const shutdown = async () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    const closing = launched;
    reset();
    if (closing !== undefined) await closing.then((started) => started.close()).catch(() => {});
  };

  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (active > 0 || options.idleMs <= 0 || launched === undefined) return;
    idleTimer = setTimeout(() => void shutdown(), options.idleMs);
    idleTimer.unref();
  };

  /** Runs one call: the browser stays open while it runs, and its idle time counts from when the last call ends. */
  const use = <A>(work: () => Promise<A>, target?: BrowserTarget): Effect.Effect<A, BrowserError> =>
    Effect.tryPromise({
      try: async () => {
        active++;
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        try {
          return await work();
        } finally {
          active--;
          armIdle();
        }
      },
      catch: (cause) => toBrowserError(cause, target),
    });

  const addTab = (session: Session, page: Page): Tab => {
    const tab: Tab = { id: `t${++session.opened}`, page, generation: 0, valid: undefined, console: [], windowOpens: 0 };
    session.tabs.set(tab.id, tab);
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    page.on("console", (message) => keepMessage(tab.console, consoleMessage(consoleLevel(message.type()), message.text())));
    page.on("pageerror", (error) => keepMessage(tab.console, consoleMessage("error", error.stack ?? error.message)));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) tab.valid = undefined;
    });
    // A page the tab opens (a link with target=_blank, a sign-in window) is a tab of its own, and the current one.
    page.on("popup", (popup) => {
      session.current = addTab(session, popup).id;
      session.popups++;
      for (const wake of session.popupWaiters.splice(0)) wake();
    });
    // Chromium says a window is about to open while the action that opens it runs, before the popup arrives: the action
    // waits for it then, and only then.
    void session.context
      .newCDPSession(page)
      .then(async (cdp) => {
        cdp.on("Page.windowOpen", () => void tab.windowOpens++);
        await cdp.send("Page.enable");
      })
      .catch(() => {});
    page.on("close", () => {
      session.tabs.delete(tab.id);
      if (session.current === tab.id) session.current = [...session.tabs.keys()].at(-1);
    });
    return tab;
  };

  const sessionOf = (sessionId: string): Promise<Session> => {
    const known = sessions.get(sessionId);
    if (known !== undefined) return known;
    const making = browser()
      .then((started) => started.newContext({ viewport: VIEWPORT }))
      .then((context): Session => ({ context, tabs: new Map(), current: undefined, opened: 0, popups: 0, popupWaiters: [] }));
    making.catch(() => {
      if (sessions.get(sessionId) === making) sessions.delete(sessionId);
    });
    sessions.set(sessionId, making);
    return making;
  };

  const tabOf = async (sessionId: string, { tabId }: InTab): Promise<{ readonly session: Session; readonly tab: Tab }> => {
    const session = await (sessions.get(sessionId) ?? Promise.reject(noTabs(options.idleMs)));
    const id = tabId ?? session.current;
    if (id === undefined) throw noTabs(options.idleMs);
    const tab = session.tabs.get(id);
    if (tab === undefined) {
      const open = [...session.tabs.keys()];
      throw fail("NoTab", `No tab ${id} in this session (${open.length === 0 ? "none is open" : `its tabs: ${open.join(", ")}`}): open one with browser_open`);
    }
    return { session, tab };
  };

  /** What `target` names on the tab's page; a point has no locator. */
  const locate = (tab: Tab, target: BrowserTarget): Locator | undefined => {
    const problem = targetProblem(target);
    if (problem !== undefined) throw fail("InvalidTarget", problem);
    if (target.ref !== undefined) {
      const ref = parseRef(target.ref);
      if (ref === undefined)
        throw fail("InvalidTarget", `"${target.ref}" is not a ref a snapshot gave (they look like s3-e12): take one with browser_snapshot`);
      if (tab.valid !== ref.generation)
        throw fail(
          "StaleRef",
          ref.generation > tab.generation
            ? `Ref ${target.ref} is not from a snapshot of ${tab.id} (${tab.generation === 0 ? "none has been taken" : `its latest is snapshot ${tab.generation}`}), perhaps another tab's or session's: take a snapshot with browser_snapshot and use its refs`
            : `Ref ${target.ref} is from an earlier snapshot of ${tab.id}${tab.valid === undefined ? ", and the page has navigated since" : ""}: take a new snapshot with browser_snapshot and use its refs`,
        );
      return tab.page.getByRef(ref.element);
    }
    if (target.locator !== undefined) return byLocator(tab.page, target.locator);
    if (target.selector !== undefined) return tab.page.locator(`css=${target.selector}`);
    return undefined;
  };

  /**
   * A Playwright selector (`role=button[name='Save']`, `text=Sign in`, `css=…`), or one of the shorthands for Playwright's
   * `getBy…` locators: `label=Email`, `placeholder=Search`, `alt=Logo`, `title=Close`, `testid=submit` (quotes optional).
   */
  const byLocator = (page: Page, locator: string): Locator => {
    const shorthand = /^(label|placeholder|alt|title|testid)=(.*)$/s.exec(locator.trim());
    if (shorthand === null) return page.locator(locator);
    const text = shorthand[2]!.trim().replace(/^(["'])(.*)\1$/s, "$2");
    switch (shorthand[1]) {
      case "label":
        return page.getByLabel(text);
      case "placeholder":
        return page.getByPlaceholder(text);
      case "alt":
        return page.getByAltText(text);
      case "title":
        return page.getByTitle(text);
      default:
        return page.getByTestId(text);
    }
  };

  /**
   * Loads `url` in `page`. Chromium lands a navigation it had under way after the call that started it has given up (the
   * error page of a failed load, a load cut off by a later one), and that landing cuts off the next navigation, then that
   * one the next: so a failed load waits for its error page, and a navigation cut off that way waits for the one that
   * cut it off to land, then goes again, once.
   */
  const goto = async (page: Page, url: string, waitUntil: LoadState): Promise<number | undefined> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await page.goto(url, { waitUntil }))?.status();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const interrupting = /is interrupted by another navigation to "([^"]*)"/.exec(message)?.[1];
        if (interrupting !== undefined && attempt === 0) {
          await page.waitForURL(interrupting, { waitUntil: "commit", timeout: INTERRUPTED_WAIT_MS }).catch(() => {});
          continue;
        }
        if (/net::ERR_/.test(message) && !page.url().startsWith("chrome-error:"))
          await page.waitForURL(/^chrome-error:/, { waitUntil: "commit", timeout: INTERRUPTED_WAIT_MS }).catch(() => {});
        throw cause;
      }
    }
  };

  /** A navigation an action started is under way: give it a moment to land, so the tab's address is where it went. */
  const settle = (page: Page) => page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});

  /** Runs an action on the tab, and gives the session's current tab afterwards (a popup it opened, else the same). */
  const act = (sessionId: string, options: InTab & BrowserTarget, work: (tab: Tab, locator: Locator | undefined) => Promise<void>) =>
    use(async () => {
      const { session, tab } = await tabOf(sessionId, options);
      const opens = tab.windowOpens;
      const popups = session.popups;
      await work(tab, hasTarget(options) ? locate(tab, options) : undefined);
      await settle(tab.page);
      // It asked for a window that has not arrived yet: wait for it, so the result names the tab it opened. A window
      // Chromium refuses (a data: URL) never arrives, and the wait ends at its limit.
      if (tab.windowOpens > opens && session.popups === popups) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, POPUP_WAIT_MS);
          session.popupWaiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      const current = session.tabs.get(session.current ?? tab.id) ?? tab;
      if (current !== tab) await settle(current.page);
      return tabInfo(session, current);
    }, options);

  const point = (options: BrowserTarget) => ({ x: options.x!, y: options.y! });

  const service: Service = {
    open: (sessionId, { tabId, url, newTab }) =>
      use(async () => {
        const session = await sessionOf(sessionId);
        let tab = tabId === undefined ? undefined : session.tabs.get(tabId);
        if (tabId !== undefined && tab === undefined)
          throw fail("NoTab", `No tab ${tabId} in this session: leave tabId out to open a new one, or list them with browser_tabs`);
        if (tab === undefined && newTab !== true && session.current !== undefined) tab = session.tabs.get(session.current);
        tab ??= addTab(session, await session.context.newPage());
        session.current = tab.id;
        const status = url === undefined ? undefined : await goto(tab.page, url, "load");
        return tabInfo(session, tab, status);
      }),

    tabs: (sessionId) =>
      Effect.promise(async () => {
        const session = await sessions.get(sessionId)?.catch(() => undefined);
        return session === undefined ? [] : Promise.all([...session.tabs.values()].map((tab) => tabInfo(session, tab)));
      }),

    close: (sessionId, options) =>
      use(async () => {
        const { session, tab } = await tabOf(sessionId, options);
        await tab.page.close();
        session.tabs.delete(tab.id);
        if (session.current === tab.id) session.current = [...session.tabs.keys()].at(-1);
        return Promise.all([...session.tabs.values()].map((left) => tabInfo(session, left)));
      }),

    navigate: (sessionId, { url, waitUntil, ...options }) =>
      use(async () => {
        const { session, tab } = await tabOf(sessionId, options);
        const status = await goto(tab.page, url, waitUntil ?? "load");
        return tabInfo(session, tab, status);
      }),

    snapshot: (sessionId, options) =>
      use(async () => {
        const { tab } = await tabOf(sessionId, options);
        const raw = await tab.page.ariaSnapshot({ mode: "ai", timeout: ACTION_TIMEOUT_MS });
        // Password fields' values, and fields drawn as dots, are never in a snapshot: each field showing a value is
        // looked up by its ref, and one that is secret, or cannot be looked up, has its value hidden.
        const secret = new Set<string>();
        await Promise.all(
          fieldRefs(raw).map(async (ref) => {
            const hidden = await tab.page
              .getByRef(ref)
              .evaluate(
                (element) =>
                  element instanceof HTMLInputElement &&
                  (element.type === "password" || getComputedStyle(element).getPropertyValue("-webkit-text-security") !== "none"),
                undefined,
                { timeout: 2_000 },
              )
              .catch(() => true);
            if (hidden) secret.add(ref);
          }),
        );
        tab.generation++;
        tab.valid = tab.generation;
        const { tree, truncated } = capTree(withGeneration(maskFields(raw, secret), tab.generation));
        return {
          tabId: tab.id,
          url: tab.page.url(),
          title: await tab.page.title().catch(() => ""),
          generation: tab.generation,
          tree,
          truncated,
          console: tab.console.splice(0, MAX_CONSOLE_MESSAGES),
        };
      }),

    click: (sessionId, options) =>
      act(sessionId, options, async (tab, locator) => {
        const how = { button: options.button ?? "left", clickCount: options.clickCount ?? 1 } as const;
        if (locator === undefined) await tab.page.mouse.click(options.x!, options.y!, how);
        else await locator.click(how);
      }),

    type: (sessionId, options) =>
      act(sessionId, options, async (tab, locator) => {
        if (locator === undefined) {
          await tab.page.mouse.click(options.x!, options.y!);
          await tab.page.keyboard.type(options.text);
        } else await locator.fill(options.text);
        if (options.submit !== true) return;
        if (locator === undefined) await tab.page.keyboard.press("Enter");
        else await locator.press("Enter");
      }),

    press: (sessionId, options) =>
      act(sessionId, options, async (tab, locator) => {
        if (locator !== undefined) await locator.press(options.key);
        else if (hasTarget(options)) {
          await tab.page.mouse.click(options.x!, options.y!);
          await tab.page.keyboard.press(options.key);
        } else await tab.page.keyboard.press(options.key);
      }),

    hover: (sessionId, options) =>
      act(sessionId, options, async (tab, locator) => {
        if (locator === undefined) {
          const { x, y } = point(options);
          await tab.page.mouse.move(x, y);
        } else await locator.hover();
      }),

    select: (sessionId, options) =>
      act(sessionId, options, async (_, locator) => {
        if (locator === undefined) throw fail("InvalidTarget", "A select needs a ref, locator, or selector naming the <select>, not a point");
        await locator.selectOption([...options.values]);
      }),

    scroll: (sessionId, options) =>
      act(sessionId, options, async (tab, locator) => {
        if (locator !== undefined) return locator.scrollIntoViewIfNeeded();
        const viewport = tab.page.viewportSize() ?? VIEWPORT;
        const { x, y } = hasTarget(options) ? point(options) : { x: viewport.width / 2, y: viewport.height / 2 };
        await tab.page.mouse.move(x, y);
        await tab.page.evaluate(scrollAt, { x, y, dx: options.deltaX ?? 0, dy: options.deltaY ?? viewport.height * 0.8 });
      }),

    evaluate: (sessionId, { expression, ...options }) =>
      use(async () => {
        const { tab } = await tabOf(sessionId, options);
        const json = toJson(await tab.page.evaluate(expression));
        return json.length > MAX_VALUE_CHARS
          ? { value: `${json.slice(0, MAX_VALUE_CHARS)}…`, truncated: true }
          : { value: JSON.parse(json) as unknown, truncated: false };
      }),

    screenshot: (sessionId, { fullPage, maxBytes, ...options }) =>
      use(async (): Promise<BrowserImage> => {
        const { tab } = await tabOf(sessionId, options);
        const viewport = tab.page.viewportSize() ?? VIEWPORT;
        const pageHeight =
          fullPage === true ? await tab.page.evaluate(() => Math.ceil(document.documentElement.scrollHeight)).catch(() => viewport.height) : viewport.height;
        const height = Math.min(pageHeight, MAX_SCREENSHOT_HEIGHT);
        const clip = fullPage === true ? { clip: { x: 0, y: 0, width: viewport.width, height } } : {};
        let data = await tab.page.screenshot({ type: "png", fullPage: fullPage === true, ...clip });
        let mimeType = "image/png";
        // A page too big as PNG for a model's attachment goes as JPEG, at lower quality until it fits.
        for (const quality of [80, 60, 40]) {
          if (maxBytes === undefined || data.length <= maxBytes) break;
          data = await tab.page.screenshot({ type: "jpeg", quality, fullPage: fullPage === true, ...clip });
          mimeType = "image/jpeg";
        }
        return { data: data.toString("base64"), mimeType, width: viewport.width, height };
      }),

    waitFor: (sessionId, { text, load, state, timeoutMs, ...options }) =>
      use(async () => {
        const { session, tab } = await tabOf(sessionId, options);
        const timeout = Math.min(Math.max(timeoutMs ?? ACTION_TIMEOUT_MS, 0), MAX_WAIT_MS);
        if (load === undefined && text === undefined && !hasTarget(options))
          throw fail("InvalidTarget", "Say what to wait for: text, a load state, or a ref, locator, or selector");
        if (load !== undefined) await tab.page.waitForLoadState(load, { timeout });
        if (text !== undefined)
          await tab.page
            .getByText(text)
            .first()
            .waitFor({ state: state ?? "visible", timeout });
        if (hasTarget(options)) {
          const locator = locate(tab, options);
          if (locator === undefined) throw fail("InvalidTarget", "Waiting needs a ref, locator, or selector, not a point");
          await locator.waitFor({ state: state ?? "visible", timeout });
        }
        return tabInfo(session, tab);
      }, options),

    render: (html, { width, colorScheme }) =>
      renders.withPermits(1)(
        use(async () => {
          const started = await browser();
          const context = await started.newContext({ viewport: { width, height: VIEWPORT.height }, colorScheme });
          try {
            const page = await context.newPage();
            const console: ConsoleMessage[] = [];
            let dropped = 0;
            const keep = (message: ConsoleMessage) => (console.length < MAX_CONSOLE_MESSAGES ? console.push(message) : dropped++);
            page.on("console", (message) => keep(consoleMessage(consoleLevel(message.type()), message.text())));
            page.on("pageerror", (error) => keep(consoleMessage("error", error.stack ?? error.message)));
            // The page is answered from here; what it asks of this machine or its network is refused, whatever Chromium
            // would allow, and the console says so.
            const refuse = (url: string) =>
              keep(consoleMessage("error", `Not loaded: ${url} is on this machine or its network, which a preview does not reach`));
            await page.route("**/*", async (route) => {
              const url = route.request().url();
              if (url === RENDER_URL) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
              if (!(await isLocalUrl(url))) return route.continue();
              refuse(url);
              return route.abort("blockedbyclient");
            });
            await page.routeWebSocket(/.*/, async (socket) => {
              if (!(await isLocalUrl(socket.url()))) return void socket.connectToServer();
              refuse(socket.url());
              return socket.close();
            });
            // What the page is still loading, to name when it does not finish.
            const loading = new Set<string>();
            page.on("request", (request) => void loading.add(request.url()));
            page.on("requestfinished", (request) => void loading.delete(request.url()));
            page.on("requestfailed", (request) => void loading.delete(request.url()));
            await page.goto(RENDER_URL, { waitUntil: "load", timeout: renderTimeout }).catch((cause: unknown) => {
              if (!(cause instanceof Error && cause.name === "TimeoutError")) throw cause;
              const named = [...loading].filter((url) => url !== RENDER_URL);
              throw fail(
                "Timeout",
                `The page did not finish loading within ${renderTimeout / 1000} seconds${named.length === 0 ? "" : `; still loading: ${named.slice(0, 3).join(", ")}${named.length > 3 ? `, and ${named.length - 3} more` : ""}`}. Leave out what does not load, or load it from an address that answers`,
                cause,
              );
            });
            const frames = () =>
              page.evaluate(async () => {
                await document.fonts.ready;
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              });
            await frames();
            // Measured as the chat's frame measures it, so a page previewed fits the frame it is shown in.
            const contentHeight = Number(await page.evaluate(HTML_MEASURE_SOURCE));
            const capturedHeight = Math.max(1, Math.min(contentHeight, MAX_RENDER_HEIGHT));
            await page.setViewportSize({ width, height: capturedHeight });
            await frames();
            const shot = await page.screenshot({ type: "png" });
            if (dropped > 0) console.push({ level: "info", text: `… ${dropped} more console messages not shown` });
            return {
              width,
              contentHeight,
              capturedHeight,
              screenshot: { data: shot.toString("base64"), mimeType: "image/png", width, height: capturedHeight },
              console,
            };
          } finally {
            await context.close().catch(() => {});
          }
        }),
      ),
  };

  return {
    service,
    close: shutdown,
    /** What the inspector shows: the executable, whether it runs, and each session's tabs. */
    snapshot: Effect.promise(async () => ({
      executable: executable ?? null,
      running: launched !== undefined,
      calls: active,
      sessions: await Promise.all(
        [...sessions.entries()].map(async ([sessionId, making]) => {
          const session = await making.catch(() => undefined);
          return {
            sessionId,
            tabs: session === undefined ? [] : await Promise.all([...session.tabs.values()].map((tab) => tabInfo(session, tab))),
          };
        }),
      ),
    })),
  };
};

const noTabs = (idleMs: number) =>
  fail(
    "NoTab",
    `No tab is open in this session${idleMs > 0 ? ` (the browser closes ${idleMs < 1000 ? `${idleMs} ms` : `${Math.round(idleMs / 1000)} seconds`} after its last call)` : ""}: open one with browser_open`,
  );
