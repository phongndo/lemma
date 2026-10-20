import { Cause, Deferred, Effect, Exit, PubSub, Stream } from "effect";
import type { Scope } from "effect";
import { asksAnswer, LlmError } from "./llm.ts";
import type { AuthType, SignIn, SignInEnd, SignInStep } from "./llm.ts";

/** How long an ended sign-in stays listed, so every client can say how it ended. */
export const ENDED_LISTED_MS = 5_000;

/** What a step that was answered shows until the flow shows its next, unless the flow says (`AskOptions.answered`). */
const ANSWERED: SignInStep = { type: "working", message: "Continuing" };

/**
 * Numbers the steps of every sign-in in this process, from the time it started: rising across a provider's reloads,
 * and past those of a process before it, so an answer meant for a step of a replaced sign-in can never land on a
 * replacement's.
 */
let counter = Date.now();

/** What a flow says of a step it asks: what shows once it is answered, and once it is withdrawn. */
export interface AskOptions {
  /** Shows once a client answers, until the flow shows its next step: "Checking the key". Default: `Continuing`. */
  readonly answered?: SignInStep;
  /**
   * Shows when the flow withdraws the step while it shows (the browser came back before a paste): what the flow is
   * doing now. Default: the step it replaced.
   */
  readonly withdrawn?: SignInStep;
}

/** What a login flow is handed to tell the person, and ask them, through its `SignIn`. */
export interface SignInFlow {
  /** Shows a step that asks nothing: a page to open, a code to enter, progress. Callable from a callback, outside any fiber. */
  readonly show: (step: SignInStep) => void;
  /**
   * Shows a step that asks (`asksAnswer`), and waits for its answer. Interrupted (the flow no longer needs it), it is
   * withdrawn: `options.withdrawn`, else the step before it, shows again, unless another has replaced it meanwhile. A
   * step shown again is a new step, with its own number: a client compares what it shows, not only its number.
   */
  readonly ask: (step: SignInStep, options?: AskOptions) => Effect.Effect<string>;
  /** Points the person to something on the way: documentation for what the flow asks. Callable as `show` is. */
  readonly info: (message: string, links: readonly { readonly url: string; readonly label?: string }[]) => void;
}

/** The sign-ins a provider of `Llm` runs: what it lists in `signIns`, answers in `answerSignIn`, and runs each login in. */
export interface SignIns {
  /** The sign-ins now, then the list after each change (`Llm.signIns`). */
  readonly list: Stream.Stream<readonly SignIn[]>;
  /** The sign-ins now. */
  readonly current: () => readonly SignIn[];
  /** `Llm.answerSignIn`: fails `NotAsked` unless `seq` is the provider's open step. */
  readonly answer: (provider: string, seq: number, value: string) => Effect.Effect<void, LlmError>;
  /**
   * Runs `flow` as the provider's sign-in, listed while it runs, replacing an ended one still listed. How it ends is
   * listed for a few seconds: signed in (with `detail` of what it returned), failed (with its error's message), or
   * cancelled (interrupted).
   */
  readonly run: <A, E, R>(
    provider: string,
    method: AuthType,
    flow: (signIn: SignInFlow) => Effect.Effect<A, E, R>,
    detail?: (value: A) => string | undefined,
  ) => Effect.Effect<A, E, R>;
}

interface Entry {
  signIn: SignIn;
  pending?: { readonly seq: number; readonly answer: Deferred.Deferred<string>; readonly answered: SignInStep } | undefined;
}

const messageOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/**
 * The sign-ins of a provider of `Llm`, kept for its lifetime (the scope): one a provider at a time. Steps are numbered
 * across all of them, and every instance, so an answer can never reach a later step, or a later sign-in, by mistake.
 * `endedListedMs`: how long an ended one stays listed (`ENDED_LISTED_MS`).
 */
