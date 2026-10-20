import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { Duration, Effect } from "effect";
import { signInPage } from "./page.ts";
import type { LoginContext } from "./providers.ts";

/**
 * What the sign-ins share: the browser's way back to a local server (and its URL pasted by hand, when the browser is on
 * another machine), PKCE, and the device-code grant, where the person enters a code on the provider's site while Lemma
 * asks it, now and then, whether they have.
 */

/** A random value for a state, a verifier, or a path, URL-safe. */
export const random = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** A PKCE verifier and its S256 challenge. */
export function pkce(): { readonly verifier: string; readonly challenge: string } {
  const verifier = random();
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export interface LoopbackOptions<A> {
  /** As its pages name it: "ChatGPT". */
  readonly provider: string;
  /** The port it listens on, `0` for any free one, and the path the browser comes back to. */
  readonly port: number;
  readonly path: string;
  /** What else may hold the port, for the error saying it is taken. */
  readonly holders?: string;
  /** Whether a callback is this login's (its state is), which only then can end it: another's (a stale tab's) cannot. */
  readonly ours: (url: URL) => boolean;
  /** What a callback of this login's signs in with: its code read, and exchanged for tokens. Throws to fail the login. */
  readonly accept: (url: URL) => Promise<A>;
  /** Told as the code is taken, before it is exchanged (a progress notice). */
  readonly exchanging?: () => void;
}

/** A login's local server: where the browser is sent back, and what the first callback of this login's signed in with. */
export interface Loopback<A> {
  readonly redirectUri: string;
  readonly result: Promise<A>;
  /** Takes the sign-in a pasted URL brings, through the same `accept`, unless a callback already did. */
  readonly paste: (url: URL) => Promise<A>;
}

/**
 * Listens for the browser's way back, on 127.0.0.1, for as long as the scope is open. The page it answers with is
 * Lemma's (`page.ts`) and says whether the sign-in went through, once the code is exchanged; any page can send the
 * browser here, so a request that is no callback of this login's is answered and ignored.
 */
export const loopback = <A>(options: LoopbackOptions<A>) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly server: Server; readonly loopback: Loopback<A> }, Error>((resume) => {
      let settle!: { resolve: (value: A) => void; reject: (error: Error) => void };
      const result = new Promise<A>((resolve, reject) => (settle = { resolve, reject }));
      // Kept from becoming an unhandled rejection when a paste wins and the server closes unanswered.
      result.catch(() => undefined);
      let claimed = false;
      /** The one sign-in this login takes, the callback's or the paste's, whichever comes first. */
      const take = (url: URL): Promise<A> => {
        if (claimed) return Promise.reject(new Error("This sign-in was already completed"));
        claimed = true;
        options.exchanging?.();
        // A throw before `accept` has a promise to return fails the sign-in too, never the server.
        return Promise.resolve()
          .then(() => options.accept(url))
          .then(
            (value) => (settle.resolve(value), value),
            (error: unknown) => {
              const failure = error instanceof Error ? error : new Error(String(error));
              settle.reject(failure);
              throw failure;
            },
          );
      };
      const notOne = `This address is where a ${options.provider} sign-in comes back to Lemma.`;
      let base = `http://127.0.0.1:${options.port}`;
      const server = createServer((request, response) => {
        const send = (status: number, body: string) =>
          response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
        // A path that is no URL is answered, not thrown where nothing catches it.
        let url: URL;
        try {
          url = new URL(request.url ?? "", base);
        } catch {
          return send(400, signInPage("failed", "Not a sign-in", notOne));
        }
        if (request.method !== "GET" || url.pathname !== options.path) return send(404, signInPage("failed", "Not a sign-in", notOne));
        if (!options.ours(url))
          return send(
            400,
            signInPage("failed", `${options.provider} was not connected`, "This page is from another sign-in. Use the latest one Lemma opened."),
          );
        if (claimed) return send(409, signInPage("failed", `${options.provider} was not connected`, "This sign-in was already completed."));
        take(url).then(
          () => send(200, signInPage("signed-in", `Signed in to ${options.provider}`, "You can close this tab and go back to Lemma.")),
          (error: Error) => send(400, signInPage("failed", `${options.provider} was not connected`, error.message)),
        );
      });
      server.once("error", (error: NodeJS.ErrnoException) =>
        resume(
          Effect.fail(
            error.code === "EADDRINUSE"
              ? new Error(
                  `Port ${options.port} is in use, probably by an unfinished sign-in${options.holders === undefined ? "" : ` or ${options.holders}`}. Cancel it and try again.`,
                )
              : error,
          ),
        ),
      );
      server.listen(options.port, "127.0.0.1", () => {
        const address = server.address();
        if (address !== null && typeof address === "object") base = `http://127.0.0.1:${address.port}`;
        resume(Effect.succeed({ server, loopback: { redirectUri: `${base}${options.path}`, result, paste: take } }));
      });
    }),
    ({ server }) =>
      Effect.sync(() => {
        server.close();
        // A connection the browser opened ahead of time could otherwise take a later login's callback.
        server.closeAllConnections();
      }),
  ).pipe(Effect.map(({ loopback }) => loopback));

/**
 * The sign-in the browser's callback brings, or the redirect URL the person pastes when it cannot reach this machine:
 * whichever comes first, the other withdrawn. `parse` reads what was pasted as a callback URL of this login's, or
 * fails saying what to paste.
 */
