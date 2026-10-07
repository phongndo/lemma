import { batch, createMemo, createSignal } from "solid-js";
import { HostError } from "@lemma/contracts";
import type { AuthType, CustomProviderSpec, ModelInfo, ProviderInfo, ThinkingLevel } from "@lemma/contracts";
import { load, loadJson, save } from "../lib/storage.ts";
import { DEFAULT_THINKING, clampThinking, resolveModel } from "../model/prefs.ts";
import { Client, Models, Notify } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

const MODEL_KEY = "lemma.model";
const THINKING_KEY = "lemma.thinkingByModel";
const FAVORITES_KEY = "lemma.favoriteModels";

/**
 * Providers and models as the host reports them, and this browser's choices:
 * the preferred model, a reasoning level per model, and favorites.
 */
export default defineUiPlugin({
  id: "models",
  requires: { client: Client, notify: Notify },
  provides: { models: Models },
  setup: ({ client, notify }, plugin) => {
    const host = client.host;
    const [providers, setProviders] = createSignal<readonly ProviderInfo[]>([]);
    const [models, setModels] = createSignal<readonly ModelInfo[]>([]);
    const [loadedAt, setLoadedAt] = createSignal(false);
    const [preferred, setPreferred] = createSignal(load(MODEL_KEY));
    const [thinkingByModel, setThinkingByModel] = createSignal<Readonly<Record<string, ThinkingLevel>>>(loadJson(THINKING_KEY, {}));
    const [favorites, setFavorites] = createSignal<readonly string[]>(loadJson(FAVORITES_KEY, []));
    const [loggingIn, setLoggingIn] = createSignal<string>();

    const selected = createMemo(() => resolveModel(models(), preferred()));
    const thinking = createMemo(() => {
      const model = selected();
      return model === undefined ? undefined : clampThinking(model, thinkingByModel()[model.ref] ?? DEFAULT_THINKING);
    });
    const configured = createMemo(() => providers().some((provider) => provider.configured));

    const refresh = async () => {
      const [nextProviders, nextModels] = await Promise.all([host.llm.providers(), host.llm.models(true)]);
      batch(() => {
        setProviders(nextProviders);
        setModels(nextModels);
        setLoadedAt(true);
      });
    };
    const quietly = () => void refresh().catch(() => {});

    plugin.onCleanup(client.onConnect(() => void refresh().catch((error) => notify.report(error, "Sync failed"))));
    plugin.onCleanup(
      client.onEvent((event) => {
        // A login may finish after this page reloaded and lost its own call; provider plugins may come or go; a
        // provider's catalog refreshes (a ChatGPT plan's list, say).
        if ((event.type === "notice" && event.notice.source === "llm") || event.type === "plugins-changed" || event.type === "models-changed") quietly();
      }),
    );

    /**
     * Waits until the host lists a provider as `listed` wants, after a change
     * saved to the llm plugin's config (its reload may finish after the reply).
     */
    const settle = async (id: string, listed: (provider: ProviderInfo | undefined) => boolean) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        await refresh();
        const found = providers().find((provider) => provider.id === id);
        if (listed(found)) return found;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return undefined;
    };
    return {
      models: {
        providers,
        providersLoaded: loadedAt,
        models,
        modelsLoaded: loadedAt,
        configured,
        preferred,
        selected,
        thinking,
        choose: (ref: string | undefined) => {
          save(MODEL_KEY, ref);
          setPreferred(ref);
        },
        chooseThinking: (level: ThinkingLevel) => {
          const model = selected();
          if (model === undefined) return;
          const next = { ...thinkingByModel(), [model.ref]: level };
          setThinkingByModel(next);
          save(THINKING_KEY, JSON.stringify(next));
        },
        favorites,
        toggleFavorite: (ref: string) => {
          const next = favorites().includes(ref) ? favorites().filter((item) => item !== ref) : [...favorites(), ref];
          setFavorites(next);
          save(FAVORITES_KEY, JSON.stringify(next));
        },
        turnOptions: () => {
          const model = selected();
          if (model === undefined) return undefined;
          const level = thinking();
          return { model: model.ref, ...(level === undefined ? {} : { thinking: level }) };
        },
        loggingIn,
        login: async (provider: ProviderInfo, type: AuthType) => {
          if (loggingIn() !== undefined) return false;
          setLoggingIn(provider.id);
          const before = Math.max(0, ...notify.toasts().map((toast) => toast.id));
          try {
            // The host announces success as a notice, which also refreshes providers.
            await host.llm.login(provider.id, type);
            await refresh();
            return true;
          } catch (error) {
            // Whoever cancelled it knows.
            if (!(error instanceof HostError && error.code === "Cancelled")) notify.report(error, `Login to ${provider.name} failed`);
            return false;
          } finally {
            setLoggingIn(undefined);
            // Device codes, login links, and progress from this attempt are no longer useful; its success still is.
            const origin = `login:${provider.id}`;
            notify.dismissWhere(
              (toast) => toast.id > before && toast.kind !== "signed-in" && (toast.code !== undefined || toast.links !== undefined || toast.origin === origin),
            );
          }
        },
        cancelLogin: async (provider: ProviderInfo) => {
          return host.llm.cancelLogin(provider.id).catch((error) => {
            notify.report(error, `Could not cancel the ${provider.name} login`);
            return true;
          });
        },
        logout: async (provider: ProviderInfo) => {
          try {
            await host.llm.logout(provider.id);
            notify.toast({ level: "info", message: `Logged out of ${provider.name}` });
            await refresh();
          } catch (error) {
            notify.report(error, "Logout failed");
          }
        },
        addCustom: async (spec: CustomProviderSpec) => {
          const id = await host.llm.addCustom(spec);
          const provider = await settle(id, (found) => found !== undefined);
          if (provider === undefined) throw new Error(`The host did not list ${spec.name} after saving it`);
          return provider;
        },
        removeCustom: async (provider: ProviderInfo) => {
          await host.llm.removeCustom(provider.id);
          await settle(provider.id, (found) => found === undefined);
        },
        setLogo: async (provider: ProviderInfo, svg: string | undefined) => {
          await host.llm.setLogo(provider.id, svg);
          await settle(provider.id, (found) => found?.logo === svg);
        },
        refresh,
      },
    };
  },
});
