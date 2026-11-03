import { existsSync } from "node:fs";
import { app, BrowserWindow, ipcMain, session } from "electron";
import { isDefaultProfile, profileHome, profileNameProblem } from "@lemma/contracts/profiles";
import { browserPartition } from "./browser.ts";
import { canonicalProfile, hosts, owns, pageAt, paths, reloading, serve, startHost, state, stopHost } from "./hosts.ts";
import { appWindows, HEAD_HEIGHT, mac, openProfile, reloadWindows, windows } from "./windows.ts";

/** The profile of the window whose own page sent `event`, and its window, or undefined for anything else (a frame inside it). */
const senderOf = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const profile = window === null ? undefined : appWindows.get(window);
  return window === null || profile === undefined || event.senderFrame !== event.sender.mainFrame ? undefined : { window, profile };
};

/** Answers what the app windows' pages ask of the app (`preload.cjs`). */
export const handlePages = () => {
  // The `reload` web plugin's restart of a host this app started (README.md): the host of the asking window's profile.
  ipcMain.handle("lemma:reload", async (event) => {
    const sender = senderOf(event);
    const expected = sender === undefined ? undefined : pageAt(sender.profile);
    if (sender === undefined || !owns(sender.profile) || expected === undefined || new URL(event.sender.getURL()).origin !== new URL(expected).origin)
      throw new Error("Only the window of a host this app started can restart it.");
    const name = sender.profile;
    if (reloading.has(name) || state.quitting) return;
    reloading.add(name);
    try {
      await stopHost(name);
      if (state.quitting) return;
      // Never start a second writer if the old host has not actually exited.
      if (hosts.get(name)?.child !== undefined) throw new Error("The host has not stopped yet. Try reloading again once it exits.");
      serve(name, await startHost(name));
      await reloadWindows(name);
    } finally {
      reloading.delete(name);
    }
  });

  // A page's reopening of the app once Homebrew's cask replaced it (`release.updates`): it quits as Quit does, asking
  // first what stopping its hosts cuts off, then opens again, the release now installed. Kept running, it reopens nothing.
  ipcMain.handle("lemma:relaunch", (event) => {
    if (senderOf(event) === undefined) throw new Error("Only an app window's page can reopen the app.");
    state.relaunching = true;
    app.quit();
  });

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
    if (state.remote !== undefined || existsSync(profileHome(paths.root, name))) return;
    const served = hosts.get(name)?.served;
    hosts.delete(name);
    for (const window of windows(name)) window.close();
    await session.fromPartition(browserPartition(name)).clearStorageData();
    if (served !== undefined) await session.defaultSession.clearStorageData({ origin: new URL(served.url).origin });
  });

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
};
