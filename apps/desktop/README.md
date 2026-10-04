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

- **Attach first.** Like the CLI, it opens the page of the host `LEMMA_URL`
  (with `LEMMA_TOKEN`) or `$LEMMA_HOME/remote.json` names, a host on another
  machine ([remote access](../../docs/remote.md)), else of a running local host
  found through `$LEMMA_HOME/transport.json`. With a remote host it never starts
  a local one; if the remote does not answer at start, a dialog names its URL
  and offers Retry or Quit. With neither, it starts one with Electron's Node
  (`packages/host/src/main.ts --no-open`, the project being the directory
  `pnpm desktop` ran from, else `~`). Never two: the sessions store has a
  single writer.
- **A host it started stops when it quits.** One it attached to keeps running.
  On macOS, closing the last window leaves the app (and its host) running until
  you quit it.
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
