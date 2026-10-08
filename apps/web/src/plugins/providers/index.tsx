import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Schema } from "effect";
import type { AuthType, InteractionRequest, NoticePayload, ProviderInfo } from "@lemma/contracts";
import { logoProblem, customProviderSpec, describeProvider, endsLogin, fromEnv, providerGroups, providerText, signInState } from "../../model/providers.ts";
import type { AuthFilter, CustomProviderDraft } from "../../model/providers.ts";
import {
  ActionIds,
  Actions,
  Client,
  ComposerNotices,
  Dialogs,
  Interactions,
  Layers,
  Models,
  Notify,
  ProviderRowPart,
  Settings,
  SettingsGroups,
  SettingsSections,
  Slots,
  UiPlugins,
} from "../../ui/contracts.ts";
import type { ModelsService, ProviderRowProps } from "../../ui/contracts.ts";
import { defineUiPlugin } from "../../ui/define.ts";
import { DEFAULT_PART_ORDER } from "../../ui/slots.ts";
import { CheckIcon, FilterIcon, KeyIcon, PlusIcon, Popover, ProviderLogo, ProviderRowView, SearchField, Spinner } from "../../ui/parts.tsx";
import { ConnectDialog } from "./connect.tsx";
import { CustomProviderDialog, pickSvg } from "./custom.tsx";
import styles from "./providers.css?inline";

const SECTION = "providers";
const CONNECT_DIALOG = "providers.connect";
const CUSTOM_DIALOG = "providers.custom";
const GROUPS = ["Results", "Connected", "Popular", "All providers"];

type Login = (provider: ProviderInfo, type: AuthType) => void;
type Method = ProviderInfo["auth"][number];

/** A way in, as a menu item says it: the host's name for a sign-in (`Sign in with ChatGPT`, `GitHub Copilot`). */
const methodLabel = (method: Method) =>
  method.type === "api_key" ? "Paste an API key" : /^sign in/i.test(method.name) ? method.name : `Sign in with ${method.name}`;

const FILTERS: readonly { value: AuthFilter; label: string }[] = [
  { value: "all", label: "All providers" },
  { value: "oauth", label: "Sign in with a subscription" },
  { value: "api_key", label: "Paste an API key" },
];

/** What a custom provider's menus offer besides connecting. */
interface CustomActions {
  readonly changeLogo: (provider: ProviderInfo) => void;
  readonly removeLogo: (provider: ProviderInfo) => void;
  readonly remove: (provider: ProviderInfo) => void;
}

/** An item of a provider's menu: picking it closes the menu, then runs. */
function MenuItem(props: { label: string; close: () => void; run: () => void; danger?: boolean }) {
  return (
    <button
      class="menu-item"
      classList={{ "menu-danger": props.danger === true }}
      role="menuitem"
      onClick={() => {
        props.close();
        props.run();
      }}
    >
      <span class="menu-label">{props.label}</span>
    </button>
  );
}

function CustomItems(props: { provider: ProviderInfo; custom: CustomActions; close: () => void }): JSX.Element {
  return (
    <>
      <div class="menu-sep" />
      <MenuItem label="Change logo…" close={props.close} run={() => props.custom.changeLogo(props.provider)} />
      <Show when={props.provider.logo !== undefined}>
        <MenuItem label="Remove logo" close={props.close} run={() => props.custom.removeLogo(props.provider)} />
      </Show>
      <MenuItem label="Remove provider" close={props.close} run={() => props.custom.remove(props.provider)} danger />
    </>
  );
}

