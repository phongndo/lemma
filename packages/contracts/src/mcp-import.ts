import { Either, Schema } from "effect";
import { MCP_HIDDEN, McpServerSpec } from "./mcp.ts";
import type { McpTransport } from "./mcp.ts";

/**
 * Reading what someone pastes to add MCP servers (a URL, a command line, or a
 * config written for another client), shared by the web app and the CLI so
 * both read it the same way.
 */

/** A server id from a name: `My Server!` reads as `my-server`. */
export function mcpServerId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 48)
    .replace(/[-_]+$/g, "");
  return slug === "" ? "server" : slug;
}

/**
 * Splits a command line as a POSIX shell would split words: whitespace
 * separates, single quotes keep everything, double quotes keep all but `\`
 * escapes, and a backslash outside quotes escapes the next character. Nothing
 * is expanded: `$HOME` stays as written.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\" && index + 1 < line.length && /["\\$`]/.test(line[index + 1]!)) word += line[++index];
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "\\" && index + 1 < line.length) {
      word += line[++index];
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/** A command line that `splitCommandLine` reads back as `words`. */
export function joinCommandLine(words: readonly string[]): string {
  return words.map((word) => (word !== "" && /^[A-Za-z0-9_@%+=:,./~-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** An env or header name that usually holds a credential. */
export function looksSecret(name: string): boolean {
  return (
    /(^|[_-])(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|PAT|COOKIE)([_-]|$)/i.test(name) ||
    /api[_-]?key|access[_-]?key|private[_-]?key|authorization|session|(password|passwd|secret|token)$/i.test(name)
  );
}

/** A URL with a password in it: `postgres://user:pass@host/db`. */
const CREDENTIAL_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/i;

/** A value that is a credential whatever it is called: a URL with a password, or a token in a well-known format. */
export function looksSecretValue(value: string): boolean {
  return CREDENTIAL_URL.test(value) || /^(gh[pousr]_|github_pat_|glpat-|sk-|sk_live_|xox[abprs]-|AKIA[0-9A-Z]{12})/.test(value);
}

/** A value a README leaves for you to fill in: `<YOUR_TOKEN>`, `your-api-key`, `xxxx`. */
export function looksPlaceholder(value: string): boolean {
  return /^<.*>$|^\{\{.*\}\}$|^(your|my)[_ -]|[_-]here$|^x{4,}$|^\*{4,}$|^\.{3}$|^(changeme|replace[_-]?me|todo)$/i.test(value.trim());
}

/** `Authorization` as a secret's name: `AUTHORIZATION`; `X-Api-Key`: `X_API_KEY`. */
export const secretName = (name: string): string =>
  name
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "SECRET";

/** One server read from a pasted config, with what it needs before it can be saved. */
export interface ImportedServer {
  readonly spec: McpServerSpec;
  /** Credential-looking values moved out of the config: saved as the server's secrets, and the spec reads them as `${NAME}`. */
  readonly secrets: Readonly<Record<string, string>>;
  /** What to check before saving: placeholders to fill in, inputs the other client prompted for. */
  readonly notes: readonly string[];
}

export interface McpImport {
  readonly servers: readonly ImportedServer[];
  /** Why the text, or an entry in it, could not be read. */
  readonly problems: readonly string[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] | undefined => (Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined);
const record = (value: unknown): Record<string, string> | undefined => {
  if (!isObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value))
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") out[key] = String(item);
  return out;
};

/** `${env:NAME}` (Cursor, VS Code) as `${NAME}`; VS Code's `${input:id}` as `${ID}`, which becomes a secret to set. */
const normalizeReferences = (value: string, inputs: Set<string>): string =>
  value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}").replace(/\$\{input:([^}]+)\}/g, (_, id: string) => {
    const name = secretName(id);
    inputs.add(name);
    return `\${${name}}`;
  });

const decodeSpec = Schema.decodeUnknownEither(McpServerSpec);

const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);

