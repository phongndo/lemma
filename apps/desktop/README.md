# @lemma/desktop

The web app in a desktop window. The window shows what the host's `transport`
plugin serves, so it is the same app as in the browser, with the same plugins
and rows.

```sh
nix develop -c pnpm desktop   # build the core and the web app, then open the window

# Developing: `pnpm dev` opens the window on the web app's dev server, so web edits hot-reload
nix develop -c pnpm dev:desktop   # the window again while `pnpm dev` runs, as after editing src/main.ts
```

Each release has it ([installation](../../docs/installation.md#the-desktop-app)),
built by `scripts/dist-desktop.ts` ([releases](../../docs/development.md#releases)),
whose main process is this `src/main.ts` as the release's archive has it: what
it reads beside its sources, as the icon, is in the archive (`scripts/dist.ts`).

## Behavior

- **Attach first.** Like the CLI, it opens the page of the host `LEMMA_URL` or
  the default environment names ([remote access](../../docs/remote.md)), or of
  a running local one. With
  neither, it starts a host with Electron's Node, for the directory
  `pnpm desktop` ran from (else `~`). Never two for one profile: the sessions
  store has a single writer.
- **A window per profile.** It starts on `LEMMA_PROFILE`'s
  [profile](../../docs/configuration.md#profiles) (the default when unset;
  showing a server, the server's host's own), and opens another in a window of
  its own when a page's profile menu asks (`lemmaDesktop.openProfile(name)`)
  or a link names one (`?profile=<name>`): on this machine, the profile's
  running host, else one it starts, refusing a profile never made; showing a
  server, through the server's host (`profiles.open`), at the server's name
  and the profile's port, never through a loopback address, which may be a
  tunnel carrying one port. A link to a profile it cannot open is said so, and
  the first profile's window opens instead.
  Another profile's window says whose it is in its title, by the name it is
  shown by, and its browser pages keep their
  sign-ins in the profile's own partition (`persist:lemma-browser-<name>`; the
  default's is `persist:lemma-browser`). A page that deletes a profile says so
  (`lemmaDesktop.profileRemoved(name)`): once its home is gone, its windows
  close, and its partition and its pages' storage at its address are cleared,
  so a profile made later with its name or port starts with none of them.
- **A host it started stops when it quits,** every profile's. One it attached to keeps running.
  On macOS, closing the last window leaves the app (and its host) running until
  you quit it. Before stopping its host, quitting asks the host what that cuts
  off (`cli.in-progress`: turns running, prompts queued) and, when there is
  anything, asks whether to quit; a host that cannot say within two seconds is
  taken to be busy. The host it starts says the app started it
  (`LEMMA_STARTED_BY=desktop`), so `lemma status` names its owner and `lemma
  stop` leaves it to the app.
- **The CLI reaches it.** While it runs it writes `<home>/desktop.json` (its
  process, and the command that hands it a `lemma://` link), so `lemma open`
  shows a page here rather than in a browser, in the window of the profile the
  command names (`lemma://threads/<id>?profile=<name>`). It writes what it says of its own
  running (a host it started that exited, a start that failed) to
  `<home>/logs/desktop.log` (`lemma logs --desktop`); the host's own log is
  `lemma logs`.
- **Reload** (the button beside the connection dot) restarts the window's
  profile's host when the app started it, loading changed code (a turn it cuts
  off resumes), then reloads that profile's windows at their addresses. Any other host keeps running and re-reads its
  config and plugin files. Neither rebuilds the web app for `pnpm desktop` nor
  reloads the desktop's own main process.
- **No title bar of its own.** The page's heads (`--head-height`, 48px) are
  the window's title bar, and its controls sit in them, level with their
  buttons: the traffic lights centered on macOS; on Windows and Linux an
  overlay as tall as a head, in the page's colors, which change with its look.
- **Links open in the system browser.** Navigation stays within the host's
  origin.
- **The browser view's pages are Chromium's** (`src/browser.ts`): a
  `<webview>` each, in their own partition (the profile's, so
  sign-ins last), with no Node, no preload, and the sandbox, whatever the
  element asks for. A page may write to the clipboard and go fullscreen, and
  is refused the rest (reading the clipboard, location, notifications). A
  window it opens (a sign-in) is a window the app makes, its size and kind the
  app's, three at most, closing with its page and with the app's window; it is
  not one of the app's own, so reloading, a `lemma://` link, and the Dock leave
  it alone, and the app does not stay open for it. A link to a new tab opens
  one in the thread's pane.
  Its right-click menu has Back, Forward, Reload, what is under the pointer,
  and Inspect, and its DevTools open in their own window. While a page has
  focus, ⌘R (Ctrl+R) reloads it, not the app; ⌘[ and ⌘] (Alt+← and Alt+→) go
  back and forward; ⌘⌥I (Ctrl+Shift+I) or F12 opens its DevTools; the menu's
  other keys (quitting, editing, zoom) work as usual; and the app's own
  shortcuts that a browser keeps for itself (tabs, threads) reach the app,
  those held with a modifier or a function key, matched as the web app matches
  them (`@lemma/web/keys`).
- **`lemma://` links open in the app.** `lemma://threads/<id>` shows that
  thread (any of the web app's [addresses](../web/README.md#addresses) works):
  in the open window, without a reload, or in a new one; `?profile=<name>`
  shows it in that profile's window. The app registers
  itself as the scheme's handler when it starts. Run from source on macOS,
  that registers Electron itself: a link reaches the app while it runs, and
  with it closed opens Electron's default app instead. Released, macOS has the
  scheme from the app's Info.plist and Linux from the desktop entry the Debian
  package installs; an AppImage has no desktop entry, so only `lemma open`
  reaches it, while it runs.
- **Run from a checkout, it is Lemma Dev** ([development](../../docs/development.md)):
  its windows are titled `lemma dev`, with the orange icon, and it opens
  `lemma-dev://` links, so a link for an installed Lemma's app (its sign-in's
  "Return to Lemma", say) never opens a checkout's. It keeps its data (the
  lock that makes it one instance, its pages' sign-ins) in a folder of its
  own, `Lemma Dev` beside a release's `Lemma`, so the two run at once.
- The start script clears `ELECTRON_RUN_AS_NODE`, which terminals inside other
  Electron apps can inherit and which would run Electron as plain Node.
