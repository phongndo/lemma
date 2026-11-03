import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { app, dialog, Menu } from "electron";
import { Effect } from "effect";
import { errorMessage } from "@lemma/contracts";
import { findTarget } from "@lemma/contracts/discovery";
import type { Target } from "@lemma/contracts/discovery";
import { DEFAULT_PROFILE, profileNameProblem } from "@lemma/contracts/profiles";
import { makeHostRpcHttp } from "@lemma/client";
import { buildKind } from "@lemma/host/paths";
import { deepLinkTarget } from "@lemma/profiles";
import {
  canonicalProfile,
  ensureHost,
  failure,
  hosts,
  inProgress,
  kind,
  logLine,
  otherHome,
  pageAt,
  paths,
  profileProblem,
  serve,
  startHost,
  state,
  stopHost,
  webUrl,
} from "./hosts.ts";
import { handlePages } from "./ipc.ts";
import { icon, mac, openFirstWindow, openProfile, openWindow, raise, windows } from "./windows.ts";

// The desktop app is the web app in a window: it shows what the host's transport serves, so the two never differ.
// It finds its host like the CLI does: one on another machine (`LEMMA_URL`, or the default environment), else a running local
// one, and starts one only when none runs, since the sessions store has a single writer. A host it started stops
// when it quits. Each profile (`@lemma/contracts/profiles`) is a host of its own, shown in windows of its own: the app
// starts with `LEMMA_PROFILE`'s (the default's when unset), and opens another when a page asks (`lemma:open-profile`)
// or a link names one, from that machine: this one's, or through the host on another (`profiles.open`). Its hosts are
// `hosts.ts`'s, its windows `windows.ts`'s, and what their pages ask of it `ipc.ts`'s.
const REMOTE_TIMEOUT_MS = 10_000;

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

/** Says what the app `could` not do (`could not start`), in its log and in an error box. */
const complain = (could: string, message: string) => {
  logLine(`${could}: ${message}`);
  dialog.showErrorBox(`${kind.name} ${could}`, message);
};

/** A deep link that arrived before there was a window to show it in. */
let pending: { readonly path: string; readonly profile?: string } | undefined;

/** Shows a deep link's address (`lemma://threads/<id>` is `/threads/<id>`), in the profile it names, else the first's. */
const openLink = (link: { readonly path: string; readonly profile?: string }) => {
  if (pageAt(state.first) === undefined) {
    pending = link;
    return;
  }
  const name = link.profile ?? state.first;
  if (name !== DEFAULT_PROFILE && profileNameProblem(name) !== undefined) return;
  openProfile(name, link.path).catch((error: unknown) => complain(`could not open the profile ${name}`, failure(error)));
};
const linkIn = (argv: readonly string[]) => argv.map(deepLinkTarget).find((link) => link !== undefined);

const fail = (error: unknown) => {
  complain("could not start", errorMessage(error));
  app.exit(1);
};

handlePages();

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
    if (window === undefined) openFirstWindow();
    else raise(window);
  });

  /**
   * Electron's default menu, less what the page binds itself: ⌘W closes the pane's tab and ⌘N starts a thread (the web
   * app's Actions), so no menu item takes them first. Quitting closes the window.
   */
  const menu: Electron.MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" as const }] : []),
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
      submenu: [{ role: "minimize" }, { role: "zoom" }, ...(mac ? [{ type: "separator" as const }, { role: "front" as const }] : [{ role: "quit" as const }])],
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
      const dev = webUrl;
      if (
        dev !== undefined &&
        !(await untilReached(
          () => devServerProblem(dev),
          `Nothing serves the web app at ${dev}`,
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
        state.remote = target;
        // Its own profile, so a switch back to it finds its window. LEMMA_PROFILE names one of this machine's, not that one's.
        const info = await Effect.runPromise(Effect.scoped(Effect.flatMap(makeHostRpcHttp(target.url, target.token), (rpc) => rpc["Host.Info"]())));
        state.first = info.profile ?? DEFAULT_PROFILE;
        serve(state.first, target);
      } else {
        if (paths.profile !== undefined && !existsSync(paths.home))
          throw new Error(`There is no profile "${paths.profile}" (LEMMA_PROFILE); \`lemma profile create ${paths.profile}\` makes one`);
        serve(state.first, target ?? (await startHost(state.first)));
      }
      const link = pending;
      pending = undefined;
      // A link for another profile opens its window; one that cannot be opened (no such profile, a name none can be)
      // is said so, and the first profile's window opens instead.
      let name = state.first;
      const wanted = link?.profile === undefined ? undefined : canonicalProfile(link.profile);
      if (wanted !== undefined && wanted !== state.first) {
        try {
          if (wanted !== DEFAULT_PROFILE && profileNameProblem(wanted) !== undefined) throw new Error(`No profile can be named ${JSON.stringify(wanted)}`);
          await ensureHost(wanted);
          name = wanted;
        } catch (error) {
          complain(`could not open the profile ${wanted}`, failure(error));
        }
      }
      // The link's address is its profile's: the first profile's window, opened instead, starts at its own start.
      openWindow(name, pageAt(name, name === (wanted ?? state.first) ? link?.path : undefined)!);
      announce();
    })
    .catch(fail);

  // macOS keeps an app running with no windows; the Dock icon opens a new one.
  app.on("activate", openFirstWindow);
  // Handled, so closing every window does not quit the app as Electron would by default: macOS keeps it running, and
  // elsewhere the app has quit already, as its last app window closed (`openWindow`), whatever a page left open.
  app.on("window-all-closed", () => {});

  // Quitting stops the hosts this app started: first it says what that cuts off, and asks, when there is anything.
  let asking = false;
  app.on("before-quit", (event) => {
    if (state.quitting) return;
    const started = [...hosts].filter(([, held]) => held.child !== undefined).map(([name]) => name);
    if (started.length === 0) {
      state.quitting = true;
      if (state.relaunching) app.relaunch();
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
          state.relaunching = false;
          // Kept running: a quit that came from closing the last window leaves none, and off macOS nothing else opens one.
          openFirstWindow();
          return;
        }
      }
      state.quitting = true;
      if (state.relaunching) app.relaunch();
      await Promise.all(started.map(stopHost));
      app.quit();
    });
  });
  app.on("will-quit", unannounce);
}