export const callbackOrPaste = <A>(context: LoginContext, server: Loopback<A>, question: string, parse: (input: string) => URL) =>
  Effect.raceFirst(
    Effect.promise(() =>
      server.result.then(
        (value) => ({ value }),
        (error: Error) => ({ error }),
      ),
    ).pipe(Effect.flatMap((settled) => ("error" in settled ? Effect.fail(settled.error) : Effect.succeed(settled.value)))),
    context.ask(question, { placeholder: server.redirectUri, kind: "sign-in-code" }).pipe(
      Effect.flatMap((input) =>
        Effect.tryPromise({
          try: () => server.paste(parse(input)),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
      ),
    ),
  );

/** What a provider's device authorization gave: the code to enter, where, and how often to ask whether it was. */
export interface DeviceGrant {
  readonly userCode: string;
  /** Where to enter it; best a URL with the code already in it. */
  readonly verificationUri: string;
  readonly intervalSeconds?: number;
  readonly expiresInSeconds?: number;
}

/** What asking the provider whether the code was entered said. */
export type DevicePoll<A> =
  | { readonly status: "done"; readonly value: A }
  | { readonly status: "pending" }
  | { readonly status: "slow-down"; readonly intervalSeconds?: number }
  | { readonly status: "failed"; readonly message: string };

/** RFC 8628: without an interval, five seconds; asked to slow down, five more. No provider is asked oftener than each second. */
const DEFAULT_INTERVAL_MS = 5_000;
const SLOW_DOWN_MS = 5_000;
const MINIMUM_INTERVAL_MS = 1_000;

const seconds = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : undefined);

/**
 * The device-code grant: tells the person the code and where to enter it, then asks the provider whether they have,
 * at the interval it names, until it says done, fails, or the code expires. Stopping the login stops the asking.
 */
export const deviceSignIn = <A>(context: LoginContext, provider: string, grant: DeviceGrant, poll: (signal: AbortSignal) => Promise<DevicePoll<A>>) =>
  Effect.gen(function* () {
    yield* context.notify({
      kind: "device-code",
      message: `Enter code ${grant.userCode} at ${grant.verificationUri} to sign in to ${provider}.`,
      code: grant.userCode,
      links: [{ url: grant.verificationUri, label: `Sign in to ${provider}` }],
    });
    const deadline = (yield* Effect.clockWith((clock) => clock.currentTimeMillis)) + (seconds(grant.expiresInSeconds) ?? 15 * 60 * 1000);
    let interval = Math.max(MINIMUM_INTERVAL_MS, seconds(grant.intervalSeconds) ?? DEFAULT_INTERVAL_MS);
    let slowed = false;
    for (;;) {
      yield* Effect.sleep(Duration.millis(interval));
      if ((yield* Effect.clockWith((clock) => clock.currentTimeMillis)) >= deadline) {
        return yield* Effect.fail(
          new Error(
            slowed
              ? `The ${provider} code expired; the provider asked Lemma to slow down, which a clock out of step can cause (a VM's). Sign in again.`
              : `The ${provider} code expired before it was entered. Sign in again.`,
          ),
        );
      }
      const answer = yield* Effect.tryPromise({ try: (signal) => poll(signal), catch: (error) => (error instanceof Error ? error : new Error(String(error))) });
      if (answer.status === "done") return answer.value;
      if (answer.status === "failed") return yield* Effect.fail(new Error(answer.message));
      if (answer.status === "slow-down") {
        slowed = true;
        interval = Math.max(MINIMUM_INTERVAL_MS, seconds(answer.intervalSeconds) ?? interval + SLOW_DOWN_MS);
      }
    }
  });

/** A verification link from a provider's answer, as the person will open it: only an http(s) URL is. */
export function trustedLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** A provider's JSON answer, or an empty object for one that is none. */
export async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await response.json()) as unknown;
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** What an OAuth error answer says (`error: error_description`), for a message. */
export function oauthDetail(body: Record<string, unknown>): string {
  const parts = [body.error, body.error_description ?? body.message ?? body.detail].filter((part): part is string => typeof part === "string" && part !== "");
  return parts.length === 0 ? "" : `: ${parts.join(": ")}`;
}

/** A form POST, as OAuth token endpoints take it. */
export const postForm = (fetchImpl: typeof fetch, url: string, fields: Record<string, string>, signal: AbortSignal, headers: Record<string, string> = {}) =>
  fetchImpl(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields),
    signal,
  });

/** The device-code grant's poll, as RFC 8628 answers it: done with tokens, or pending, slowed, or failed by its `error`. */
export function devicePoll<A>(provider: string, response: Response, body: Record<string, unknown>, done: (body: Record<string, unknown>) => A): DevicePoll<A> {
  if (response.ok && typeof body.access_token === "string" && body.access_token !== "") return { status: "done", value: done(body) };
  switch (body.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow-down", ...(typeof body.interval === "number" ? { intervalSeconds: body.interval } : {}) };
    case "access_denied":
    case "authorization_denied":
      return { status: "failed", message: `${provider} sign-in was denied` };
    case "expired_token":
      return { status: "failed", message: `The ${provider} code expired before it was entered. Sign in again.` };
    default:
      return { status: "failed", message: `${provider}'s token request failed (${response.status})${oauthDetail(body)}` };
  }
}
