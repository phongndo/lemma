import type { ChannelAccess } from "@lemma/contracts";

/**
 * Which channels become tools, and on what terms: those scripts call freely (each declares it only reads, or the config
 * lists it and it declares no write), those that ask the person before each call (each changes something worth having
 * an agent do), and those never offered, whatever the config says (they handle credentials, or run what could).
 */

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
  "sessions.fork",
  "commands.run",
  "workspace.create-directory",
  "workspace.create-worktree",
  "workspace.remove-worktree",
  "workspace.restore-worktree",
  "workspace.checkout",
  "mcp.reconnect",
];

/**
 * Never offered, even when configured: signing in and out, and the provider and server entries that can hold a
 * credential, and their state as written; and `cli.run`, which runs any `lemma` command, those among them. Those a
 * credential crosses declare `secret`, which keeps them out too; these stay out when a replacement declares less.
 */
export const NEVER: ReadonlySet<string> = new Set([
  "llm.login",
  "llm.sign-ins",
  "llm.answer-sign-in",
  "llm.logout",
  "llm.cancel-login",
  "llm.add-custom",
  "llm.remove-custom",
  "llm.set-logo",
  "mcp.state",
  "mcp.changes",
  "mcp.put",
  "cli.run",
]);

/** The tool a channel becomes: `lemma_` and its id, `.` and `-` as `_` (`sessions.set-title` is `lemma_sessions_set_title`). */
export const toolName = (id: string): string => `lemma_${id.replace(/[.-]/g, "_")}`;

/** In `channels`, every channel that declares it only reads (`access: "read"`). */
export const EVERY_READ = "*";

/**
 * What a channel is offered as: freely, after asking, or not at all. One in `NEVER`, or that declares `secret`, is
 * never offered. One in `confirm` asks first. One in `channels`, or that declares `read` while `channels` holds `*`, is
 * offered freely, unless it declares it writes (`operate`, `change`): that one asks first all the same.
 */
export const termsOf = (
  channel: { readonly id: string; readonly access?: ChannelAccess },
  config: { readonly channels: readonly string[]; readonly confirm: readonly string[] },
): "free" | "confirm" | undefined => {
  if (NEVER.has(channel.id) || channel.access === "secret") return undefined;
  if (config.confirm.includes(channel.id)) return "confirm";
  if (config.channels.includes(channel.id)) return channel.access === "operate" || channel.access === "change" ? "confirm" : "free";
  return config.channels.includes(EVERY_READ) && channel.access === "read" ? "free" : undefined;
};
