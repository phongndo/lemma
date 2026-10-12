import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { kindOf } from "@lemma/contracts/fs";
import { resolveToCwd } from "@lemma/tools/files";

/** Where a call searches: the directory fff indexes, and what narrows the search inside it. */
export interface Scope {
  /** The directory indexed, symlinks resolved: the session's, or the one a path outside it names. */
  readonly root: string;
  /** fff constraint tokens relative to `root`: the path's, then the excludes. */
  readonly constraints: readonly string[];
  /** How a result's path (relative to `root`) is shown: relative to the session's directory, or absolute outside it. */
  readonly display: (relativePath: string) => string;
}

const GLOB = /[*?[{]/;
const EXTENSION = /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/;
const posix = (path: string) => (sep === "/" ? path : path.split(sep).join("/"));
const outside = (rel: string) => rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
const isRoot = (dir: string) => dirname(dir) === dir;

/**
 * A path matched literally: fff's glob characters escaped, and whitespace, which would split the query into words,
 * matched by `?`.
 */
const literal = (path: string) => path.replace(/[\\*?[\]{}!]/g, "\\$&").replace(/\s/g, "?");

/**
 * An existing directory or file, matched exactly. fff reads `src/` as a folder named `src` anywhere, so a directory
 * is the glob `src/**`. A glob needs a wildcard to be read as one, and fff matches one only when it has a `/`, so a
 * file below the top level ends in a one-character class (`src/a.t[s]`), and a top-level one is matched at any depth,
 * so its namesakes below match too.
 */
const exact = (rel: string, kind: "file" | "directory"): string | undefined => {
  if (rel === "") return undefined;
  if (kind === "directory") return `${literal(rel)}/**`;
  if (rel.includes("/") && /[A-Za-z0-9._-]$/.test(rel)) return `${literal(rel.slice(0, -1))}[${rel.at(-1)}]`;
  return `**/${literal(rel)}`;
};

/**
 * A path that names nothing on disk, or a glob, as fff reads it (pi-fff's rules): a glob as it is, a name with an
 * extension as a file anywhere (`main.rs`), and anything else as a folder anywhere (`lib` is `lib/`).
 */
export const loose = (path: string): string | undefined => {
  const value = path.trim().replace(/^\.\//, "");
  if (value === "" || value === "." || value === "**" || value === "**/" || value === "**/*") return undefined;
  if (value.endsWith("/") || GLOB.test(value) || EXTENSION.test(value.split("/").pop() ?? "")) return value;
  return `${value}/`;
};

/** `exclude` as fff's negated constraints: comma- or space-separated, each read as `loose` reads a path, a leading `!` optional. */
const excludes = (exclude: string | readonly string[] | undefined, root: string): string[] =>
  (typeof exclude === "string" ? [exclude] : (exclude ?? []))
    .flatMap((item) => item.split(/[,\s]+/))
    .map((item) => item.replace(/^!/, ""))
    .flatMap((item) => {
      if (!isAbsolute(item)) return [item];
      const rel = relative(root, item);
      return outside(rel) ? [] : [posix(rel)];
    })
    .flatMap((item) => {
      const constraint = loose(item);
      return constraint === undefined ? [] : [`!${constraint}`];
    });

const real = (path: string) => realpath(path).catch(() => path);

/**
 * Resolves a call's `path` and `exclude` against the session's directory. Inside it, the session's directory is
 * indexed; a path outside it (absolute, `~/…`, `../…`) indexes the deepest directory of it that exists. The home
 * directory and `/` are never indexed: fff refuses them, and a scan of either would take long.
 */
export async function scopeOf(path: string | undefined, exclude: string | readonly string[] | undefined, cwd: string): Promise<Scope> {
  if ((await kindOf(cwd)) !== "directory") throw new Error(`The working directory ${cwd} does not exist`);
  const here = await realpath(cwd);
  const home = await real(homedir());
  const target = path === undefined || path.trim() === "" ? here : resolveToCwd(path.trim(), here);

  // A path on disk is itself, glob characters and all (`app/[id]`). Otherwise, before its first glob segment it is a
  // place on disk, and the deepest part of that which exists is where it starts.
  let existing = target;
  let kind = await kindOf(existing);
  const segments = target.split(sep);
  const firstGlob = kind === undefined ? segments.findIndex((segment) => GLOB.test(segment)) : -1;
  if (firstGlob !== -1) {
    existing = segments.slice(0, firstGlob).join(sep) || sep;
    kind = await kindOf(existing);
  }
  while (kind === undefined && !isRoot(existing)) {
    existing = dirname(existing);
    kind = await kindOf(existing);
  }
  const tail = posix(relative(existing, target));
  const found = await real(existing);
  const isDirectory = kind === "directory";

  const fromHere = !outside(relative(here, found)) && here !== home && !isRoot(here);
  const root = fromHere ? here : isDirectory ? found : dirname(found);
  if (root === home || isRoot(root)) {
    if (tail !== "" && firstGlob === -1) throw new Error(`No such file or directory: ${path}`);
    throw new Error(`Searching ${path ?? cwd} would index all of ${root === home ? "the home directory" : root}: give a path inside a project, or use bash`);
  }

  const at = posix(relative(root, found));
  const constraint = tail === "" ? exact(at, isDirectory ? "directory" : "file") : loose([at, tail].filter((part) => part !== "").join("/"));
  return {
    root,
    constraints: [...(constraint === undefined ? [] : [constraint]), ...excludes(exclude, root)],
    display: (relativePath) => {
      const absolute = join(root, relativePath);
      const rel = relative(here, absolute);
      return outside(rel) ? absolute : posix(rel);
    },
  };
}
