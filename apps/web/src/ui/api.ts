import * as solid from "solid-js";
import html from "solid-js/html";
import * as store from "solid-js/store";
import * as web from "solid-js/web";
import * as agent from "@lemma/agent";
import * as agentPrompt from "@lemma/agent/prompt";
import * as clientFormat from "@lemma/client/format";
import * as commandsContract from "@lemma/commands";
import * as runtimeContracts from "@lemma/contracts";
import * as core from "@lemma/core";
import * as devtoolsContract from "@lemma/devtools";
import * as llmContract from "@lemma/llm";
import * as router from "@lemma/router";
import * as routerSolid from "@lemma/router-solid";
import * as sessions from "@lemma/sessions";
import * as tools from "@lemma/tools";
import * as workspaceContract from "@lemma/workspace";
import * as defaults from "@lemma/look-kit/defaults";
import * as clipboard from "@lemma/web/clipboard";
import * as format from "@lemma/web/format";
import * as keys from "@lemma/web/keys";
import * as match from "@lemma/web/match";
import * as now from "@lemma/web/now";
import * as paint from "@lemma/web/paint";
import * as quickPick from "@lemma/web/quick-pick";
import * as storage from "@lemma/web/storage";
import * as actions from "@lemma/actions";
import * as commands from "@lemma/commands/web";
import * as devtools from "@lemma/devtools/web";
import * as frame from "@lemma/frame";
import * as llm from "@lemma/llm/web";
import * as look from "@lemma/look";
import * as settings from "@lemma/settings";
import * as threads from "@lemma/threads";
import { DEFAULT_PART_ORDER, defineSlot, defineWebPlugin, definePart, extendWebPlugin, WebSchema, usePlugin } from "@lemma/web";
import * as webRuntime from "@lemma/web";
import type { Part } from "@lemma/web";
import * as workspace from "@lemma/workspace/web";
import { bundled } from "../bundled.ts";

/** `value` without `keys`, typed so. */
const omit = <T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !(keys as readonly PropertyKey[]).includes(key))) as Omit<T, K>;

/**
 * Every bundled contract as one namespace: the web runtime's (`@lemma/web`: `Client`, `Slots`, `Router`, …) and each
 * domain's (`@lemma/frame`, `@lemma/threads`, `@lemma/look`, …), with the views that draw each part, and the thread
 * routes (`@lemma/sessions`). Not what makes slots and parts: a web half makes those with `api.defineSlot` and
 * `api.definePart`, which gives a part no fallback, since a fallback belongs to no plugin and outlives the half.
 */
export const contractModules = {
  "@lemma/web": omit(webRuntime, ["definePart", "createSlots"]),
  "@lemma/frame": frame,
  "@lemma/look": look,
  "@lemma/settings": settings,
  "@lemma/actions": actions,
  "@lemma/devtools": devtools,
  "@lemma/threads": threads,
  "@lemma/llm/web": llm,
  "@lemma/workspace/web": workspace,
  "@lemma/commands/web": commands,
  "@lemma/sessions": { NewThreadRoute: sessions.NewThreadRoute, ThreadRoute: sessions.ThreadRoute },
};
// One namespace of them all: a name two of them export would be one's, silently (tests/api.test.ts fails that).
const contracts = {
  ...contractModules["@lemma/web"],
  ...frame,
  ...look,
  ...settings,
  ...actions,
  ...devtools,
  ...threads,
  ...llm,
  ...workspace,
  ...commands,
  NewThreadRoute: sessions.NewThreadRoute,
  ThreadRoute: sessions.ThreadRoute,
};

/**
 * What a web half's default export receives when it is a function: the page's
 * own module instances, so a plugin shares Solid's reactivity and the
 * contracts' tags with the app, and needs no build step (`html` is Solid's
 * tagged template, JSX without a compiler).
 *
 *   export default ({ defineWebPlugin, contracts: { Slots, Actions }, html }) =>
 *     defineWebPlugin({ id: "hello", requires: { slots: Slots }, setup: ({ slots }, plugin) => { … } });
 */
