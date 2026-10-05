import { joinCommandLine, parseMcpInput } from "@lemma/contracts";
import type { ImportedServer, McpImport, McpServerInfo, McpServerSpec, McpStatus, McpToolInfo, McpTransport } from "@lemma/contracts";
import type { ToolSummary } from "./format.ts";
import { matchesQuery } from "./settings.ts";

/**
 * MCP servers as the web app shows them: names, targets, status in words,
 * searching, and the text the add and edit dialog reads. What is pasted is
 * read by `parseMcpInput`, shared with the CLI.
 */

// ------------------------------------------------------------------ naming

/** What the app calls a server: its name, else its id. */
export const serverName = (spec: Pick<McpServerSpec, "id" | "name">): string => spec.name ?? spec.id;

export const transportOf = (spec: McpServerSpec): McpTransport => spec.type ?? (spec.command !== undefined ? "stdio" : "http");

/** A URL as its host and path: `https://mcp.linear.app/mcp/` → `mcp.linear.app/mcp`. */
export const shortUrl = (url: string): string => {
  // A `${NAME}` is filled in on the host; parsing would lowercase it.
  if (url.includes("${") || !URL.canParse(url)) return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
};

/** Where a server is: its command line, or its URL's host and path. */
export const serverTarget = (spec: McpServerSpec): string =>
  transportOf(spec) === "stdio" ? (spec.command === undefined ? "" : joinCommandLine([spec.command, ...(spec.args ?? [])])) : shortUrl(spec.url ?? "");

export const transportLabel = (transport: McpTransport): string =>
  transport === "stdio" ? "Command (stdio)" : transport === "sse" ? "URL (legacy SSE)" : "URL (Streamable HTTP)";

/** `create_issue` → `Create issue`; `getUserProfile` → `Get user profile`. */
export const humanize = (name: string): string => {
  const text = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
    .join(" ");
  return text === "" ? name : `${text[0]!.toUpperCase()}${text.slice(1)}`;
};

/** What to call a tool: its title, else its name in words. */
export const toolTitle = (tool: Pick<McpToolInfo, "name" | "title">): string => tool.title ?? humanize(tool.name);

/** Argument names that say what a call is about, read before the rest. */
const GIST_KEYS = ["title", "query", "q", "url", "name", "path", "element", "text", "message", "pattern", "command"];

/** A call's gist: the argument short enough to read on one line that best says what it is about. */
export const callGist = (args: Record<string, unknown> | undefined, max = 120): string | undefined => {
  const short = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && value.length <= max && !value.includes("\n");
  const named = GIST_KEYS.map((key) => args?.[key]).find(short);
  return named ?? Object.values(args ?? {}).find(short);
};

/** How the chat shows a call to a server's tool: `GitHub · Create issue`, then its gist. */
export const toolCallSummary = (server: McpServerInfo, tool: McpToolInfo, args: Record<string, unknown> | undefined): ToolSummary => {
  const detail = callGist(args);
  return { title: `${serverName(server.spec)} · ${toolTitle(tool)}`, ...(detail === undefined ? {} : { primary: detail }) };
};

// ------------------------------------------------------------------ status

/** How a status is drawn: its dot's colour. */
export type StatusTone = "ok" | "busy" | "warn" | "err" | "off";
export const statusTone = (status: McpStatus): StatusTone =>
  status === "ready" ? "ok" : status === "starting" ? "busy" : status === "auth" ? "warn" : status === "error" ? "err" : "off";

const retryIn = (at: number, now: number): string => {
  const seconds = Math.ceil((at - now) / 1000);
  if (seconds <= 0) return "retrying now";
  return seconds < 60 ? `retrying in ${seconds}s` : `retrying in ${Math.ceil(seconds / 60)}m`;
};

/** A server's state in plain words: `Connected · Playwright 0.0.41`, `Couldn't connect: … · retrying in 4s`. */
export const describeStatus = (server: McpServerInfo, now: number = Date.now()): string => {
  switch (server.status) {
    case "off":
      return "Off";
    case "starting":
      return "Starting…";
    case "auth":
      return "Needs you to sign in";
    case "ready": {
      const about = server.server;
      return about === undefined ? "Connected" : `Connected · ${about.title ?? about.name} ${about.version}`;
    }
    case "error": {
      const why = server.error === undefined ? "Couldn't connect" : `Couldn't connect: ${server.error}`;
      return server.retryAt === undefined ? why : `${why} · ${retryIn(server.retryAt, now)}`;
    }
  }
};

