import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Effect, Schema } from "effect";
import { shellWord } from "@lemma/contracts";
import { Channel, ReleaseError } from "@lemma/release";

/*
 * The `lemma` command beside the host, which knows what this Lemma is and how to replace it (`lemma version`,
 * `lemma update`, `lemma restart`): this plugin asks it rather than knowing any of that itself.
 */

/**
 * What this plugin reads of `lemma update --check --json`: the channel the installer's lemma follows and its newest
 * release, neither for a pinned release. It compares them with what the host runs, which may not be that lemma.
 */
export const CheckAnswer = Schema.Struct({
  /** The release the installer's lemma is: what `lemma update` restarts the host on when the channel has none newer. */
  version: Schema.optional(Schema.String),
  channel: Schema.optional(Channel),
  newest: Schema.optional(Schema.String),
});
export type CheckAnswer = typeof CheckAnswer.Type;

/** What `lemma update --json` answers: the release installed, and whether that took installing. */
export const UpdateAnswer = Schema.Struct({ updated: Schema.Boolean, version: Schema.String });

/** What a failed `lemma` said: its JSON error's message on stderr, else what it printed. */
const said = (stderr: string, code: number | null): { readonly code?: string; readonly message: string } => {
  for (const line of stderr.trim().split("\n").reverse()) {
    try {
      const error = (JSON.parse(line) as { error?: { code?: unknown; message?: unknown } }).error;
      if (typeof error?.message === "string") return { ...(typeof error.code === "string" ? { code: error.code } : {}), message: error.message };
    } catch {
      // Progress, not its error.
    }
  }
  return { message: stderr.trim() || `lemma exited ${code}` };
};

/**
 * Runs `<cli> <args> --json`, `cli` being a shell command line (the host's `cliCommand`), and decodes what it prints
 * with `schema`. Fails `ReleaseError` with what it said; interrupting it stops it.
 */
export const runLemma = <A>(cli: string, args: readonly string[], schema: Schema.Codec<A, any>, timeoutMs: number): Effect.Effect<A, ReleaseError> =>
  Effect.callback<string, ReleaseError>((resume) => {
    const child = spawn("sh", ["-c", `${cli} ${[...args, "--json"].map(shellWord).join(" ")}`], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resume(Effect.fail(new ReleaseError({ reason: "Failed", message: `Could not run lemma: ${error.message}`, cause: error })));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resume(Effect.succeed(stdout));
      const { code: reason, message } = said(stderr, code);
      resume(
        Effect.fail(
          new ReleaseError({ reason: reason === "Checkout" || reason === "NotInstalled" ? reason : "Failed", message: `lemma ${args.join(" ")}: ${message}` }),
        ),
      );
    });
    return Effect.sync(() => {
      clearTimeout(timer);
      child.kill("SIGTERM");
    });
  }).pipe(
    Effect.flatMap((stdout) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(stdout.trim()).pipe(
        Effect.mapError(
          (error) =>
            new ReleaseError({ reason: "Failed", message: `lemma ${args.join(" ")} answered what this plugin does not read: ${error.message}`, cause: error }),
        ),
      ),
    ),
  );

/**
 * Has the `lemma` at `link` restart this host once it has answered: it stops it, saying first what that cuts off, and
 * starts it again on the release installed last (`lemma restart --force`). Started apart from the host, so it outlives
 * it; the second's wait lets the answer leave first. What it prints goes to `log`. `ended` hears when it ends while
 * the host still runs: with nothing, or, when the restart failed before stopping the host, with why, from what it printed.
 */
export const restartLater = (link: string, log: string, ended: (why?: string) => void): void => {
  mkdirSync(dirname(log), { recursive: true });
  const out = openSync(log, "w");
  const child = spawn("sh", ["-c", 'sleep 1; exec "$0" restart --force', link], { detached: true, stdio: ["ignore", out, out] });
  closeSync(out);
  child.once("error", (error) => ended(`Could not run lemma restart: ${error.message}`));
  child.once("exit", (code, signal) => {
    if (code === 0) return ended();
    const printed = (() => {
      try {
        return readFileSync(log, "utf8");
      } catch {
        return "";
      }
    })();
    ended(`lemma restart failed (${signal ?? `exit ${code}`}): ${said(printed, code).message} (${log})`);
  });
  child.unref();
};
