import { homedir } from "node:os";
import { resolve } from "node:path";
import { looksSecret, looksSecretValue, MCP_HIDDEN } from "@lemma/contracts";
import type { McpServerSpec, McpTransport } from "@lemma/contracts";
import type { Launch } from "./connection.ts";

/** `${NAME}`, or `${NAME:-fallback}` when NAME may be unset. */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export const transportOf = (spec: McpServerSpec): McpTransport => spec.type ?? (spec.command !== undefined ? "stdio" : "http");

/** Every value of a spec that `${NAME}` may appear in. */
const values = (spec: McpServerSpec): string[] => [
  ...(spec.command === undefined ? [] : [spec.command]),
  ...(spec.args ?? []),
  ...Object.values(spec.env ?? {}),
  ...(spec.cwd === undefined ? [] : [spec.cwd]),
  ...(spec.url === undefined ? [] : [spec.url]),
  ...Object.values(spec.headers ?? {}),
  ...(spec.oauth?.clientId === undefined ? [] : [spec.oauth.clientId]),
  ...(spec.oauth?.clientSecret === undefined ? [] : [spec.oauth.clientSecret]),
];

/** The names a spec reads without a fallback, so it cannot start while one is unset. */
export function requiredNames(spec: McpServerSpec): string[] {
  const names = new Set<string>();
  for (const value of values(spec)) for (const match of value.matchAll(REFERENCE)) if (match[2] === undefined) names.add(match[1]!);
  return [...names];
}

export type Lookup = (name: string) => string | undefined;

/** `text` with each `${NAME}` replaced; names `lookup` does not know (and that have no fallback) are added to `missing`. */
export function interpolate(text: string, lookup: Lookup, missing: Set<string>): string {
  return text.replace(REFERENCE, (_, name: string, fallback: string | undefined) => {
    const value = lookup(name);
    if (value !== undefined && value !== "") return value;
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return "";
  });
}

const expandHome = (path: string): string => (path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path);

/**
 * What a stdio server inherits from the host: its environment minus names that
 * usually hold credentials (provider API keys, tokens), which a server gets
 * only when its config passes them (`"GITHUB_TOKEN": "${GITHUB_TOKEN}"`).
 */
export function inheritedEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined && !looksSecret(name)) out[name] = value;
  return out;
}

export interface Resolved {
  readonly launch?: Launch;
  /** `${NAME}`s that neither a stored secret nor the host's environment sets. */
  readonly missing: readonly string[];
  /** Why it cannot start, when it cannot. */
  readonly problem?: string;
}

/**
 * How to start `spec`: every `${NAME}` read from the server's stored secrets,
 * then the host's environment; paths with `~` expanded and resolved against
 * `cwd`. A spec that names an unset value, or lacks what its transport needs,
 * has no launch and says why.
 */
export function launchOf(
  spec: McpServerSpec,
  options: { readonly secrets: Readonly<Record<string, string>>; readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): Resolved {
  const env = options.env ?? process.env;
  const lookup: Lookup = (name) => options.secrets[name] ?? env[name];
  const missing = new Set<string>();
  const read = (text: string) => interpolate(text, lookup, missing);
  const type = transportOf(spec);
  let launch: Launch | undefined;
  let problem: string | undefined;
  if (type === "stdio") {
    if (spec.command === undefined || spec.command.trim() === "") problem = "It has no command to run";
    else {
      launch = {
        type,
        command: expandHome(read(spec.command)),
        args: (spec.args ?? []).map(read),
        env: Object.fromEntries(Object.entries(spec.env ?? {}).map(([name, value]) => [name, read(value)])),
        cwd: resolve(options.cwd, expandHome(spec.cwd === undefined ? options.cwd : read(spec.cwd))),
      };
    }
  } else if (spec.url === undefined || spec.url.trim() === "") {
    problem = "It has no URL";
  } else {
    const url = read(spec.url);
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      problem = `"${url}" is not a URL`;
    }
    if (parsed !== undefined && parsed.protocol !== "https:" && parsed.protocol !== "http:") problem = `"${url}" is not an http or https URL`;
    if (problem === undefined) {
      launch = {
        type,
        url,
        headers: Object.fromEntries(Object.entries(spec.headers ?? {}).map(([name, value]) => [name, read(value)])),
        fallback: spec.type === undefined,
      };
    }
  }
  const unset = [...missing];
  if (unset.length > 0)
    return {
      missing: unset,
      problem: `${unset.join(", ")} ${unset.length === 1 ? "is" : "are"} not set: store ${unset.length === 1 ? "it" : "them"} as the server's secrets, or set ${unset.length === 1 ? "it" : "them"} in the host's environment`,
    };
  return problem === undefined ? { launch: launch!, missing: [] } : { missing: [], problem };
}

/**
 * A value clients do not receive: one that looks like a credential, or one
 * under a credential-like name with more in it than `${NAME}` references and
 * an auth scheme (`Bearer ${TOKEN}` is shown).
 */
const hidden = (name: string, value: string): boolean =>
  looksSecretValue(value) ||
  (looksSecret(name) &&
    value
      .replace(REFERENCE, "")
      .replace(/^\s*(Bearer|Basic|Token|Bot|ApiKey)\b/i, "")
      .trim() !== "");

const mask = (entries: Readonly<Record<string, string>> | undefined) =>
  entries === undefined ? undefined : Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, hidden(name, value) ? MCP_HIDDEN : value]));

/** `spec` as clients see it: credential-like literals as `MCP_HIDDEN`. */
export function masked(spec: McpServerSpec): McpServerSpec {
  const env = mask(spec.env);
  const headers = mask(spec.headers);
  const secret = spec.oauth?.clientSecret;
  return {
    ...spec,
    ...(env === undefined ? {} : { env }),
    ...(headers === undefined ? {} : { headers }),
    ...(spec.oauth === undefined || secret === undefined ? {} : { oauth: { ...spec.oauth, clientSecret: hidden("secret", secret) ? MCP_HIDDEN : secret } }),
  };
}

/**
 * A spec a client sent, with each `MCP_HIDDEN` back to the value `previous`
 * holds under the same name. Fails naming a hidden value with nothing to keep.
 */
export function unmasked(next: McpServerSpec, previous: McpServerSpec | undefined): McpServerSpec | string {
  const missing: string[] = [];
  const restore = (entries: Readonly<Record<string, string>> | undefined, old: Readonly<Record<string, string>> | undefined) => {
    if (entries === undefined) return undefined;
    return Object.fromEntries(
      Object.entries(entries).map(([name, value]) => {
        if (value !== MCP_HIDDEN) return [name, value];
        const kept = old?.[name];
        if (kept === undefined) missing.push(name);
        return [name, kept ?? ""];
      }),
    );
  };
  const env = restore(next.env, previous?.env);
  const headers = restore(next.headers, previous?.headers);
  let oauth = next.oauth;
  if (oauth?.clientSecret === MCP_HIDDEN) {
    const kept = previous?.oauth?.clientSecret;
    if (kept === undefined) missing.push("clientSecret");
    oauth = { ...oauth, clientSecret: kept ?? "" };
  }
  if (missing.length > 0) return `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} hidden but not in the saved config: send the value`;
  return { ...next, ...(env === undefined ? {} : { env }), ...(headers === undefined ? {} : { headers }), ...(oauth === undefined ? {} : { oauth }) };
}

/** The command line or URL, for logs and errors. */
export const describeLaunch = (launch: Launch): string => (launch.type === "stdio" ? [launch.command, ...launch.args].join(" ") : launch.url);
