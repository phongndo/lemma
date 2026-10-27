# browser.chromium

Provides [`Browser`](../contract/src/browser.ts) over a Chromium that [Playwright](https://playwright.dev) (`playwright-core`) launches headless on the first call, with a browser context per session. Nothing starts until a tool asks for a page, and nothing of Playwright loads until then either: it is most of the code the host would load at start. A Playwright that cannot be loaded fails the call `Unavailable`, saying why, as a missing Chromium does.

```jsonc
{ "plugins": { "browser.chromium": { "config": { "idleSeconds": 900, "headless": false } } } }
```

| Config           | Default | Meaning                                                                                                                            |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `executablePath` | none    | The Chromium or Chrome to launch, instead of looking for one                                                                       |
| `idleSeconds`    | `300`   | Seconds after a session's last call that its tabs close, and after the last call of all that the browser does; `0` keeps them open |
| `headless`       | `true`  | `false` shows the browser's windows on the host's screen, to watch the agent work                                                  |

## Behavior

- **Which Chromium.** `executablePath`, else `LEMMA_CHROMIUM` (the `browser`
  dev shell sets it: `nix develop .#browser`), else the first of `chromium`,
  `chromium-browser`, `google-chrome-stable`, and `google-chrome` on `PATH`
  (and the Chromium and Chrome apps on macOS), else Playwright's own download
  (`npx playwright install chromium`). A configured path or `LEMMA_CHROMIUM`
  that is not an executable fails the call, saying so, rather than another
  browser launching. With none, calls fail `Unavailable` with how to provide
  one, and the plugin keeps running.
- **Tabs.** Each session's tabs (`t1`, `t2`, numbered in the order it opened
  them) share its profile. A page a tab opens (a link to a new window, a
  sign-in popup) becomes a tab of its own and the current one, and the action
  that opened it (a click) resolves to it: Chromium says a window is coming
  while the action runs (`Page.windowOpen`), and only then does the action wait
  for it, up to 3 seconds. The action waits up to 30 seconds for the popup's
  document to finish parsing. It fails `Timeout` if the document does not
  finish. A session's tabs close `idleSeconds` after its
  own last call, though other sessions keep the browser open: each session's
  profile is a renderer or more (about 70MB with one tab of a light page,
  measured 2026-10-21), which a session gone quiet would otherwise hold until
  the browser closed. A later call says they closed and to open a tab
  again. `browser.chromium` (`lemma inspectors browser.chromium`) shows the
  executable, whether it runs, and each session's tabs.
- **Snapshots** are Playwright's AI-mode aria snapshots
  (`page.ariaSnapshot({ mode: "ai" })`), their refs renamed with the snapshot's
  number (`[ref=e12]` becomes `[ref=s3-e12]`), cut near 20 KB at a line
  boundary with a note of what was left out. The value of a password field,
  or of a field drawn as dots (`-webkit-text-security`), never appears in one.
  A snapshot carries what the tab logged since the last one, its newest 20
  messages of 500 characters, uncaught exceptions with their stacks.
- **Targets.** A locator is a Playwright selector (`role=button[name='Save']`,
  `text=Sign in`), or one of the shorthands `label=`, `placeholder=`, `alt=`,
  `title=`, and `testid=` for Playwright's `getBy…` locators. A target
  matching several elements fails, saying to use a ref or a narrower locator;
  actions wait up to 15 seconds for theirs, navigations 30. A scroll without
  a target scrolls what a wheel at the point (the viewport's middle by default)
  would, the innermost element there that scrolls that way, else the page, at
  once: Chromium does not deliver a synthetic wheel after some actions, and
  scrolls smoothly after one returns, so a snapshot after it would see the page
  where it was. A page that listens for wheel events (a map) does not hear one.
- **Navigations.** Chromium lands a navigation it had under way after the
  call that started it gave up: the error page of a load that failed (an
  address that does not resolve), a load a later one cut off. That landing
  would cut off the next navigation, and that one the next, so a failed load
  waits for its error page, and a navigation cut off that way waits for what
  cut it off to land and goes again, once. A failed load says why
  (`net::ERR_NAME_NOT_RESOLVED at …`); a page that came with an HTTP error
  status loads as any page does, with its `status`.
- **Evaluating.** An expression's value comes back as JSON, a BigInt as its
  digits and `n`, a reference back into an object holding it as
  `"[Circular]"` (an object reached twice by other paths is written out each
  time), and nothing (`undefined`, a function) as `null`.
- **Screenshots** are PNG, the viewport (1280×800) or the whole page up to
  8000 pixels tall; one over the size a model takes as an attachment is
  retaken as JPEG at falling quality.
- **`render`** draws a page in a fresh context at the width asked, answering
  requests for `http://lemma-page.localhost/page.html` with it, so the page
  never touches a network while what it links to (a CDN script) loads. It
  waits for the page's load event, its fonts, and two frames, measures the
  root element's height, and screenshots that much, up to 4000 pixels.
  It keeps the first 20 console messages and says how many more there were.
  A page that has not loaded within 20 seconds fails, naming what it was still
  loading. It refuses every request the page makes (a script, an image, a
  `fetch`, a WebSocket) to this machine or a private network: `localhost` and
  names under it, loopback, private, link-local, and shared (100.64/10)
  addresses, and names resolving to one; the console says what it refused.
  Chromium alone would refuse some of them, by its version and flags. Two pages
  render at once; more wait.

## Rationale

- **Playwright over raw CDP.** Its AI-mode snapshots, refs, locators, and
  actionability waits (visible, enabled, stable) are what an agent's actions
  need, kept current with Chromium by the Playwright team; T3 Code drives
  its browser with the same snapshots.
- **One profile per session, none kept.** Contexts are made fresh, so nothing
  a session signed into outlives the browser, and a host's sessions never
  share cookies.