/** One entry of a `mcpServers`-style map, in any of the shapes clients write, Lemma's own included. */
function importEntry(name: string, entry: unknown, taken: Set<string>): { readonly server?: ImportedServer; readonly problem?: string } {
  if (!isObject(entry)) return { problem: `"${name}" is not an object` };
  let id = mcpServerId(name);
  for (let suffix = 2; taken.has(id); suffix++) id = `${mcpServerId(name).slice(0, 44)}-${suffix}`;
  const inputs = new Set<string>();
  const notes: string[] = [];
  const secrets: Record<string, string> = {};
  const rawType = typeof entry["type"] === "string" ? entry["type"].toLowerCase() : undefined;
  const url = [entry["url"], entry["httpUrl"], entry["serverUrl"]].find((value): value is string => typeof value === "string");
  // OpenCode writes the whole command line as an array.
  const commandLine = strings(entry["command"]);
  const command = commandLine?.[0] ?? (typeof entry["command"] === "string" ? entry["command"] : undefined);
  const args = [...(commandLine?.slice(1) ?? []), ...(strings(entry["args"]) ?? [])];
  // Written only when the config says which: without it the host infers it, and falls back from Streamable HTTP to SSE.
  let stated: McpTransport | undefined;
  if (rawType === "sse" || rawType === "stdio") stated = rawType;
  else if (rawType === "http" || rawType === "streamable-http" || rawType === "streamablehttp" || typeof entry["httpUrl"] === "string") stated = "http";
  const type: McpTransport | undefined =
    stated ??
    (rawType === "stdio" || rawType === "local" || (command !== undefined && rawType !== "remote") ? "stdio" : url !== undefined ? "http" : undefined);
  if (type === undefined) return { problem: `"${name}" has neither a command nor a URL` };

  /**
   * A value from the pasted config: a credential (by its name or its look) moves to `secrets` and the spec reads
   * `${NAME}`. `MCP_HIDDEN` stays: saving it keeps the value the host holds.
   */
  const keep = (key: string, value: string, secretKey: string): string => {
    const normalized = normalizeReferences(value, inputs);
    if (normalized === MCP_HIDDEN || normalized.includes("${") || !(looksSecret(key) || looksSecretValue(normalized))) return normalized;
    if (looksPlaceholder(normalized)) notes.push(`Set ${secretKey}: the config has a placeholder (${normalized})`);
    else secrets[secretKey] = normalized;
    return `\${${secretKey}}`;
  };
  /** An argument that is a credential (`postgres://user:pass@…`) moves to a secret named for what it is. */
  const keepArg = (arg: string): string => {
    const normalized = normalizeReferences(arg, inputs);
    if (normalized.includes("${") || !looksSecretValue(normalized)) return normalized;
    const base = CREDENTIAL_URL.test(normalized) ? `${secretName(normalized.slice(0, normalized.indexOf(":")))}_URL` : "TOKEN";
    let secretKey = base;
    for (let suffix = 2; secretKey in secrets; suffix++) secretKey = `${base}_${suffix}`;
    return keep(secretKey, normalized, secretKey);
  };
  const env = record(entry["env"] ?? entry["environment"]);
  const headers = record(entry["headers"]);
  const spec: Record<string, unknown> = { id, ...(stated === undefined ? {} : { type: stated }) };
  if (typeof entry["name"] === "string") spec["name"] = entry["name"];
  else if (id !== name) spec["name"] = name;
  if (type === "stdio") {
    if (command === undefined) return { problem: `"${name}" is a stdio server without a command` };
    spec["command"] = normalizeReferences(command, inputs);
    if (args.length > 0) spec["args"] = args.map(keepArg);
    if (typeof entry["cwd"] === "string") spec["cwd"] = normalizeReferences(entry["cwd"], inputs);
    if (env !== undefined && Object.keys(env).length > 0)
      spec["env"] = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, keep(key, value, key)]));
  } else {
    if (url === undefined) return { problem: `"${name}" is a URL server without a url` };
    spec["url"] = normalizeReferences(url, inputs);
    if (headers !== undefined && Object.keys(headers).length > 0) {
      spec["headers"] = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, keep(key, value, secretName(key))]));
    }
  }
  if (entry["disabled"] === true || entry["enabled"] === false) spec["enabled"] = false;
  const toolTimeoutMs = positive(entry["toolTimeoutMs"]) ?? positive(entry["timeout"]);
  if (toolTimeoutMs !== undefined) spec["toolTimeoutMs"] = toolTimeoutMs;
  const startupTimeoutMs = positive(entry["startupTimeoutMs"]);
  if (startupTimeoutMs !== undefined) spec["startupTimeoutMs"] = startupTimeoutMs;
  const disabledTools = strings(entry["disabledTools"]);
  if (disabledTools !== undefined && disabledTools.length > 0) spec["disabledTools"] = disabledTools;
  // Lemma's own sign-in settings; a client secret written out moves to the secrets like any credential.
  const oauth = entry["oauth"];
  if (type !== "stdio" && isObject(oauth)) {
    spec["oauth"] = {
      ...(typeof oauth["clientId"] === "string" ? { clientId: oauth["clientId"] } : {}),
      ...(typeof oauth["clientSecret"] === "string" ? { clientSecret: keep("clientSecret", oauth["clientSecret"], "OAUTH_CLIENT_SECRET") } : {}),
      ...(strings(oauth["scopes"]) === undefined ? {} : { scopes: strings(oauth["scopes"]) }),
      ...(positive(oauth["callbackPort"]) === undefined ? {} : { callbackPort: positive(oauth["callbackPort"]) }),
    };
  }
  const decoded = decodeSpec(spec);
  if (Either.isLeft(decoded)) return { problem: `"${name}": ${decoded.left.message}` };
  for (const input of inputs) if (!(input in secrets)) notes.push(`Set ${input}: the other client prompted for it`);
  taken.add(id);
  return { server: { spec: decoded.right, secrets, notes } };
}

