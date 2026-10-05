import { Schema } from "effect";

/** An agent that speaks ACP over stdio, and how to start it. Each becomes a harness with its `id`. */
export const AgentSpec = Schema.Struct({
  id: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]+$/)).annotations({ description: "The harness id threads name it by: letters, digits, '-' and '_'." }),
  title: Schema.optional(Schema.String).annotations({ description: "Its name in the app. Absent: the id." }),
  description: Schema.optional(Schema.String),
  command: Schema.String.annotations({ description: "The program that speaks ACP on stdin and stdout: a name on PATH, or a path." }),
  args: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })).annotations({
    description: "Set for the agent's process, on top of the host's environment.",
  }),
  install: Schema.optional(Schema.String).annotations({ description: "How to install it, shown while it is missing." }),
});
export type AgentSpec = typeof AgentSpec.Type;

/**
 * Agents that speak ACP themselves or through the adapter their makers
 * publish, each with the sign-in it already has. Each is listed whether or
 * not it can start; one that cannot says how to fix that. Claude and Codex
 * run through the official adapters, at pinned versions, with `npx` (which
 * downloads them once into npm's cache): Claude's brings Anthropic's Agent SDK,
 * Codex's brings Codex.
 */
export const DEFAULT_AGENTS: readonly AgentSpec[] = [
  {
    id: "claude",
    title: "Claude",
    description: "Claude Code, through the Agent SDK's ACP adapter, on your Claude Code sign-in.",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.85.1"],
    install: "Install Node.js for npx, and sign in to Claude Code (run `claude` once).",
  },
  {
    id: "codex",
    title: "Codex",
    description: "OpenAI's Codex, through its ACP adapter, on your Codex sign-in.",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@2.1.1"],
    install: "Install Node.js for npx, and sign in to Codex (`codex login`).",
  },
  {
    id: "opencode",
    title: "OpenCode",
    description: "OpenCode, through its built-in ACP server.",
    command: "opencode",
    args: ["acp"],
    install: "Install OpenCode (https://opencode.ai) and sign in with `opencode auth login`.",
  },
  {
    id: "gemini",
    title: "Gemini CLI",
    description: "Google's Gemini CLI, in its ACP mode.",
    command: "gemini",
    args: ["--acp"],
    install: "Install it with `npm install -g @google/gemini-cli`, then run `gemini` once to sign in.",
  },
];

export const AcpConfig = Schema.Struct({
  agents: Schema.optionalWith(Schema.Array(AgentSpec), { default: () => DEFAULT_AGENTS }).annotations({
    description: "The ACP agents to offer as harnesses. Replaces the defaults (Claude, Codex, OpenCode, Gemini CLI) when set.",
  }),
});
export type AcpConfig = typeof AcpConfig.Type;
