import { fileURLToPath } from "node:url";
import { app, BrowserWindow, nativeTheme, shell } from "electron";
import { Effect } from "effect";
import { buildKind } from "@lemma/host/paths";
import { DEFAULT_PROFILE, profileHome } from "@lemma/contracts/profiles";
import { profileTitle } from "@lemma/profiles";
import { readTitle } from "@lemma/profiles/local";
import { browserPartition, hostBrowser } from "./browser.ts";
import { ensureHost, failure, kind, owns, pageAt, paths, state } from "./hosts.ts";

/*
 * The app's own windows, each showing the web app of one profile: not the windows a browser page opens (a sign-in,
 * `browser.ts`), which are no window of the app's to reload, to show a link in, or to keep it running for.
 */

export const mac = process.platform === "darwin";
/**
 * The shared app icon (assets/brand); the dark tile reads on light and dark desktops alike. Run from a checkout
 * (`buildKind`), the orange dev icon, so it is told apart from an installed Lemma.
 */
export const icon = fileURLToPath(new URL(`../../../assets/brand/${buildKind === "release" ? "icon-dark" : "icon-dev"}.png`, import.meta.url));
/**
 * The page's heads (`--head-height`, the sidebar's and the page's bars): the window's title bar, whose controls sit
 * in them, centered. On macOS the traffic lights' middle is 7px below their position (measured: at y 13 it sat at
 * 20), so y 17 puts it on the heads' middle, 24, level with their buttons; on Windows and Linux the controls overlay
 * is as tall as a head, and takes the page's colors (`lemma:title-bar`).
 */
export const HEAD_HEIGHT = 48;
/** The controls' colors until the page says its own: its default dark or light background and muted text. */
const overlayColors = () => (nativeTheme.shouldUseDarkColors ? { color: "#0b0b0b", symbolColor: "#a5a5a5" } : { color: "#fafafa", symbolColor: "#5c5c5c" });

/** Each app window, by the profile it shows. */
export const appWindows = new Map<BrowserWindow, string>();
export const windows = (name?: string) =>
  [...appWindows].filter(([window, profile]) => !window.isDestroyed() && (name === undefined || profile === name)).map(([window]) => window);

/** Each of the profile's windows again at its address, from the host now serving; one that fails does not keep the rest from it. */
export const reloadWindows = async (name: string) => {
  const failed: string[] = [];
  await Promise.all(
    windows(name).map(async (page) => {
      let path = "/";
      try {
        const current = new URL(page.webContents.getURL());
        path = `${current.pathname}${current.search}${current.hash}`;
      } catch {
        // Nothing loaded yet: the app's start.
      }
      await page.loadURL(pageAt(name, path)!).catch((error: unknown) => {
        // Closed meanwhile, or the page's own navigation took over.
        if (page.isDestroyed() || (error as { code?: string }).code === "ERR_ABORTED") return;
        failed.push(failure(error));
      });
    }),
  );
  if (failed.length > 0) throw new Error(`Could not reload ${failed.length === 1 ? "a window" : `${failed.length} windows`}: ${failed.join("; ")}`);
};

/** What the profile `name` is called, as its pages show it (`profileTitle`): on this machine, the name it was given. */
const shownName = async (name: string) => {
  const title = state.remote === undefined ? await Effect.runPromise(readTitle(profileHome(paths.root, name))) : undefined;
  return profileTitle({ name, default: name === DEFAULT_PROFILE, ...(title === undefined ? {} : { title }) });
};

export const openWindow = (name: string, url: string) => {
  const partition = browserPartition(name);
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    title: name === DEFAULT_PROFILE ? kind.name.toLowerCase() : `${kind.name.toLowerCase()} · ${name}`,
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
      additionalArguments: [...(owns(name) ? ["--lemma-owns-host"] : []), `--lemma-browser-partition=${partition}`, `--lemma-deep-link-scheme=${kind.scheme}`],
      // The browser view's pages (`browser.ts`); page fullscreen fills the page's place, not the window.
      webviewTag: true,
      disableHtmlFullscreenWindowResize: true,
    },
  });
  appWindows.set(window, name);
  window.once("closed", () => {
    appWindows.delete(window);
    // Off macOS the app goes with its last window, whatever a page left open (its windows close with it).
    if (appWindows.size === 0 && !mac) app.quit();
  });
  hostBrowser(window, partition);
  // The page names itself; another profile's window says whose it is too, by the name it is shown by as the title
  // changes, so windows tell apart in the OS's switcher.
  if (name !== DEFAULT_PROFILE) {
    let titled = 0;
    window.on("page-title-updated", (event, title) => {
      event.preventDefault();
      const asked = ++titled;
      void shownName(name).then((shown) => {
        if (asked === titled && !window.isDestroyed()) window.setTitle(`${title} · ${shown}`);
      });
    });
  }
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
    // The profile's current page's origin: a restarted host may listen on another port.
    if (new URL(target).origin === new URL(pageAt(name) ?? url).origin) return;
    event.preventDefault();
    external(target);
  });
  void window.loadURL(url);
};

/** Opens the first profile's window when the app has none, once its host is known. */
export const openFirstWindow = () => {
  const url = pageAt(state.first);
  if (url !== undefined && windows().length === 0) openWindow(state.first, url);
};

/** Shows `window`, brought forward. */
export const raise = (window: BrowserWindow) => {
  if (window.isMinimized()) window.restore();
  window.focus();
};

/**
 * Shows the profile `name` at `path`: in its open window, where the page's router takes it like an address typed into
 * it, else in a new window once its host is found (started when none runs).
 */
export const openProfile = async (name: string, path?: string) => {
  const [window] = windows(name);
  if (window !== undefined) {
    // A new history entry and a popstate, as an edited address would make: no reload, and back returns.
    if (path !== undefined)
      void window.webContents.executeJavaScript(`history.pushState(null, "", ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent("popstate"));`);
    return raise(window);
  }
  await ensureHost(name);
  if (state.quitting) return;
  openWindow(name, pageAt(name, path)!);
};
