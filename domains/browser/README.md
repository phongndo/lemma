# browser

A web browser the agent drives: tabs of its own per session, pages read as accessibility trees and acted on by ref, screenshots, and pages drawn on their own to check them. Its contract is [`@lemma/browser`](contract/src/browser.ts).

| Plugin                                   | Halves | What it does                                                                                                  |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| [`browser.chromium`](chromium/README.md) | host   | A headless Chromium through Playwright, launched on first use: provides `Browser`                             |
| [`browser.tools`](tools/README.md)       | host   | The `browser_*` tools scripts call, in the `browser` namespace, and `html_preview`, which the model calls too |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| Add       | Nothing: the tools are `browser.tools`', in the tools domain's `Tools` and `ToolNamespaces`                                |
| Intercept | Nothing: a browser call is a tool call, which `ToolExecuteHook` and `Guards` see                                           |
| Observe   | Nothing                                                                                                                    |
| Call      | `Browser`: a session's tabs, snapshots, actions on a target (`BrowserTarget`), screenshots, evaluation, and `render`       |
| Serve     | `Browser`: a plugin providing it replaces `browser.chromium`, as one driving the desktop app's browser pane over CDP would |

## Rationale

- **The browser apart from its tools.** `browser.tools` meets a browser only
  through `Browser`, so another way to drive one (a remote browser, the
  desktop app's own pane, which T3 Code drives by relaying its Electron
  webview's debugger as CDP) is a plugin that provides it, with the same
  tools.
- **Refs from snapshots, not coordinates.** A page reads as its accessibility
  tree, each element with a ref (`s3-e12`): its snapshot's number and the
  element's id in it. Acting by ref is exact; a ref from an earlier snapshot,
  or from before a navigation, fails, saying to take a new one, rather than
  acting on whatever is there now. Playwright locators and CSS selectors work
  without a snapshot, and a point for what has no element (a canvas).
- **Sessions apart.** Each session's tabs are in a browser context of their
  own, so a sign-in in one session is not another's, and concurrent sessions
  do not move each other's tabs.
