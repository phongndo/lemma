# browser.tools

Adds the browser tools to `Tools`, over [`Browser`](../contract/src/browser.ts).
The `browser_*` tools are `nested`: only scripts call them, in the `browser`
namespace of `ToolNamespaces`. The model calls `html_preview` too. No config.

Each tool declares its `output`, which a `codemode` script's call resolves to
(`ToolResult.structured`). The model reads the same in words.

| Tool                 | Input                                                                       | Resolves to                                                                    |
| -------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `browser_open`       | `url?`, `tabId?`, `newTab?`                                                 | the tab: `{ tabId, url, title, current, status? }`                             |
| `browser_navigate`   | `url`, `tabId?`, `waitUntil?` (`load`, `domcontentloaded`, `networkidle`)   | the tab                                                                        |
| `browser_snapshot`   | `tabId?`                                                                    | `{ tabId, url, title, generation, tree, truncated, console }`                  |
| `browser_click`      | a target, `tabId?`, `button?`, `clickCount?`                                | the current tab afterwards                                                     |
| `browser_type`       | a target, `text`, `submit?`, `tabId?`                                       | the current tab afterwards                                                     |
| `browser_press`      | `key`, a target?, `tabId?`                                                  | the current tab afterwards                                                     |
| `browser_hover`      | a target, `tabId?`                                                          | the current tab afterwards                                                     |
| `browser_select`     | a target, `values`, `tabId?`                                                | the current tab afterwards                                                     |
| `browser_scroll`     | a target?, `deltaX?`, `deltaY?`, `tabId?`                                   | the current tab afterwards                                                     |
| `browser_evaluate`   | `expression`, `tabId?`                                                      | `{ value, truncated }`                                                         |
| `browser_screenshot` | `tabId?`, `fullPage?`                                                       | an image block `{ type, data, mimeType, note }`                                |
| `browser_wait_for`   | `text?`, `load?`, a target?, `state?`, `timeoutMs?` (up to 60000), `tabId?` | the tab                                                                        |
| `browser_tabs`       | none                                                                        | the session's tabs                                                             |
| `browser_close`      | `tabId?`                                                                    | the tabs left                                                                  |
| `html_preview`       | `html`, `width?` (240–1600, 728), `appearance?` (`dark`, `light`)           | `{ width, contentHeight, capturedHeight, console, missingImages, screenshot }` |

A target is one of `ref` (from the tab's latest snapshot), `locator`,
`selector`, or `x` and `y` ([`BrowserTarget`](../contract/src/browser.ts)).

## Behavior

- **Scripts first.** A script snapshots, decides, acts, and returns only what
  the model needs, so a dozen steps cost the model one call.
  `describeNamespace("browser")` gives the order calls go in. With no tool that
  runs others offered, the model is declared the tools and calls them itself
  (`declaredTools` in `@lemma/tools`).
- **Images stay in the script** unless it shows them with `image()`. An image
  classifier (`models.classify` with `images`) judges one without the model. A
  screenshot too large to attach is left out of the model's result and kept in
  the script's.
- **`html_preview`** draws a page as the chat's `html_render` would show it:
  with the theme `@lemma/tools/html` gives, local images inlined
  (`missingImages` names those it could not), 728 pixels wide by default. Its
  description sends the model to `html_render`'s, so the rules for writing a
  page live in one description. It resolves to the screenshot, the height the
  page needs, and what the page logged, so the model fixes a page before
  showing it. A page taller than `HTML_TALL_PAGE` (1,500 pixels) is called
  out, so the model trims or splits it. Addresses on this machine or its
  network do not load, as [`render`](../chromium/README.md#behavior) refuses
  them.
- **Statuses.** `open` and `navigate` give a page's HTTP error `status`, which
  the model reads after the address (`(HTTP 404)`).
- **Replays.** A snapshot, a screenshot, a tab list, and a preview only read,
  so one cut off by a host restart runs again. Actions do not.
