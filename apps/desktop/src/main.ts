import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell, utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import { Effect } from "effect";
import { appUrl } from "@lemma/contracts";
import { findTarget, readDiscovery } from "@lemma/contracts/discovery";
import type { Discovery, Target } from "@lemma/contracts/discovery";
import { DEFAULT_PROFILE, isDefaultProfile, profileHome, profileNameProblem, profileOf } from "@lemma/contracts/profiles";
import { callChannel, makeHostRpcHttp } from "@lemma/client";
import { CliChannels } from "@lemma/cli";
import { HOST_FLAGS } from "@lemma/host/launch";
import { deepLinkTarget, isLoopback, ProfileChannels, profileAddress, profileTitle } from "@lemma/profiles";
import { readTitle } from "@lemma/profiles/local";
import { SHUTDOWN_TIMEOUT_MS as HOST_SHUTDOWN_MS } from "@lemma/host/limits";
import { buildKind, hostFiles, KINDS, otherHomeProblem, resolvePaths } from "@lemma/host/paths";
import { browserPartition, hostBrowser } from "./browser.ts";

// The desktop app is the web app in a window: it shows what the host's transport serves, so the two never differ.
// It finds its host like the CLI does: one on another machine (`LEMMA_URL`, or the default environment), else a running local
// one, and starts one only when none runs, since the sessions store has a single writer. A host it started stops
// when it quits. Each profile (`@lemma/contracts/profiles`) is a host of its own, shown in windows of its own: the app
// starts with `LEMMA_PROFILE`'s (the default's when unset), and opens another when a page asks (`lemma:open-profile`)
// or a link names one, from that machine: this one's, or through the host on another (`profiles.open`).
const hostMain = fileURLToPath(import.meta.resolve("@lemma/host"));
// `pnpm start` runs from apps/desktop; INIT_CWD is where the user invoked it, and the host takes it as the project.
const project = process.env.INIT_CWD ?? homedir();
const profileProblem = profileOf(process.env) === undefined ? undefined : profileNameProblem(profileOf(process.env)!);
const paths = resolvePaths({ env: profileProblem === undefined ? process.env : { ...process.env, LEMMA_PROFILE: undefined }, cwd: project });
/** Never on the other kind's home (`otherHomeProblem`), neither attaching to a host there nor starting one. */
const otherHome = otherHomeProblem(paths.root, process.env);
/** Development: the page comes from the web app's dev server (`pnpm dev`), which proxies to the first profile's host, so edits hot-reload. */
const webUrl = process.env.LEMMA_WEB_URL;
const STARTUP_TIMEOUT_MS = 30_000;
/** The host's own limit on stopping, and a margin: quitting sooner would cut off what it lets finish. */
const SHUTDOWN_TIMEOUT_MS = HOST_SHUTDOWN_MS + 5_000;
const REMOTE_TIMEOUT_MS = 10_000;
/**
 * The shared app icon (assets/brand); the dark tile reads on light and dark desktops alike. Run from a checkout
 * (`buildKind`), the orange dev icon, so it is told apart from an installed Lemma.
 */
const icon = fileURLToPath(new URL(`../../../assets/brand/${buildKind === "release" ? "icon-dark" : "icon-dev"}.png`, import.meta.url));
/** What it is shown by, and the scheme of the links it opens: its kind's (`KINDS`). */
const kind = KINDS[buildKind];

/** What the app says of its own running (a host it started that exited, a start that failed): `<root>/logs/desktop.log`. */
const logLine = (text: string) => {
  try {
    mkdirSync(hostFiles(paths.root).logs, { recursive: true, mode: 0o700 });
    appendFileSync(join(hostFiles(paths.root).logs, "desktop.log"), `${new Date().toISOString()} ${text}\n`, { mode: 0o600 });
  } catch {
    // No log: the app runs on.
  }
};

