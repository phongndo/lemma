import { Cause, Effect, Exit, Runtime } from "effect";
import type * as Pi from "@earendil-works/pi-ai";
import type { Credential, Credentials, Interaction, NoticePayload } from "@lemma/contracts";

type CredentialsService = typeof Credentials.Service;
type InteractionService = typeof Interaction.Service;

/**
 * Runs an Effect as a promise for pi-ai: typed failures reject with the error
 * itself (not a FiberFailure), and interruption rejects with the signal's
 * reason so pi-ai sees an ordinary abort.
 */
export function runner(runtime: Runtime.Runtime<never>) {
  const run = Runtime.runPromiseExit(runtime);
  return async <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> => {
    const exit = await run(effect, signal === undefined ? undefined : { signal });
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === "Some") throw failure.value;
    if (Cause.isInterruptedOnly(exit.cause)) throw signal?.reason ?? new DOMException("Aborted", "AbortError");
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
 * Login prompts become `Interaction` questions. A prompt's own signal (a
 * callback server that won the race against a paste-the-code prompt) and the
 * login's signal both withdraw the pending question by interrupting it.
 */
export function authInteraction(interaction: InteractionService, run: Run, signal: AbortSignal, notify: (event: Pi.AuthEvent) => void): Pi.AuthInteraction {
  return {
    signal,
    notify,
    prompt: (prompt) => {
      const withdraw = prompt.signal === undefined ? signal : AbortSignal.any([signal, prompt.signal]);
      switch (prompt.type) {
        case "select":
          return run(
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
          return run(
            interaction.ask(prompt.message, {
              ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
              ...(prompt.type === "secret" ? { secret: true } : {}),
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
        message: event.instructions ?? `Open the link to sign in to ${providerName}.`,
        links: [{ url: event.url, label: `Sign in to ${providerName}` }],
      };
    case "device_code":
      return {
        ...base,
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
      return { ...base, message: event.message };
  }
}
