import { Effect, Fiber } from "effect";
import type { Context } from "effect";
import { definePlugin, Registries } from "@lemma/core";
import { Interaction, InteractionError } from "@lemma/contracts";
import { LlmChannels } from "@lemma/llm";
import type { ModelInfo, ProviderInfo, SignIn, SignInStep } from "@lemma/llm";
import { callHere, CliChecks, CliCommandError, CliCommands, defineCliCommand, followHere, formatTokens, table, usageError } from "@lemma/cli";

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
 * A sign-in's step for the terminal: the page to open and the code to enter alone on their lines, unindented, so a
 * wrapped link still copies whole; progress as it says itself. `link` is the page a step names, to open; `ask` is
 * what it asks, which the command asks at the terminal. Nothing for a step that only waits on an answer it took.
 */
export const stepLines = (step: SignInStep, providerName: string): { readonly lines: readonly string[]; readonly link?: string; readonly ask?: SignInAsk } => {
  switch (step.type) {
    case "browser":
      return {
        link: step.url,
        lines: ["", `Sign in to ${providerName} in your browser:`, "", step.url, "", "Open it in any browser, on this machine or another.", ""],
        ...(step.paste === undefined
          ? {}
          : {
              ask: {
                type: "text",
                title: "If the browser cannot reach this machine, paste the address it ended on",
                ...(step.paste.placeholder === undefined ? {} : { placeholder: step.paste.placeholder }),
              },
            }),
      };
    case "code":
      return {
        link: step.url,
        lines: ["", `First copy your one-time code: ${step.code}`, `Then enter it at ${step.url}`, "Only enter this code if you started this sign-in.", ""],
      };
    case "key":
      return { lines: step.problem === undefined ? [] : [step.problem], ask: { type: "text", title: `Paste your ${step.label}`, secret: true } };
    case "text":
      return {
        lines: [],
        ask: {
          type: "text",
          title: step.title,
          ...(step.placeholder === undefined ? {} : { placeholder: step.placeholder }),
          ...(step.secret ? { secret: true } : {}),
        },
      };
    case "choice":
      return { lines: [], ask: { type: "choice", title: step.title, options: step.options } };
    case "working":
      return { lines: [`${step.message}…`] };
  }
};

/** What a step asks at the terminal. */
export type SignInAsk =
  | { readonly type: "text"; readonly title: string; readonly placeholder?: string; readonly secret?: boolean }
  | { readonly type: "choice"; readonly title: string; readonly options: Extract<SignInStep, { type: "choice" }>["options"] };

/**
 * What the terminal does on hearing of a sign-in: lines to print, a page to open (asking `prompt` first), and what to
 * ask. `fresh`: a new step, which withdraws what the step before asked.
 */
export interface SignInTurn {
  readonly fresh: boolean;
  readonly lines: readonly string[];
  readonly open?: { readonly url: string; readonly prompt?: string };
  readonly ask?: SignInAsk;
}

/**
 * Follows one sign-in's list entries for the terminal: what each new step adds there, or undefined for nothing new. A
 * page or a code prints, and opens, the first time it is seen, whichever step brings it (one that also takes a paste,
 * though the plain one before it went by unseen), and never again (a step shown again once a paste is withdrawn); a
 * documentation link prints once; progress prints when it changes. A step that asks is asked each time it is new.
 */