/**
 * `<root>/desktop.json` while the app runs: its process, and the command that reaches it with a link of its scheme (the
 * app again, which hands the link to this instance), so `lemma open` shows a page here rather than in a browser, in
 * the window of the profile the link names.
 */
const desktopFile = join(paths.root, "desktop.json");
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

/** A profile's host as the app holds it. */
interface ProfileHost {
  /** A host this app started, while it runs: the app stops it when it quits. */
  child?: UtilityProcess;
  /** The host serving the profile's windows, once known. */
  served?: { readonly url: string; readonly token: string };
}
const hosts = new Map<string, ProfileHost>();
const hostOf = (name: string): ProfileHost => {
  let held = hosts.get(name);
  if (held === undefined) hosts.set(name, (held = {}));
  return held;
};
/** The profile the app started with: its windows open first, and a link naming none is for it. Known once the host is. */
let first = paths.profile ?? DEFAULT_PROFILE;
/** The host on another machine the app shows, when it shows one: its machine's profiles are opened through it. */
let remote: Target | undefined;
/** A deep link that arrived before there was a window to show it in. */
let pending: { readonly path: string; readonly profile?: string } | undefined;
/** The web app at `path` of the profile's host; the first profile's comes from the dev server while developing. */
const pageAt = (name: string, path = "/") => {
  const served = hosts.get(name)?.served;
  return served === undefined ? undefined : appUrl(name === first ? (webUrl ?? served.url) : served.url, path, served.token);
};
const owns = (name: string) => hosts.get(name)?.child !== undefined;

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

/** Starts a host for the profile `name` on this machine, and resolves with it once it listens. */
const startHost = async (name: string): Promise<Discovery> => {
  const home = profileHome(paths.root, name);
  const env: Record<string, string | undefined> = { ...process.env, LEMMA_HOME: paths.root, INIT_CWD: project, LEMMA_STARTED_BY: "desktop" };
  if (name === DEFAULT_PROFILE) delete env.LEMMA_PROFILE;
  else env.LEMMA_PROFILE = name;
  const child = utilityProcess.fork(hostMain, ["--no-open"], {
    cwd: project,
    // It says the app started it, so `lemma status` names its owner and `lemma stop` leaves it to the app.
    env: env as NodeJS.ProcessEnv,
    // The host's Node.js flags, which are V8's: Electron's utility process takes them as Chromium's `--js-flags` alone.
    execArgv: ["--conditions=lemma-source", `--js-flags=${HOST_FLAGS.join(" ")}`],
    stdio: "inherit",
    serviceName: `${kind.name.toLowerCase()} host${name === DEFAULT_PROFILE ? "" : ` (${name})`}`,
  });
  const held = hostOf(name);
  held.child = child;
  let exited: number | undefined;
  child.once("exit", (code) => {
    exited = code;
    if (!quitting && !reloading.has(name)) logLine(`the host for ${name} (pid ${child.pid}) exited with code ${code}; its log is ${hostFiles(home).log}`);
    if (held.child === child) delete held.child;
  });
  // The transport writes transport.json once it listens; the entry is ours when it names our process.
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited !== undefined)
      throw new Error(`The host for ${name} exited with code ${exited} before it started listening; its log is ${hostFiles(home).log}.`);
    const entry = await Effect.runPromise(readDiscovery(home));
    if (entry !== undefined && entry.pid === child.pid) return entry;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`The host for ${name} did not start listening within ${STARTUP_TIMEOUT_MS / 1000}s.`);
};

/** Opens the profile `name` on the remote's machine through the remote's host (`profiles.open`), which starts it there. */
const openRemote = async (target: Target, name: string) => {
  // A loopback address may be a tunnel to that machine: it carries one port, and another profile's port on loopback is
  // this machine's, which would be handed the profile's token.
  if (isLoopback(target.url))
    throw new Error(`${target.url} is a loopback address, which may be a tunnel to another machine: open the profile "${name}" at its own address`);
  const opened = await Effect.runPromise(
    Effect.scoped(Effect.flatMap(makeHostRpcHttp(target.url, target.token), (rpc) => callChannel(rpc, ProfileChannels.open, { name }))).pipe(
      Effect.mapError((error) => new Error(error.message)),
    ),
  );
  return { url: profileAddress(target.url, opened), token: opened.token };
};

