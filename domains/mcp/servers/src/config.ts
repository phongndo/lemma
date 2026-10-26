import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { writeFileAtomic } from "@lemma/contracts/fs";
import { McpServerConfig, SERVER_NAME } from "@lemma/mcp";
import type { Exposure, McpServer, McpServerChange } from "@lemma/mcp";
import { normalize } from "./form.ts";
import { isObject } from "./values.ts";

/**
 * A server as the plugin runs it: its entry, merged, and where it came from: the file, or a plugin (with the server as
 * the plugin added it). `file`: the file's entry for it, if any. `error`: the entry cannot run.
 */
export interface Definition {
  readonly name: string;
  readonly source: { readonly kind: "file"; readonly path: string } | { readonly kind: "plugin"; readonly id: string; readonly config: McpServerConfig };
  readonly config: McpServerConfig;
  readonly file?: McpServerConfig;
  readonly error?: string;
}

/** The file's entries by name, decoded, or why each could not be. */
export interface ServersFile {
  readonly path: string;
  readonly entries: ReadonlyMap<string, { readonly config: McpServerConfig } | { readonly error: string }>;
  /** The file could not be read or parsed: its entries are not known. */
  readonly error?: string;
}

const decodeEntry = Schema.decodeUnknownResult(McpServerConfig);

/** pi's names for exposures it has and this plugin runs as code mode: `deferred` loads by search, which code mode's `searchTools` does. */
/** One entry of `mcpServers`, decoded; anything another client keeps beside it (`alwaysAllow`, say) is ignored. */
export function decodeServer(name: string, raw: unknown): { readonly config: McpServerConfig } | { readonly error: string } {
  if (!SERVER_NAME.test(name)) return { error: `"${name}" is not a server name: use letters, digits, _, and -` };
  if (!isObject(raw)) return { error: "An entry is an object" };
  if (raw["type"] === "sse") return { error: "The SSE transport is not supported: a server that has it usually offers Streamable HTTP too, often at /mcp" };
  const decoded = decodeEntry(normalize(raw), { errors: "all", onExcessProperty: "ignore" });
  if (decoded._tag === "Failure") return { error: `Invalid entry: ${decoded.failure.message}` };
  const config = decoded.success;
  if (config.command !== undefined && config.url !== undefined) return { error: "An entry has a command or a url, not both" };
  if (config.type === "stdio" && config.command === undefined) return { error: 'A "stdio" entry needs a command' };
  if ((config.type === "http" || config.type === "streamable-http") && config.url === undefined) return { error: `A "${config.type}" entry needs a url` };
  return { config };
}

/** Reads `mcpServers` from the file; a missing file has none. */
export async function readServersFile(path: string): Promise<ServersFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { path, entries: new Map() };
    return { path, entries: new Map(), error: `Could not read the file: ${(cause as Error).message}` };
  }
  let json: unknown;
  try {
    json = text.trim() === "" ? {} : JSON.parse(text);
  } catch (cause) {
    return { path, entries: new Map(), error: `The file is not valid JSON: ${(cause as Error).message}` };
  }
  if (!isObject(json)) return { path, entries: new Map(), error: 'The file is a JSON object with an "mcpServers" object' };
  const servers = json["mcpServers"] ?? {};
  if (!isObject(servers)) return { path, entries: new Map(), error: '"mcpServers" is an object of servers by name' };
  return { path, entries: new Map(Object.entries(servers).map(([name, raw]) => [name, decodeServer(name, raw)])) };
}

/** What an entry without `command` or `url` changes of a server a plugin adds; its `toolExposure` adds to the plugin's. */
const OVERRIDES = ["enabled", "exposure", "description", "timeout"] as const;

/** Names that would give the same tool names: `a-b` and `a_b` both become `mcp__a_b__…`. */
const toolKey = (name: string) => name.replace(/-/g, "_").toLowerCase();

/**
 * The servers to run, by name: the file's entries, and the servers plugins add. A file entry with a `command` or `url`
 * wins over a plugin's server of its name; one with neither changes only `OVERRIDES` of it, and adds its
 * `toolExposure` to the plugin's, ahead of it, so its patterns are tried first.
 */
