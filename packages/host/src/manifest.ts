import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { Predicate } from "effect";

/*
 * A plugin directory (`<home>/plugins`, a trusted project's `.lemma/plugins`) holds a plugin's halves as files, by
 * name, or as a package:
 *
 *   approvals.ts        a host half (`.ts`, `.js`, `.mjs`): the host loads it
 *   notes.web.js        a web half (`.web.js`, `.web.mjs`): the web app loads it
 *   theme.css           a stylesheet the web app applies after its own
 *   ticker/             a package, whose package.json says where its halves are:
 *     package.json        "lemma": { "host": "./ticker.ts", "web": "./web.js", "styles": ["./ticker.css"] }
 *
 * Both halves of one plugin define the same id, so one row decides both, and the web app runs a web half only while its
 * host half runs.
 */

/** A package's `lemma` manifest: where its halves are, written relative to the package and read as absolute paths. */
export interface Manifest {
  readonly host?: string;
  readonly web?: string;
  readonly styles?: readonly string[];
}

/**
 * An entry of a plugin directory: a file of a half (`approvals.ts`, `notes.web.js`), a stylesheet, or a package, whose
 * manifest's paths are resolved against it. A path outside the package is none of its own, and is left out.
 */
export type Entry =
  | { readonly kind: "host" | "web" | "style"; readonly path: string; readonly name: string }
  | { readonly kind: "package"; readonly path: string; readonly name: string; readonly manifest: Manifest };

const isWeb = (name: string) => /\.web\.(js|mjs)$/.test(name);
const isHost = (name: string) => /\.(ts|js|mjs)$/.test(name) && !name.endsWith(".d.ts") && !isWeb(name);

/** A package's manifest, its paths absolute; undefined when its package.json has no `lemma` object. */
const manifestOf = async (dir: string): Promise<Manifest | undefined> => {
  const text = await readFile(join(dir, "package.json"), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const lemma: unknown = (() => {
    try {
      return (JSON.parse(text) as { lemma?: unknown }).lemma;
    } catch {
      return undefined;
    }
  })();
  if (!Predicate.isObject(lemma)) return undefined;
  const { host, web, styles } = lemma as Record<string, unknown>;
  const inside = (file: unknown): string[] => {
    if (typeof file !== "string") return [];
    const path = join(dir, file);
    return relative(dir, path).startsWith("..") ? [] : [path];
  };
  const [hostPath] = inside(host);
  const [webPath] = inside(web);
  return {
    ...(hostPath === undefined ? {} : { host: hostPath }),
    ...(webPath === undefined ? {} : { web: webPath }),
    ...(Array.isArray(styles) ? { styles: styles.flatMap(inside) } : {}),
  };
};

/** The entries of a plugin directory, by name; a directory without a `lemma` manifest is not a plugin. */
export async function entriesOf(dir: string): Promise<Entry[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const entries: Entry[] = [];
  for (const name of names.sort()) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (info?.isDirectory()) {
      const manifest = await manifestOf(path);
      if (manifest !== undefined) entries.push({ kind: "package", path, name, manifest });
    } else if (info?.isFile()) {
      if (isWeb(name)) entries.push({ kind: "web", path, name });
      else if (isHost(name)) entries.push({ kind: "host", path, name });
      else if (name.endsWith(".css")) entries.push({ kind: "style", path, name });
    }
  }
  return entries;
}
