import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Schema } from "effect";
import { asksAnswer } from "@lemma/llm";
import type { AuthType, ProviderInfo, SignIn } from "@lemma/llm";
import {
  customProviderSpec,
  describeProvider,
  fromEnv,
  providerBrand,
  providerGroups,
  providerText,
  Models,
  ProviderRowPart,
  LlmActionIds,
  ProviderLogo,
  ProviderRowView,
} from "@lemma/llm/web";
import type { AuthFilter, CustomProviderDraft, ModelsService, ProviderRowProps } from "@lemma/llm/web";
import { Actions } from "@lemma/actions";
import { Dialogs, Layers } from "@lemma/frame";
import { Settings, SettingsGroups, SettingsSections } from "@lemma/settings";
import { ComposerNotices, ErrorActions } from "@lemma/threads";
import type { ErrorActionProps } from "@lemma/threads";
import { Notify, Slots, WebPlugins, defineWebPlugin } from "@lemma/web";
import { CheckIcon, Dialog, FilterIcon, KeyIcon, MenuItem, pickSvg, PlusIcon, Popover, SearchField, Spinner } from "@lemma/look";
import { ConnectDialog } from "./connect.tsx";
import { CustomProviderDialog } from "./custom.tsx";
import styles from "./providers.css?inline";

const SECTION = "providers";
const CONNECT_DIALOG = "providers.connect";
const CUSTOM_DIALOG = "providers.custom";
const LOGOUT_DIALOG = "providers.logout";
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