export function definitions(file: ServersFile, plugins: readonly { readonly item: McpServer; readonly pluginId: string }[]): Definition[] {
  const fromFile = { kind: "file", path: file.path } as const;
  const byPlugin = new Map(plugins.map((contribution) => [contribution.item.name, contribution]));
  const out = new Map<string, Definition>();
  for (const [name, entry] of file.entries) {
    if ("error" in entry) {
      out.set(name, { name, source: fromFile, config: {}, error: entry.error });
      continue;
    }
    const { config } = entry;
    if (config.command !== undefined || config.url !== undefined) {
      out.set(name, { name, source: fromFile, config, file: config });
      continue;
    }
    const added = byPlugin.get(name);
    if (added === undefined) {
      out.set(name, {
        name,
        source: fromFile,
        config,
        file: config,
        error: "An entry needs a command or a url (one without changes only a server a plugin adds, and no plugin adds this one)",
      });
      continue;
    }
    const { name: _, ...base } = added.item;
    const changed = Object.fromEntries(OVERRIDES.flatMap((key) => (config[key] === undefined ? [] : [[key, config[key]]])));
    const toolExposure = config.toolExposure === undefined ? base.toolExposure : { ...config.toolExposure, ...base.toolExposure, ...config.toolExposure };
    out.set(name, {
      name,
      source: { kind: "plugin", id: added.pluginId, config: base },
      config: { ...base, ...changed, ...(toolExposure === undefined ? {} : { toolExposure }) },
      file: config,
    });
  }
  for (const [name, { item, pluginId }] of byPlugin) {
    if (out.has(name)) continue;
    const { name: _, ...config } = item;
    out.set(name, { name, source: { kind: "plugin", id: pluginId, config }, config });
  }
  const sorted = [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // The first of two names that give the same tool names keeps them.
  const taken = new Map<string, string>();
  return sorted.map((definition) => {
    const key = toolKey(definition.name);
    const holder = taken.get(key);
    if (holder === undefined) {
      taken.set(key, definition.name);
      return definition;
    }
    return { ...definition, error: `"${definition.name}" names the same tools as "${holder}": rename one` };
  });
}

/** `*` matches any characters; everything else is literal. */
const pattern = (glob: string) =>
  new RegExp(
    `^${glob
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );

/** The `toolExposure` key that decides a tool's exposure: its own name, else the first pattern matching it. */
export function ruleOf(config: McpServerConfig, tool: string): string | undefined {
  const rules = config.toolExposure;
  if (rules === undefined) return undefined;
  if (Object.hasOwn(rules, tool)) return tool;
  return Object.keys(rules).find((glob) => glob.includes("*") && pattern(glob).test(tool));
}

/** A tool's exposure: its rule's (`ruleOf`), else the server's. */
export function exposureOf(config: McpServerConfig, tool: string): Exposure {
  const rule = ruleOf(config, tool);
  return rule === undefined ? (config.exposure ?? "codemode") : config.toolExposure![rule]!;
}

/** A `${NAME}` the host's environment does not set, in a value that gives no default. */
export class MissingVariable extends Error {
  readonly variable: string;
  constructor(variable: string) {
    super(`\${${variable}} is not set in the host's environment`);
    this.variable = variable;
  }
}

/** `${NAME}` and `${NAME:-default}` from `env`; a leading `~/` is the home directory, where a path may be. */
export function expand(value: string, env: Readonly<Record<string, string | undefined>>, path = false): string {
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback: string | undefined) => {
    const set = env[name];
    if (set !== undefined && set !== "") return set;
    if (fallback !== undefined) return fallback;
    throw new MissingVariable(name);
  });
  return path && expanded.startsWith("~/") ? join(homedir(), expanded.slice(2)) : expanded;
}

/** The entry with its variables read from `env`; throws `MissingVariable`. */
export function expandConfig(config: McpServerConfig, env: Readonly<Record<string, string | undefined>>): McpServerConfig {
  const record = (values: Readonly<Record<string, string>> | undefined) =>
    values === undefined ? undefined : Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expand(value, env)]));
  const env_ = record(config.env);
  const headers = record(config.headers);
  const { oauth } = config;
  return {
    ...config,
    ...(config.command === undefined ? {} : { command: expand(config.command, env, true) }),
    ...(config.args === undefined ? {} : { args: config.args.map((arg) => expand(arg, env, true)) }),
    ...(config.cwd === undefined ? {} : { cwd: expand(config.cwd, env, true) }),
    ...(config.url === undefined ? {} : { url: expand(config.url, env) }),
    ...(env_ === undefined ? {} : { env: env_ }),
    ...(headers === undefined ? {} : { headers }),
    ...(oauth === undefined
      ? {}
      : {
          oauth: {
            ...oauth,
            ...(oauth.clientId === undefined ? {} : { clientId: expand(oauth.clientId, env) }),
            ...(oauth.clientSecret === undefined ? {} : { clientSecret: expand(oauth.clientSecret, env) }),
          },
        }),
  };
}

/**
 * What the `${VAR}` references in `config` read from `env`, each with its reference, for an error to show the
 * reference in its place: a token in a URL's query or a header must not reach a page or a model. Values too short to
 * be secrets (`1`, `on`) are left, as replacing them would garble the message.
 */
