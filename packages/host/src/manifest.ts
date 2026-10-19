import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Predicate } from "effect";
import { isInside } from "@lemma/contracts/fs";

/*
 * A plugin directory (`<home>/plugins`, a trusted project's `.lemma/plugins`) holds a plugin's halves as files, by
 * name, or as a package:
 *
 *   approvals.ts        a host half (`.ts`, `.js`, `.mjs`): the host loads it
 *   notes.web.js        a web half (`.web.js`, `.web.mjs`, or `.web.ts`, its types stripped as it is served)
 *   theme.css           a stylesheet the web app applies after its own
 *   ticker/             a package, whose package.json says where its halves are:
 *     package.json        "lemma": { "host": "./ticker.ts", "web": "./web.js", "styles": ["./ticker.css"] }
 *
 * A package also names folders of things other plugins read, by kind (`"resources": { "skills": "./skills" }`): the
 * host passes them on as they are, in its plugin's status, for the plugin that reads that kind to find them.
 *
 * Both halves of one plugin define the same id, so one row decides both, and the web app runs a web half only while its
 * host half runs.
 */

/** A package's `lemma` manifest: where its halves are, written relative to the package and read as absolute paths. */
export interface Manifest {
  readonly host?: string;
  readonly web?: string;
  readonly styles?: readonly string[];
  /** Folders of things other plugins read, by kind (`skills`, `profiles`): absolute, each inside the package. */
  readonly resources?: Readonly<Record<string, readonly string[]>>;
}

/** The manifest's fields; any other is said to be ignored, which catches a typo. */
const FIELDS = new Set(["host", "web", "styles", "resources"]);

/**
 * An entry of a plugin directory: a file of a half (`approvals.ts`, `notes.web.js`), a stylesheet, or a package, whose
 * manifest's paths are resolved against it. A path outside the package is none of its own, and is left out.
 */
export type Entry =
  | { readonly kind: "host" | "web" | "style"; readonly path: string; readonly name: string }
  | {
      readonly kind: "package";
      readonly path: string;
      readonly name: string;
      readonly manifest: Manifest;
      /** What its manifest names that is left out, and why: a path outside it, a file missing, a web half not JavaScript. */
      readonly problems: readonly string[];
    };

const WEB_FILE = /\.web\.(js|mjs|ts|mts)$/;
const isWeb = (name: string) => WEB_FILE.test(name);
/** The plugin a web half's file is named for: `notes.web.js` defines `notes`. */
export const webPluginOf = (name: string): string => name.replace(WEB_FILE, "");
const isHost = (name: string) => /\.(ts|js|mjs)$/.test(name) && !name.endsWith(".d.ts") && !isWeb(name);

/** A package's manifest, its paths absolute, and what it names that is left out; undefined with no `lemma` object. */
const manifestOf = async (dir: string): Promise<{ readonly manifest: Manifest; readonly problems: readonly string[] } | undefined> => {
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
  const { host, web, styles, resources } = lemma as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of Object.keys(lemma)) if (!FIELDS.has(field)) problems.push(`"lemma.${field}" is not a field Lemma reads (host, web, styles, resources)`);
  /** `file` as an absolute path when it is one of the package's own (a string, inside it, there). */
  const inside = async (field: string, file: unknown): Promise<string[]> => {
    if (file === undefined) return [];
    if (typeof file !== "string") return (problems.push(`"lemma.${field}" is not a path`), []);
    const path = join(dir, file);
    if (!isInside(dir, path)) return (problems.push(`"lemma.${field}" names ${file}, outside the package`), []);
    // A host half that is missing is the loader's to report: that plugin cannot run.
    if (field !== "host" && !(await stat(path).catch(() => undefined))?.isFile())
      return (problems.push(`"lemma.${field}" names ${file}, which is missing`), []);
    return [path];
  };
  const [hostPath] = await inside("host", host);
  let [webPath] = await inside("web", web);
  // The web app imports a web half as a module: JavaScript, or TypeScript whose types are stripped as it is served.
  if (webPath !== undefined && !/\.m?[jt]s$/.test(webPath)) {
    problems.push(`"lemma.web" names ${String(web)}: a web half is JavaScript or TypeScript (.js, .mjs, .ts, .mts), not JSX`);
    webPath = undefined;
  }
  if (styles !== undefined && !Array.isArray(styles)) problems.push(`"lemma.styles" is not a list of paths`);
  const stylePaths = Array.isArray(styles) ? (await Promise.all(styles.map((style) => inside("styles", style)))).flat() : undefined;
  /** A kind's folders, each one of the package's own and there. */
  const folders = async (kind: string, value: unknown): Promise<string[]> => {
    const listed = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
    if (listed === undefined) return (problems.push(`"lemma.resources.${kind}" is not a folder or a list of folders`), []);
    const found: string[] = [];
    for (const folder of listed) {
      if (typeof folder !== "string") {
        problems.push(`"lemma.resources.${kind}" lists something that is not a path`);
        continue;
      }
      const path = join(dir, folder);
      if (!isInside(dir, path)) problems.push(`"lemma.resources.${kind}" names ${folder}, outside the package`);
      else if (!(await stat(path).catch(() => undefined))?.isDirectory()) problems.push(`"lemma.resources.${kind}" names ${folder}, which is no folder`);
      else found.push(path);
    }
    return found;
  };
  if (resources !== undefined && !Predicate.isObject(resources)) problems.push(`"lemma.resources" is not an object of folders by kind`);
  const resourcePaths = Predicate.isObject(resources)
    ? Object.fromEntries(await Promise.all(Object.entries(resources).map(async ([kind, value]) => [kind, await folders(kind, value)] as const)))
    : undefined;
  return {
    manifest: {
      ...(hostPath === undefined ? {} : { host: hostPath }),
      ...(webPath === undefined ? {} : { web: webPath }),
      ...(stylePaths === undefined ? {} : { styles: stylePaths }),
      ...(resourcePaths === undefined ? {} : { resources: resourcePaths }),
    },
    problems,
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
      const found = await manifestOf(path);
      if (found !== undefined) entries.push({ kind: "package", path, name, ...found });
    } else if (info?.isFile()) {
      if (isWeb(name)) entries.push({ kind: "web", path, name });
      else if (isHost(name)) entries.push({ kind: "host", path, name });
      else if (name.endsWith(".css")) entries.push({ kind: "style", path, name });
    }
  }
  return entries;
}
