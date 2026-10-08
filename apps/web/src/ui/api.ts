import * as solid from "solid-js";
import html from "solid-js/html";
import * as store from "solid-js/store";
import * as web from "solid-js/web";
import { definePlugin, Event, Hook } from "@lemma/core";
import { defineRoute, isRoute } from "@lemma/router";
import { ConfigForm as DefaultConfigForm } from "../components/config-form.tsx";
import { CopyButton as DefaultCopyButton } from "../components/copy-button.tsx";
import { Dialog as DefaultDialog } from "../components/dialog.tsx";
import { PlainFileIcon } from "../components/file-icon.tsx";
import { DefaultIcon, icons as defaultIcons } from "../components/icons.tsx";
import { Markdown as DefaultMarkdown } from "../components/markdown.tsx";
import { Popover as DefaultPopover } from "../components/popover.tsx";
import { ProviderLogo as DefaultProviderLogo } from "../components/provider-logo.tsx";
import { Segmented as DefaultSegmented, SettingRow as DefaultSettingRow } from "../components/setting-row.tsx";
import { SearchField as DefaultSearchField } from "../components/search-field.tsx";
import { Toggle as DefaultToggle } from "../components/toggle.tsx";
import { copyText } from "../lib/clipboard.ts";
import { currentTheme, currentToken, onLookChange, onThemeChange, paint, tokenColor, unpaint } from "../lib/paint.ts";
import { bundled } from "../plugins/index.ts";
import * as contracts from "./contracts.ts";
import { defineUiPlugin, extendUiPlugin } from "./define.ts";
import * as parts from "./parts.tsx";
import { UiSchema } from "./schema.ts";
import { DEFAULT_PART_ORDER, definePart, defineSlot } from "./slots.ts";

/**
 * What a UI file's default export receives when it is a function: the page's
 * own module instances, so a plugin shares Solid's reactivity and the
 * contracts' tags with the app, and needs no build step (`html` is Solid's
 * tagged template, JSX without a compiler).
 *
 *   export default ({ defineUiPlugin, contracts: { Slots, Actions }, html }) =>
 *     defineUiPlugin({ id: "hello", requires: { slots: Slots }, setup: ({ slots }, plugin) => { … } });
 */
export const api = {
  defineUiPlugin,
  /** A plugin made from another's definition, such as a bundled one's: a replacement that keeps the original's later updates. */
  extendUiPlugin,
  /**
   * The bundled plugins by id: what a replacement with the same id wraps (`extendUiPlugin`) rather than copies. The
   * runtime (`Client`, `Slots`, `Router`, `Notify`, `HostPlugins`, `Interactions`, `UiPlugins`) is not among them:
   * the app provides it, and no plugin replaces or provides it. Requiring it is as before, by its tag in `contracts`.
   */
  bundled: Object.fromEntries(bundled.map((plugin) => [plugin.id, plugin])),
  defineSlot,
  /** A route of the plugin's own (`/notes/:id`), for a `Pages` item; links to it are `router.href(route, params)`. */
  defineRoute,
  /** Narrows `router.match()` to a route, with its typed params and search. */
  isRoute,
  /** A new part, for a plugin's own replaceable pieces; `parts.partView` draws one. */
  definePart,
  /** The order bundled parts are added at: add with a lower one to replace a part. */
  DEFAULT_PART_ORDER,
  contracts,
  /**
   * The page's look (see "the look" in the contracts): `paint` applies a scheme and tokens for an owner, as the
   * bundled `appearance` does, remembered so the next load shows it before plugins start, and `unpaint` stops; a
   * replacement for `appearance` uses these to take its place. The rest read the look for a renderer that does
   * not draw with CSS: `tokenColor` gives a token as a plain color, and `onLookChange` says when to draw again.
   */
  look: { paint, unpaint, currentTheme, onThemeChange, currentToken, tokenColor, onLookChange },
  solid,
  web,
  store,
  html,
  /**
   * The shared parts as the bundled plugins draw them, each following whatever
   * replaces it (`Icon`, `Dialog`, `PlusIcon`, …); `Contained`, `Each`, and
   * `First` draw a slot's items, each contained, and `partView` draws a
   * plugin's own part.
   */
  parts,
  /** The bundled implementations of the shared parts, to wrap or fall back to from a replacement. */
  defaults: {
    ConfigForm: DefaultConfigForm,
    CopyButton: DefaultCopyButton,
    Dialog: DefaultDialog,
    FileIcon: PlainFileIcon,
    Icon: DefaultIcon,
    icons: defaultIcons,
    Markdown: DefaultMarkdown,
    Popover: DefaultPopover,
    ProviderLogo: DefaultProviderLogo,
    Segmented: DefaultSegmented,
    SettingRow: DefaultSettingRow,
    Toggle: DefaultToggle,
    SearchField: DefaultSearchField,
  },
  copyText,
  /** For plugins written against the kernel directly; one adds to slots through `slots.as(context)`, with its setup's context. */
  core: { definePlugin, Event, Hook },
  /** Enough of Effect Schema to declare a config and a route's params and search (see `UiSchema`). */
  Schema: UiSchema,
};

export type UiApi = typeof api;