export function secretsOf(config: McpServerConfig, env: Readonly<Record<string, string | undefined>>): ReadonlyMap<string, string> {
  const secrets = new Map<string, string>();
  for (const [, name] of JSON.stringify(config).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) {
    const value = env[name!];
    if (value !== undefined && value.length >= 4) secrets.set(value, `\${${name}}`);
  }
  return secrets;
}

/**
 * `text` with each of `secrets` replaced by its reference, the longest first: a value inside a longer one (a host in
 * a URL holding a key) would otherwise break the longer one up, and leave the rest of it showing.
 */
export const redact = (text: string, secrets: ReadonlyMap<string, string>): string => {
  let out = text;
  for (const [value, reference] of [...secrets].sort(([a], [b]) => b.length - a.length)) out = out.split(value).join(reference);
  return out;
};

/** What makes a connection: a change to any of these connects again; to anything else, only re-adds the tools. */
export const connectionKey = (config: McpServerConfig): string =>
  JSON.stringify([config.type, config.command, config.args, config.env, config.cwd, config.url, config.headers, config.timeout, config.oauth]);

/**
 * Writes `change` into the server's entry, keeping everything else in the file. A value that is what the server would
 * have without it (`base`: the plugin's, for a server a plugin adds, else the default) is removed rather than written,
 * and an entry left with nothing to say is removed. A file that is a link is written where it links to.
 */
export async function writeChange(path: string, name: string, change: McpServerChange, base: McpServerConfig = {}): Promise<void> {
  await updateServers(path, (servers) => {
    const entry: Record<string, unknown> = isObject(servers[name]) ? { ...servers[name] } : {};
    if (change.enabled !== undefined) {
      delete entry["disabled"];
      if (change.enabled === (base.enabled ?? true)) delete entry["enabled"];
      else entry["enabled"] = change.enabled;
    }
    if (change.exposure !== undefined) {
      if (change.exposure === (base.exposure ?? "codemode")) delete entry["exposure"];
      else entry["exposure"] = change.exposure;
    }
    if (change.tools !== undefined) {
      const tools: Record<string, unknown> = isObject(entry["toolExposure"]) ? { ...entry["toolExposure"] } : {};
      for (const [tool, exposure] of Object.entries(change.tools)) {
        if (exposure === null) delete tools[tool];
        else tools[tool] = exposure;
      }
      if (Object.keys(tools).length === 0) delete entry["toolExposure"];
      else entry["toolExposure"] = tools;
    }
    if (Object.keys(entry).length === 0) delete servers[name];
    else servers[name] = entry;
  });
}

/**
 * Writes the server's whole entry, or removes it (`null`), keeping the rest of the file and the keys another client
 * keeps in the entry beside the ones this plugin reads (`alwaysAllow`, say).
 */
export async function writeEntry(path: string, name: string, entry: McpServerConfig | null): Promise<void> {
  await updateServers(path, (servers) => {
    if (entry === null) {
      delete servers[name];
      return;
    }
    const known = new Set(Object.keys(McpServerConfig.fields));
    const kept = isObject(servers[name]) ? Object.fromEntries(Object.entries(servers[name]).filter(([key]) => !known.has(key) && key !== "disabled")) : {};
    servers[name] = { ...kept, ...entry };
  });
}

/** Changes the file's `mcpServers` with `change`, written atomically; a file that is a link is written where it links to. */
async function updateServers(path: string, change: (servers: Record<string, unknown>) => void): Promise<void> {
  // Through a link (one home-manager keeps, say) rather than over it.
  const target = await realpath(path).catch(() => path);
  let json: Record<string, unknown> = {};
  try {
    const text = await readFile(target, "utf8");
    const parsed: unknown = text.trim() === "" ? {} : JSON.parse(text);
    if (!isObject(parsed)) throw new Error('the file is not a JSON object with an "mcpServers" object');
    json = parsed;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not update ${path}: ${(cause as Error).message}`);
  }
  const servers = isObject(json["mcpServers"]) ? { ...json["mcpServers"] } : {};
  change(servers);
  json = { ...json, mcpServers: servers };
  // As an editor leaves it: the mode the file has (0644 for a new one), and a folder it makes as mkdir makes one.
  const mode = await stat(target).then(
    (info) => info.mode & 0o777,
    () => 0o644,
  );
  try {
    await writeFileAtomic(target, `${JSON.stringify(json, null, 2)}\n`, { mode, dirMode: 0o777 });
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (target !== path && (code === "EROFS" || code === "EACCES" || code === "EPERM"))
      throw new Error(`${path} links to ${target}, which cannot be written: change it where it is managed`, { cause });
    throw cause;
  }
}
