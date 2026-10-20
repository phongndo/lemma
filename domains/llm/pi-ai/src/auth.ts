import { Cause, Effect, Exit } from "effect";
import type { Context } from "effect";
import type * as Pi from "@earendil-works/pi-ai";
import type { Credential, Credentials } from "@lemma/credentials";
import type { AskOptions, LoginOptions, SignInFlow, SignInStep } from "@lemma/llm";
import type { KeyCheck } from "./keycheck.ts";

type CredentialsService = typeof Credentials.Service;

/**
 * Runs an Effect as a promise for pi-ai: typed failures reject with the error
 * itself (not a FiberFailure), and interruption rejects with the signal's
 * reason so pi-ai sees an ordinary abort.
 */
export function runner(services: Context.Context<never>) {
  const run = Effect.runPromiseExitWith(services);
  return async <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> => {
    const exit = await run(effect, signal === undefined ? undefined : { signal });
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.findErrorOption(exit.cause);
    if (failure._tag === "Some") throw failure.value;
    if (Cause.hasInterruptsOnly(exit.cause)) throw signal?.reason ?? new DOMException("Aborted", "AbortError");
    throw Cause.squash(exit.cause);
  };
}

type Run = ReturnType<typeof runner>;

/** pi-ai's `CredentialStore` over the `Credentials` capability. The shapes match; `modify` keeps its lock. */
export function credentialStore(credentials: CredentialsService, run: Run): Pi.CredentialStore {
  return {
    read: (provider, options) => run(credentials.read(provider), options?.signal) as Promise<Pi.Credential | undefined>,
    list: async (options) => (await run(credentials.list, options?.signal)).map(({ provider, type }) => ({ providerId: provider, type })),
    modify: (provider, update, options) =>
      run(
        credentials.modify(provider, (current) =>
          Effect.tryPromise({
            try: () => update(current as Pi.Credential | undefined) as Promise<Credential | undefined>,
            // Rejections from `update` propagate unchanged, as pi-ai expects.
            catch: (error) => error,
          }),
        ),
        options?.signal,
      ) as Promise<Pi.Credential | undefined>,
    delete: (provider, options) => run(credentials.remove(provider), options?.signal),
  };
}

/** pi-ai's wording without what a terminal prompt ends with: `Enter the code:` is `Enter the code`. */
export const tidy = (text: string) => text.trim().replace(/\s*(?::|\.{3}|…)$/, "");

/** What a key prompt asks for: `Enter the Gateway API key` asks for the `Gateway API key`. */
const keyLabel = (message: string) => tidy(message).replace(/^enter\s+(?:the\s+|your\s+)?/i, "") || "API key";

/** The ways in a flow offers when the browser is not on the host's machine: a device code, or a code the page shows. */
const AWAY = new Set(["device-code", "device_code", "copy_code"]);

/**
 * The option a flow's choice of how to sign in takes without asking: the device or copied code, when the client said
 * the browser is elsewhere, as it works from any browser. A browser said to be `here` may not be (a page reached through
 * an SSH port forward looks local), and the browser's way back would then reach nothing, so the person picks.
 * Undefined: the person picks.
 */
export const chooseWay = (options: readonly { readonly id: string }[], browser: LoginOptions["browser"]): string | undefined => {
  const away = options.filter((option) => AWAY.has(option.id));
  if (browser !== "elsewhere" || !options.some((option) => option.id === "browser") || away.length !== 1 || options.length !== 2) return undefined;
  return away[0]!.id;
};

/** What a sign-in shows once its browser has come back, or its address was pasted: the code is being exchanged. */
const FINISHING: SignInStep = { type: "working", message: "Finishing sign-in" };

/** What the key check found, for the sign-in's end: how many models the key lists. */
export interface KeyFound {
  readonly models?: number;
}

