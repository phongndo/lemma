import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import { Effect } from "effect";
import { appUrl, DEEP_LINK_SCHEME, deepLinkPath } from "@lemma/contracts";
import { findTarget, readDiscovery } from "@lemma/contracts/discovery";
import type { Discovery, Target } from "@lemma/contracts/discovery";
import { callChannel, makeHostRpcHttp } from "@lemma/client";
import { CliChannels } from "@lemma/cli";
import { HOST_FLAGS } from "@lemma/host/launch";
import { SHUTDOWN_TIMEOUT_MS as HOST_SHUTDOWN_MS } from "@lemma/host/limits";
import { hostFiles, resolvePaths } from "@lemma/host/paths";
import { hostBrowser } from "./browser.ts";

// The desktop app is the web app in a window: it shows what the host's transport serves, so the two never differ.
// It finds its host like the CLI does: one on another machine (`LEMMA_URL`, or the default environment), else a running local
// one, and starts one only when none runs, since the sessions store has a single writer. A host it started stops
// when it quits.
const hostMain = fileURLToPath(import.meta.resolve("@lemma/host"));
// `pnpm start` runs from apps/desktop; INIT_CWD is where the user invoked it, and the host takes it as the project.
const project = process.env.INIT_CWD ?? homedir();
const paths = resolvePaths({ env: process.env, cwd: project });
/** Development: the page comes from the web app's dev server (`pnpm dev`), which proxies to the host, so edits hot-reload. */
const webUrl = process.env.LEMMA_WEB_URL;
const STARTUP_TIMEOUT_MS = 30_000;
/** The host's own limit on stopping, and a margin: quitting sooner would cut off what it lets finish. */
const SHUTDOWN_TIMEOUT_MS = HOST_SHUTDOWN_MS + 5_000;
const REMOTE_TIMEOUT_MS = 10_000;
/** The shared app icon (assets/brand); the dark tile reads on light and dark desktops alike. */
const icon = fileURLToPath(new URL("../../../assets/brand/icon-dark.png", import.meta.url));

/** What the app says of its own running (a host it started that exited, a start that failed): `<home>/logs/desktop.log`. */
const logLine = (text: string) => {
  try {
    mkdirSync(hostFiles(paths.home).logs, { recursive: true, mode: 0o700 });
    appendFileSync(join(hostFiles(paths.home).logs, "desktop.log"), `${new Date().toISOString()} ${text}\n`, { mode: 0o600 });
  } catch {
    // No log: the app runs on.
  }
};

/**
 * `<home>/desktop.json` while the app runs: its process, and the command that reaches it with a `lemma://` link (the
 * app again, which hands the link to this instance), so `lemma open` shows a page here rather than in a browser.
 */
const desktopFile = join(paths.home, "desktop.json");
const announce = () => {
  try {
    const open = [process.execPath, ...(process.defaultApp ? [resolve(process.argv[1] ?? ".")] : [])];
    writeFileSync(desktopFile, `${JSON.stringify({ pid: process.pid, open })}\n`, { mode: 0o600 });
  } catch {
    // `lemma open` uses a browser then.
  }
};
const unannounce = () => {
  try {
    if ((JSON.parse(readFileSync(desktopFile, "utf8")) as { readonly pid?: unknown }).pid === process.pid) rmSync(desktopFile);
  } catch {
    // Gone already, or another instance's.
  }
};

let host: UtilityProcess | undefined;
let ownsHost = false;
/** The host serving the page, once known. */
let served: { readonly url: string; readonly token: string } | undefined;
/** A deep link that arrived before there was a window to show it in. */
let pending: string | undefined;
const pageAt = (path = "/") => (served === undefined ? undefined : appUrl(webUrl ?? served.url, path, served.token));

/** What keeps the remote host from serving this app, or undefined when it answers to the token. */
const problemWith = async (remote: Target): Promise<string | undefined> => {
  try {
    const response = await fetch(new URL("/api/health", remote.url), {
      headers: { authorization: `Bearer ${remote.token}` },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (response.status === 401) return `It rejected the token from ${remote.from}; \`lemma token\` on that machine prints the current one.`;
    return response.ok ? undefined : `It answered ${response.status} ${response.statusText}.`;
  } catch (error) {
    return failure(error);
  }
};

/** What keeps the web app's dev server from serving the page, or undefined when it does. */
const devServerProblem = async (url: string): Promise<string | undefined> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
    return response.ok ? undefined : `It answered ${response.status} ${response.statusText}.`;
  } catch (error) {
    return failure(error);
  }
};

