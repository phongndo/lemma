import type { Exposure, McpServerConfig } from "@lemma/mcp";
import { SERVER_NAME } from "@lemma/mcp";
import { isObject } from "./values.ts";

/*
 * The web half's model of adding and editing a server: a command line as one string, name and value rows, and entries
 * pasted from another client's config. Pure, so it is tested without a page.
 */

/** Splits a command line as a shell would split simple words: on spaces, with single and double quotes, and `\` escaping. */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === "\\" && i + 1 < line.length) {
      word += line[++i];
      started = true;
    } else if (/\s/.test(char)) {
      if (started || word !== "") words.push(word);
      word = "";
      started = false;
    } else word += char;
  }
  if (started || word !== "") words.push(word);
  return words;
}

/** The words as one command line `splitCommand` reads back: a word with spaces or quotes in it is quoted. */
export const joinCommand = (words: readonly string[]): string =>
  words.map((word) => (word === "" || /[\s"'\\]/.test(word) ? `"${word.replace(/(["\\])/g, "\\$1")}"` : word)).join(" ");

/** Name and value rows: blank rows dropped. */
export type Rows = readonly { readonly name: string; readonly value: string }[];

const rowsOf = (record: Readonly<Record<string, string>> | undefined): Rows => Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));

const recordOf = (rows: Rows): Record<string, string> | undefined => {
  const kept = rows.filter((row) => row.name.trim() !== "");
  return kept.length === 0 ? undefined : Object.fromEntries(kept.map((row) => [row.name.trim(), row.value]));
};

/** Whether `text` can be an icon: an `https:` address, or an image as a `data:` URL. */
export const isImageAddress = (text: string): boolean => /^https:\/\/\S+$/.test(text) || /^data:image\/[a-z0-9.+-]+(;[^,]*)?,.+$/i.test(text);

const EXPOSURE_ALIASES: Readonly<Record<string, Exposure>> = { deferred: "codemode", "codemode-deferred": "codemode" };
const exposureAlias = (value: unknown): unknown => (typeof value === "string" ? (EXPOSURE_ALIASES[value] ?? value) : value);

/**
 * An entry as another client may have written it, in this plugin's terms: `disabled: true` (Cline's, OpenCode's) is
 * `enabled: false`, and pi's other exposure names are code mode.
 */
export const normalize = (entry: Record<string, unknown>): Record<string, unknown> => {
  const { disabled, ...rest } = entry;
  const out: Record<string, unknown> = { ...rest };
  if (disabled === true && out["enabled"] === undefined) out["enabled"] = false;
  if (out["exposure"] !== undefined) out["exposure"] = exposureAlias(out["exposure"]);
  if (isObject(out["toolExposure"]))
    out["toolExposure"] = Object.fromEntries(Object.entries(out["toolExposure"]).map(([tool, value]) => [tool, exposureAlias(value)]));
  return out;
};

/** What the form holds. */
export interface ServerDraft {
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly command: string;
  readonly env: Rows;
  readonly url: string;
  readonly headers: Rows;
  readonly description: string;
  /** Its icon's address; empty: the one the server declares. */
  readonly icon?: string;
}

export const draftOf = (name: string, entry: McpServerConfig | undefined): ServerDraft => ({
  name,
  transport: entry?.url !== undefined ? "http" : "stdio",
  command: entry?.command === undefined ? "" : joinCommand([entry.command, ...(entry.args ?? [])]),
  env: rowsOf(entry?.env),
  url: entry?.url ?? "",
  headers: rowsOf(entry?.headers),
  description: entry?.description ?? "",
  icon: entry?.icon ?? "",
});

/**
 * The entry the form makes, over `base` (the entry it edits, whose other settings it keeps: exposure, the tools', the
 * switch), or why it cannot be made.
 */
export function entryOf(draft: ServerDraft, base: McpServerConfig = {}): { readonly entry: McpServerConfig } | { readonly error: string } {
  if (!SERVER_NAME.test(draft.name)) return { error: "A name is letters, digits, _, and -" };
  const {
    type: _type,
    command: _command,
    args: _args,
    env: _env,
    cwd: _cwd,
    url: _url,
    headers: _headers,
    description: _description,
    icon: _icon,
    ...kept
  } = base;
  const icon = (draft.icon ?? "").trim();
  if (icon !== "" && !isImageAddress(icon)) return { error: "The icon is an https: address or a data:image/ URL" };
  const description = { ...(draft.description.trim() === "" ? {} : { description: draft.description.trim() }), ...(icon === "" ? {} : { icon }) };
  if (draft.transport === "stdio") {
    const [command, ...args] = splitCommand(draft.command.trim());
    if (command === undefined || command === "") return { error: "Give the command that starts the server" };
    const env = recordOf(draft.env);
    return {
      entry: {
        ...kept,
        command,
        ...(args.length === 0 ? {} : { args }),
        ...(env === undefined ? {} : { env }),
        ...(base.cwd === undefined ? {} : { cwd: base.cwd }),
        ...description,
      },
    };
  }
  const url = draft.url.trim();
  if (!/^https?:\/\//.test(url)) return { error: "Give the server's address, starting http:// or https://" };
  const headers = recordOf(draft.headers);
  return { entry: { ...kept, url, ...(headers === undefined ? {} : { headers }), ...description } };
}

const isEntry = (value: unknown): value is Record<string, unknown> =>
  isObject(value) && (typeof value["command"] === "string" || typeof value["url"] === "string");

/**
 * The servers in JSON pasted from another client or a README: a whole file (`{ "mcpServers": { … } }`, or VS Code's
 * `{ "servers": { … } }`), entries by name, or one entry (named `name`). The entries are as written; the host checks
 * each as it adds it.
 */
export function parsePasted(
  text: string,
  name = "",
): { readonly servers: readonly { readonly name: string; readonly entry: McpServerConfig }[] } | { readonly error: string } {
  let json: unknown;
  try {
    // A fragment copied without its braces (`"github": { … }`) is read as an object.
    const trimmed = text.trim();
    json = JSON.parse(trimmed.startsWith('"') ? `{${trimmed.replace(/,\s*$/, "")}}` : trimmed);
  } catch (cause) {
    return { error: `Not JSON: ${(cause as Error).message}` };
  }
  if (!isObject(json)) return { error: "Paste a JSON object: a config with mcpServers, servers by name, or one server" };
  if (isEntry(json)) {
    if (!SERVER_NAME.test(name)) return { error: "This is one server: give it a name" };
    return { servers: [{ name, entry: normalize(json) as McpServerConfig }] };
  }
  const byName = isObject(json["mcpServers"]) ? json["mcpServers"] : isObject(json["servers"]) ? json["servers"] : json;
  const servers = Object.entries(byName).filter(([, entry]) => isEntry(entry));
  if (servers.length === 0) return { error: "No server found: each needs a command or a url" };
  // In this plugin's terms (`disabled: true` is `enabled: false`), as a client sends them, which drops what it does not know.
  return { servers: servers.map(([key, entry]) => ({ name: key, entry: normalize(entry as Record<string, unknown>) as McpServerConfig })) };
}