/** Each profile's host as it is being found, so two windows asking at once find one. */
const finding = new Map<string, Promise<{ readonly url: string; readonly token: string }>>();

/** The host serving the profile `name`: the one known, else one running for it, else one this app starts (or, remotely, has its machine start). */
const ensureHost = (name: string): Promise<{ readonly url: string; readonly token: string }> => {
  const known = hosts.get(name)?.served;
  if (known !== undefined && (remote !== undefined || owns(name))) return Promise.resolve(known);
  const going = finding.get(name);
  if (going !== undefined) return going;
  const found = (async () => {
    if (quitting) throw new Error("Lemma is quitting");
    // A profile is made first (`lemma profile create`): a host started for one never made would take another's port.
    if (remote === undefined && name !== DEFAULT_PROFILE && !existsSync(profileHome(paths.root, name)))
      throw new Error(`There is no profile "${name}"; \`lemma profile create ${name}\` makes one`);
    const served =
      remote !== undefined
        ? await openRemote(remote, name)
        : await Effect.runPromise(readDiscovery(profileHome(paths.root, name))).then((entry) => entry ?? startHost(name));
    hostOf(name).served = { url: served.url, token: served.token };
    return hostOf(name).served!;
  })().finally(() => finding.delete(name));
  finding.set(name, found);
  return found;
};

/** Each host's stop, once begun: a second SIGTERM would end its graceful shutdown partway. */
const exits = new WeakMap<UtilityProcess, Promise<void>>();

/** Resolves once the profile's host this app started exits, or after `SHUTDOWN_TIMEOUT_MS`; a call while it stops waits again without signalling again. */
const stopHost = (name: string) => {
  const child = hosts.get(name)?.child;
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
 * The app's own windows, each showing the web app of one profile: not the windows a browser page opens (a sign-in,
 * `browser.ts`), which are no window of the app's to reload, to show a link in, or to keep it running for.
 */
const appWindows = new Map<BrowserWindow, string>();
const windows = (name?: string) =>
  [...appWindows].filter(([window, profile]) => !window.isDestroyed() && (name === undefined || profile === name)).map(([window]) => window);

