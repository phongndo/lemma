# tools.html

The `html_render` tool: a page the model made (a chart, a table, a diagram, a
mockup) shown to the person in the chat, above the model's reply. Adds it to
`Tools`; its web half (`./web`) draws the page and shows calls by the page's
title. No config.

| Input     | Limits                                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `title`   | 1–200 characters                                                                                                            |
| `html`    | One self-contained document, up to `HTML_MAX_CHARS` (512,000 characters); 5 MiB once its local images are inlined           |
| `height?` | 80–2000 CSS pixels: the most the frame grows to, the rest scrolling inside it. Without it the frame fits the page (to 4000) |

Absolute paths to local images in the page, quoted or in CSS `url(…)`, become
`data:` URLs (`inlineLocalImages` in `@lemma/tools/files`); a path that is
missing, not an image, or too large stays as it is, and the result names it.
Remote URLs, such as a chart library from a CDN, load as they are. The result
tells the model the page is shown, so its reply adds only what the page does
not say; a script's call resolves to `{ shown, title, missingImages }`
(`structured`). The tool is `display: true` ([`@lemma/tools`](../contract/src/tools.ts)),
so `codemode` keeps a script's calls for the chat to draw too.

## The page

The web half draws the page as its `ToolViews` item's `display`, which the
transcript puts after the fold holding the call, above the answer
([threads.transcript](../../threads/transcript/README.md)). Opened, a call
shows the page's source and the images not inlined.

- **Sandboxed.** The page is an `<iframe srcdoc>` with
  `sandbox="allow-scripts allow-forms"` and never `allow-same-origin`: its
  scripts run in an opaque origin, with no reach into the app, its storage, or
  the host's channels; it opens no window, shows no `alert`, and navigates no
  page but its own (its forms submit in its frame, so a page's form handlers
  work).
- **The app's theme.** A bootstrap put first in the page's head
  (`@lemma/tools/html`) sets the app's tokens on `:root`: `--bg`, `--bg-raised`,
  `--bg-sunk`, `--text`, `--text-2`, `--text-3`, `--border`, `--border-strong`,
  `--accent`, `--accent-text`, `--ok`, `--warn`, `--err`, `--radius`,
  `--font-ui`, `--font-mono`, and `--chart-1` to `--chart-6` for series. It
  follows the app's look as it changes, sent to the page as a message, so the
  page is not loaded again; `html_preview` renders with the same bootstrap.
- **Height.** The page reports its height (only its own frame's window is
  heard), and the frame grows to it at once and shrinks once a smaller height
  has stood for 150 ms, up to the call's `height` or 4000 px. A report of 0 (a
  page not laid out yet, or hidden) changes nothing. A page sized by its frame
  (`100vh`) stays the frame's height, and one that overflows each new height by
  the same amount (`min-height: 100vh` and a margin) stops the frame growing
  after three rounds; the rest scrolls inside. A frame out of view reports
  nothing until it is scrolled to (Chromium pauses rendering in it).
- **Links.** The page hands its link clicks to the app, which opens web and
  mail links in the person's browser, only for a click in that page just now
  (it has focus, and the app the person's activation): a page's script posting
  on its own, or a moment after a click elsewhere, opens nothing.

## Rationale

- **The page lives in the log.** It is kept whole in the call's `details`,
  so the thread's log holds what the person saw, and any client reading the
  thread draws it, with nothing else to keep or delete.
- **A size cap.** A page is logged with its call and loaded by every client
  that reads the thread, so it is held to 5 MiB with its images: room for a
  page and a few screenshots, not an archive of them.
- **Recorded, not run.** The host only prepares and records the page, so the
  tool is `replay: "safe"` and `parallel: "safe"`; the page's scripts run in
  the person's client, in the sandbox.
