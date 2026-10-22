import { BrowserWindow, clipboard, ipcMain, Menu, session, shell } from "electron";
import type { BrowserWindowConstructorOptions, ContextMenuParams, Input, MenuItemConstructorOptions, WebContents } from "electron";
import { matchesKeys } from "@lemma/web/keys";
import { isDefaultProfile } from "@lemma/contracts/profiles";

/**
 * The web app's browser pages (`threads.browser`): each a `<webview>` in the window, so a page is Chromium's, with its
 * history and DevTools. This side keeps them apart from the app (their own partition, no Node, no preload, the sandbox),
 * lets a page ask for little, opens its windows and new tabs, gives it a context menu, and shares the keyboard with the
 * app.
 */

/**
 * A profile's pages' partition: their cookies and storage, kept across restarts, apart from the app's and from every
 * other profile's (`@lemma/contracts/profiles`). The default profile's is the one pages had before there were profiles.
 */
export const browserPartition = (profile: string | undefined): string =>
  profile === undefined || isDefaultProfile(profile) ? "persist:lemma-browser" : `persist:lemma-browser-${profile}`;

/** What a page may use without asking: the rest (the clipboard's contents, location, notifications) is refused. */
const ALLOWED = new Set(["clipboard-sanitized-write", "fullscreen"]);

/** How many windows of its own (sign-ins) a page may have open at once. */
const POPUPS = 3;

const web = (url: string) => /^https?:/i.test(url);
const mac = process.platform === "darwin";

/** The app's bindings a page with focus hands on (`mod+t`), per window, as its page last said. */
const forwarded = new WeakMap<WebContents, readonly string[]>();

/**
 * Whether `input` presses `binding`, as the web app matches its bindings: the same matcher (`@lemma/web/keys`), so the
 * keys a page hands on are the ones the app takes. `mod` is ⌘ on macOS, Ctrl elsewhere.
 */
const presses = (binding: string, input: Input): boolean =>
  // Off macOS, Ctrl+Alt may be AltGr typing in the page (ą), which a page's key event here cannot tell: never handed on.
  !(!mac && input.control && input.alt) &&
  matchesKeys(binding, { key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift }, mac);

const toggleDevTools = (page: WebContents) => {
  if (page.isDevToolsOpened()) page.closeDevTools();
  else page.openDevTools({ mode: "detach" });
};

/** Sends to the window's page while it is there. */
const tell = (host: WebContents, channel: string, ...args: unknown[]) => {
  if (!host.isDestroyed()) host.send(channel, ...args);
};

/**
 * Chromium's right-click menu, much as Chrome has it: the page's way back, what is under the pointer, and Inspect.
 * `opener` is the browser page a window it opened (a popup) belongs to: a new tab opens beside it.
 */
const contextMenu = (host: WebContents, page: WebContents, params: ContextMenuParams, opener = page) => {
  const items: MenuItemConstructorOptions[] = [];
  const group = (...next: MenuItemConstructorOptions[]) => {
    if (next.length === 0) return;
    if (items.length > 0) items.push({ type: "separator" });
    items.push(...next);
  };
  if (params.isEditable && params.misspelledWord !== "")
    group(
      ...(params.dictionarySuggestions.length > 0
        ? params.dictionarySuggestions.slice(0, 5).map((word): MenuItemConstructorOptions => ({ label: word, click: () => page.replaceMisspelling(word) }))
        : [{ label: "No guesses", enabled: false }]),
    );
  if (web(params.linkURL))
    group(
      { label: "Open Link in New Tab", click: () => tell(host, "lemma:browser-open", opener.id, params.linkURL, true) },
      { label: "Open Link in Your Browser", click: () => void shell.openExternal(params.linkURL) },
      { label: "Copy Link Address", click: () => clipboard.writeText(params.linkURL) },
    );
  if (params.mediaType === "image")
    group(
      { label: "Copy Image", click: () => page.copyImageAt(params.x, params.y) },
      { label: "Copy Image Address", click: () => clipboard.writeText(params.srcURL) },
    );
  if (params.isEditable)
    group(
      { label: "Cut", enabled: params.editFlags.canCut, click: () => page.cut() },
      { label: "Copy", enabled: params.editFlags.canCopy, click: () => page.copy() },
      { label: "Paste", enabled: params.editFlags.canPaste, click: () => page.paste() },
      { label: "Select All", enabled: params.editFlags.canSelectAll, click: () => page.selectAll() },
    );
  else if (params.selectionText.trim() !== "") group({ label: "Copy", click: () => page.copy() });
  if (!web(params.linkURL) && params.mediaType === "none" && !params.isEditable && params.selectionText.trim() === "")
    group(
      { label: "Back", enabled: page.navigationHistory.canGoBack(), click: () => page.navigationHistory.goBack() },
      { label: "Forward", enabled: page.navigationHistory.canGoForward(), click: () => page.navigationHistory.goForward() },
      { label: "Reload", click: () => page.reload() },
    );
  group({ label: "Inspect", click: () => page.inspectElement(params.x, params.y) });
  const window = BrowserWindow.fromWebContents(page) ?? BrowserWindow.fromWebContents(host);
  Menu.buildFromTemplate(items).popup(window === null ? {} : { window });
};

