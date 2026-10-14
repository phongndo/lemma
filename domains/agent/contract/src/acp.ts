import { Schema } from "effect";
import { defineChannel } from "@lemma/contracts";
import { Access, HarnessLogo } from "./harness.ts";

/*
 * The coding agents a turn can run on over the Agent Client Protocol, as `agent.acp` serves them: the entries of
 * `~/.lemma/agents.json`, each agent's state, and the `acp.*` channels its web half (Settings › Integrations) calls.
 * A plugin providing them in its place serves these channels.
 */

/**
 * An agent's entry in `~/.lemma/agents.json`, by its id. Over a preset (`claude`, `codex`, `gemini`, `opencode`) it
 * changes only what it names; an agent of the file's own needs a `command`.
 */
export const AgentEntry = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  /** Starts the agent speaking ACP over stdin and stdout. Resolved on the host's PATH. */
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  /** Added to the host's environment for it. */
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** `false` keeps the entry without offering the agent. */
  enabled: Schema.optional(Schema.Boolean),
  /** How to install it or sign in, shown while it cannot run. */
  install: Schema.optional(Schema.String),
  docs: Schema.optional(Schema.String),
  /** `false`: it is not handed Lemma's MCP servers (Settings › Integrations › MCP servers) with each session. */
  mcp: Schema.optional(Schema.Boolean),
  /** An image's address (`https:`, or a `data:image/` URL) for its mark, over the one Lemma or the registry gives it. */
  icon: Schema.optional(Schema.String),
  /** The ACP Registry entry it was added from, and its icon. */
  registry: Schema.optional(Schema.Struct({ id: Schema.String, version: Schema.optional(Schema.String), icon: Schema.optional(Schema.String) })),
});
export type AgentEntry = typeof AgentEntry.Type;

/** An agent as the plugin starts it: a preset, or the file's entry, merged. */
export interface AgentSpec {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly install?: string;
  readonly docs?: string;
  readonly mcp?: boolean;
}

/**
 * `off`: turned off in the file; `missing`: its command is not on the host's PATH; `ready`: it can run turns (it may
 * still need signing in, which a turn reports); `failed`: it did not start, or its entry cannot run (`detail` says why).
 */
export const AgentState = Schema.Literals(["off", "missing", "ready", "failed"]);
export type AgentState = typeof AgentState.Type;

export const AuthMethodInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /** `terminal`: the agent signs in by running in a terminal, which Lemma cannot do for it: `detail` says the command. */
  kind: Schema.Literals(["agent", "terminal"]),
});
export type AuthMethodInfo = typeof AuthMethodInfo.Type;

export const AcpAgentStatus = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  /** `preset`: one Lemma knows (the file may change it); `file`: one the file adds. */
  source: Schema.Literals(["preset", "file"]),
  enabled: Schema.Boolean,
  state: AgentState,
  detail: Schema.optional(Schema.String),
  /** The command line it starts with. */
  command: Schema.String,
  args: Schema.Array(Schema.String),
  /** The file's entry for it, as written: what a client edits. */
  entry: Schema.optional(AgentEntry),
  install: Schema.optional(Schema.String),
  docs: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  mcp: Schema.Boolean,
  /** What the agent says it is, once started. */
  agent: Schema.optional(Schema.Struct({ name: Schema.String, version: Schema.optional(Schema.String), title: Schema.optional(Schema.String) })),
  /** How it signs in, once started. */
  authMethods: Schema.Array(AuthMethodInfo),
  /** Sessions it has open, one per Lemma session that has run a turn on it since it started. */
  sessions: Schema.Number,
  logo: Schema.optional(HarnessLogo),
  /** The access levels it offers (see `Access`), and the agent's own mode each sets, once it has said its modes. */
  access: Schema.Array(Schema.Struct({ access: Access, mode: Schema.optional(Schema.String) })),
});
export type AcpAgentStatus = typeof AcpAgentStatus.Type;

export const AcpState = Schema.Struct({
  /** `<home>/agents.json`. */
  file: Schema.String,
  fileError: Schema.optional(Schema.String),
  agents: Schema.Array(AcpAgentStatus),
});
export type AcpState = typeof AcpState.Type;