/** Each of the profile's windows again at its address, from the host now serving; one that fails does not keep the rest from it. */
const reloadWindows = async (name: string) => {
  const failed: string[] = [];
  await Promise.all(
    windows(name).map(async (page) => {
      if (page.isDestroyed()) return;
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

/** The profile of the window whose own page sent `event`, and its window, or undefined for anything else (a frame inside it). */
const senderOf = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const profile = window === null ? undefined : appWindows.get(window);
  return window === null || profile === undefined || event.senderFrame !== event.sender.mainFrame ? undefined : { window, profile };
};

// The `reload` web plugin's restart of a host this app started (README.md): the host of the asking window's profile.
const reloading = new Set<string>();
ipcMain.handle("lemma:reload", async (event) => {
  const sender = senderOf(event);
  const expected = sender === undefined ? undefined : pageAt(sender.profile);
  if (sender === undefined || !owns(sender.profile) || expected === undefined || new URL(event.sender.getURL()).origin !== new URL(expected).origin)
    throw new Error("Only the window of a host this app started can restart it.");
  const name = sender.profile;
  if (reloading.has(name) || quitting) return;
  reloading.add(name);
  try {
    await stopHost(name);
    if (quitting) return;
    // Never start a second writer if the old host has not actually exited.
    if (hosts.get(name)?.child !== undefined) throw new Error("The host has not stopped yet. Try reloading again once it exits.");
    const started = await startHost(name);
    hostOf(name).served = { url: started.url, token: started.token };
    await reloadWindows(name);
  } finally {
    reloading.delete(name);
  }
});

// A page's reopening of the app once Homebrew's cask replaced it (`release.updates`): it quits as Quit does, asking
// first what stopping its hosts cuts off, then opens again, the release now installed. Kept running, it reopens nothing.
let relaunching = false;
ipcMain.handle("lemma:relaunch", (event) => {
  if (senderOf(event) === undefined) throw new Error("Only an app window's page can reopen the app.");
  relaunching = true;
  app.quit();
});

/** A profile's name as this app keeps it: the default's under one name, whichever of its names (`core`) it was given. */
const canonicalProfile = (name: string) => (isDefaultProfile(name) ? DEFAULT_PROFILE : name);

// A page's switch to another profile (`profiles.switcher`): its window, or a new one, from this machine or the remote's.
ipcMain.handle("lemma:open-profile", async (event, name: unknown) => {
  if (senderOf(event) === undefined) throw new Error("Only an app window's page can open a profile.");
  if (typeof name !== "string" || (!isDefaultProfile(name) && profileNameProblem(name) !== undefined))
    throw new Error(`No profile can be named ${JSON.stringify(name)}.`);
  await openProfile(canonicalProfile(name));
});

// A page deleted a profile (`profiles.switcher`): its windows close, and what its pages kept (their browser view's
// logins, the page's own storage at its address) goes with it, so a profile made later with its name or port starts
// with none of it. Only for a profile of this machine that is gone.
ipcMain.handle("lemma:profile-removed", async (event, name: unknown) => {
  if (senderOf(event) === undefined) throw new Error("Only an app window's page can say a profile was deleted.");
  if (typeof name !== "string" || isDefaultProfile(name) || profileNameProblem(name) !== undefined)
    throw new Error(`No profile can be named ${JSON.stringify(name)}.`);
  if (remote !== undefined || existsSync(profileHome(paths.root, name))) return;
  const served = hosts.get(name)?.served;
  hosts.delete(name);
  for (const window of windows(name)) window.close();
  await session.fromPartition(browserPartition(name)).clearStorageData();
  if (served !== undefined) await session.defaultSession.clearStorageData({ origin: new URL(served.url).origin });
});

/** What the profile `name` is called, as its pages show it (`profileTitle`): on this machine, the name it was given. */
const shownName = async (name: string) => {
  const title = remote === undefined ? await Effect.runPromise(readTitle(profileHome(paths.root, name))) : undefined;
  return profileTitle({ name, default: name === DEFAULT_PROFILE, ...(title === undefined ? {} : { title }) });
};

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

// How many threads need the person, by window (`lemma:badge`): the app's icon counts every window's. Only a window's own page says.
const badges = new Map<number, number>();
const showBadges = () => app.setBadgeCount([...badges.values()].reduce((sum, count) => sum + count, 0));
ipcMain.on("lemma:badge", (event, count: unknown) => {
  if (senderOf(event) === undefined || typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 9999) return;
  const id = event.sender.id;
  if (!badges.has(id))
    event.sender.once("destroyed", () => {
      badges.delete(id);
      showBadges();
    });
  badges.set(id, count);
  showBadges();
});

// A notification about a window's thread was picked: that window comes forward.
ipcMain.on("lemma:focus", (event) => {
  const sender = senderOf(event);
  if (sender === undefined) return;
  if (sender.window.isMinimized()) sender.window.restore();
  sender.window.show();
  sender.window.focus();
  if (mac) app.focus({ steal: true });
});

const openWindow = (name: string, url: string) => {
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
    if (appWindows.size === 0 && process.platform !== "darwin") app.quit();
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

/** Shows `window`, brought forward. */
const raise = (window: BrowserWindow) => {
  if (window.isMinimized()) window.restore();
  window.focus();
};

/**
 * Shows the profile `name` at `path`: in its open window, where the page's router takes it like an address typed into
 * it, else in a new window once its host is found (started when none runs).
 */
const openProfile = async (name: string, path?: string) => {
  const [window] = windows(name);
  if (window !== undefined) {
    // A new history entry and a popstate, as an edited address would make: no reload, and back returns.
    if (path !== undefined)
      void window.webContents.executeJavaScript(`history.pushState(null, "", ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent("popstate"));`);
    return raise(window);
  }
  await ensureHost(name);
  if (quitting) return;
  openWindow(name, pageAt(name, path)!);
};

/** Shows a deep link's address (`lemma://threads/<id>` is `/threads/<id>`), in the profile it names, else the first's. */
const openLink = (link: { readonly path: string; readonly profile?: string }) => {
  if (pageAt(first) === undefined) {
    pending = link;
    return;
  }
  const name = link.profile ?? first;
  if (name !== DEFAULT_PROFILE && profileNameProblem(name) !== undefined) return;
  openProfile(name, link.path).catch((error: unknown) => {
    logLine(`could not open the profile ${name}: ${failure(error)}`);
    dialog.showErrorBox(`${kind.name} could not open the profile ${name}`, failure(error));
  });
};
const linkIn = (argv: readonly string[]) => argv.map(deepLinkTarget).find((link) => link !== undefined);

const fail = (error: unknown) => {
  logLine(`could not start: ${error instanceof Error ? error.message : String(error)}`);
  dialog.showErrorBox(`${kind.name} could not start`, error instanceof Error ? error.message : String(error));
  app.exit(1);
};

// A checkout's app keeps its own data (its lock, and its pages' sign-ins) in a folder of its own name, as a release's
// keeps its in its own (`Lemma`, its product name), so one never takes the other for a second instance of itself.
if (buildKind === "checkout") app.setPath("userData", join(app.getPath("appData"), kind.name));
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName(kind.name);
  // Its kind's links open here (`lemma://`, a checkout's `lemma-dev://`), so a link for one never opens the other. Run
  // from source, the app is Electron with this script as its argument, but only Windows registers those: macOS
  // registers Electron itself, so there a link reaches the app while it runs and not otherwise.
  if (process.defaultApp) app.setAsDefaultProtocolClient(kind.scheme, process.execPath, [resolve(process.argv[1] ?? ".")]);
  else app.setAsDefaultProtocolClient(kind.scheme);
  pending = linkIn(process.argv);
  // macOS hands links over as an event (also the one that launched the app); elsewhere they arrive as arguments.
  app.on("open-url", (event, link) => {
    event.preventDefault();
    const target = deepLinkTarget(link);
    if (target !== undefined) openLink(target);
  });
  app.on("second-instance", (_event, argv) => {
    const link = linkIn(argv);
    if (link !== undefined) return openLink(link);
    const [window] = windows();
    if (window === undefined) {
      const url = pageAt(first);
      if (url !== undefined) openWindow(first, url);
      return;
    }
    raise(window);
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
      if (profileProblem !== undefined) throw new Error(`LEMMA_PROFILE: ${profileProblem}`);
      if (otherHome !== undefined) throw new Error(otherHome);
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
      const target = await Effect.runPromise(
        findTarget(process.env, paths.root, undefined, paths.home).pipe(Effect.mapError((error) => new Error(error.message))),
      );
      if (target !== undefined && target.source !== "local") {
        // Never a local host beside a remote one: the window shows the remote's page, deep links included.
        const reached = await untilReached(
          () => problemWith(target),
          `Cannot reach the Lemma host at ${target.url}`,
          `The address is set by ${target.from}. Check that the host runs on that machine and that this one can reach it, or run \`lemma env use local\` to use a host on this machine.`,
        );
        if (!reached) return app.quit();
        remote = target;
        // Its own profile, so a switch back to it finds its window. LEMMA_PROFILE names one of this machine's, not that one's.
        const info = await Effect.runPromise(Effect.scoped(Effect.flatMap(makeHostRpcHttp(target.url, target.token), (rpc) => rpc["Host.Info"]())));
        first = info.profile ?? DEFAULT_PROFILE;
        hostOf(first).served = target;
      } else {
        if (paths.profile !== undefined && !existsSync(paths.home))
          throw new Error(`There is no profile "${paths.profile}" (LEMMA_PROFILE); \`lemma profile create ${paths.profile}\` makes one`);
        const entry = target ?? (await startHost(first));
        hostOf(first).served = { url: entry.url, token: entry.token };
      }
      const link = pending;
      pending = undefined;
      // A link for another profile opens its window; one that cannot be opened (no such profile, a name none can be)
      // is said so, and the first profile's window opens instead.
      let name = first;
      const wanted = link?.profile === undefined ? undefined : canonicalProfile(link.profile);
      if (wanted !== undefined && wanted !== first) {
        try {
          if (wanted !== DEFAULT_PROFILE && profileNameProblem(wanted) !== undefined) throw new Error(`No profile can be named ${JSON.stringify(wanted)}`);
          await ensureHost(wanted);
          name = wanted;
        } catch (error) {
          logLine(`could not open the profile ${wanted}: ${failure(error)}`);
          dialog.showErrorBox(`${kind.name} could not open the profile ${wanted}`, failure(error));
        }
      }
      // The link's address is its profile's: the first profile's window, opened instead, starts at its own start.
      openWindow(name, pageAt(name, name === (wanted ?? first) ? link?.path : undefined)!);
      announce();
    })
    .catch(fail);

  // macOS keeps an app running with no windows; the Dock icon opens a new one.
  app.on("activate", () => {
    const url = pageAt(first);
    if (url !== undefined && windows().length === 0) openWindow(first, url);
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Quitting stops the hosts this app started: first it says what that cuts off, and asks, when there is anything.
  let asking = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    const started = [...hosts].filter(([, held]) => held.child !== undefined).map(([name]) => name);
    if (started.length === 0) {
      quitting = true;
      if (relaunching) app.relaunch();
      return;
    }
    event.preventDefault();
    if (asking) return;
    asking = true;
    void Promise.all(started.map(async (name) => ({ name, work: await inProgress(name) }))).then(async (each) => {
      asking = false;
      const work = each.flatMap(({ name, work }) => (started.length === 1 ? work : work.map((item) => `${name}: ${item}`)));
      if (work.length > 0) {
        const { response } = await dialog.showMessageBox({
          type: "warning",
          message: `Quit ${kind.name}?`,
          detail: `Quitting stops the ${started.length === 1 ? "host" : "hosts"} this app started, which cuts off:\n${work.map((item) => `• ${item}`).join("\n")}\n\nA running turn resumes when ${kind.name} starts again.`,
          buttons: ["Quit", "Cancel"],
          defaultId: 1,
          cancelId: 1,
        });
        if (response !== 0) {
          relaunching = false;
          // Kept running: a quit that came from closing the last window leaves none, and off macOS nothing else opens one.
          const url = pageAt(first);
          if (url !== undefined && windows().length === 0) openWindow(first, url);
          return;
        }
      }
      quitting = true;
      if (relaunching) app.relaunch();
      await Promise.all(started.map(stopHost));
      app.quit();
    });
  });
  app.on("will-quit", unannounce);
}

/**
 * What stopping the profile's host this app started would cut off, as its plugins say (`cli.in-progress`). A host that
 * cannot say within two seconds, or at all (`cli.registry` is off), is taken to be busy: better to ask needlessly than
 * to cut off a turn unasked.
 */
async function inProgress(name: string): Promise<readonly string[]> {
  const served = hosts.get(name)?.served;
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