export const signInPrinter = (providerName: string) => {
  let seq: number | undefined;
  let pointed: string | undefined;
  let working: string | undefined;
  const seen = new Set<string>();
  return (signIn: SignIn): SignInTurn | undefined => {
    const lines: string[] = [];
    if (signIn.info !== undefined && signIn.info.message !== pointed) {
      pointed = signIn.info.message;
      lines.push(signIn.info.message, ...signIn.info.links.map((link) => (link.label === undefined ? link.url : `${link.label}: ${link.url}`)));
    }
    if (signIn.ended !== undefined || signIn.seq === seq) return lines.length === 0 ? undefined : { fresh: false, lines };
    seq = signIn.seq;
    const { step } = signIn;
    const shown = stepLines(step, providerName);
    let open: SignInTurn["open"];
    if (step.type === "working") {
      if (step.message !== working) lines.push(...shown.lines);
      working = step.message;
    } else {
      working = undefined;
      const page = step.type === "browser" ? `page ${step.url}` : step.type === "code" ? `code ${step.code}` : undefined;
      if (page === undefined || !seen.has(page)) {
        lines.push(...shown.lines);
        if (page !== undefined) seen.add(page);
        if (step.type === "browser") open = { url: step.url };
        if (step.type === "code") open = { url: step.url, prompt: `Press Enter to open ${hostOf(step.url)} in your browser… ` };
      }
    }
    return { fresh: true, lines, ...(open === undefined ? {} : { open }), ...(shown.ask === undefined ? {} : { ask: shown.ask }) };
  };
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const provider = [{ name: "provider", description: "A provider's id (lemma providers lists them)", required: true }] as const;

export const llmCommands = (registries: Reader, interaction: Context.Service.Shape<typeof Interaction>) => [
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
      "A sign-in's link and one-time code print on lines of their own, so they copy whole into a browser on any machine; with a browser here, the link opens in it. What it asks (an API key, the address a browser elsewhere ended on) is asked as --questions says. Ctrl+C cancels the login.",
    args: provider,
    flags: {
      method: { type: "string", values: ["api_key", "oauth"], description: "How to log in, when it offers both (default: its first)" },
      elsewhere: {
        type: "boolean",
        description: "The browser is on another machine than the host (an SSH session): a sign-in that offers a device code uses it",
      },
    },
    run: ({ args, flags, out }) =>
      Effect.gen(function* () {
        const info = (yield* callHere(registries, LlmChannels.providers, undefined)).find((candidate) => candidate.id === args.provider);
        if (info === undefined)
          return yield* new CliCommandError({ reason: "UnknownProvider", message: `No provider "${args.provider}"`, subject: args.provider });
        const method = flags.method ?? info.auth[0]?.type;
        if (method !== "api_key" && method !== "oauth") return yield* usageError(`${args.provider} offers no login here`);
        if (!info.auth.some((auth) => auth.type === method))
          return yield* usageError(`${args.provider} does not offer ${method}; it offers ${info.auth.map((auth) => auth.type).join(", ")}`);
        // Its sign-in's steps, shown as they come; what one asks is asked here, under this command's origin, which the
        // client answers, and handed to the sign-in. A step that goes (the browser came back first) withdraws its question.
        const scope = yield* Effect.scope;
        const next = signInPrinter(info.name);
        let asking: Fiber.Fiber<void, unknown> | undefined;
        const show = (signIn: SignIn) =>
          Effect.gen(function* () {
            const step = next(signIn);
            if (step === undefined) return;
            // A new step: the question an earlier one asked is no longer wanted.
            if (asking !== undefined && step.fresh) {
              yield* Fiber.interrupt(asking);
              asking = undefined;
            }
            for (const line of step.lines) out.line(line, { err: true });
            if (step.open !== undefined) out.open({ url: step.open.url }, ...(step.open.prompt === undefined ? [] : [step.open.prompt]));
            const ask = step.ask;
            if (ask === undefined || !step.fresh) return;
            const answer =
              ask.type === "choice"
                ? interaction.select(
                    ask.title,
                    ask.options.map((option) => ({
                      value: option.value,
                      label: option.label,
                      ...(option.description === undefined ? {} : { description: option.description }),
                    })),
                  )
                : interaction.ask(ask.title, {
                    ...(ask.placeholder === undefined ? {} : { placeholder: ask.placeholder }),
                    ...(ask.secret ? { secret: true } : {}),
                  });
            asking = yield* Effect.forkIn(
              answer.pipe(
                Effect.flatMap((value) => callHere(registries, LlmChannels.answerSignIn, { provider: args.provider, seq: signIn.seq, value })),
                // Closed at the terminal: the login stops, as Ctrl+C stops it.
                Effect.catch((error) =>
                  error instanceof InteractionError && error.reason === "Dismissed"
                    ? callHere(registries, LlmChannels.cancelLogin, { provider: args.provider })
                    : Effect.fail(error),
                ),
                Effect.ignore,
              ),
              scope,
            );
          });
        yield* Effect.forkScoped(
          followHere(
            registries,
            LlmChannels.signIns,
            () => undefined,
            (list) => {
              const signIn = list.find((candidate) => candidate.provider === args.provider);
              return signIn === undefined ? Effect.void : show(signIn);
            },
          ),
        );
        yield* callHere(registries, LlmChannels.login, {
          provider: args.provider,
          type: method,
          ...(flags.elsewhere === true ? { browser: "elsewhere" as const } : {}),
        }).pipe(
          // Ctrl+C (the client cancels the run): the login stops on the host too, which it would otherwise outlive.
          Effect.onInterrupt(() => callHere(registries, LlmChannels.cancelLogin, { provider: args.provider }).pipe(Effect.ignore)),
        );
        const signedIn = (yield* callHere(registries, LlmChannels.providers, undefined)).find((candidate) => candidate.id === args.provider);
        return {
          json: { loggedIn: args.provider, method, ...(signedIn?.account === undefined ? {} : { account: signedIn.account }) },
          text: `logged in to ${info.name}${signedIn?.account === undefined ? "" : ` as ${signedIn.account}`}`,
        };
      }).pipe(Effect.scoped),
  }),
  defineCliCommand({
    path: ["logout"],
    summary: "Log out of a provider: forget its stored key or sign-in",
    description:
      "Lemma forgets the key or sign-in it stored. The provider still honors them until you revoke them there: delete the key, or remove Lemma from the account's connected apps.",
    args: provider,
    run: ({ args }) =>
      Effect.as(callHere(registries, LlmChannels.logout, { provider: args.provider }), {
        json: { loggedOut: args.provider },
        text: `logged out of ${args.provider}: Lemma forgot what it stored; revoke it with the provider to end it there too`,
      }),
  }),
];

/**
 * The model providers' commands for the `lemma` command (`CliCommands`):
 * `models`, `providers`, `login`, `logout`; and `lemma doctor`'s check that a
 * model is there to use (`CliChecks`). It reaches the providers through their
 * channels, so it requires only `Interaction`, to ask at the terminal what a
 * sign-in asks.
 */
export default definePlugin({
  id: "llm.cli",
  version: "0.1.0",
  requires: { interaction: Interaction },
  setup: function* ({ interaction }, owner) {
    const registries = yield* Registries;
    for (const command of llmCommands(registries, interaction)) yield* owner.add(CliCommands, command);
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
