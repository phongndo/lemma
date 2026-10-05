import { Schema } from "effect";
import * as solid from "solid-js";
import html from "solid-js/html";
import * as store from "solid-js/store";
import * as web from "solid-js/web";
import { definePlugin, Event, Hook } from "@lemma/core";
import { defineRoute, isRoute } from "@lemma/router";
import { ConfigForm as DefaultConfigForm } from "../components/config-form.tsx";
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
import * as contracts from "./contracts.ts";
import { defineUiPlugin } from "./define.ts";
import * as parts from "./parts.tsx";
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
  solid,
  web,
  store,
  html,
  /** The shared parts, as the bundled plugins draw them: each follows whatever replaces it. */
  components: {
    ConfigForm: parts.ConfigForm,
    Dialog: parts.Dialog,
    Markdown: parts.Markdown,
    Popover: parts.Popover,
    ProviderLogo: parts.ProviderLogo,
    Segmented: parts.Segmented,
    SettingRow: parts.SettingRow,
    Toggle: parts.Toggle,
    SearchField: parts.SearchField,
    FileIcon: parts.FileTypeIcon,
  },
  /** Every part's proxy (icons by name included), and `partView` for a plugin's own parts. */
  parts,
  /** Icons by their names, each the `icon` part. */
  icons: parts,
  /** The bundled implementations of the shared parts, to wrap or fall back to from a replacement. */
  defaults: {
    ConfigForm: DefaultConfigForm,
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
  /** For plugins written against the kernel directly. */
  core: { definePlugin, Event, Hook },
  /**
   * Enough of Effect Schema to declare a config, which the Plugins page turns
   * into a form, and a route's params and search. Only these members, so the
   * rest of Schema stays out of the app.
   */
  Schema: {
    Array: Schema.Array,
    Boolean: Schema.Boolean,
    Int: Schema.Int,
    Literal: Schema.Literal,
    Number: Schema.Number,
    NumberFromString: Schema.NumberFromString,
    Record: Schema.Record,
    String: Schema.String,
    Struct: Schema.Struct,
    between: Schema.between,
    nonNegative: Schema.nonNegative,
    optional: Schema.optional,
    optionalWith: Schema.optionalWith,
    positive: Schema.positive,
    propertySignature: Schema.propertySignature,
  },
};

export type UiApi = typeof api;
