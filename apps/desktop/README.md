# @lemma/desktop

The web app in a desktop window. The window shows what the host's `transport`
plugin serves, so it is the same app as in the browser, with the same plugins,
UI files, and `"ui"` rows.

```sh
nix develop -c pnpm desktop   # build the core and the web app, then open the window

# Developing: `pnpm dev` opens the window on the web app's dev server, so web edits hot-reload
nix develop -c pnpm dev:desktop   # the window again while `pnpm dev` runs, as after editing src/main.ts
```

## Behavior

- **Attach first.** Like the CLI, it opens the page of a remote host
  ([remote access](../../docs/remote.md)) or of a running local one. With
  neither, it starts a host with Electron's Node, for the directory
  `pnpm desktop` ran from (else `~`). Never two: the sessions store has a
  single writer.
- **A host it started stops when it quits.** One it attached to keeps running.
  On macOS, closing the last window leaves the app (and its host) running until
  you quit it.
- **Reload** (the button beside the connection dot) restarts a host the app
  started, loading changed code (a turn it cuts off resumes), then reloads
  each window at its address. Any other host keeps running and re-reads its
  config and plugin files. Neither rebuilds the web app for `pnpm desktop` nor
  reloads the desktop's own main process.
- **Links open in the system browser.** Navigation stays within the host's
  origin.
- **`lemma://` links open in the app.** `lemma://threads/<id>` shows that
  thread (any of the web app's [addresses](../web/README.md#addresses) works):
  in the open window, without a reload, or in a new one. The app registers
  itself as the scheme's handler when it starts. Run from source on macOS,
  that registers Electron itself: a link reaches the app while it runs, and
  with it closed opens Electron's default app instead.
- The start script clears `ELECTRON_RUN_AS_NODE`, which terminals inside other
  Electron apps can inherit and which would run Electron as plain Node.