export const makeSignIns = (options: { readonly endedListedMs?: number } = {}): Effect.Effect<SignIns, never, Scope.Scope> =>
  Effect.gen(function* () {
    const endedListedMs = options.endedListedMs ?? ENDED_LISTED_MS;
    const scope = yield* Effect.scope;
    // The latest list is replayed to each new subscriber: it starts with what is running now.
    const lists = yield* Effect.acquireRelease(PubSub.unbounded<readonly SignIn[]>({ replay: 1 }), PubSub.shutdown);
    const entries = new Map<string, Entry>();
    const current = () => [...entries.values()].map((entry) => entry.signIn);
    // Published as an effect inside a fiber, so a subscriber never runs in the middle of this code; a flow's callbacks
    // (`show`, `info`) run outside any fiber and publish at once.
    const published = Effect.suspend(() => PubSub.publish(lists, current())).pipe(Effect.asVoid);
    const publishNow = () => void PubSub.publishUnsafe(lists, current());
    const set = (entry: Entry, fields: Partial<SignIn>) => void (entry.signIn = { ...entry.signIn, ...fields });
    const live = (entry: Entry) => entries.get(entry.signIn.provider) === entry && entry.signIn.ended === undefined;
    yield* published;

    const run: SignIns["run"] = (provider, method, flow, detail) =>
      Effect.suspend(() => {
        const entry: Entry = {
          signIn: { provider, method, seq: ++counter, step: { type: "working", message: "Starting" }, startedAt: Date.now() },
        };
        entries.set(provider, entry);
        const signIn: SignInFlow = {
          show: (step) => {
            if (!live(entry)) return;
            set(entry, { step, seq: ++counter });
            publishNow();
          },
          info: (message, links) => {
            if (!live(entry)) return;
            set(entry, { info: { message, links: links.map((link) => ({ ...link })) } });
            publishNow();
          },
          ask: (step, options = {}) =>
            Effect.suspend(() => {
              const before = entry.signIn.step;
              const answer = Deferred.makeUnsafe<string>();
              const seq = ++counter;
              entry.pending = { seq, answer, answered: options.answered ?? ANSWERED };
              if (live(entry)) set(entry, { step, seq });
              return Effect.andThen(published, Deferred.await(answer)).pipe(
                Effect.onInterrupt(() =>
                  Effect.suspend(() => {
                    if (entry.pending?.answer === answer) entry.pending = undefined;
                    // Withdrawn while it shows: what the flow does now, or what it replaced, shows again.
                    if (!live(entry) || entry.signIn.seq !== seq) return Effect.void;
                    set(entry, { step: options.withdrawn ?? before, seq: ++counter });
                    return published;
                  }),
                ),
              );
            }),
        };
        const end = (ended: SignInEnd) =>
          Effect.suspend(() => {
            entry.pending = undefined;
            if (entries.get(provider) !== entry) return Effect.void;
            set(entry, { ended });
            const unlist = Effect.suspend(() => {
              if (entries.get(provider) !== entry) return Effect.void;
              entries.delete(provider);
              return published;
            });
            return Effect.andThen(published, Effect.forkIn(Effect.andThen(Effect.sleep(endedListedMs), unlist), scope));
          }).pipe(Effect.asVoid);
        // Listed from here on, so its end is said however early it comes: an interrupt as it is first published too.
        return Effect.andThen(published, flow(signIn)).pipe(
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) {
              const said = detail?.(exit.value);
              return end({ outcome: "signed-in", ...(said === undefined ? {} : { detail: said }) });
            }
            return end(Cause.hasInterruptsOnly(exit.cause) ? { outcome: "cancelled" } : { outcome: "failed", message: messageOf(exit.cause) });
          }),
        );
      });

    const answer: SignIns["answer"] = (provider, seq, value) =>
      Effect.suspend(() => {
        const entry = entries.get(provider);
        const pending = entry?.pending;
        if (entry === undefined || pending === undefined || pending.seq !== seq || entry.signIn.seq !== seq || !asksAnswer(entry.signIn.step)) {
          return Effect.fail(
            new LlmError({ reason: "NotAsked", provider, message: `The ${provider} sign-in is not asking that now: it was answered, or it moved on` }),
          );
        }
        entry.pending = undefined;
        set(entry, { step: pending.answered, seq: ++counter });
        // Handed over before the list is told, so the answer stands though its caller stops on hearing the step go.
        return Effect.andThen(Deferred.succeed(pending.answer, value), published).pipe(Effect.asVoid);
      });

    return { list: Stream.fromPubSub(lists), current, answer, run };
  });
