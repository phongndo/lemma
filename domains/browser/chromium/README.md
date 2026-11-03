# browser.chromium

Provides [`Browser`](../contract/src/browser.ts) over a headless Chromium that
[Playwright](https://playwright.dev) (`playwright-core`) launches on the first
call, with a browser context per session. Nothing of Playwright loads until a
tool asks for a page, because it is most of the code the host would otherwise
load at start. A Playwright that cannot be loaded fails the call
`Unavailable`, saying why, as a missing Chromium does.

```jsonc
{ "plugins": { "browser.chromium": { "config": { "idleSeconds": 900, "headless": false } } } }
```

| Config           | Default | Meaning                                                                                                                            |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `executablePath` | none    | The Chromium or Chrome to launch, instead of looking for one                                                                       |
| `idleSeconds`    | `300`   | Seconds after a session's last call that its tabs close, and after the last call of all that the browser does; `0` keeps them open |
| `headless`       | `true`  | `false` shows the browser's windows on the host's screen, to watch the agent work                                                  |

## Behavior

- **Which Chromium.** It launches `executablePath`, else `LEMMA_CHROMIUM` (set
  by `nix develop .#browser`), else the first of `chromium`,
  `chromium-browser`, `google-chrome-stable`, and `google-chrome` on `PATH`
  (and the Chromium and Chrome apps on macOS), else Playwright's own download
  (`npx playwright install chromium`). A configured path that is not an
  executable fails the call rather than launching another browser. With none,
  calls fail `Unavailable` with how to provide one, and the plugin keeps
  running.
- **Tabs.** A session's tabs (`t1`, `t2`, in the order opened) share its
  profile. A page a tab opens (a new window, a sign-in popup) becomes a tab of
  its own and the current one. A session's tabs close `idleSeconds` after its
  last call, since each profile holds a renderer or more (about 70 MB for one
  light page). `lemma inspectors browser.chromium` shows the executable, whether
  it runs, and each session's tabs.
- **Snapshots** are Playwright's AI-mode aria snapshots, their refs prefixed
  with the snapshot's number (`[ref=s3-e12]`), cut near 20 KB. A password
  field's value, or a field drawn as dots, never appears in one. A snapshot
  carries the tab's newest 20 console messages since the last one, 500
  characters each, and uncaught exceptions with their stacks.
- **Targets.** A locator is a Playwright selector (`role=button[name='Save']`,
  `text=Sign in`), or `label=`, `placeholder=`, `alt=`, `title=`, or `testid=`.
  A target matching several elements fails. Actions wait up to 15 seconds for
  their target, navigations 30. A scroll without a target scrolls at once what
  a wheel at the point would, so a page that listens for wheel events (a map)
  does not hear one.
- **Navigations.** A failed load says why (`net::ERR_NAME_NOT_RESOLVED at …`).
  A page with an HTTP error status loads as any page does, with its `status`.
- **Evaluating** returns JSON: a BigInt as its digits and `n`, a cycle as
  `"[Circular]"`, and `undefined` or a function as `null`.
- **Screenshots** are PNG, of the 1280×800 viewport or the whole page up to
  8000 pixels tall. One too large for a model's attachment is retaken as JPEG.
- **`render`** draws a page at the width asked, in a fresh context, served as
  `http://lemma-page.localhost/page.html`, and screenshots up to 4000 pixels
  of it. It keeps the first 20 console messages. A page not loaded within 20
  seconds fails, naming what it was still loading. Two pages render at once.
  It refuses every request the page makes to this machine or a private
  network (`localhost`, loopback, private, link-local, and 100.64/10 addresses,
  and names resolving to one), since Chromium alone refuses only some of them.

## Rationale

- **Playwright over raw CDP.** Its AI-mode snapshots, refs, locators, and
  actionability waits (visible, enabled, stable) are what an agent's actions
  need, kept current with Chromium by the Playwright team; T3 Code drives
  its browser with the same snapshots.
- **One profile per session, none kept.** Contexts are made fresh, so nothing
  a session signed into outlives the browser, and a host's sessions never
  share cookies.
