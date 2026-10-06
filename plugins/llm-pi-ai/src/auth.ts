import { Cause, Effect, Exit } from "effect";
import type { Context } from "effect";
import type * as Pi from "@earendil-works/pi-ai";
import { InteractionOrigin } from "@lemma/contracts";
import type { Credential, Credentials, Interaction, NoticePayload } from "@lemma/contracts";

type CredentialsService = typeof Credentials.Service;
type InteractionService = typeof Interaction.Service;

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

/**
 * Login prompts become `Interaction` questions, asked under the login's
 * `origin`: pi-ai calls back through promises, outside the login's fiber, so
 * the origin is carried here rather than inherited. A prompt's own signal (a
 * callback server that won the race against a paste-the-code prompt) and the
 * login's signal both withdraw the pending question by interrupting it.
 */
export function authInteraction(
  interaction: InteractionService,
  run: Run,
  signal: AbortSignal,
  origin: string | undefined,
  notify: (event: Pi.AuthEvent) => void,
): Pi.AuthInteraction {
  const ask = <A>(effect: Effect.Effect<A, unknown>, withdraw: AbortSignal) =>
    run(origin === undefined ? effect : Effect.provideService(effect, InteractionOrigin, origin), withdraw);
  return {
    signal,
    notify,
    prompt: (prompt) => {
      const withdraw = prompt.signal === undefined ? signal : AbortSignal.any([signal, prompt.signal]);
      switch (prompt.type) {
        case "select":
          return ask(
            interaction.select(
              prompt.message,
              prompt.options.map((option) => ({
                value: option.id,
                label: option.label,
                ...(option.description === undefined ? {} : { description: option.description }),
              })),
            ),
            withdraw,
          );
        case "secret":
        case "text":
        case "manual_code":
          return ask(
            interaction.ask(prompt.message, {
              ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
              ...(prompt.type === "secret" ? { secret: true } : {}),
              ...(prompt.type === "manual_code" ? { kind: "sign-in-code" as const } : {}),
            }),
            withdraw,
          );
      }
    },
  };
}

export function toNotice(event: Pi.AuthEvent, providerName: string): NoticePayload {
  const base = { level: "info", source: "llm" } as const;
  switch (event.type) {
    case "auth_url":
      return {
        ...base,
        kind: "sign-in",
        message: event.instructions ?? `Open the link to sign in to ${providerName}.`,
        links: [{ url: event.url, label: `Sign in to ${providerName}` }],
      };
    case "device_code":
      return {
        ...base,
        kind: "device-code",
        message: `Enter code ${event.userCode} at ${event.verificationUri} to sign in to ${providerName}.`,
        code: event.userCode,
        links: [{ url: event.verificationUri, label: "Enter code" }],
      };
    case "info":
      return {
        ...base,
        message: event.message,
        ...(event.links === undefined
          ? {}
          : {
              links: event.links.map((link) => ({ url: link.url, ...(link.label === undefined ? {} : { label: link.label }) })),
            }),
      };
    case "progress":
      return { ...base, kind: "progress", message: event.message };
  }
}
