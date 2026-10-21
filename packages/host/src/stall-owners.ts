import { isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Whose code a blocked thread's stacks were in (see `watchStalls` in stall.ts). Apart from stall.ts so the watchdog's
 * worker, which names the plugin while the loop is still blocked, imports nothing but this and Node's own: stall.ts
 * imports `effect`, which would load all of Effect into the worker's isolate: about 35 MB more of a host's memory.
 */

/** Where a plugin's code lives: a directory (a bundled plugin's package, a folder plugin) or one file. */
export interface CodeOwner {
  readonly path: string;
  readonly id: string;
}

/** A file URL's path; one that names no file here (another host's) names no plugin's. */
const pathOf = (url: string): string => {
  try {
    return fileURLToPath(url);
  } catch {
    return "";
  }
};

/** The plugin whose code a file is: the owner whose path is the file, or the deepest directory holding it. */
export const ownerOfFile = (owners: readonly CodeOwner[], file: string): string | undefined => {
  let found: CodeOwner | undefined;
  for (const owner of owners) {
    if ((file === owner.path || file.startsWith(owner.path + sep)) && (found === undefined || owner.path.length > found.path.length)) found = owner;
  }
  return found?.id;
};

/**
 * Whose code a stall ran, from stacks of the blocked thread (each a list of script names, file URLs or paths, innermost
 * first): each stack
 * goes to the plugin owning its innermost frame that is a plugin's (the kernel, Effect, and the host are no plugin's,
 * so time spent in them goes to the plugin that called them), and the plugin with the most stacks is named, with its
 * share of them all. None is named when no stack held any plugin's code.
 */
export function attribute(stacks: readonly (readonly string[])[], owners: readonly CodeOwner[]): { readonly pluginId?: string; readonly share?: number } {
  const byUrl = new Map<string, string | undefined>();
  const ownerOfUrl = (url: string) => {
    if (!byUrl.has(url)) byUrl.set(url, url.startsWith("file:") ? ownerOfFile(owners, pathOf(url)) : isAbsolute(url) ? ownerOfFile(owners, url) : undefined);
    return byUrl.get(url);
  };
  const counts = new Map<string, number>();
  for (const stack of stacks) {
    const id = stack.map(ownerOfUrl).find((owner) => owner !== undefined);
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let top: [string, number] | undefined;
  for (const entry of counts) if (top === undefined || entry[1] > top[1]) top = entry;
  return top === undefined ? {} : { pluginId: top[0], share: top[1] / stacks.length };
}
