import { Effect, Stream } from "effect";
import type { Context } from "effect";
import { definePlugin, Events, Registries } from "@lemma/core";
import { Notice } from "@lemma/contracts";
import type { NoticePayload } from "@lemma/contracts";
import { LlmChannels } from "@lemma/llm";
import type { ModelInfo, ProviderInfo } from "@lemma/llm";
import { callHere, CliChecks, CliCommandError, CliCommands, defineCliCommand, formatTokens, table, usageError } from "@lemma/cli";

type Reader = Context.Service.Shape<typeof Registries>;

export const formatModels = (models: readonly ModelInfo[]): string =>
  models.length === 0
    ? "No models. Log in to a provider (lemma providers, lemma login <provider>), or use --all."
    : table([
        ["model", "name", "context", "thinking", "input", "$/M in/out"],
        ...models.map((model) => [
          model.ref,
          model.name,
          formatTokens(model.contextWindow),
          model.reasoning ? model.thinkingLevels.join(",") : "no",
          model.input.join(","),
          model.cost.input === 0 && model.cost.output === 0 ? "" : `${model.cost.input}/${model.cost.output}`,
        ]),
      ]);

export const formatProviders = (providers: readonly ProviderInfo[]): string =>
  table([
    ["provider", "name", "configured", "from", "login"],
    ...providers.map((provider) => [
      provider.id,
      provider.name,
      provider.configured ? "yes" : "no",
      provider.source ?? "",
      provider.auth.map((auth) => auth.type).join(", "),
    ]),
  ]);

/**
 * A login's notice for the terminal, by its kind: the sign-in page and the
 * code alone on their lines, unindented, so a wrapped link still copies
 * whole; a documentation link on its own line under what it explains. Its
 * success and end print nothing: the command's own result says them. `link`
 * is the page a sign-in or code names.
 */
export const loginLines = (notice: NoticePayload, providerName: string): { readonly lines: readonly string[]; readonly link?: string } => {
  const link = notice.links?.[0]?.url;
  switch (notice.kind) {
    case "device-code":
      return notice.code === undefined || link === undefined
        ? { lines: [notice.message] }
        : {
            link,
            lines: ["", `First copy your one-time code: ${notice.code}`, `Then enter it at ${link}`, "Only enter this code if you started this sign-in.", ""],
          };
    case "sign-in":
      return link === undefined
        ? { lines: [notice.message] }
        : { link, lines: ["", `Sign in to ${providerName} in your browser:`, "", link, "", "Open it in any browser, on this machine or another.", ""] };
    case "signed-in":
    case "ended":
      return { lines: [] };
    default:
      return { lines: [notice.message, ...(notice.links ?? []).map((item) => (item.label === undefined ? item.url : `${item.label}: ${item.url}`))] };
  }
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const provider = [{ name: "provider", description: "A provider's id (lemma providers lists them)", required: true }] as const;

export const llmCommands = (registries: Reader, events: Context.Service.Shape<typeof Events>) => [
  defineCliCommand({
    path: ["models"],
    summary: "The models you can use now: their reference, context, thinking levels, and price",
    flags: { all: { type: "boolean", description: "Every known model, logged in or not" } },
    run: ({ flags }) =>
      Effect.map(callHere(registries, LlmChannels.models, flags.all ? {} : { available: true }), (models) => ({
        json: models,
        text: formatModels(models),
        ids: models.map((model) => model.ref),
      })),
  }),
  defineCliCommand({
    path: ["providers"],
    summary: "The model providers, whether each is configured, and how to log in to it",
    run: () =>
      Effect.map(callHere(registries, LlmChannels.providers, undefined), (providers) => ({
        json: providers,
        text: formatProviders(providers),
        ids: providers.map((info) => info.id),
      })),
  }),
  defineCliCommand({
    path: ["login"],
    summary: "Log in to a provider: an API key, or a sign-in in the browser",
    description:
      "A sign-in's link and one-time code print on lines of their own, so they copy whole into a browser on any machine; with a browser here, the link opens in it. Its questions (an API key) are asked as --questions says. Ctrl+C cancels the login.",
    args: provider,
    flags: { method: { type: "string", values: ["api_key", "oauth"], description: "How to log in, when it offers both (default: its first)" } },
    run: ({ args, flags, out }) =>
      Effect.gen(function* () {
        const info = (yield* callHere(registries, LlmChannels.providers, undefined)).find((candidate) => candidate.id === args.provider);
        if (info === undefined)
          return yield* new CliCommandError({ reason: "UnknownProvider", message: `No provider "${args.provider}"`, subject: args.provider });
        const method = flags.method ?? info.auth[0]?.type;
        if (method !== "api_key" && method !== "oauth") return yield* usageError(`${args.provider} offers no login here`);
        if (!info.auth.some((auth) => auth.type === method))
          return yield* usageError(`${args.provider} does not offer ${method}; it offers ${info.auth.map((auth) => auth.type).join(", ")}`);
        // Its questions and notices carry its origin: the client answers those, and this shows these.
        const origin = `login:${args.provider}`;
        out.answer(origin);
        yield* Effect.forkScoped(
          Stream.runForEach(events.stream(Notice, { buffer: 64 }), (notice) =>
            Effect.sync(() => {
              if (notice.origin !== origin) return;
              const shown = loginLines(notice, info.name);
              for (const line of shown.lines) out.line(line, { err: true });
              if (shown.link === undefined) return;
              if (notice.kind === "sign-in") out.open({ url: shown.link });
              if (notice.kind === "device-code") out.open({ url: shown.link }, `Press Enter to open ${hostOf(shown.link)} in your browser… `);
            }),
          ),
        );
        yield* callHere(registries, LlmChannels.login, { provider: args.provider, type: method }).pipe(
          // Ctrl+C (the client cancels the run): the login stops on the host too, which it would otherwise outlive.
          Effect.onInterrupt(() => callHere(registries, LlmChannels.cancelLogin, { provider: args.provider }).pipe(Effect.ignore)),
        );
        return { json: { loggedIn: args.provider, method }, text: `logged in to ${info.name}` };
      }).pipe(Effect.scoped),
  }),
  defineCliCommand({
    path: ["logout"],
    summary: "Log out of a provider: forget its stored key or sign-in",
    args: provider,
    run: ({ args }) =>
      Effect.as(callHere(registries, LlmChannels.logout, { provider: args.provider }), {
        json: { loggedOut: args.provider },
        text: `logged out of ${args.provider}`,
      }),
  }),
];

/**
 * The model providers' commands for the `lemma` command (`CliCommands`):
 * `models`, `providers`, `login`, `logout`; and `lemma doctor`'s check that a
 * model is there to use (`CliChecks`). It reaches the providers through their
 * channels, so it requires nothing.
 */
export default definePlugin({
  id: "llm.cli",
  version: "0.1.0",
  setup: function* (_, owner) {
    const registries = yield* Registries;
    const events = yield* Events;
    for (const command of llmCommands(registries, events)) yield* owner.add(CliCommands, command);
    yield* owner.add(CliChecks, {
      id: "llm.models",
      title: "Models",
      run: () =>
        Effect.map(callHere(registries, LlmChannels.models, { available: true }), (models) =>
          models.length > 0
            ? { status: "ok" as const, message: `${models.length} model${models.length === 1 ? "" : "s"} to use` }
            : {
                status: "fail" as const,
                message: "No model to use: no provider is logged in",
                fix: "lemma providers, then lemma login <provider> (or set its API key variable)",
              },
        ),
    });
  },
});