function ProviderRow(props: { models: ModelsService; provider: ProviderInfo; login: Login; custom: CustomActions }) {
  const busy = () => props.models.loggingIn() === props.provider.id;
  const locked = () => props.models.loggingIn() !== undefined;
  const methods = () => props.provider.auth;
  const login = (type: AuthType) => props.login(props.provider, type);
  const logout = () => void props.models.logout(props.provider);
  /** Signing in first: it needs nothing pasted. */
  const ways = () => [...methods()].sort((a, b) => (a.type === b.type ? 0 : a.type === "oauth" ? -1 : 1));
  return (
    <div class="provider" classList={{ configured: props.provider.configured }}>
      <ProviderLogo id={props.provider.id} name={props.provider.name} custom={props.provider.logo} />
      <span class="provider-info">
        <span class="provider-name">{props.provider.name}</span>
        <span class="provider-desc">{describeProvider(props.provider)}</span>
      </span>
      <Show
        when={props.provider.configured}
        fallback={
          <Show
            when={!busy()}
            fallback={
              <span class="provider-waiting">
                <Spinner />
                Connecting…
              </span>
            }
          >
            <Show
              when={methods().length > 1 || props.provider.custom}
              fallback={
                <button class="button small provider-connect" disabled={locked()} onClick={() => methods()[0] && login(methods()[0]!.type)}>
                  Connect
                </button>
              }
            >
              {/* Several ways in (or a custom provider's own options): Connect opens a menu, as Manage does. */}
              <Popover
                label={`Connect ${props.provider.name}`}
                tip="Choose how to connect"
                disabled={locked()}
                triggerClass="button small provider-connect"
                placement="bottom-end"
                trigger="Connect"
              >
                {(close) => (
                  <>
                    <For each={ways()}>{(method) => <MenuItem label={methodLabel(method)} close={close} run={() => login(method.type)} />}</For>
                    <Show when={props.provider.custom}>
                      <CustomItems provider={props.provider} custom={props.custom} close={close} />
                    </Show>
                  </>
                )}
              </Popover>
            </Show>
          </Show>
        }
      >
        <Show when={busy()}>
          <Spinner />
        </Show>
        <Popover
          label={`${props.provider.name} options`}
          tip="Options"
          disabled={locked()}
          triggerClass="button small provider-connect"
          placement="bottom-end"
          trigger="Manage"
        >
          {(close) => (
            <>
              <For each={methods()}>
                {(method) => <MenuItem label={method.type === "oauth" ? "Sign in again" : "Replace API key"} close={close} run={() => login(method.type)} />}
              </For>
              <Show when={!fromEnv(props.provider.source) && props.provider.source !== "no key required"}>
                <div class="menu-sep" />
                <MenuItem label="Log out" close={close} run={logout} danger />
              </Show>
              <Show when={props.provider.custom}>
                <CustomItems provider={props.provider} custom={props.custom} close={close} />
              </Show>
            </>
          )}
        </Popover>
      </Show>
    </div>
  );
}

/** The last row: any endpoint that speaks a known wire API, such as Ollama or a company gateway. */
/** The row that adds a provider of the user's; its form is a dialog. */
function CustomProviderRow(props: { open: () => void }) {
  return (
    <div class="provider">
      <span class="provider-mark" aria-hidden="true">
        <PlusIcon />
      </span>
      <span class="provider-info">
        <span class="provider-name">Custom provider</span>
        <span class="provider-desc">Any OpenAI-, Anthropic-, or Gemini-compatible endpoint, like Ollama or a gateway</span>
      </span>
      <button class="button small provider-connect" onClick={props.open}>
        Add
      </button>
    </div>
  );
}

const ProvidersConfig = Schema.Struct({
  logos: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    title: "Custom provider logos to move",
    description: "Logos an earlier version kept here, by provider id. They move to their providers (the llm plugin's config) on start.",
  }),
});

/**
 * Model providers: connect one by signing in with a subscription or pasting an
 * API key, or add your own, each in a dialog. The connect dialog shows any
 * login's questions, including one started from another client. A search at the top narrows the list; popular ways to start
 * come first. Opened from the chat's notice (or the palette) with nothing set
 * up, it says why and closes once a provider is connected.
 */