export const api = {
  defineWebPlugin,
  /** In a component a plugin draws (its slot item, or what it hands a part): that plugin's `action`, `listen`, `after`, … */
  usePlugin,
  /** A plugin made from another's definition, such as a bundled one's: a replacement that keeps the original's later updates. */
  extendWebPlugin,
  /**
   * The bundled plugins by id: what a replacement with the same id wraps (`extendWebPlugin`) rather than copies. The
   * runtime (`Client`, `Slots`, `Router`, `Notify`, `HostPlugins`, `Interactions`, `WebPlugins`, `PageTrace`) is not among them:
   * the app provides it, and no plugin replaces or provides it. Requiring it is as before, by its tag in `contracts`.
   */
  bundled: Object.fromEntries(bundled.map((plugin) => [plugin.id, plugin])),
  defineSlot,
  /**
   * The bundled domains' channels, as each domain's contract declares them: what
   * the bundled plugins reach the host's sessions, agent, models, workspace,
   * files, and commands through, with `Client`. A web half passes one to
   * `client.channel.call` or `client.follow` to have its payload and results
   * go through its schemas (`client.channel.call(channels.SessionChannels.list, {})`);
   * by id, they are plain JSON.
   */
  channels: {
    SessionChannels: sessions.SessionChannels,
    AgentChannels: agent.AgentChannels,
    LlmChannels: llmContract.LlmChannels,
    WorkspaceChannels: workspaceContract.WorkspaceChannels,
    FileChannels: workspaceContract.FileChannels,
    CommandChannels: commandsContract.CommandChannels,
  },
  /** A route of the plugin's own (`/notes/:id`), for a `Pages` item; links to it are `router.href(route, params)`. */
  defineRoute: router.defineRoute,
  /** Narrows `router.match()` to a route, with its typed params and search. */
  isRoute: router.isRoute,
  /** A new part, for a plugin's own replaceable pieces; `parts.partView` draws one. It has no fallback: the plugin provides it. */
  definePart: <P extends Record<string, any>>(name: string): Part<P> => definePart<P>(name),
  /** The order bundled parts are added at: add with a lower one to replace a part. */
  DEFAULT_PART_ORDER,
  contracts,
  /**
   * The page's look (see "the look" in the contracts): `paint` applies a scheme and tokens for an owner, as the
   * bundled `appearance` does, remembered so the next load shows it before plugins start, and `unpaint` stops; a
   * replacement for `appearance` uses these to take its place. The rest read the look for a renderer that does
   * not draw with CSS: `tokenColor` gives a token as a plain color, and `onLookChange` says when to draw again.
   */
  look: {
    paint: paint.paint,
    unpaint: paint.unpaint,
    currentTheme: paint.currentTheme,
    onThemeChange: paint.onThemeChange,
    currentToken: paint.currentToken,
    tokenColor: paint.tokenColor,
    onLookChange: paint.onLookChange,
  },
  solid,
  web,
  store,
  html,
  /**
   * The parts as the bundled plugins draw them, each following whatever replaces it (`Icon`, `Dialog`, `PlusIcon`,
   * `ChatTool`, …); `Contained`, `Each`, and `First` draw a slot's items, each contained, and `partView` draws a
   * plugin's own part. The same namespace as `contracts`, where each view sits beside its part.
   */
  parts: contracts,
  /** The bundled implementations of the shared parts, to wrap or fall back to from a replacement. */
  defaults: {
    ConfigForm: defaults.ConfigForm,
    CopyButton: defaults.CopyButton,
    Dialog: defaults.Dialog,
    FileIcon: defaults.PlainFileIcon,
    Icon: defaults.DefaultIcon,
    icons: defaults.icons,
    Markdown: defaults.Markdown,
    Popover: defaults.Popover,
    ProviderLogo: defaults.ProviderLogo,
    Segmented: defaults.Segmented,
    SettingRow: defaults.SettingRow,
    Toggle: defaults.Toggle,
    SearchField: defaults.SearchField,
  },
  copyText: clipboard.copyText,
  /**
   * For plugins written against the kernel directly; one adds to slots through `slots.as(context)`, with its setup's
   * context. Its items have no `usePlugin`, so they draw the kit's parts through `partView`, not `defaults`.
   */
  core: { definePlugin: core.definePlugin, Event: core.Event, Hook: core.Hook },
  /** Enough of Effect Schema to declare a config and a route's params and search (see `WebSchema`). */
  Schema: WebSchema,
};

/** What a web half's default export receives (not `WebApi`, the version key a plugin requires). */
export type WebHalfApi = typeof api;

/**
 * The page's modules by import specifier, each as CommonJS would export it (a module with only a default export, that
 * export): what a web half in TypeScript imports. The host compiles its imports of these to reads of this map
 * (`SHARED_MODULES` in `@lemma/contracts`), so it has the page's Solid and contracts, as a `.web.js` has them through
 * `api`: the runtime's packages and the domains' contracts the bundled web plugins import, never a plugin's own.
 */
export const modules: Readonly<Record<string, unknown>> = {
  "solid-js": solid,
  "solid-js/web": web,
  "solid-js/store": store,
  "solid-js/html": html,
  "@lemma/core": core,
  "@lemma/contracts": runtimeContracts,
  "@lemma/router": router,
  "@lemma/router-solid": routerSolid,
  "@lemma/client/format": clientFormat,
  "@lemma/web": webRuntime,
  "@lemma/web/clipboard": clipboard,
  "@lemma/web/format": format,
  "@lemma/web/keys": keys,
  "@lemma/web/match": match,
  "@lemma/web/now": now,
  "@lemma/web/paint": paint,
  "@lemma/web/quick-pick": quickPick,
  "@lemma/web/storage": storage,
  "@lemma/actions": actions,
  "@lemma/agent": agent,
  "@lemma/agent/prompt": agentPrompt,
  "@lemma/commands": commandsContract,
  "@lemma/commands/web": commands,
  "@lemma/devtools": devtoolsContract,
  "@lemma/devtools/web": devtools,
  "@lemma/frame": frame,
  "@lemma/llm": llmContract,
  "@lemma/llm/web": llm,
  "@lemma/look": look,
  "@lemma/sessions": sessions,
  "@lemma/settings": settings,
  "@lemma/threads": threads,
  "@lemma/tools": tools,
  "@lemma/workspace": workspaceContract,
  "@lemma/workspace/web": workspace,
};
