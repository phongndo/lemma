/**
 * Which channels become tools, and on what terms: those scripts call freely (each only reads, and answers in bounded
 * size), those that ask the person before each call (each changes something worth having an agent do), and those never
 * offered, whatever the config says (they handle credentials, or run what could).
 */

/** Read-only, bounded channels: what a script reads to see Lemma as a person would. */
export const DEFAULT_CHANNELS: readonly string[] = [
  // Sessions: which there are, one's info, its log, and search over them.
  "sessions.list",
  "sessions.get",
  "sessions.events",
  "sessions.search",
  // The agent: which sessions are running, one's live view and queue.
  "agent.running",
  "agent.view",
  "agent.queue",
  // Streams a script waits on: turns starting and ending, a session's log as it grows, sessions coming and going.
  "agent.activity",
  "sessions.log",
  "sessions.changes",
  // What else Lemma has: commands, skills, models and providers (no credentials), CLI commands.
  "commands.list",
  "skills.list",
  "llm.models",
  "llm.providers",
  "cli.commands",
  // The workspace: a directory's git state, branches, path completion, file search.
  "workspace.status",
  "workspace.branches",
  "workspace.browse",
  "files.search",
  // The host's trace: what ran and how long it took, and recent composition changes; what stopping would cut off.
  "devtools.trace.spans",
  "devtools.trace.changes",
  "cli.in-progress",
];

/** Channels that change something: offered, but each call asks the person first, showing what it would send. */
export const DEFAULT_CONFIRM: readonly string[] = [
  "agent.prompt",
  "agent.cancel",
  "agent.withdraw",
  "agent.promote",
  "sessions.create",
  "sessions.set-title",
  "sessions.mark",
  "sessions.checkout",
  "commands.run",
  "workspace.create-directory",
  "workspace.create-worktree",
  "workspace.checkout",
  "mcp.reconnect",
];

/**
 * Never offered, even when configured: logins and stored credentials, and the provider and server entries that can
 * hold them; and `cli.run`, which runs any `lemma` command, those among them.
 */
export const NEVER: ReadonlySet<string> = new Set([
  "llm.login",
  "llm.logout",
  "llm.cancel-login",
  "llm.add-custom",
  "llm.remove-custom",
  "llm.set-logo",
  "mcp.put",
  "cli.run",
]);

/** The tool a channel becomes: `lemma_` and its id, `.` and `-` as `_` (`sessions.set-title` is `lemma_sessions_set_title`). */
export const toolName = (id: string): string => `lemma_${id.replace(/[.-]/g, "_")}`;

/** What a channel is offered as: freely, after asking, or not at all. */
export const access = (id: string, config: { readonly channels: readonly string[]; readonly confirm: readonly string[] }): "free" | "confirm" | undefined =>
  NEVER.has(id) ? undefined : config.confirm.includes(id) ? "confirm" : config.channels.includes(id) ? "free" : undefined;
