import { Context } from "effect";
import type { Accessor, Component } from "solid-js";
import type { ConnectionStatus, Host } from "@lemma/client";
import type {
  ChannelDeclaration,
  ConfigScope,
  HostError,
  HostInfo,
  InspectorInfo,
  InteractionAnswer,
  InteractionRequest,
  NoticePayload,
  PluginChange,
  PluginStatus,
  ReloadResult,
  RuntimeEvent,
  UiComposition,
  UiFile,
} from "@lemma/contracts/runtime";
import type {
  AnyRoute,
  BlockOptions,
  Explanation,
  HistoryLocation,
  Match,
  Navigate,
  ParamsOf,
  RouterEvent,
  RouterSnapshot,
  SearchOf,
  Transition,
} from "@lemma/router";
import { defineSlot } from "./slots.ts";
import type { Region, SlotItem, SlotsService } from "./slots.ts";

/*
 * The web app's runtime: the API its plugins are written against. The boot
 * provides it (`src/runtime/`) for as long as the page runs, so it has no row
 * on the Plugins page, no `ui` row turns it off, and it is not in
 * `api.bundled`. Plugins require these capabilities as they require any
 * other; none provides one: a plugin that does is left out, saying so, and
 * the page keeps its own. `contracts.ts` re-exports them beside what plugins
 * provide.
 */

// ------------------------------------------------------------------ slots

/**
 * The contribution registry every slot lives in. A plugin's `setup` receives
 * a view of its own, which adds as that plugin's; the page's own view (the one
 * `core.run(Slots)` gives) reads, and refuses to add: every item belongs to a
 * plugin, and leaves with it.
 */
export class Slots extends Context.Service<Slots, SlotsService>()("lemma-ui/Slots") {}

/** What the page renders. Empty: a blank page. */
export const Root = defineSlot<Region>("root", { shows: "first" });

// ------------------------------------------------------------------ the host

type StreamEnd = (error?: HostError | Error) => void;

/**
 * The page's one connection to the host: its status, the host's own calls and
 * events, and the channels host plugins serve, through which every subsystem
 * is reached, with the declarations in `@lemma/contracts` (`SessionChannels`,
 * `AgentChannels`, `LlmChannels`, `WorkspaceChannels`, `FileChannels`,
 * `CommandChannels`) or by id. Calls reject with a `HostError`, or with an
 * `Error` when the connection failed (see `@lemma/client`'s `Host`).
 */
export interface ClientService {
  readonly status: Accessor<ConnectionStatus>;
  readonly connected: Accessor<boolean>;
  /** `Host.Info`, fetched on every (re)connect. */
  readonly info: Accessor<HostInfo | undefined>;
  /** The host's own events as they arrive (`RuntimeEvent`): each subsystem streams its own on a channel. Returns the unsubscribe. */
  readonly onEvent: (listener: (event: RuntimeEvent) => void) => () => void;
  /**
   * Runs `sync` now if connected, then after every reconnect: where a model
   * loads what it shows, since events may have been missed in between. A
   * `sync` that throws is logged; the others still run.
   */
  readonly onConnect: (sync: () => void) => () => void;
  /** Lists, calls, and opens what host plugins serve, as `@lemma/client`'s `Host.channel` does. */
  readonly channel: Host["channel"];
  /**
   * Keeps a channel stream open until the returned close, as `@lemma/client`'s
   * `follow` does over the page's connection: anew after every reconnect,
   * again at once when it ends `Withdrawn`, its plugin stopped or replaced,
   * and, after it ended otherwise (nothing served it, say), when a
   * `channels-changed` lists it. Each opening starts afresh, so a subsystem's
   * stream begins with `subscribed`, from which its reader resyncs. `payload`
   * may be a function, read at each opening (`sessions.log` resumes `after`
   * the last event its reader has). `onEnd` hears each ending.
   */
  readonly follow: {
    <Payload, Success>(
      channel: ChannelDeclaration<"stream", Payload, Success>,
      payload: Payload | (() => Payload),
      onElement: (element: Success) => void,
      onEnd?: StreamEnd,
    ): () => void;
    (id: string, payload: unknown, onElement: (element: unknown) => void, onEnd?: StreamEnd): () => void;
  };
  /** Every plugin the host knows, enabled or not. */
  readonly plugins: () => Promise<readonly PluginStatus[]>;
  /** A failed or halted host plugin and its dependents; `force` also replaces a running one. */
  readonly restartPlugin: (pluginId: string, options?: { readonly force?: boolean }) => Promise<void>;
  /** Re-reads the host's config files and applies them; `deferred` says it applies once this call has ended. */
  readonly reload: () => Promise<ReloadResult>;
  /** Writes host plugin rows into the user (default) or project config file and applies them; a rejected change is undone. */
  readonly configure: (plugins: Readonly<Record<string, PluginChange>>, options?: { readonly scope?: ConfigScope }) => Promise<ReloadResult>;
  /** What host plugins let you look into (`Inspectors`), and one's snapshot as plain JSON. */
  readonly inspectors: () => Promise<readonly InspectorInfo[]>;
  readonly inspect: (id: string) => Promise<unknown>;
  /** The web app's own rows and UI files, which the boot plans and runs (`UiPlugins` changes them). */
  readonly ui: {
    readonly composition: () => Promise<UiComposition>;
    /** Writes `ui` rows; every page hears `ui-changed`. */
    readonly configure: (plugins: Readonly<Record<string, PluginChange>>, options?: { readonly scope?: ConfigScope }) => Promise<UiComposition>;
  };
}
export class Client extends Context.Service<Client, ClientService>()("lemma-ui/Client") {}

