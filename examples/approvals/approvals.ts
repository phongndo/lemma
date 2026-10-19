import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core/plain";
import { Interaction, InteractionError } from "@lemma/contracts";
import { Guards } from "@lemma/tools";
import type { GuardDecision, ToolInvocation } from "@lemma/tools";
import { resolveToCwd } from "@lemma/tools/files";
import { patchPaths } from "@lemma/tools/patch";

/**
 * Asks before the agent runs a command or writes outside the project: allow
 * once, allow that tool for the rest of the session, or deny (the model is
 * told you declined). With nobody to ask, the call is denied.
 *
 * A plugin file, written the way a user writes one: copy or link it into
 * `~/.lemma/plugins/`, and the host loads it. It adds a guard to the tools
 * domain's `Guards`, which every call passes before its tool runs. It imports only packages the
 * host supplies: `effect`, `@lemma/core`, `@lemma/contracts`, and the tools
 * domain's contract (`@lemma/tools`), whose `/files` resolves paths as the file
 * tools do, so it judges the file a tool will touch, and whose `/patch` names
 * the files an `apply_patch` patch touches. It is
 * written with promises (`@lemma/core/plain`): its services are promise-based
 * views of the same contracts an Effect plugin uses.
 */

const Config = Schema.Struct({
  ask: Schema.Array(Schema.String)
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => ["bash"])))
    .annotate({
      title: "Always ask for",
      description: "Tools that need approval for every call.",
    }),
  outsideProject: Schema.Array(Schema.String)
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => ["write", "edit", "apply_patch"])))
    .annotate({
      title: "Ask outside the project for",
      description: "Tools that need approval when a path they are given (`path`, or a file of `apply_patch`'s patch) is outside the session's directory.",
    }),
});

/** A question for one call: what to show, or nothing when the call needs no approval. */
interface Question {
  readonly title: string;
  readonly detail: string;
}

const field = (input: unknown, key: string): string | undefined => {
  const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : undefined;
};

/** `path` with its links followed as far as it exists (a file to write may not yet), so a link out of the project leads out. */
const real = (path: string): string => {
  const rest: string[] = [];
  for (let at = path; ; at = dirname(at)) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch {
      if (dirname(at) === at) return path;
      rest.push(basename(at));
    }
  }
};

const inside = (dir: string, path: string) => {
  const rel = relative(real(dir), real(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** The paths a call is given, as written: each file `apply_patch`'s patch names, or else its `path`. */
const pathsOf = (call: ToolInvocation): readonly string[] => {
  if (call.name === "apply_patch") return patchPaths(field(call.input, "input") ?? "");
  const path = field(call.input, "path");
  return path === undefined ? [] : [path];
};

export const question = (call: ToolInvocation, config: typeof Config.Type): Question | undefined => {
  if (config.ask.includes(call.name)) {
    const command = field(call.input, "command");
    return command === undefined
      ? { title: `Allow ${call.name}?`, detail: JSON.stringify(call.input, null, 2) }
      : { title: "Run this command?", detail: command };
  }
  if (config.outsideProject.includes(call.name)) {
    // As the file tools resolve them: `~` is the home directory and a leading `@` (a mention) is dropped.
    const outside = pathsOf(call)
      .map((path) => resolveToCwd(path, call.cwd))
      .filter((absolute) => !inside(call.cwd, absolute));
    if (outside.length > 0) return { title: `Allow ${call.name} outside the project?`, detail: outside.join("\n") };
  }
  return undefined;
};

export default definePlugin({
  id: "approvals",
  version: "0.1.0",
  uses: ["lemma/tools@1"],
  config: Config,
  requires: { interaction: Interaction },
  setup: ({ interaction }, { config, add }) => {
    /** Tools allowed for the rest of a session, by session id; forgotten when the plugin reloads. */
    const allowed = new Map<string, Set<string>>();

    add(Guards, {
      tool: "*",
      guard: async (call): Promise<GuardDecision> => {
        const asked = question(call, config);
        if (asked === undefined || allowed.get(call.sessionId)?.has(call.name)) return { _tag: "allow" };
        let choice: string;
        try {
          choice = await interaction.select(
            asked.title,
            [
              { value: "once", label: "Allow once" },
              { value: "session", label: `Allow ${call.name} for this session`, description: "Until the host restarts" },
              { value: "deny", label: "Deny", description: "The agent is told you declined" },
            ],
            asked.detail,
          );
        } catch (error) {
          if (!(error instanceof InteractionError)) throw error;
          return { _tag: "deny", reason: error.reason === "Dismissed" ? "the user dismissed the approval" : `nobody could approve it (${error.message})` };
        }
        if (choice === "deny") return { _tag: "deny", reason: "the user declined" };
        if (choice === "session") allowed.set(call.sessionId, new Set([...(allowed.get(call.sessionId) ?? []), call.name]));
        return { _tag: "allow" };
      },
    });
  },
});
