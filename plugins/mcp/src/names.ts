import { createHash } from "node:crypto";

/** The strictest provider's limit (OpenAI's): letters, digits, `_` and `-`, at most 64. */
export const MAX_TOOL_NAME = 64;

/** Letters, digits, and `_`: a name that is also a codemode identifier. */
export const sanitize = (text: string): string => text.replace(/[^A-Za-z0-9_]/g, "_");

const shortHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 6);

/**
 * The model's name for each of a server's tools: `mcp__<server>__<tool>`,
 * sanitized. A name past the limit, or one another tool of the server
 * already has after sanitizing (`a.b` and `a_b`), keeps its start and gains a
 * hash of the server's own name, so names are stable across reconnects and
 * the same on every host. Tools are named in the server's order of their own
 * names, so which of two colliding tools keeps the plain name is stable too.
 */
export function toolNames(server: string, tools: readonly string[]): Map<string, string> {
  const prefix = `mcp__${sanitize(server)}__`;
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const tool of [...tools].sort()) {
    let name = `${prefix}${sanitize(tool)}`;
    if (name.length > MAX_TOOL_NAME || taken.has(name)) name = `${name.slice(0, MAX_TOOL_NAME - 7)}_${shortHash(`${server}\0${tool}`)}`;
    taken.add(name);
    names.set(tool, name);
  }
  return names;
}

/** Server ids that read the same once sanitized (`my-db` and `my_db`) would name tools alike. */
export const sameServer = (a: string, b: string): boolean => sanitize(a).toLowerCase() === sanitize(b).toLowerCase();