/** A message for the user. One with a `code` or `links` is something to act on, which stays until dismissed. */
export interface Toast {
  readonly id: number;
  readonly level: NoticePayload["level"];
  readonly message: string;
  readonly source?: string;
  readonly links?: NoticePayload["links"];
  readonly code?: string;
  /** What it belongs to (`login:<provider>`), as the host's notice says. */
  readonly origin?: string;
  /** What a login's notice is (`sign-in`, `device-code`, …), as the host's notice says. */
  readonly kind?: NoticePayload["kind"];
}

/**
 * Messages for the user: the app's own, and the host's notices (login
 * progress, faults, reloads). The messages only: a plugin draws them (the
 * `toasts` plugin, in a corner of the page) and decides how long each stays,
 * dismissing it. With nothing drawing them they wait, undrawn.
 */
export interface NotifyService {
  /** The messages not dismissed, oldest first; past the latest 50, the oldest leave. */
  readonly toasts: Accessor<readonly Toast[]>;
  /** Adds a message. Returns its id; ids only grow. */
  readonly toast: (notice: Omit<Toast, "id">) => number;
  readonly dismiss: (id: number) => void;
  /** Dismisses every toast `drop` is true for. */
  readonly dismissWhere: (drop: (toast: Toast) => boolean) => void;
  /** Adds a failure; `context` says what failed. */
  readonly report: (error: unknown, context?: string) => void;
  /**
   * Shows messages somewhere else: those `which` picks (a sign-in dialog, its
   * login's link and code). The toasts leave them undrawn until released.
   */
  readonly claim: (which: (toast: Toast) => boolean) => () => void;
  /** Some view shows this message itself. */
  readonly claimed: (toast: Toast) => boolean;
}
export class Notify extends Context.Service<Notify, NotifyService>()("lemma-ui/Notify") {}

/** Plugins and the changes the Plugins page makes. Changes reject when refused; whoever asked reports it. */
export interface PluginsService {
  readonly list: Accessor<readonly PluginStatus[]>;
  /** The capability keys their app provides itself, its runtime: no plugin provides them, and any plugin may require them. */
  readonly runtime: Accessor<readonly string[]>;
  readonly refresh: () => Promise<void>;
  readonly restart: (plugin: PluginStatus, options?: { force?: boolean }) => Promise<void>;
  /** Writes `enabled` where it is set now (the user file unless the project file decides). */
  readonly setEnabled: (plugin: PluginStatus, enabled: boolean) => Promise<ReloadResult>;
  /** Sets config fields (null unsets one) in the file that sets the plugin's config. */
  readonly setConfig: (plugin: PluginStatus, values: Readonly<Record<string, unknown>>) => Promise<ReloadResult>;
}
export interface HostPluginsService extends PluginsService {
  readonly reload: () => Promise<ReloadResult>;
  /** Adds or removes items of a list config key by their `id`, in the file that sets the plugin's config, without reading the list. */
  readonly edit: (plugin: PluginStatus, change: Pick<PluginChange, "add" | "remove">) => Promise<ReloadResult>;
}
/** The host's plugins, kept current from `plugins-changed`; `runtime` is `HostInfo.runtime`. */
export class HostPlugins extends Context.Service<HostPlugins, HostPluginsService>()("lemma-ui/HostPlugins") {}

export interface UiPluginsService extends PluginsService {
  /** Files loaded from `~/.lemma/ui` and a trusted project's `.lemma/ui`. */
  readonly files: Accessor<readonly UiFile[]>;
  /** The routes known plugins declare (`defineUiPlugin({ routes })`), running or not, with the plugin declaring each. */
  readonly routes: Accessor<readonly { readonly route: AnyRoute; readonly pluginId: string }[]>;
  /** What went wrong loading UI files or planning the composition; each names its file or plugin. */
  readonly problems: Accessor<readonly string[]>;
  /** Opened with `?safe`: `ui` rows and UI files are ignored. */
  readonly safe: boolean;
}
/** The web app's own plugins, which this page runs; its `runtime` lists the capabilities this file declares. */
export class UiPlugins extends Context.Service<UiPlugins, UiPluginsService>()("lemma-ui/UiPlugins") {}