/** A page's own keys: what `input` does to `page`, undefined for a key that is not one. */
const ownKey = (page: WebContents, input: Input): (() => void) | undefined => {
  const keys: readonly [readonly string[], () => void][] = [
    [["mod+r", "f5"], () => page.reload()],
    [["mod+shift+r", "shift+f5"], () => page.reloadIgnoringCache()],
    [mac ? ["mod+alt+i", "f12"] : ["mod+shift+i", "f12"], () => toggleDevTools(page)],
    [mac ? ["mod+["] : ["alt+arrowleft"], () => page.navigationHistory.goBack()],
    [mac ? ["mod+]"] : ["alt+arrowright"], () => page.navigationHistory.goForward()],
  ];
  return keys.find(([bindings]) => bindings.some((binding) => presses(binding, input)))?.[1];
};

/** A page's own handling, from when it attaches to `host`, the window's page. */
const guest = (host: WebContents, page: WebContents) => {
  page.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isComposing) return;
    // Stopped here, a key reaches neither the page nor the app's menu (whose View › Reload would reload the app); the
    // menu's other keys (quitting, hiding, editing, zooming) still work in a page.
    const run =
      ownKey(page, input) ??
      // The app's shortcuts reach the app, as typed in it (the window's preload hands them to its page).
      (forwarded.get(host)?.some((binding) => presses(binding, input)) === true ? () => tell(host, "lemma:browser-key", input) : undefined);
    if (run === undefined) return;
    event.preventDefault();
    if (!input.isAutoRepeat) run();
  });
  let popups = 0;
  page.setWindowOpenHandler(({ url, disposition }) => {
    // A window it opens (a sign-in, say) is a window, so it can answer the page that opened it: one the app makes, of
    // its own size and kind, whatever the page asked for. A link to a new tab opens one in the app's pane.
    if (disposition === "new-window" && (web(url) || url === "" || url === "about:blank")) {
      if (popups >= POPUPS) return { action: "deny" };
      return {
        action: "allow",
        createWindow: (options) => {
          // Only the contents Chromium made for it are taken from `options`: its size, place, and kind are the app's.
          const made = (options as BrowserWindowConstructorOptions & { readonly webContents?: WebContents }).webContents;
          const window = new BrowserWindow({
            width: 520,
            height: 680,
            autoHideMenuBar: true,
            ...(made === undefined ? {} : { webContents: made }),
          } as BrowserWindowConstructorOptions);
          popups++;
          window.once("closed", () => popups--);
          // It belongs to its page: it goes with the page (its tab closed) and with the app's window.
          const close = () => {
            if (!window.isDestroyed()) window.close();
          };
          page.once("destroyed", close);
          BrowserWindow.fromWebContents(host)?.once("closed", close);
          return window.webContents;
        },
      };
    }
    if (web(url)) tell(host, "lemma:browser-open", page.id, url, disposition === "background-tab");
    return { action: "deny" };
  });
  page.on("did-create-window", (window) => {
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("context-menu", (_event, params) => contextMenu(host, window.webContents, params, page));
  });
  page.on("context-menu", (_event, params) => contextMenu(host, page, params));
};

const readySessions = new Set<string>();
/** A partition's pages ask for little: what a page may use is `ALLOWED`. */
const readySession = (partition: string) => {
  if (readySessions.has(partition)) return;
  readySessions.add(partition);
  const pages = session.fromPartition(partition);
  pages.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED.has(permission)));
  pages.setPermissionCheckHandler((_contents, permission) => ALLOWED.has(permission));
};

ipcMain.on("lemma:browser-keys", (event, bindings: unknown) => {
  // Only a window's own page says which keys are the app's.
  if (BrowserWindow.fromWebContents(event.sender) === null || !Array.isArray(bindings)) return;
  forwarded.set(event.sender, bindings.filter((binding): binding is string => typeof binding === "string").slice(0, 500));
});

/** Lets `window`'s page hold browser pages, in `partition` (`browserPartition`): `webviewTag` is on in its preferences. */
export const hostBrowser = (window: BrowserWindow, partition: string) => {
  readySession(partition);
  const host = window.webContents;
  host.on("will-attach-webview", (event, preferences, params) => {
    if (params.partition !== partition) return event.preventDefault();
    // An address a page may not start at (a `blob:`, a `file:`) starts blank.
    if (!(params.src === undefined || params.src === "" || params.src === "about:blank" || web(params.src))) params.src = "about:blank";
    // What the page sees is set here, whatever its element asked for (`webpreferences` included).
    delete preferences.preload;
    delete preferences.enableBlinkFeatures;
    Object.assign(preferences, {
      partition,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      safeDialogs: true,
      disableHtmlFullscreenWindowResize: true,
    });
  });
  host.on("did-attach-webview", (_event, page) => guest(host, page));
};
