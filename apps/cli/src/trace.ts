import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect } from "effect";
import { chromeTrace, TraceChannels } from "@lemma/devtools";
import { call } from "./channels.ts";
import { CliError, ExitCode, usage } from "./command.ts";
import type { Command, Io, Options } from "./command.ts";

/**
 * `lemma trace export [file]`: what the host's trace kept, as `devtools.trace` serves it (secrets hidden): its spans,
 * a session's with `--session`, and the composition's recent changes. In the contracts' shapes (JSON), or with
 * `--format chrome` in Chrome's trace event format, which Perfetto opens. To `file`, else to stdout. The host keeps the
 * trace in memory, bounded, so this is how it outlasts the host or leaves the machine.
 */
export const traceCommand = (sub: string | undefined, rest: readonly string[], io: Io, options: Options): Command | CliError => {
  if (sub !== "export") return usage(sub === undefined ? "trace needs a subcommand: export" : `trace has export, not "${sub}"`);
  if (rest.length > 1) return usage(`Unexpected argument "${rest[1]}"`);
  const format = options.format ?? "json";
  if (format !== "json" && format !== "chrome") return usage(`--format is json or chrome, not "${format}"`);
  const file = rest[0] === undefined ? undefined : resolve(io.cwd, rest[0]);
  return ({ rpc, target }) =>
    Effect.gen(function* () {
      const where = options.session === undefined ? undefined : { "session.id": options.session };
      const [spans, changes] = yield* Effect.all(
        [
          call(rpc, TraceChannels.spans, { ...(where === undefined ? {} : { where }), limit: Number.MAX_SAFE_INTEGER }),
          call(rpc, TraceChannels.changes, undefined),
        ],
        { concurrency: "unbounded" },
      );
      const exported = format === "chrome" ? chromeTrace(spans) : { host: target.url, exportedAt: Date.now(), spans, changes };
      const traces = new Set(spans.map((span) => span.traceId)).size;
      if (file === undefined) return { json: exported, text: JSON.stringify(exported), compact: true };
      yield* Effect.tryPromise({
        try: () => writeFile(file, `${JSON.stringify(exported)}\n`),
        catch: (error) => new CliError({ code: "Failed", message: `Could not write ${file}: ${String(error)}`, exit: ExitCode.failed }),
      });
      return {
        json: { file, format, spans: spans.length, traces, changes: changes.length },
        text: `wrote ${spans.length} spans of ${traces} traces${format === "json" ? `, and ${changes.length} composition changes,` : ""} to ${file}${format === "chrome" ? " (open it at ui.perfetto.dev)" : ""}`,
      };
    });
};