export interface InteractionsService {
  /** Questions the host is waiting on, oldest first: a login's API key, a tool that asks to confirm. */
  readonly open: Accessor<readonly InteractionRequest[]>;
  readonly answer: (id: string, answer: InteractionAnswer) => void;
  readonly dismiss: (id: string) => void;
  /**
   * Shows questions somewhere else: all of them (the palette does while open)
   * or those `which` picks (the Providers page, its logins' questions). The
   * question dialog leaves them alone until released.
   */
  readonly claim: (which?: (request: InteractionRequest) => boolean) => () => void;
  /** Some view shows this question itself. */
  readonly claimed: (request: InteractionRequest) => boolean;
}
export class Interactions extends Context.Service<Interactions, InteractionsService>()("lemma-ui/Interactions") {}

// ------------------------------------------------------------------ version

/**
 * The version of the web app's contracts: a major number that changes when
 * one of them changes incompatibly. A plugin says which it is written for
 * with `defineUiPlugin({ api })`, which requires `UiApi(api)`; the app
 * provides the version it implements, this one, so a plugin written for
 * another is left out, saying so, rather than failing at some later call.
 */
export const UI_API = 2;
/** Required by a plugin written for version `version` of these contracts (see `UI_API`). */
export const UiApi = (version: number): Context.Key<`lemma-ui/api@${number}`, number> => Context.Service(`lemma-ui/api@${version}`);

// ------------------------------------------------------------------ addresses

/*
 * The page's address names what it shows (`@lemma/router`). A route is an
 * address and the Schemas its params and search decode through; a page is
 * what a plugin shows at one. The router knows the app's own routes (the
 * boot's `appRoutes`) and those every known plugin declares
 * (`defineUiPlugin({ routes })`), so a link to one works while nothing shows
 * it: the page then says its plugin is off, and returns with it. A UI file
 * declares its own with `api.defineRoute` and adds a `Pages` item for it.
 */

/**
 * What a plugin shows at a route: the main region's content while the address is there. The first item per route shows.
 * Items with the same component keep one instance across their routes (a new thread becoming the thread, mid-send).
 */
export interface Page {
  readonly route: AnyRoute;
  readonly component: Component;
  /**
   * A link to this page is about to be followed (hovered or focused): start fetching what it will show, so it is there
   * on arrival. `isRoute(match, route)` gives the typed params. Only warms: the page must work without it.
   */
  readonly preload?: (match: Extract<PageMatch, { readonly status: "matched" }>) => void;
}
export const Pages = defineSlot<Page>("pages");

export type PageMatch = Match<SlotItem<Page>>;

export interface RouterService {
  /** Where the page is: path, search, and the history entry's `key` and `index`. */
  readonly location: Accessor<HistoryLocation>;
  /** What the location shows: a page, a route whose page's plugin is off (`unavailable`), or nothing (`unmatched`). */
  readonly match: Accessor<PageMatch>;
  /** What an address would show, without going there. */
  readonly matchHref: (href: string) => PageMatch;
  /** The params and search when the location is `route`, else undefined. Reactive: runs again only when `route`'s match changes. */
  readonly matchOf: <R extends AnyRoute>(route: R) => { readonly params: ParamsOf<R>; readonly search: SearchOf<R> } | undefined;
  /** `route`'s address for these values (keeping `?safe`). For `<a href>`: plain clicks on links to the app navigate in place. */
  readonly href: <R extends AnyRoute>(route: R, params: ParamsOf<R>, search?: Partial<SearchOf<R>>) => string;
  /**
   * Goes to a route with its values (`navigate(ThreadRoute, { id })`), or to an address; false when a blocker refused or
   * the values do not encode (reported as a toast, never thrown).
   */
  readonly navigate: Navigate;
  readonly back: () => void;
  readonly go: (delta: number) => void;
  /**
   * Asked before every navigation (back and forward too) and before the page unloads (`action: "unload"`: closing or
   * reloading the tab, where false has the browser ask the user); false stops it. Returns the removal.
   */
  readonly block: (blocker: (transition: Transition) => boolean, options?: BlockOptions) => () => void;
  /**
   * State kept with the current history entry (a scroll position), under
   * `name`: back or forward to the entry finds it again, a reload too.
   */
  readonly entry: <T>(name: string) => { readonly get: () => T | undefined; readonly set: (value: T) => void };
  /** Why an address shows what it does: every route's verdict on it. */
  readonly explain: (href: string) => Explanation;
  /** The router now, as plain data: routes with who is registered at each, conflicts, blockers. Reactive. */
  readonly inspect: Accessor<RouterSnapshot>;
  /** What the router did lately (navigations, matches, refusals, failures), oldest first. Reactive. */
  readonly journal: Accessor<readonly RouterEvent[]>;
  /** The state kept with history entries, by entry key (see `entry`). Reactive. */
  readonly entryStates: Accessor<Readonly<Record<string, Readonly<Record<string, unknown>>>>>;
}
/**
 * The page's address as state: the history, which route it names, and which
 * `Pages` item shows there. Plain clicks on links to the app's own pages
 * navigate in place, so any plugin links with an ordinary `<a href>`, and
 * hovering one preloads its page.
 */
export class Router extends Context.Service<Router, RouterService>()("lemma-ui/Router") {}