/**
 * Servers from a config pasted from another client or a server's README:
 * `{ "mcpServers": { … } }` (Claude, Cursor, Gemini, Windsurf), `{ "servers":
 * { … } }` (VS Code), `{ "mcp": { … } }` (OpenCode), a bare map of name to
 * server, or one server object (`name` names it). Credential-looking values
 * are moved to `secrets`; nothing is saved.
 */
export function importMcpConfig(text: string, name = "server", taken: Iterable<string> = []): McpImport {
  let parsed: unknown;
  try {
    // Configs are often JSONC: drop comments and trailing commas outside strings.
    parsed = JSON.parse(stripJsonComments(text));
  } catch (error) {
    return { servers: [], problems: [`Not JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!isObject(parsed)) return { servers: [], problems: ["Expected an object of servers"] };
  const map = [parsed["mcpServers"], parsed["servers"], parsed["mcp"], parsed["context_servers"]].find(isObject);
  const single = "command" in parsed || "url" in parsed || "httpUrl" in parsed || "serverUrl" in parsed;
  const entries: [string, unknown][] = map !== undefined ? Object.entries(map) : single ? [[name, parsed]] : Object.entries(parsed);
  const used = new Set(taken);
  const servers: ImportedServer[] = [];
  const problems: string[] = [];
  for (const [key, entry] of entries) {
    const result = importEntry(key, entry, used);
    if (result.server !== undefined) servers.push(result.server);
    if (result.problem !== undefined) problems.push(result.problem);
  }
  if (entries.length === 0) problems.push("No servers in it");
  return { servers, problems };
}

/** Words that run a package rather than name the server: `npx -y @playwright/mcp`'s server is the package. */
const RUNNERS = new Set([
  "npx",
  "bunx",
  "uvx",
  "pipx",
  "pnpx",
  "dlx",
  "pnpm",
  "yarn",
  "bun",
  "uv",
  "deno",
  "node",
  "python",
  "python3",
  "docker",
  "podman",
  "run",
  "exec",
  "x",
  "tool",
]);
const AFFIXES = /^(mcp[-_]server[-_]|server[-_]|mcp[-_])|([-_]mcp[-_]server|[-_]server|[-_]mcp)$/gi;

/**
 * The server a word of a command names: a package (`@playwright/mcp@latest`
 * is `playwright`, `@modelcontextprotocol/server-everything` is `everything`),
 * an image (`ghcr.io/github/github-mcp-server` is `github`), or a script
 * (`servers/notes/index.js` is `notes`).
 */
function commandName(word: string): string {
  const parts = word
    .replace(/(.)@[^/@]*$/, "$1")
    .replace(/:[^/:]*$/, "")
    .replace(/^@/, "")
    .split(/[\\/]/)
    .filter(Boolean);
  const last = (parts.at(-1) ?? word).replace(/\.(m?[jt]s|py|rb|sh)$/i, "");
  const bare = last.replace(AFFIXES, "");
  return bare === "" || /^(mcp|server|index|main)$/i.test(bare) ? (parts.at(-2) ?? last) : bare;
}

/** The server a URL names: `https://mcp.linear.app/mcp` is `linear`. */
function hostName(url: URL): string {
  if (/^[\d.]+$|:/.test(url.hostname)) return "server";
  const labels = url.hostname.split(".");
  if (labels.length > 1 && !/^\d+$/.test(labels.at(-1)!)) labels.pop();
  return labels.filter((label) => !/^(www|mcp|api|server)$/i.test(label)).at(-1) ?? labels.at(-1) ?? "server";
}

/**
 * Servers from what someone pasted to add them: a config
 * (`importMcpConfig`), a URL (a server there), or a command line (a server
 * Lemma runs; leading `NAME=value` words become its environment). A server
 * without a name in the text is named after the URL's host or the command's
 * package; ids in `taken` get a suffix rather than replace a server.
 */
export function parseMcpInput(text: string, options: { readonly name?: string; readonly taken?: Iterable<string> } = {}): McpImport {
  const trimmed = text.trim();
  if (trimmed === "") return { servers: [], problems: [] };
  if (trimmed.startsWith("{")) return importMcpConfig(trimmed, options.name ?? "server", options.taken);
  let entry: Json;
  let name = options.name;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1];
  if (scheme !== undefined && !/^https?$/i.test(scheme)) return { servers: [], problems: [`"${trimmed}" is not an http or https URL`] };
  if (scheme !== undefined && !/\s/.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { servers: [], problems: [`"${trimmed}" is not a URL`] };
    }
    entry = { url: trimmed };
    name ??= hostName(url);
  } else {
    const words = splitCommandLine(trimmed);
    const env: Record<string, string> = {};
    while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) {
      const assignment = words.shift()!;
      const at = assignment.indexOf("=");
      env[assignment.slice(0, at)] = assignment.slice(at + 1);
    }
    if (words.length === 0) return { servers: [], problems: ["No command in it"] };
    entry = { command: words[0], args: words.slice(1), ...(Object.keys(env).length > 0 ? { env } : {}) };
    // The word that names the server: a package, image, or script, else the first that is not a flag or a runner.
    const candidates = words.slice(1).filter((word) => !word.startsWith("-") && !RUNNERS.has(word.toLowerCase()));
    name ??= commandName(candidates.find((word) => /mcp|server|[@/\\]|\.(m?[jt]s|py)$/i.test(word)) ?? candidates[0] ?? words[0]!);
  }
  // Named as written: a name that is not an id becomes the server's `name`, its id made from it.
  return importMcpConfig(JSON.stringify({ mcpServers: { [name]: entry } }), "server", options.taken);
}

/** JSONC to JSON: comments and trailing commas removed, strings untouched. */
function stripJsonComments(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') {
      const start = index;
      for (index++; index < text.length && text[index] !== '"'; index++) if (text[index] === "\\") index++;
      out += text.slice(start, index + 1);
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      out += "\n";
    } else if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++;
      index++;
    } else if (char === "," && /^\s*[}\]]/.test(text.slice(index + 1))) {
      // A trailing comma.
    } else {
      out += char;
    }
  }
  return out;
}
