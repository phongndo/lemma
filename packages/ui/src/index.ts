/*
 * The web app's contracts. Capabilities are services one plugin provides and
 * others require; slots are places any number of plugins contribute to; parts
 * are the replaceable pieces plugins draw with. The runtime's contracts (the
 * connection, slots, the router, messages, the plugins, questions:
 * `runtime.ts`, re-exported here) are the app's own; every other capability,
 * and every slot item, comes from a plugin. Every bundled plugin is written
 * against these alone, so any of them can be replaced by a plugin that
 * provides the same capability or fills the same slot. Keys are namespaced
 * `lemma-ui/…`.
 *
 * A few contracts are in the DOM rather than in code, because every plugin's
 * markup takes part in them:
 * - `data-tip` on an element is its tooltip (drawn by the `tooltips` plugin).
 * - `data-theme` (`light`/`dark`) on `<html>` is the resolved scheme, and
 *   custom properties on its `style` (a theme's `--bg`, `--accent`,
 *   `--font-ui`, the `--content` width) are tokens set over the stylesheets'
 *   own; the `appearance` plugin sets them (through `lib/paint.ts`), and
 *   stylesheets and renderers (diagrams) read them. A `data-theme` on another
 *   element gives it that scheme's own tokens, for a preview (see "the look").
 * - `aria-expanded` on a button marks a disclosure: the chat keeps it in place
 *   when it opens instead of following new output.
 * - `data-titlebar` on the shell's `.app` means the page fills a desktop
 *   window whose own controls overlay its top-left (`env(titlebar-area-*)`).
 *   The bar atop each column is then the window's title bar: it is 48px tall
 *   and marks itself `app-region: drag`. The shell sets `--titlebar-inset` on
 *   the column under the controls (the sidebar, or the main column when the
 *   sidebar is hidden or a drawer), the room its bar leaves at the left.
 * - `window.lemmaDesktop`, in a desktop window, is its app's bridge
 *   (`apps/desktop/src/preload.cjs`): `ownsHost` when the app started the
 *   host, and `reload()` for that case, which restarts it (see the desktop
 *   README). The `reload` plugin uses it; a replacement can too.
 */

export * from "./runtime.ts";
export * from "./slots.ts";
export * from "./define.ts";
export * from "./draw.tsx";
export * from "./parts.tsx";
export * from "./schema.ts";