function ProviderRow(props: { models: ModelsService; provider: ProviderInfo; login: Login; logout: (provider: ProviderInfo) => void; custom: CustomActions }) {
  /** A sign-in to it runs on the host, whichever client started it. */
  const busy = () =>
    props.models.loggingIn() === props.provider.id ||
    props.models.signIns().some((signIn) => signIn.provider === props.provider.id && signIn.ended === undefined);
  const locked = () => props.models.loggingIn() !== undefined;
  const methods = () => props.provider.auth;
  const login = (type: AuthType) => props.login(props.provider, type);
  const logout = () => props.logout(props.provider);
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
        {/* Its sign-in stopped working: signing in again is what to do. */}
        <Show when={props.provider.expired !== undefined && !busy() && methods().some((method) => method.type === "oauth")}>
          <button class="button small button-primary provider-connect" disabled={locked()} title={props.provider.expired} onClick={() => login("oauth")}>
            Sign in again
          </button>
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

/** Asks before logging out, saying what goes (Lemma's copy) and what stays (the key or the sign-in, with the provider). */
function LogoutDialog(props: { provider: ProviderInfo; logout: () => void; close: () => void }) {
  const signedIn = () => props.provider.source === "OAuth";
  const keyUrl = () => providerBrand(props.provider.id).keyUrl;
  return (
    <Dialog
      title={`Log out of ${props.provider.name}?`}
      onClose={props.close}
      footer={
        <>
          <button class="button" data-autofocus onClick={props.close}>
            Cancel
          </button>
          <button
            class="button button-danger"
            onClick={() => {
              props.logout();
              props.close();
            }}
          >
            Log out
          </button>
        </>
      }
    >
      <p class="dialog-detail">
        {signedIn()
          ? `Lemma forgets this sign-in${props.provider.account === undefined ? "" : ` (${props.provider.account})`} and stops using it.`
          : "Lemma forgets the API key it stored on the host and stops using it."}
      </p>
      <p class="dialog-detail muted">
        <Show
          when={signedIn()}
          fallback={
            <Show when={keyUrl()} fallback={<>The key itself works until you delete it in your {props.provider.name} account.</>}>
              {(url) => (
                <>
                  The key itself works until you delete it at{" "}
                  <a href={url()} target="_blank" rel="noopener noreferrer">
                    {new URL(url()).host}
                  </a>
                  .
                </>
              )}
            </Show>
          }
        >
          {props.provider.name} may still list Lemma as connected until you remove it from your account's connected apps.
        </Show>
      </p>
    </Dialog>
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
export default defineWebPlugin({
  id: "llm.providers",
  styles,
  config: ProvidersConfig,
  requires: {
    dialogs: Dialogs,
    models: Models,
    settings: Settings,
    slots: Slots,
    notify: Notify,
    webPlugins: WebPlugins,
  },
  setup: ({ dialogs, models, settings, slots, notify, webPlugins }, plugin) => {
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
        const self = webPlugins.list().find((candidate) => candidate.id === plugin.id);
        if (self !== undefined) await webPlugins.setConfig(self, { logos: null });
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
    /** A provider whose sign-in this page answers itself (a new custom provider's key), so no dialog shows for it. */
    const [quiet, setQuiet] = createSignal<string>();
    /** Sign-ins this client cancelled: their dialog closes at once, before the host lists them ended. */
    const [dropped, setDropped] = createSignal<ReadonlySet<number>>(new Set());
    const running = (provider: string) =>
      models.signIns().find((signIn) => signIn.provider === provider && signIn.ended === undefined && !dropped().has(signIn.startedAt));
    /** Whether a sign-in waits on the person: a page to open, a code to enter, or something to answer. */
    const waitsOnPerson = (signIn: SignIn) => asksAnswer(signIn.step) || signIn.step.type === "browser" || signIn.step.type === "code";
    /** Whom the dialog is for: this client's login, else a sign-in another client started that waits on the person. */
    const shown = createMemo(() => {
      const own = connecting();
      if (own !== undefined) return running(own.provider.id) === undefined && models.loggingIn() !== own.provider.id ? undefined : own;
      const elsewhere = models.signIns().find((signIn) => signIn.provider !== quiet() && running(signIn.provider) === signIn && waitsOnPerson(signIn));
      const provider = elsewhere === undefined ? undefined : models.providers().find((candidate) => candidate.id === elsewhere.provider);
      return provider === undefined ? undefined : { provider };
    });
    const login = async (provider: ProviderInfo, type: AuthType, options: { readonly quiet?: boolean } = {}) => {
      const own = !options.quiet && models.loggingIn() === undefined;
      if (options.quiet) setQuiet(provider.id);
      if (own) {
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
        if (own) setConnecting(undefined);
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
      if (current === CONNECT_DIALOG || current === CUSTOM_DIALOG || current === LOGOUT_DIALOG) dialogs.open(undefined);
    });
    const cancelConnect = (provider: ProviderInfo) => {
      const signIn = running(provider.id);
      if (signIn !== undefined) setDropped((all) => new Set([...all, signIn.startedAt]));
      if (connecting()?.provider.id === provider.id) setConnecting(undefined);
      void models.cancelLogin(provider);
    };
    const answer = (signIn: SignIn, value: string) =>
      void models.answerSignIn(signIn, value).catch((error) => notify.report(error, "The sign-in moved on before your answer reached it"));
    slots.add(Layers, {
      id: CONNECT_DIALOG,
      order: 40,
      component: () => (
        // Keyed by provider, so a new step in the same sign-in does not redraw the dialog.
        <Show when={dialogs.current() === CONNECT_DIALOG && shown()?.provider.id} keyed>
          {(id) => {
            const current = () => shown();
            const provider = () => current()?.provider ?? models.providers().find((candidate) => candidate.id === id)!;
            return (
              <ConnectDialog
                provider={provider()}
                method={current()?.method}
                signIn={() => running(id)}
                answer={answer}
                onCancel={() => cancelConnect(provider())}
              />
            );
          }}
        </Show>
      ),
    });
    /** The provider the logout dialog asks about. */
    const [leaving, setLeaving] = createSignal<ProviderInfo>();
    const logout = (provider: ProviderInfo) => {
      setLeaving(provider);
      dialogs.open(LOGOUT_DIALOG);
    };
    slots.add(Layers, {
      id: LOGOUT_DIALOG,
      order: 40,
      component: () => (
        <Show when={dialogs.current() === LOGOUT_DIALOG && leaving()}>
          {(provider) => <LogoutDialog provider={provider()} logout={() => void models.logout(provider())} close={() => dialogs.open(undefined)} />}
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

    /** Keys typed with a new custom provider, answered for it when its sign-in asks; a refused one is the dialog's to fix. */
    const pendingKeys = new Map<string, string>();
    createEffect(() => {
      for (const signIn of models.signIns()) {
        if (signIn.ended !== undefined || signIn.step.type !== "key") continue;
        const key = pendingKeys.get(signIn.provider);
        if (signIn.step.problem === undefined) {
          if (key === undefined) continue;
          pendingKeys.delete(signIn.provider);
          answer(signIn, key);
        } else {
          // Refused (the key typed with it, answered above): the dialog shows why, and takes another.
          pendingKeys.delete(signIn.provider);
          if (quiet() === signIn.provider) setQuiet(undefined);
        }
      }
    });
    const setLogo = (provider: ProviderInfo, svg: string | undefined) => models.setLogo(provider, svg);
    const custom: CustomActions = {
      changeLogo: plugin.action("change a logo", async (provider: ProviderInfo) => {
        const picked = await pickSvg();
        if (picked === undefined) return;
        if ("problem" in picked) notify.toast({ level: "error", message: picked.problem });
        else await setLogo(provider, picked.svg).catch((error) => notify.report(error, "Could not save the logo"));
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
    // Its rows are a part: its own is the default, and a plugin replaces it everywhere by adding one of its own.
    slots.add(ProviderRowPart, {
      id: "providers.row",
      phase: "default",
      component: (props: ProviderRowProps) => (
        <ProviderRow models={models} provider={props.provider} login={(_, type) => props.login(type)} logout={logout} custom={custom} />
      ),
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
            <span>No model provider connected.</span>
            <button class="button button-primary small" onClick={open}>
              Connect
            </button>
          </div>
        </Show>
      ),
    });
    // A request a provider refused for want of a working sign-in or key: connecting it again is what fixes it.
    slots.add(ErrorActions, {
      id: SECTION,
      order: 10,
      component: (props: ErrorActionProps) => {
        const provider = () => models.providers().find((candidate) => candidate.id === props.provider);
        const way = () => {
          const found = provider();
          if (found === undefined || (found.configured && found.expired === undefined)) return undefined;
          return found.auth.find((method) => method.type === "oauth" && method.interactive) ?? found.auth.find((method) => method.interactive);
        };
        return (
          <Show when={way()}>
            {(method) => (
              <button
                class="button small button-primary"
                disabled={models.loggingIn() !== undefined}
                onClick={plugin.action("connect", () => login(provider()!, method().type))}
              >
                {provider()!.expired !== undefined ? `Sign in to ${provider()!.name} again` : `Connect ${provider()!.name}`}
              </button>
            )}
          </Show>
        );
      },
    });
    slots.add(Actions, {
      id: LlmActionIds.providers,
      order: 5,
      title: "Log in to a provider…",
      category: "Providers",
      keywords: ["sign in", "api key", "credentials"],
      icon: KeyIcon,
      run: open,
    });
  },
});
