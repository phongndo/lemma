import { batch, createMemo, createSignal } from "solid-js";
import { HostError } from "@lemma/contracts";
import { LlmChannels, ThinkingLevel } from "@lemma/llm";
import type { AuthType, CustomProviderSpec, ModelInfo, ProviderInfo, SignIn } from "@lemma/llm";
import { load, loadJson, loadStrings, recordOf, save } from "@lemma/web/storage";
import { browserPlace } from "@lemma/credentials/web";
import { clampThinking, DEFAULT_THINKING, LLM_CONTRACT, Models, resolveModel, signInReturn } from "@lemma/llm/web";
import { Client, Notify, defineWebPlugin } from "@lemma/web";

const MODEL_KEY = "lemma.model";
const THINKING_KEY = "lemma.thinkingByModel";
const FAVORITES_KEY = "lemma.favoriteModels";
/** How long a change to a provider waits for the host to list it changed (ms). */
const SETTLE_MS = 5_000;

/**
 * Providers and models as the host reports them, and this browser's choices:
 * the preferred model, a reasoning level per model, and favorites.
 */
export default defineWebPlugin({
  id: "llm.client",
  implements: [LLM_CONTRACT],
  requires: { client: Client, notify: Notify },
  provides: { models: Models },
  setup: ({ client, notify }, plugin) => {
    const [providers, setProviders] = createSignal<readonly ProviderInfo[]>([]);
    const [models, setModels] = createSignal<readonly ModelInfo[]>([]);
    const [loadedAt, setLoadedAt] = createSignal(false);
    const [preferred, setPreferred] = createSignal(load(MODEL_KEY));
    const [thinkingByModel, setThinkingByModel] = createSignal<Readonly<Record<string, ThinkingLevel>>>(
      loadJson(
        THINKING_KEY,
        {},
        recordOf((value): value is ThinkingLevel => (ThinkingLevel.literals as readonly unknown[]).includes(value)),
      ),
    );
    const [favorites, setFavorites] = createSignal<readonly string[]>(loadStrings(FAVORITES_KEY));
    const [loggingIn, setLoggingIn] = createSignal<string>();
    const [signIns, setSignIns] = createSignal<readonly SignIn[]>([]);
    // Each list is all of them: one heard on reconnecting replaces what was left from before.
    plugin.onCleanup(client.follow(LlmChannels.signIns, undefined, (list) => setSignIns(list)));

    const selected = createMemo(() => resolveModel(models(), preferred()));
    const thinking = createMemo(() => {
      const model = selected();
      return model === undefined ? undefined : clampThinking(model, thinkingByModel()[model.ref] ?? DEFAULT_THINKING);
    });
    const configured = createMemo(() => providers().some((provider) => provider.configured));

    /** Each listing applied calls these, so `settle` hears it. */
    const listings = new Set<() => void>();
    /** The latest listing asked for: an older one answering after it must not undo it. */
    let asked = 0;
    /** That listing, until it applies: one it superseded ends when it does, so whoever awaits a listing sees one. */
    let latest: Promise<void> = Promise.resolve();
    const refresh = (): Promise<void> => {
      const listing = ++asked;
      const listed = (async () => {
        const [nextProviders, nextModels] = await Promise.all([
          client.channel.call(LlmChannels.providers, undefined),
          client.channel.call(LlmChannels.models, { available: true }),
        ]);
        // Asked again meanwhile (`llm.changes` reporting the login this listing follows, say): the later one shows.
        if (listing !== asked) return latest;
        batch(() => {
          setProviders(nextProviders);
          setModels(nextModels);
          setLoadedAt(true);
        });
        for (const heard of listings) heard();
      })();
      latest = listed;
      return listed;
    };

    // Listed when subscribed, and again after each change it reports: a login wherever it ran, a provider's catalog
    // refreshing (a ChatGPT plan's list, say). It starts afresh, so lists again, when the llm plugin reloads (a change
    // to its providers) or comes back.
    plugin.onCleanup(client.follow(LlmChannels.changes, undefined, () => void refresh().catch((error) => notify.report(error, "Sync failed"))));

    /**
     * Waits until the host lists a provider as `listed` wants, after a change
     * saved to the llm plugin's config: its reload may finish after the reply,
     * and `llm.changes` says when, starting afresh on the reloaded plugin.
     * Undefined if it is not listed so within `SETTLE_MS`.
     */
    const settle = (id: string, listed: (provider: ProviderInfo | undefined) => boolean) =>
      new Promise<ProviderInfo | undefined>((resolve) => {
        const check = () => {
          const found = providers().find((provider) => provider.id === id);
          if (!listed(found)) return;
          listings.delete(check);
          clearTimeout(timer);
          resolve(found);
        };
        const timer = setTimeout(() => {
          listings.delete(check);
          resolve(undefined);
        }, SETTLE_MS);
        listings.add(check);
        check();
      });
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
          try {
            // Where this page's browser is may decide a sign-in's way in; the desktop app's page offers a way back to it.
            const returnTo = signInReturn((window as Window & { lemmaDesktop?: { readonly deepLinkScheme?: string } }).lemmaDesktop);
            await client.channel.call(LlmChannels.login, {
              provider: provider.id,
              type,
              browser: browserPlace(location.hostname),
              ...(returnTo === undefined ? {} : { returnTo }),
            });
            // Listed now, so it shows connected as the call returns: `llm.changes` reports it too, a moment later.
            await refresh();
            return true;
          } catch (error) {
            // Whoever cancelled it knows.
            if (!(error instanceof HostError && error.code === "Cancelled")) notify.report(error, `Login to ${provider.name} failed`);
            return false;
          } finally {
            setLoggingIn(undefined);
          }
        },
        signIns,
        answerSignIn: (signIn: SignIn, value: string) => client.channel.call(LlmChannels.answerSignIn, { provider: signIn.provider, seq: signIn.seq, value }),
        cancelLogin: async (provider: ProviderInfo) => {
          return client.channel.call(LlmChannels.cancelLogin, { provider: provider.id }).catch((error) => {
            notify.report(error, `Could not cancel the ${provider.name} login`);
            // It may still run: say so, so the caller does not forget it.
            return true;
          });
        },
        logout: async (provider: ProviderInfo) => {
          try {
            await client.channel.call(LlmChannels.logout, { provider: provider.id });
            notify.toast({ level: "info", message: `Logged out of ${provider.name}. To end its access there too, revoke it with ${provider.name}.` });
            await refresh();
          } catch (error) {
            notify.report(error, "Logout failed");
          }
        },
        addCustom: async (spec: CustomProviderSpec) => {
          const id = await client.channel.call(LlmChannels.addCustom, { spec });
          const provider = await settle(id, (found) => found !== undefined);
          if (provider === undefined) throw new Error(`The host did not list ${spec.name} after saving it`);
          return provider;
        },
        removeCustom: async (provider: ProviderInfo) => {
          await client.channel.call(LlmChannels.removeCustom, { provider: provider.id });
          await settle(provider.id, (found) => found === undefined);
        },
        setLogo: async (provider: ProviderInfo, svg: string | undefined) => {
          await client.channel.call(LlmChannels.setLogo, svg === undefined ? { provider: provider.id } : { provider: provider.id, svg });
          await settle(provider.id, (found) => found?.logo === svg);
        },
        refresh,
      },
    };
  },
});