export default defineUiPlugin({
  id: "providers",
  styles,
  config: ProvidersConfig,
  requires: {
    client: Client,
    dialogs: Dialogs,
    models: Models,
    settings: Settings,
    slots: Slots,
    interactions: Interactions,
    notify: Notify,
    uiPlugins: UiPlugins,
  },
  setup: ({ client, dialogs, models, settings, slots, interactions, notify, uiPlugins }, plugin) => {
    const moving = Object.entries(plugin.config.logos ?? {});
    let moved = moving.length === 0;
    createEffect(() => {
      if (moved || !models.providersLoaded()) return;
      moved = true;
      void (async () => {
        for (const [id, svg] of moving) {
          const provider = models.providers().find((candidate) => candidate.id === id && candidate.custom);
          if (provider !== undefined && provider.logo === undefined) await models.setLogo(provider, svg);
        }
        // Clearing this plugin's own config restarts it, so it comes last.
        const self = uiPlugins.list().find((candidate) => candidate.id === plugin.id);
        if (self !== undefined) await uiPlugins.setConfig(self, { logos: null });
      })().catch((error) => notify.report(error, "Could not move custom provider logos"));
    });
    const [welcome, setWelcome] = createSignal(false);
    const [query, setQuery] = createSignal("");
    const [filter, setFilter] = createSignal<AuthFilter>("all");
    createEffect(
      on(
        settings.section,
        (section) => {
          if (section === undefined) setWelcome(false);
          if (section !== SECTION) {
            setQuery("");
            setFilter("all");
          }
        },
        { defer: true },
      ),
    );
    /** The login this client started, shown in the connect dialog until it ends or is cancelled. */
    const [connecting, setConnecting] = createSignal<{ readonly provider: ProviderInfo; readonly method?: string }>();
    /** That login's origin, until it settles: past a cancel that closed the dialog already. */
    const [ownOrigin, setOwnOrigin] = createSignal<string>();
    /** A provider whose login this plugin answers itself (a new custom provider's key), so no dialog shows for it. */
    const [quiet, setQuiet] = createSignal<string>();
    /** Each running login's notices so far, by origin, whichever client started it; dropped once it ends. */
    const [loginNotices, setLoginNotices] = createSignal<Readonly<Record<string, readonly NoticePayload[]>>>({});
    const forget = (origin: string) => {
      setLoginNotices(({ [origin]: _, ...rest }) => rest);
      // Its link and code are no use now; its success says so itself.
      notify.dismissWhere((toast) => toast.origin === origin && toast.kind !== "signed-in");
    };
    plugin.onCleanup(
      client.onEvent((event) => {
        const origin = event.type === "notice" ? event.notice.origin : undefined;
        if (event.type !== "notice" || origin === undefined || !origin.startsWith("login:")) return;
        if (endsLogin(event.notice)) forget(origin);
        else setLoginNotices((all) => ({ ...all, [origin]: [...(all[origin] ?? []), event.notice] }));
      }),
    );
    // What was published while the connection was down is lost; the logins still running ask again or time out.
    createEffect(
      on(
        () => client.status().state,
        (state) => state === "reconnecting" && setLoginNotices({}),
      ),
    );
    const isLogin = (request: InteractionRequest) => request.origin?.startsWith("login:") === true;
    const providerOf = (origin: string | undefined) => models.providers().find((candidate) => origin === `login:${candidate.id}`);
    /** Logins this dialog leaves alone: the one answered for a new custom provider, and this client's own once cancelled. */
    const skipped = (origin: string | undefined) => origin === `login:${quiet()}` || (connecting() === undefined && origin === ownOrigin());
    const waiting = (origin: string) => {
      const state = signInState(loginNotices()[origin] ?? []);
      return state.link !== undefined || state.device !== undefined;
    };
    /** Whom the dialog is for: this client's login, else a login asking a question or waiting on its page or code (one started elsewhere). */
    const shown = createMemo(() => {
      const own = connecting();
      if (own !== undefined) return own;
      const asking = interactions.open().find((request) => isLogin(request) && !skipped(request.origin) && providerOf(request.origin) !== undefined);
      const origin =
        asking?.origin ?? Object.keys(loginNotices()).find((candidate) => !skipped(candidate) && waiting(candidate) && providerOf(candidate) !== undefined);
      const provider = providerOf(origin);
      return provider === undefined ? undefined : { provider };
    });
    // The dialog shows the logins' questions, links, and codes, wherever they were started; nothing else draws them.
    // A question for a provider this page does not know stays the question dialog's, so it is never left unshown.
    plugin.onCleanup(interactions.claim((request) => isLogin(request) && (request.origin === `login:${quiet()}` || providerOf(request.origin) !== undefined)));
    plugin.onCleanup(
      notify.claim((toast) => toast.origin?.startsWith("login:") === true && toast.kind !== "signed-in" && providerOf(toast.origin) !== undefined),
    );
    const login = async (provider: ProviderInfo, type: AuthType, options: { readonly quiet?: boolean } = {}) => {
      const origin = `login:${provider.id}`;
      const own = !options.quiet && models.loggingIn() === undefined;
      if (options.quiet) setQuiet(provider.id);
      if (own) {
        setOwnOrigin(origin);
        const method = provider.auth.find((candidate) => candidate.type === type);
        // "Sign in with GitHub Copilot" under "Connect GitHub Copilot" says nothing new.
        const label = method === undefined || method.name === provider.name ? undefined : type === "api_key" ? "API key" : methodLabel(method);
        setConnecting({ provider, ...(label === undefined ? {} : { method: label }) });
      }
      try {
        const ok = await models.login(provider, type);
        if (ok && welcome() && models.configured()) settings.open(undefined);
      } finally {
        if (options.quiet) setQuiet(undefined);
        if (own) {
          setConnecting(undefined);
          setOwnOrigin(undefined);
          forget(origin);
        }
      }
    };
    // A modal while it shows, held as the open dialog: the app's keys wait, and another dialog gives way to the login.
    createEffect(() => {
      const visible = shown() !== undefined;
      const current = dialogs.current();
      if (visible && current !== CONNECT_DIALOG) dialogs.open(CONNECT_DIALOG);
      else if (!visible && current === CONNECT_DIALOG) dialogs.open(undefined);
    });
    plugin.onCleanup(() => {
      const current = dialogs.current();
      if (current === CONNECT_DIALOG || current === CUSTOM_DIALOG) dialogs.open(undefined);
    });
    const cancelConnect = (provider: ProviderInfo) => {
      const origin = `login:${provider.id}`;
      if (connecting()?.provider.id === provider.id) setConnecting(undefined);
      // None running: what the dialog showed was left over (its end was missed), so it goes now.
      void models.cancelLogin(provider).then((running) => running || forget(origin));
    };
    slots.add(Layers, {
      id: CONNECT_DIALOG,
      order: 40,
      component: () => (
        // Keyed by provider, so a new question in the same login does not redraw the dialog.
        <Show when={dialogs.current() === CONNECT_DIALOG && shown()?.provider.id} keyed>
          {(id) => {
            const current = () => shown();
            const provider = () => current()?.provider ?? models.providers().find((candidate) => candidate.id === id)!;
            return (
              <ConnectDialog
                provider={provider()}
                method={current()?.method}
                notices={() => loginNotices()[`login:${id}`] ?? []}
                questions={() => interactions.open().filter((request) => request.origin === `login:${id}`)}
                interactions={interactions}
                onCancel={() => cancelConnect(provider())}
              />
            );
          }}
        </Show>
      ),
    });
    const closeCustom = () => dialogs.current() === CUSTOM_DIALOG && dialogs.open(undefined);
    slots.add(Layers, {
      id: CUSTOM_DIALOG,
      order: 40,
      component: () => (
        <Show when={dialogs.current() === CUSTOM_DIALOG}>
          <CustomProviderDialog add={addCustom} onClose={closeCustom} />
        </Show>
      ),
    });
    const open = () => {
      setWelcome(!models.configured());
      settings.open(SECTION);
    };

    /** Keys typed with a new custom provider, answered for it when its login asks. */
    const pendingKeys = new Map<string, string>();
    createEffect(() => {
      for (const request of interactions.open()) {
        const id = request.origin?.startsWith("login:") ? request.origin.slice("login:".length) : undefined;
        const key = id === undefined ? undefined : pendingKeys.get(id);
        if (key === undefined || request.type !== "ask") continue;
        pendingKeys.delete(id!);
        interactions.answer(request.id, { type: "ask", value: key });
      }
    });
    const setLogo = (provider: ProviderInfo, svg: string | undefined) => models.setLogo(provider, svg);
    const custom: CustomActions = {
      changeLogo: (provider) =>
        pickSvg((svg) => {
          const problem = logoProblem(svg);
          if (problem !== undefined) notify.toast({ level: "error", message: problem });
          else setLogo(provider, svg).catch((error) => notify.report(error, "Could not save the logo"));
        }),
      removeLogo: (provider) => void setLogo(provider, undefined).catch((error) => notify.report(error, "Could not remove the logo")),
      remove: (provider) => void removeCustom(provider),
    };
    const addCustom = async (draft: CustomProviderDraft, key: string, logo: string | undefined): Promise<boolean> => {
      try {
        const provider = await models.addCustom(customProviderSpec(draft));
        if (key !== "") {
          pendingKeys.set(provider.id, key);
          await login(provider, "api_key", { quiet: true });
        }
        if (logo !== undefined) await setLogo(provider, logo);
        return true;
      } catch (error) {
        notify.report(error, `Could not add ${draft.name.trim()}`);
        return false;
      }
    };
    const removeCustom = async (provider: ProviderInfo) => {
      try {
        // A key it stored goes with it.
        if (provider.configured && !fromEnv(provider.source) && provider.source !== "no key required") await models.logout(provider);
        await models.removeCustom(provider);
      } catch (error) {
        notify.report(error, `Could not remove ${provider.name}`);
      }
    };
    const groups = createMemo(() => providerGroups(models.providers(), query(), filter()));
    // Its rows are a part: its own is the default, and a plugin replaces it everywhere by adding a lower order.
    slots.add(ProviderRowPart, {
      id: "providers.row",
      order: DEFAULT_PART_ORDER,
      component: (props: ProviderRowProps) => <ProviderRow models={models} provider={props.provider} login={(_, type) => props.login(type)} custom={custom} />,
    });
    const row = (provider: ProviderInfo) => () => <ProviderRowView provider={provider} login={(type) => void login(provider, type)} />;

    function Search() {
      let input!: HTMLInputElement;
      onMount(() => input.focus());
      /** Enter starts the first match's quickest way in. */
      const connectFirst = () => {
        const provider = groups()
          .flatMap((group) => group.providers)
          .find((candidate) => !candidate.configured);
        const method = provider?.auth.find((candidate) => candidate.type === "oauth") ?? provider?.auth[0];
        if (provider !== undefined && method !== undefined && models.loggingIn() === undefined) void login(provider, method.type);
      };
      return (
        <div class="providers-top">
          <Show when={welcome()}>
            <p class="settings-intro">Connect a provider to start chatting: sign in with a subscription, or paste an API key.</p>
          </Show>
          <SearchField
            ref={(element) => (input = element)}
            value={query()}
            onInput={setQuery}
            placeholder={`Search ${models.providers().length} providers`}
            label="Search providers"
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              connectFirst();
            }}
          >
            {/* Which ways in to list. */}
            <Popover
              label={filter() === "all" ? "Filter providers" : `Showing: ${FILTERS.find((option) => option.value === filter())!.label}`}
              trigger={<FilterIcon />}
              triggerClass={filter() === "all" ? "icon-button" : "icon-button active"}
              placement="bottom-end"
            >
              {(close) => (
                <For each={FILTERS}>
                  {(option) => (
                    <button
                      class="menu-item"
                      role="menuitemradio"
                      aria-checked={filter() === option.value}
                      onClick={() => {
                        setFilter(option.value);
                        close();
                      }}
                    >
                      <span class="menu-check">
                        <Show when={filter() === option.value}>
                          <CheckIcon />
                        </Show>
                      </span>
                      {option.label}
                    </button>
                  )}
                </For>
              )}
            </Popover>
          </SearchField>
        </div>
      );
    }

    slots.add(SettingsSections, {
      id: SECTION,
      order: 20,
      title: "Providers",
      icon: KeyIcon,
      intro: Search,
      empty: () => (
        <Switch fallback={<p class="settings-empty">No provider plugins are loaded. Check Plugins.</p>}>
          <Match when={!models.providersLoaded()}>
            <p class="settings-empty">
              <Spinner /> Loading providers…
            </p>
          </Match>
          <Match when={query().trim() !== "" || filter() !== "all"}>
            <p class="settings-empty">No providers match{query().trim() === "" ? "" : ` “${query().trim()}”`}</p>
          </Match>
        </Switch>
      ),
    });
    for (const [order, title] of GROUPS.entries()) {
      slots.add(SettingsGroups, {
        id: `${SECTION}.${order}`,
        order,
        section: SECTION,
        // A search's matches need no heading.
        ...(title === "Results" ? {} : { title }),
        entries: () =>
          (groups().find((group) => group.title === title)?.providers ?? []).map((provider) => ({
            text: `provider login ${providerText(provider)}`,
            view: row(provider),
          })),
      });
    }
    // Last: adding a custom provider, while browsing (it answers no search).
    slots.add(SettingsGroups, {
      id: `${SECTION}.custom`,
      order: GROUPS.length,
      section: SECTION,
      // Titled, so it is not merged into the untitled search results.
      title: "Custom",
      entries: () =>
        models.providersLoaded() && query().trim() === "" && filter() !== "oauth"
          ? [{ text: "provider add custom openai compatible ollama gateway", view: () => <CustomProviderRow open={() => dialogs.open(CUSTOM_DIALOG)} /> }]
          : [],
    });
    slots.add(ComposerNotices, {
      id: SECTION,
      order: 10,
      component: () => (
        <Show when={models.providersLoaded() && !models.configured()}>
          <div class="callout callout-info composer-callout">
            <KeyIcon />
            <span>No model provider is set up yet.</span>
            <button class="button button-primary small" onClick={open}>
              Log in to a provider
            </button>
          </div>
        </Show>
      ),
    });
    slots.add(Actions, {
      id: ActionIds.providers,
      order: 5,
      title: "Log in to a provider…",
      category: "Providers",
      keywords: ["sign in", "api key", "credentials"],
      icon: KeyIcon,
      run: open,
    });
  },
});
