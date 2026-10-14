import type { Access } from "@lemma/agent";

/*
 * How an access level (`Access`) is kept with an agent: by the agent's own mode for it, when it has one (Claude Code's
 * `acceptEdits`, Codex's `workspace-write`), and by how Lemma answers the permission requests the agent still makes.
 */

/** A mode an agent offers (`session/new`'s `modes`). */
export interface AgentMode {
  readonly id: string;
  readonly name: string;
}

/** The mode ids agents use for each level, as Claude Code, Codex, Gemini CLI, and others name them; the first found wins. */
const MODE_IDS: Readonly<Record<Access, readonly string[]>> = {
  supervised: ["default", "manual", "read-only", "ask", "suggest"],
  "auto-edits": ["acceptEdits", "accept-edits", "auto-edit", "autoEdit", "workspace-write", "edit"],
  auto: ["auto", "agent", "auto-review"],
  full: ["bypassPermissions", "agent-full-access", "full-access", "yolo", "danger-full-access"],
};

/** The agent's mode for `access`, if it has one. */
export function modeFor(access: Access, modes: readonly AgentMode[]): string | undefined {
  const ids = new Set(modes.map((mode) => mode.id));
  return MODE_IDS[access].find((id) => ids.has(id));
}

/**
 * The levels an agent offers: those Lemma keeps by answering its requests (supervised, auto-edits, full) whatever its
 * modes, and `auto` only where the agent has a mode for it, since only the agent can tell what is routine.
 */
export function offered(modes: readonly AgentMode[]): readonly { readonly access: Access; readonly mode?: string }[] {
  return (["supervised", "auto-edits", "auto", "full"] as const).flatMap((access) => {
    const mode = modeFor(access, modes);
    if (access === "auto" && mode === undefined) return [];
    return [{ access, ...(mode === undefined ? {} : { mode }) }];
  });
}

/** The kinds of call that change files: what `auto-edits` allows without asking. */
const EDITS = new Set(["edit", "delete", "move"]);

/** Whether Lemma allows a request itself at `access`, rather than ask the person. */
export const allowsItself = (access: Access, kind: string | undefined): boolean =>
  access === "full" || (access === "auto-edits" && kind !== undefined && EDITS.has(kind));
