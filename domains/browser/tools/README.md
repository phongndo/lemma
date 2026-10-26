# browser.tools

The browser tools, over [`Browser`](../contract/src/browser.ts): the `browser_*` tools, which only scripts call (`nested`, in the `browser` namespace of `ToolNamespaces`), and `html_preview`, which the model calls too. Adds them to `Tools`. No config.

Each declares its `output`, which a `codemode` script's call resolves to (`ToolResult.structured`); the model reads the same in words.

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

A target is one of `ref` (from the tab's latest snapshot), `locator`, `selector`, or `x` and `y` ([`BrowserTarget`](../contract/src/browser.ts)).

## Behavior

- **Scripts first.** A script snapshots, decides in code or with a
  classifier, acts, and returns only what the model needs, so a dozen steps
  cost the model one call; `describeNamespace("browser")` gives the order
  calls go in. With no tool that runs others offered, the model is declared
  the tools and calls them itself (`declaredTools` in `@lemma/tools`).
- **Images stay in the script** unless it shows them: `browser_screenshot`
  resolves to an image block, which `image()` shows the model and an image
  classifier (`models.classify` with `images`) judges without it.
- **`html_preview`** draws a page as the chat's `html_render` would show it,
  and its description sends the model to `html_render`'s for how to write one,
  so the rules for a page's layout and theme are in one description:
  the theme `@lemma/tools/html` gives (its variables on `:root`, in the dark or
  light default), absolute paths to local images inlined
  (`inlineLocalImages` in `@lemma/tools/files`, `missingImages` naming those
  it could not), at 728 pixels, the chat's reply column, by default. It
  resolves to the screenshot, the height the page needs, and what it logged,
  uncaught exceptions with their stacks, so the model fixes a page before
  showing it. A page taller than `HTML_TALL_PAGE` (1,500 pixels) at the reply
  column's width or wider, more than a page between the model's text reads
  well at, is called out, so the model trims or splits it. A screenshot too large to attach is left out of the model's
  result and kept in the script's, for `html_preview` and `browser_screenshot`
  alike. Addresses on this machine or its network (`localhost`, `192.168.x.x`)
  do not load in a preview (`render` refuses them, below), as T3 Code's preview
  refuses them too, so a preview cannot reach this machine's services.
- **Statuses.** A page that came with an HTTP error status (a 404) loads as
  any page does; `open` and `navigate` give its `status`, and the model reads
  it after the address (`(HTTP 404)`).
- **Replays.** A snapshot, a screenshot, a tab list, and a preview only read,
  so one cut off by a host restart runs again; actions do not.