/**
 * pi-ai's login callbacks as the steps of a `SignIn`:
 * - its link to open (`auth_url`) is a `browser` step, and the paste prompt that races its callback (`manual_code`) the
 *   same step taking a paste; a device code is a `code` step; progress is `working`; documentation is `info`.
 * - a secret prompt is a `key` step (in a login with a key; a `text` step masked otherwise), checked with `check` when
 *   given: a key the provider refuses is asked again, saying why. Text prompts are `text` steps, choices `choice`
 *   steps, but a choice between the browser and a code elsewhere, which `chooseWay` takes when the client said the
 *   browser is elsewhere.
 * A prompt's own signal (a callback that won the race against the paste) and the login's withdraw its step; a paste
 * withdrawn so, or answered, shows the code being exchanged rather than the page again.
 */
export function signInInteraction(
  signIn: SignInFlow,
  run: Run,
  signal: AbortSignal,
  options: { readonly browser?: LoginOptions["browser"]; readonly keys: boolean; readonly check?: KeyCheck | undefined },
): { readonly interaction: Pi.AuthInteraction; readonly found: () => KeyFound | undefined } {
  /** The page the flow sent the person to, which a paste prompt is about. */
  let page: string | undefined;
  let found: KeyFound | undefined;
  let checked = false;
  const ask = (step: SignInStep, withdraw: AbortSignal, then?: AskOptions) => run(signIn.ask(step, then), withdraw);
  const key = async (message: string, withdraw: AbortSignal): Promise<string> => {
    const label = keyLabel(message);
    const check = checked ? undefined : options.check;
    checked = true;
    let problem: string | undefined;
    for (;;) {
      const value = await ask({ type: "key", label, ...(problem === undefined ? {} : { problem }) }, withdraw, {
        answered: { type: "working", message: check === undefined ? "Saving the key" : "Checking the key" },
      });
      if (check === undefined || value.trim() === "") return value;
      const verdict = await check(value.trim(), withdraw);
      if (verdict.verdict !== "refused") {
        if (verdict.verdict === "works") found = verdict.models === undefined ? {} : { models: verdict.models };
        return value;
      }
      problem = verdict.problem;
    }
  };
  const interaction: Pi.AuthInteraction = {
    signal,
    notify: (event) => {
      switch (event.type) {
        case "auth_url":
          page = event.url;
          signIn.show({ type: "browser", url: event.url });
          return;
        case "device_code":
          signIn.show({
            type: "code",
            code: event.userCode,
            url: event.verificationUri,
            ...(event.expiresInSeconds === undefined ? {} : { expiresIn: event.expiresInSeconds }),
          });
          return;
        case "progress":
          signIn.show({ type: "working", message: tidy(event.message) });
          return;
        case "info":
          signIn.info(
            tidy(event.message),
            (event.links ?? []).map((link) => (link.label === undefined ? { url: link.url } : { url: link.url, label: link.label })),
          );
          return;
      }
    },
    prompt: (prompt) => {
      const withdraw = prompt.signal === undefined ? signal : AbortSignal.any([signal, prompt.signal]);
      switch (prompt.type) {
        case "select": {
          const chosen = chooseWay(prompt.options, options.browser);
          if (chosen !== undefined) return Promise.resolve(chosen);
          return ask(
            {
              type: "choice",
              title: tidy(prompt.message),
              options: prompt.options.map((option) => ({
                value: option.id,
                label: option.label,
                ...(option.description === undefined ? {} : { description: option.description }),
              })),
            },
            withdraw,
          );
        }
        case "secret":
          if (options.keys) return key(prompt.message, withdraw);
          return ask(
            { type: "text", title: tidy(prompt.message), secret: true, ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }) },
            withdraw,
          );
        case "text":
          return ask({ type: "text", title: tidy(prompt.message), ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }) }, withdraw);
        case "manual_code":
          // Without a page to open, it is a code the person was given some other way.
          if (page === undefined) {
            return ask(
              { type: "text", title: tidy(prompt.message), ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }) },
              withdraw,
            );
          }
          // Answered, or withdrawn as the browser came back first, the code is being exchanged: the page is done with.
          return ask({ type: "browser", url: page, paste: prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder } }, withdraw, {
            answered: FINISHING,
            withdrawn: FINISHING,
          });
      }
    },
  };
  return { interaction, found: () => found };
}
