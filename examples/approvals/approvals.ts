import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { definePlugin, Registries } from "@lemma/core";
import { Interaction, McpManagers, Tools } from "@lemma/contracts";
import type { GuardDecision, McpToolInfo, ToolInvocation } from "@lemma/contracts";
import { resolveToCwd } from "@lemma/plugin-tools-builtin";

/**
 * Asks before the agent runs a command, writes outside the project, or uses an
 * MCP tool that may change something: allow once, allow that tool for the
 * rest of the session, or deny (the model is told you declined). With nobody
 * to ask, the call is denied.
 *
 * A plugin file, written the way a user writes one: copy or link it into
 * `~/.lemma/plugins/` and run `lemma reload`. It imports only packages the
 * host supplies: `effect`, `@lemma/core`, `@lemma/contracts`, and the file
 * tools' own path resolution, so it judges the file a tool will touch.
 */

const Config = Schema.Struct({
  ask: Schema.optionalWith(Schema.Array(Schema.String), { default: () => ["bash"] }).annotations({
    title: "Always ask for",
    description: "Tools that need approval for every call; `*` matches any characters (`mcp__github__*`).",
  }),
  mcp: Schema.optionalWith(Schema.Literal("writes", "all", "none"), { default: () => "writes" as const }).annotations({
    title: "Ask for MCP tools",
    description: "writes: unless the server marks the tool read-only; all: every call; none: never (the lists above still apply).",
  }),
  outsideProject: Schema.optionalWith(Schema.Array(Schema.String), { default: () => ["write", "edit"] }).annotations({
    title: "Ask outside the project for",
    description: "Tools that need approval when the path they are given is outside the session's directory.",
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

/** `pattern` with `*` matching any characters. */
const matches = (pattern: string, name: string) =>
  pattern.includes("*")
    ? new RegExp(
        `^${pattern
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      ).test(name)
    : pattern === name;

/**
 * The question a call needs, if any. `mcp` is what the `mcp` plugin knows of
 * the call's tool when it is an MCP server's (`undefined` for any other tool),
 * so a tool its server marks read-only can pass without asking. The mark is
 * the server's word: `mcp: "all"` asks regardless.
 */
export const question = (
  call: ToolInvocation,
  config: typeof Config.Type,
  mcp?: { readonly server: string; readonly tool?: McpToolInfo },
): Question | undefined => {
  if (mcp !== undefined && !config.ask.some((pattern) => matches(pattern, call.name))) {
    if (config.mcp === "none" || (config.mcp === "writes" && mcp.tool?.hints.readOnly === true)) return undefined;
    return { title: `Allow ${mcp.server}'s ${mcp.tool?.title ?? mcp.tool?.name ?? call.name}?`, detail: JSON.stringify(call.input, null, 2) };
  }
  if (config.ask.some((pattern) => matches(pattern, call.name))) {
    const command = field(call.input, "command");
    return command === undefined
      ? { title: `Allow ${call.name}?`, detail: JSON.stringify(call.input, null, 2) }
      : { title: "Run this command?", detail: command };
  }
  if (config.outsideProject.includes(call.name)) {
    const path = field(call.input, "path");
    if (path === undefined) return undefined;
    // As the file tools resolve it: `~` is the home directory and a leading `@` (a mention) is dropped.
    const absolute = resolveToCwd(path, call.cwd);
    if (!inside(call.cwd, absolute)) return { title: `Allow ${call.name} outside the project?`, detail: absolute };
  }
  return undefined;
};

export default definePlugin({
  id: "approvals",
  version: "0.1.0",
  config: Config,
  requires: [Tools, Interaction],
  layer: (config: typeof Config.Type) =>
    Layer.scopedDiscard(
      Effect.gen(function* () {
        const tools = yield* Tools;
        const interaction = yield* Interaction;
        const registries = yield* Registries;
        /** The MCP server and tool behind a call, from whichever plugin manages MCP; a `mcp__` name with none is still an MCP tool. */
        const mcpTool = (name: string) =>
          Effect.gen(function* () {
            const [manager] = yield* registries.items(McpManagers);
            const servers = manager === undefined ? [] : yield* manager.item.servers;
            for (const server of servers) {
              const tool = server.tools.find((candidate) => candidate.tool === name);
              if (tool !== undefined) return { server: server.spec.name ?? server.id, tool };
            }
            return name.startsWith("mcp__") ? { server: name.split("__")[1] ?? "an MCP server" } : undefined;
          });
        /** Tools allowed for the rest of a session, by session id; forgotten when the plugin reloads. */
        const allowed = new Map<string, Set<string>>();

        yield* tools.guard("*", (call) =>
          Effect.gen(function* () {
            const asked = question(call, config, yield* mcpTool(call.name));
            if (asked === undefined || allowed.get(call.sessionId)?.has(call.name)) return { _tag: "allow" } satisfies GuardDecision;
            const choice = yield* interaction
              .select(
                asked.title,
                [
                  { value: "once", label: "Allow once" },
                  { value: "session", label: `Allow ${call.name} for this session`, description: "Until the host restarts" },
                  { value: "deny", label: "Deny", description: "The agent is told you declined" },
                ],
                asked.detail,
              )
              .pipe(Effect.either);
            if (choice._tag === "Left") {
              const reason = choice.left.reason === "Dismissed" ? "the user dismissed the approval" : `nobody could approve it (${choice.left.message})`;
              return { _tag: "deny", reason } satisfies GuardDecision;
            }
            if (choice.right === "deny") return { _tag: "deny", reason: "the user declined" } satisfies GuardDecision;
            if (choice.right === "session") allowed.set(call.sessionId, new Set([...(allowed.get(call.sessionId) ?? []), call.name]));
            return { _tag: "allow" } satisfies GuardDecision;
          }),
        );
      }),
    ),
});
