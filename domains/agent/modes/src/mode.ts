import { MODES_PLUGIN, MODES_PLUGIN_FORMERLY } from "@lemma/agent";
import type { ModeUse } from "@lemma/agent";
import type { SessionEvent } from "@lemma/sessions";

/**
 * A mode: what a thread's agent is for, as a Markdown file. Its frontmatter says what it keeps of what plugins offer,
 * and its body is a section of the system prompt:
 *
 *   ---
 *   description: Drafts and edits prose
 *   model: anthropic/claude-sonnet-5-5
 *   thinking: low
 *   tools: read, write, edit
 *   sections: "*", "!project-context"
 *   use: thread, agent
 *   ---
 *   You help the user write. …
 *
 * `tools` and `sections` are lists of names, globs with `*`, or exclusions starting with `!`, applied in order: the
 * last that matches decides, and a name nothing matches is left out once anything is listed. Absent, everything
 * stays. `use` says where it is offered: `thread` (a new thread's mode), `agent` (an agent's a thread hands a task to),
 * or both, as when absent. Pure, so it is tested without a host, and shared with the web half (which names,
 * describes, and picks).
 */

export interface Mode {
  /** Its file's name, without `.md`: what a thread chooses it by. */
  readonly name: string;
  readonly description?: string;
  /** A model to pick when the mode is chosen, as `provider/model`. */
  readonly model?: string;
  readonly thinking?: string;
  readonly tools?: readonly string[];
  readonly sections?: readonly string[];
  /** Where it is offered (`ModeUse`): absent, everywhere. */
  readonly use?: readonly ModeUse[];
  /** Its body: a section of the system prompt; empty adds none. */
  readonly prompt: string;
  /** Where it was found: `bundled`, `user` (`~/.lemma/modes`), or `project` (`.lemma/modes` in the session's directory). */
  readonly source: "bundled" | "user" | "project";
}

const unquote = (value: string) => {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value.trim());
  return quoted === null ? value.trim() : quoted[2]!;
};

/** A list field: `a, b`, or `[a, b]`, each item quoted or not. */
const listOf = (value: string): string[] =>
  value
    .trim()
    .replace(/^\[(.*)\]$/, "$1")
    .split(",")
    .map(unquote)
    .filter((item) => item !== "");

/** A mode file's fields and body; one with no frontmatter is all body. */
export const parseMode = (name: string, text: string, source: Mode["source"]): Mode => {
  const source_ = text.startsWith("﻿") ? text.slice(1) : text;
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source_);
  const fields = new Map<string, string>();
  if (block !== null) {
    for (const line of block[1]!.split(/\r?\n/)) {
      const field = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
      if (field !== null) fields.set(field[1]!, field[2]!);
    }
  }
  const text_ = (key: string) => {
    const value = fields.get(key);
    return value === undefined || unquote(value) === "" ? undefined : unquote(value);
  };
  const list = (key: string) => {
    const value = fields.get(key);
    return value === undefined ? undefined : listOf(value);
  };
  const description = text_("description");
  const model = text_("model");
  const thinking = text_("thinking");
  const tools = list("tools");
  const sections = list("sections");
  // Words it does not know are left out; a list of none of them offers it nowhere new, so everywhere, as when absent.
  const uses = list("use")?.filter((word): word is ModeUse => word === "thread" || word === "agent");
  const use = uses === undefined || uses.length === 0 ? undefined : [...new Set(uses)];
  return {
    name,
    ...(description === undefined ? {} : { description }),
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(tools === undefined ? {} : { tools }),
    ...(sections === undefined ? {} : { sections }),
    ...(use === undefined ? {} : { use }),
    prompt: (block === null ? source_ : source_.slice(block[0].length)).trim(),
    source,
  };
};

const glob = (pattern: string): RegExp => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

/** Whether `name` stays under `patterns` (see the module's comment); with none, it does. */
export const keeps = (patterns: readonly string[] | undefined, name: string): boolean => {
  if (patterns === undefined) return true;
  let kept = false;
  for (const pattern of patterns) {
    const excluded = pattern.startsWith("!");
    if (glob(excluded ? pattern.slice(1) : pattern).test(name)) kept = !excluded;
  }
  return kept;
};

/**
 * The bundled modes `work` replaced, which older threads logged: a thread taken with one goes on in `work` unless a
 * mode of the old name is found.
 */
export const RENAMED: Readonly<Record<string, string>> = { coding: "work", general: "work" };

/**
 * A thread's mode, as its first turn logged it (`turn-start`'s `plugins["agent.modes"]`, or, in a thread from before
 * modes were named so, `plugins["agent.profiles"]`): it is chosen for the thread and kept from then on. `undefined`
 * before its first turn; no `name` when that turn logged none (a thread from before modes were kept, or a client that
 * sent none), which then has the default.
 */
export const firstMode = (branch: readonly SessionEvent[]): { readonly name?: string } | undefined => {
  for (const event of branch) {
    if (event.data.type !== "turn-start") continue;
    const chosen = event.data.plugins?.[MODES_PLUGIN] ?? event.data.plugins?.[MODES_PLUGIN_FORMERLY];
    return typeof chosen === "string" ? { name: chosen } : {};
  }
  return undefined;
};

/** Modes by name, later sources winning: bundled, then the user's, then the project's. */
export const byName = (modes: readonly Mode[]): ReadonlyMap<string, Mode> => {
  const rank = { bundled: 0, user: 1, project: 2 } as const;
  const out = new Map<string, Mode>();
  for (const mode of [...modes].sort((a, b) => rank[a.source] - rank[b.source])) out.set(mode.name, mode);
  return out;
};