/** An agent of the ACP Registry that Lemma can start: one it runs through `npx` or `uvx`. */
export const RegistryAgent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  website: Schema.optional(Schema.String),
  /** The command line it starts with. */
  command: Schema.String,
  args: Schema.Array(Schema.String),
  /** Whether that command is on the host's PATH. */
  runnable: Schema.Boolean,
  /** Its icon, read from the registry by the host. */
  logo: Schema.optional(HarnessLogo),
});
export type RegistryAgent = typeof RegistryAgent.Type;

/** One way to answer a permission request, as the agent offers it. */
export const PermissionChoice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["allow_once", "allow_always", "reject_once", "reject_always"]),
});
export type PermissionChoice = typeof PermissionChoice.Type;

/**
 * An agent asking before it acts, in a thread: what it wants to do (a command, file changes, a fetch), and the
 * choices it offers. Open until answered (`acp.respond`), or its turn ends.
 */
export const PermissionRequest = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  /** The agent's id and name. */
  agent: Schema.String,
  agentTitle: Schema.String,
  /** The call's title, as the agent puts it: `Run npm test`, `Edit src/a.ts`. */
  title: Schema.String,
  /** The call's ACP kind: `execute`, `edit`, `delete`, `move`, `read`, `fetch`, … */
  kind: Schema.optional(Schema.String),
  /** The command it runs, for a command. */
  command: Schema.optional(Schema.String),
  /** The files it touches. */
  paths: Schema.Array(Schema.String),
  /** The changes it makes, for an edit. */
  diffs: Schema.Array(Schema.Struct({ path: Schema.String, oldText: Schema.NullOr(Schema.String), newText: Schema.String })),
  /** Its raw input, when it gives none of the above. */
  input: Schema.optional(Schema.String),
  choices: Schema.Array(PermissionChoice),
  at: Schema.Number,
});
export type PermissionRequest = typeof PermissionRequest.Type;

const idField = { id: Schema.String };

export const AcpChannels = {
  state: defineChannel({
    kind: "call",
    id: "acp.state",
    title: "ACP agents",
    description: "The coding agents Lemma can run turns on over ACP, whether each can, and the file they are configured in",
    payload: Schema.Void,
    success: AcpState,
    repeatable: true,
  }),
  changes: defineChannel({
    kind: "stream",
    id: "acp.changes",
    title: "ACP agent changes",
    description: "The ACP agents now, then again whenever one changes",
    payload: Schema.Void,
    success: AcpState,
  }),
  put: defineChannel({
    kind: "call",
    id: "acp.put",
    title: "Add, change, or remove an ACP agent",
    description: "Writes an agent's whole entry to the user's agents.json, or removes it with null (a preset then has its own settings again)",
    payload: Schema.Struct({ ...idField, entry: Schema.NullOr(AgentEntry) }),
    success: Schema.Void,
  }),
  check: defineChannel({
    kind: "call",
    id: "acp.check",
    title: "Check an ACP agent",
    description: "Starts the agent if it is not running, and reports what it says it is and how it signs in",
    payload: Schema.Struct(idField),
    success: AcpAgentStatus,
  }),
  authenticate: defineChannel({
    kind: "call",
    id: "acp.authenticate",
    title: "Sign in to an ACP agent",
    description: "Asks the agent to sign in with one of its methods (it may open a browser on the host)",
    payload: Schema.Struct({ ...idField, method: Schema.String }),
    success: Schema.Void,
  }),
  /** Following it is what tells the host a client can answer: with none, a request waits `waitForClientMs`, then is refused. */
  permissions: defineChannel({
    kind: "stream",
    id: "acp.permissions",
    title: "Agents' permission requests",
    description: "Every permission request an agent has open, in every thread, now and on each change",
    payload: Schema.Void,
    success: Schema.Array(PermissionRequest),
  }),
  respond: defineChannel({
    kind: "call",
    id: "acp.respond",
    title: "Answer a permission request",
    description: "Answers an agent's permission request with one of its choices; fails NotFound once it is answered or its turn ended",
    payload: Schema.Struct({ id: Schema.String, choice: Schema.String }),
    success: Schema.Void,
  }),
  registry: defineChannel({
    kind: "call",
    id: "acp.registry",
    title: "The ACP Registry",
    description: "The agents of the ACP Registry Lemma can start, read from cdn.agentclientprotocol.com (cached for an hour)",
    payload: Schema.Void,
    success: Schema.Array(RegistryAgent),
    repeatable: true,
  }),
} as const;