/** Why a fetch failed: `fetch failed` says nothing, and its cause says why (refused, not found, timed out). */
const failure = (error: unknown): string => {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  return cause instanceof Error ? cause.message : String(cause);
};

/** Resolves true once `problem` finds none; until then each one found asks whether to retry. False to quit. */
const untilReached = async (problem: () => Promise<string | undefined>, message: string, advice: string): Promise<boolean> => {
  for (;;) {
    const found = await problem();
    if (found === undefined) return true;
    const { response } = await dialog.showMessageBox({
      type: "error",
      message,
      detail: `${found}\n\n${advice}`,
      buttons: ["Retry", "Quit"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1) return false;
  }
};

const startHost = async (): Promise<Discovery> => {
  ownsHost = true;
  const child = utilityProcess.fork(hostMain, ["--no-open"], {
    cwd: project,
    // It says the app started it, so `lemma status` names its owner and `lemma stop` leaves it to the app.
    env: { ...process.env, INIT_CWD: project, LEMMA_STARTED_BY: "desktop" },
    // The host's Node.js flags, which are V8's: Electron's utility process takes them as Chromium's `--js-flags` alone.
    execArgv: ["--conditions=lemma-source", `--js-flags=${HOST_FLAGS.join(" ")}`],
    stdio: "inherit",
    serviceName: "lemma host",
  });
  host = child;
  let exited: number | undefined;
  child.once("exit", (code) => {
    exited = code;
    if (!quitting && !reloading) logLine(`the host (pid ${child.pid}) exited with code ${code}; its log is ${hostFiles(paths.home).log}`);
    if (host === child) host = undefined;
  });
  // The transport writes transport.json once it listens; the entry is ours when it names our process.
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(`The host exited with code ${exited} before it started listening; its output is in the terminal.`);
    const entry = await Effect.runPromise(readDiscovery(paths.home));
    if (entry !== undefined && entry.pid === child.pid) return entry;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`The host did not start listening within ${STARTUP_TIMEOUT_MS / 1000}s.`);
};

/** Each host's stop, once begun: a second SIGTERM would end its graceful shutdown partway. */
const exits = new WeakMap<UtilityProcess, Promise<void>>();

/** Resolves once the host exits, or after `SHUTDOWN_TIMEOUT_MS`; a call while it stops waits again without signalling again. */
const stopHost = () => {
  const child = host;
  if (child === undefined) return Promise.resolve();
  let exited = exits.get(child);
  if (exited === undefined) {
    exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    exits.set(child, exited);
    // SIGTERM: the host shuts down its plugins and removes transport.json.
    child.kill();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([exited, new Promise<void>((resolve) => (timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)))]).finally(() => clearTimeout(timer));
};

/** Set once the app starts quitting: nothing starts a host after that. */
let quitting = false;

/**
 * The app's own windows, each showing the web app: not the windows a browser page opens (a sign-in, `browser.ts`),
 * which are no window of the app's to reload, to show a link in, or to keep it running for.
 */
const appWindows = new Set<BrowserWindow>();
const windows = () => [...appWindows].filter((window) => !window.isDestroyed());

/** Each window again at its address, from the host now serving; one that fails does not keep the rest from it. */
const reloadWindows = async () => {
  const failed: string[] = [];
  await Promise.all(
    windows().map(async (page) => {
      if (page.isDestroyed()) return;
      let path = "/";
      try {
        const current = new URL(page.webContents.getURL());
        path = `${current.pathname}${current.search}${current.hash}`;
      } catch {
        // Nothing loaded yet: the app's start.
      }
      await page.loadURL(pageAt(path)!).catch((error: unknown) => {
        // Closed meanwhile, or the page's own navigation took over.
        if (page.isDestroyed() || (error as { code?: string }).code === "ERR_ABORTED") return;
        failed.push(failure(error));
      });
    }),
  );
  if (failed.length > 0) throw new Error(`Could not reload ${failed.length === 1 ? "a window" : `${failed.length} windows`}: ${failed.join("; ")}`);
};

// The `reload` web plugin's restart of a host this app started (README.md).
let reloading = false;
ipcMain.handle("lemma:reload", async (event) => {
  const expected = pageAt();
  if (!ownsHost || event.senderFrame !== event.sender.mainFrame || expected === undefined || new URL(event.sender.getURL()).origin !== new URL(expected).origin)
    throw new Error("Only the window of a host this app started can restart it.");
  if (reloading || quitting) return;
  reloading = true;
  try {
    await stopHost();
    if (quitting) return;
    // Never start a second writer if the old host has not actually exited.
    if (host !== undefined) throw new Error("The host has not stopped yet. Try reloading again once it exits.");
    served = await startHost();
    await reloadWindows();
  } finally {
    reloading = false;
  }
});

/**
 * The page's heads (`--head-height`, the sidebar's and the page's bars): the window's title bar, whose controls sit
 * in them, centered. On macOS the traffic lights' middle is 7px below their position (measured: at y 13 it sat at
 * 20), so y 17 puts it on the heads' middle, 24, level with their buttons; on Windows and Linux the controls overlay
 * is as tall as a head, and takes the page's colors (`lemma:title-bar`).
 */
const HEAD_HEIGHT = 48;
const mac = process.platform === "darwin";
/** The controls' colors until the page says its own: its default dark or light background and muted text. */
const overlayColors = () => (nativeTheme.shouldUseDarkColors ? { color: "#0b0b0b", symbolColor: "#a5a5a5" } : { color: "#fafafa", symbolColor: "#5c5c5c" });

// The page's colors for the window's controls (Windows, Linux), as its look changes. Only a window's own page says.
ipcMain.on("lemma:title-bar", (event, color: unknown, symbolColor: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const hex = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
  if (mac || window === null || event.senderFrame !== event.sender.mainFrame || !hex(color) || !hex(symbolColor)) return;
  window.setTitleBarOverlay({ color, symbolColor, height: HEAD_HEIGHT });
});

const openWindow = (url: string) => {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    title: "lemma",
    icon,
    show: false,
    // No native title bar: the controls overlay the page, which reads where (Window Controls Overlay) and makes its
    // heads the title bar, the controls level with the heads' buttons (`HEAD_HEIGHT`).
    titleBarStyle: "hidden",
    titleBarOverlay: mac ? true : { height: HEAD_HEIGHT, ...overlayColors() },
    trafficLightPosition: { x: 17, y: HEAD_HEIGHT / 2 - 7 },
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: fileURLToPath(new URL("preload.cjs", import.meta.url)),
      additionalArguments: ownsHost ? ["--lemma-owns-host"] : [],
      // The browser view's pages (`browser.ts`); page fullscreen fills the page's place, not the window.
      webviewTag: true,
      disableHtmlFullscreenWindowResize: true,
    },
  });
  appWindows.add(window);
  window.once("closed", () => {
    appWindows.delete(window);
    // Off macOS the app goes with its last window, whatever a page left open (its windows close with it).
    if (appWindows.size === 0 && process.platform !== "darwin") app.quit();
  });
  hostBrowser(window);
  window.once("ready-to-show", () => window.show());
  // Links leave for the system browser, as they would leave the app's tab.
  const external = (target: string) => {
    if (/^https?:|^mailto:/.test(target)) void shell.openExternal(target);
  };
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    external(target);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    // The current page's origin: a restarted host may listen on another port.
    if (new URL(target).origin === new URL(pageAt() ?? url).origin) return;
    event.preventDefault();
    external(target);
  });
  void window.loadURL(url);
};

