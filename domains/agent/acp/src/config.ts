import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Schema } from "effect";
import { NATIVE_HARNESS } from "@lemma/agent";
import { AgentEntry } from "@lemma/agent/acp";
import type { AgentSpec } from "@lemma/agent/acp";
import { PRESETS } from "./presets.ts";
import type { Preset } from "./presets.ts";

export { PRESETS } from "./presets.ts";

/** Agent ids: what the log names a turn's harness by, so stable, short, and readable. */
export const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** The file: `{ "agents": { "<id>": entry } }`. */
const AgentsFile = Schema.Struct({ agents: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) });
const decodeFile = Schema.decodeUnknownResult(AgentsFile);
const decodeEntry = Schema.decodeUnknownResult(AgentEntry);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What the file says: each entry by id, decoded, or why it could not be. */
export interface AgentsRead {
  readonly entries: ReadonlyMap<string, { readonly entry: AgentEntry } | { readonly error: string }>;
  /** The file could not be read or parsed: its entries are not known. */
  readonly error?: string;
}

export async function readAgentsFile(path: string): Promise<AgentsRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { entries: new Map() };
    return { entries: new Map(), error: `Could not read the file: ${(cause as Error).message}` };
  }
  let json: unknown;
  try {
    json = text.trim() === "" ? {} : JSON.parse(text);
  } catch (cause) {
    return { entries: new Map(), error: `The file is not valid JSON: ${(cause as Error).message}` };
  }
  const file = decodeFile(json);
  if (file._tag === "Failure") return { entries: new Map(), error: 'The file is a JSON object with an "agents" object' };
  return {
    entries: new Map(
      Object.entries(file.success.agents ?? {}).map(([id, raw]) => {
        if (!AGENT_ID.test(id) || id === NATIVE_HARNESS)
          return [id, { error: `"${id}" is not an agent id: lowercase letters, digits, _, and -, and not "${NATIVE_HARNESS}"` }];
        const decoded = decodeEntry(raw, { errors: "all", onExcessProperty: "ignore" });
        return [id, decoded._tag === "Failure" ? { error: `Invalid entry: ${decoded.failure.message}` } : { entry: decoded.success }];
      }),
    ),
  };
}

/** An agent as the plugin runs it: a preset the file adds, with its entry over it, or the file's own. */
export interface Agent {
  readonly spec: AgentSpec;
  readonly source: "preset" | "file";
  /** The preset it is. */
  readonly preset?: Preset;
  /** The file's entry for it, as written. */
  readonly entry?: AgentEntry;
  readonly enabled: boolean;
  /** Why the entry cannot run. */
  readonly error?: string;
}

/**
 * The agents the file adds, by id: a preset's id (even `{}`) adds that preset, with the entry over it; another id adds
 * an agent of the file's own. None until one is added: the presets are what Settings › Integrations offers to add.
 */
export function agentsOf(read: AgentsRead): Agent[] {
  const out = new Map<string, Agent>();
  for (const preset of PRESETS) {
    const found = read.entries.get(preset.id);
    if (found === undefined) continue;
    if ("error" in found) {
      out.set(preset.id, { spec: specOf(preset), source: "preset", preset, enabled: false, error: found.error });
      continue;
    }
    const { entry } = found;
    out.set(preset.id, { spec: merge(specOf(preset), entry), source: "preset", preset, entry, enabled: entry.enabled !== false });
  }
  for (const [id, found] of read.entries) {
    if (out.has(id)) continue;
    const blank: AgentSpec = { id, title: id, command: "", args: [] };
    if ("error" in found) {
      out.set(id, { spec: blank, source: "file", enabled: false, error: found.error });
      continue;
    }
    const { entry } = found;
    const spec = merge(blank, entry);
    out.set(id, {
      spec,
      source: "file",
      entry,
      enabled: entry.enabled !== false,
      ...(entry.command === undefined ? { error: "An agent the file adds needs a command" } : {}),
    });
  }
  return [...out.values()];
}

/** A preset's spec: how it starts, without its mark. */
const specOf = ({ registry: _registry, logo: _logo, requires: _requires, ...spec }: Preset): AgentSpec => spec;

const merge = (base: AgentSpec, entry: AgentEntry | undefined): AgentSpec =>
  entry === undefined
    ? base
    : {
        ...base,
        ...(entry.title === undefined ? {} : { title: entry.title }),
        ...(entry.description === undefined ? {} : { description: entry.description }),
        ...(entry.command === undefined ? {} : { command: entry.command, args: entry.args ?? [] }),
        ...(entry.command === undefined && entry.args !== undefined ? { args: entry.args } : {}),
        ...(entry.env === undefined ? {} : { env: entry.env }),
        ...(entry.install === undefined ? {} : { install: entry.install }),
        ...(entry.docs === undefined ? {} : { docs: entry.docs }),
        ...(entry.mcp === undefined ? {} : { mcp: entry.mcp }),
      };

/**
 * Writes an agent's whole entry to the file, or removes it (`null`), keeping the rest; written atomically, and through
 * a link (one home-manager keeps) rather than over it.
 */
export async function writeAgentEntry(path: string, id: string, entry: AgentEntry | null): Promise<void> {
  const target = await realpath(path).catch(() => path);
  let json: Record<string, unknown> = {};
  try {
    const text = await readFile(target, "utf8");
    const parsed: unknown = text.trim() === "" ? {} : JSON.parse(text);
    if (!isObject(parsed)) throw new Error('the file is not a JSON object with an "agents" object');
    json = parsed;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not update ${path}: ${(cause as Error).message}`);
  }
  const agents = isObject(json["agents"]) ? { ...json["agents"] } : {};
  // An empty entry stays: for a preset, it is what adds it.
  if (entry === null) delete agents[id];
  else agents[id] = entry;
  json = { ...json, agents };
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(json, null, 2)}\n`);
    await rename(temporary, target);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => {});
    const code = (cause as NodeJS.ErrnoException).code;
    if (target !== path && (code === "EROFS" || code === "EACCES" || code === "EPERM"))
      throw new Error(`${path} links to ${target}, which cannot be written: change it where it is managed`, { cause });
    throw cause;
  }
}
