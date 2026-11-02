# @lemma/desktop

The web app in a desktop window. The window shows what the host's `transport`
plugin serves, so it is the same app as in the browser, with the same plugins
and rows.

```sh
nix develop -c pnpm desktop   # build the core and the web app, then open the window

# Developing: `pnpm dev` opens the window on the web app's dev server, so web edits hot-reload
nix develop -c pnpm dev:desktop   # the window again while `pnpm dev` runs, as after editing src/
```

Each release includes it
([installation](../../docs/installation.md#the-desktop-app)).
`scripts/dist-desktop.ts` builds it
([releases](../../docs/development.md#releases)). The built app runs this
`src/main.ts` from the release's archive, so anything it reads beside its
sources, such as the icon, must be in the archive (`scripts/dist.ts`).

## Behavior

- **Attach first.** It opens the host `LEMMA_URL` or the default environment
  names ([remote access](../../docs/remote.md)), else a running local one.
  With neither, it starts a host on Electron's Node, in the directory
  `pnpm desktop` ran from (else `~`). It never starts two for one profile,
  because the sessions store has a single writer.
- **A window per profile.** It starts on `LEMMA_PROFILE`'s
  [profile](../../docs/configuration.md#profiles), the default when unset.
  `lemmaDesktop.openProfile(name)` or a `?profile=<name>` link opens another
  profile in a window of its own. A server's profile opens through the
  server's host (`profiles.open`), never a loopback address, which may be a
  tunnel carrying one port. A profile's browser pages keep their sign-ins in
  `persist:lemma-browser-<name>` (the default's is `persist:lemma-browser`).
  `lemmaDesktop.profileRemoved(name)` closes that profile's windows and clears
  its partition and storage, so a later profile of that name starts clean.
- **Quitting** stops every host the app started; a host it attached to keeps
  running. Before stopping one, it asks the host what that cuts off
  (`cli.in-progress`) and asks you when there is anything. A host that cannot
  say within two seconds counts as busy. Its hosts run with
  `LEMMA_STARTED_BY=desktop`, so `lemma stop` leaves them to the app.
- **The CLI reaches it** through `<home>/desktop.json`: `lemma open` shows a
  page in the window of the profile it names. The app logs to
  `<home>/logs/desktop.log` (`lemma logs --desktop`).
- **Reload** restarts the window's host when the app started it, then reloads
  that profile's windows. Any other host re-reads its config and plugin files.
  Neither rebuilds the web app or reloads the main process.
- **Reopen Lemma** in Settings › About (`lemmaDesktop.relaunch()`) quits as
  Quit does and opens the app again, as after Homebrew's cask replaced it.
- **The page's heads are the title bar** (`--head-height`, 48px): the window
  controls sit in them.
- **The badge** is the sum of every window's
  `lemmaDesktop.attention.setBadge(count)`. `lemmaDesktop.attention.focus()`
  brings a window forward.
- **Links** open in the system browser. Navigation stays within the host's
  origin.
- **Browser view pages** (`src/browser.ts`) run sandboxed, with no Node and no
  preload, in the profile's partition. They may write the clipboard and go
  fullscreen; every other permission is refused. A page may open three
  windows (a sign-in) at most, which close with it. While a page has focus,
  ⌘R (Ctrl+R) reloads it, ⌘[ and ⌘] (Alt+← and Alt+→) go back and forward,
  and ⌘⌥I (Ctrl+Shift+I) or F12 opens its DevTools. The app's shortcuts held
  with a modifier or a function key still reach the app (`@lemma/web/keys`).
- **`lemma://` links** open any of the web app's
  [addresses](../web/README.md#addresses) in the app; `?profile=<name>` picks
  the profile's window. Released, macOS registers the scheme from the app's
  Info.plist and Linux from the Debian package's desktop entry. An AppImage
  has no desktop entry, so only `lemma open` reaches it, while it runs.
- **Run from a checkout, it is Lemma Dev**
  ([development](../../docs/development.md#running-from-a-checkout)). It opens
  `lemma-dev://` links and keeps its data in a `Lemma Dev` folder, so it runs
  beside an installed Lemma.
- The start script clears `ELECTRON_RUN_AS_NODE`, which terminals inside other
  Electron apps can inherit and which would run Electron as plain Node.