/**
 * Shows a deep link's address (`lemma://threads/<id>` is `/threads/<id>`):
 * in the open window, where the page's router takes it like an address typed
 * into it, else in a new window, or once the page is known.
 */
const openLink = (path: string) => {
  const [window] = windows();
  if (window === undefined) {
    const url = pageAt(path);
    if (url === undefined) pending = path;
    else openWindow(url);
    return;
  }
  // A new history entry and a popstate, as an edited address would make: no reload, and back returns.
  void window.webContents.executeJavaScript(`history.pushState(null, "", ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent("popstate"));`);
  if (window.isMinimized()) window.restore();
  window.focus();
};
const linkIn = (argv: readonly string[]) => argv.map(deepLinkPath).find((path) => path !== undefined);

const fail = (error: unknown) => {
  logLine(`could not start: ${error instanceof Error ? error.message : String(error)}`);
  dialog.showErrorBox("Lemma could not start", error instanceof Error ? error.message : String(error));
  app.exit(1);
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName("Lemma");
  // `lemma://` links open here. Run from source, the app is Electron with this script as its argument, but only Windows
  // registers those: macOS registers Electron itself, so there a link reaches the app while it runs and not otherwise.
  if (process.defaultApp) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [resolve(process.argv[1] ?? ".")]);
  else app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  pending = linkIn(process.argv);
  // macOS hands links over as an event (also the one that launched the app); elsewhere they arrive as arguments.
  app.on("open-url", (event, link) => {
    event.preventDefault();
    const path = deepLinkPath(link);
    if (path !== undefined) openLink(path);
  });
  app.on("second-instance", (_event, argv) => {
    const link = linkIn(argv);
    if (link !== undefined) return openLink(link);
    const [window] = windows();
    if (window === undefined) {
      const url = pageAt();
      if (url !== undefined) openWindow(url);
      return;
    }
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  /**
   * Electron's default menu, less what the page binds itself: ⌘W closes the pane's tab and ⌘N starts a thread (the web
   * app's Actions), so no menu item takes them first. Quitting closes the window.
   */
  const menu: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(process.platform === "darwin" ? [{ type: "separator" as const }, { role: "front" as const }] : [{ role: "quit" as const }]),
      ],
    },
  ];

  app
    .whenReady()
    .then(async () => {
      // Windows and Linux take the window's `icon`; the macOS Dock takes the app's.
      app.dock?.setIcon(icon);
      Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
      // Without the dev server the window would be blank, and a host started for it would serve nothing.
      if (
        webUrl !== undefined &&
        !(await untilReached(
          () => devServerProblem(webUrl),
          `Nothing serves the web app at ${webUrl}`,
          "This window shows the web app's dev server, which `pnpm dev` runs: it starts the host and the dev server, and opens this window on them.",
        ))
      )
        return app.quit();
      // Found as the CLI finds it (docs/remote.md). A target that is set but unusable fails rather than falling back to
      // a local host, which would act on the wrong machine.
      const target = await Effect.runPromise(findTarget(process.env, paths.home).pipe(Effect.mapError((error) => new Error(error.message))));
      if (target !== undefined && target.source !== "local") {
        // Never a local host beside a remote one: the window shows the remote's page, deep links included.
        const reached = await untilReached(
          () => problemWith(target),
          `Cannot reach the Lemma host at ${target.url}`,
          `The address is set by ${target.from}. Check that the host runs on that machine and that this one can reach it, or run \`lemma env use local\` to use a host on this machine.`,
        );
        if (!reached) return app.quit();
        served = target;
      } else {
        const entry = target ?? (await startHost());
        served = { url: entry.url, token: entry.token };
      }
      openWindow(pageAt(pending)!);
      pending = undefined;
      announce();
    })
    .catch(fail);

  // macOS keeps an app running with no windows; the Dock icon opens a new one.
  app.on("activate", () => {
    const url = pageAt();
    if (url !== undefined && windows().length === 0) openWindow(url);
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Quitting stops a host this app started: first it says what that cuts off, and asks, when there is anything.
  let asking = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    if (host === undefined) {
      quitting = true;
      return;
    }
    event.preventDefault();
    if (asking) return;
    asking = true;
    void inProgress().then(async (work) => {
      asking = false;
      if (work.length > 0) {
        const { response } = await dialog.showMessageBox({
          type: "warning",
          message: "Quit Lemma?",
          detail: `Quitting stops the host this app started, which cuts off:\n${work.map((item) => `• ${item}`).join("\n")}\n\nA running turn resumes when Lemma starts again.`,
          buttons: ["Quit", "Cancel"],
          defaultId: 1,
          cancelId: 1,
        });
        if (response !== 0) {
          // Kept running: a quit that came from closing the last window leaves none, and off macOS nothing else opens one.
          const url = pageAt();
          if (url !== undefined && windows().length === 0) openWindow(url);
          return;
        }
      }
      quitting = true;
      await stopHost();
      app.quit();
    });
  });
  app.on("will-quit", unannounce);
}

/**
 * What stopping the host this app started would cut off, as its plugins say (`cli.in-progress`). A host that cannot say
 * within two seconds, or at all (`cli.registry` is off), is taken to be busy: better to ask needlessly than to cut off a turn unasked.
 */
async function inProgress(): Promise<readonly string[]> {
  if (served === undefined) return [];
  const { url, token } = served;
  return Effect.runPromise(
    Effect.scoped(Effect.flatMap(makeHostRpcHttp(url, token), (rpc) => callChannel(rpc, CliChannels.inProgress, {}))).pipe(
      Effect.map((reports) => reports.flatMap((report) => report.items)),
      Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(["work it could not list in time"]) }),
      Effect.orElseSucceed(() => ["work it could not list (it did not answer)"]),
    ),
  );
}