/** `1 tool`, `3 tools`. */
export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** `A`, `A and B`, `A, B and C`. */
export const listWords = (words: readonly string[]): string => (words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

/** The few words a server's row ends with: its tools when connected, else its state. */
export const shortStatus = (server: McpServerInfo): string => {
  switch (server.status) {
    case "ready": {
      const on = server.tools.filter((tool) => tool.enabled).length;
      return on === server.tools.length ? plural(on, "tool") : `${on} of ${plural(server.tools.length, "tool")}`;
    }
    case "starting":
      return "Starting…";
    case "auth":
      return "Sign in";
    case "error":
      return "Error";
    case "off":
      return "Off";
  }
};

/** What a server says of a tool, in a word or two: `read-only`, `destructive`, `open world`. */
export const hintLabels = (hints: McpToolInfo["hints"]): string[] => [
  ...(hints.readOnly === true ? ["read-only"] : []),
  ...(hints.destructive === true && hints.readOnly !== true ? ["destructive"] : []),
  ...(hints.openWorld === true ? ["open world"] : []),
];

/** Turned on, and waiting on the user (a sign-in) or failing. */
export const needsAttention = (server: McpServerInfo): boolean => server.spec.enabled !== false && (server.status === "auth" || server.status === "error");

// ------------------------------------------------------------------ search

const serverText = (server: McpServerInfo): string => `${server.id} ${serverName(server.spec)} ${serverTarget(server.spec)}`;
const toolText = (tool: McpToolInfo): string => `${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`;

/** Its tools a search shows: all of them when the server itself matches. */
export const matchTools = (server: McpServerInfo, query: string): readonly McpToolInfo[] => {
  if (query.trim() === "" || matchesQuery(query, serverText(server))) return server.tools;
  return server.tools.filter((tool) => matchesQuery(query, `${serverText(server)} ${toolText(tool)}`));
};

/** The servers a search finds, by their own name and target or by a tool's. */
export const matchServers = (servers: readonly McpServerInfo[], query: string): readonly McpServerInfo[] =>
  query.trim() === "" ? servers : servers.filter((server) => matchTools(server, query).length > 0 || matchesQuery(query, serverText(server)));

/** What the settings search matches a server and a tool by. */
export const serverSearchText = (server: McpServerInfo): string => `mcp server ${serverText(server)}`;
export const toolSearchText = (server: McpServerInfo, tool: McpToolInfo): string => `${toolText(tool)} ${serverName(server.spec)}`;

// ------------------------------------------------------------------ the dialog

/** What Edit opens with: the server's spec as its config holds it (credentials as `MCP_HIDDEN`), without the id it keeps. */
export const specText = (spec: McpServerSpec): string => {
  const { id: _id, ...rest } = spec;
  return JSON.stringify(rest, null, 2);
};

/**
 * Edit's text read back as the spec of the server `before` is: one server,
 * keeping its id. A name that only repeats the id is dropped.
 */
export const readEdit = (text: string, before: McpServerSpec): McpImport => {
  const read = parseMcpInput(text, { name: before.id });
  if (read.servers.length > 1) return { servers: [], problems: [`That is ${read.servers.length} servers: edit one here, and add the others with Add server`] };
  const found = read.servers[0];
  if (found === undefined) return read;
  const { id: _id, name, ...rest } = found.spec;
  const spec: McpServerSpec = { id: before.id, ...(name === undefined || name === before.id ? {} : { name }), ...rest };
  return { servers: [{ ...found, spec }], problems: read.problems };
};

/**
 * The secrets a save sends: those the text moved out of the config, and
 * `null` for each one `stored` holds that the spec no longer reads, so an
 * edit leaves none behind.
 */
export const secretChanges = (found: ImportedServer, stored: readonly string[] = []): Record<string, string | null> => {
  const text = JSON.stringify(found.spec);
  const stale = stored.filter((name) => !(name in found.secrets) && !new RegExp(`\\$\\{${name}(:-[^}]*)?\\}`).test(text));
  return { ...found.secrets, ...Object.fromEntries(stale.map((name) => [name, null])) };
};
