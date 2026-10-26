import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionPoints, walk } from "./sources.ts";

// Every registry, hook, event, slot, and part a domain's contract declares needs a user. A user adds an item to it,
// handles it, or observes it. Reading a registry or slot, running a hook, publishing an event, and drawing a part are
// its owner's work, so they do not count. Users are bundled plugins, examples, and contracts' own code (a contract that
// streams an event to clients observes it), outside tests. A capability is left out: its provider is its user.
// This fails on a point with no user: use it in a plugin or an example, or remove it.
// It also reports how many points the examples show, as they are the reference a plugin author reads. `--list` names
// the examples that import each point, and the points none does. `pnpm check` runs it.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The calls that take a point first and are its owner's: any other call that does (`add`, `on`, `observe`, `stream`) uses it. */
const OWNER_CALLS = new Set(["list", "first", "get", "owner", "fail", "items", "changes", "invoke", "publish", "partView"]);

/** Whether a file is a plugin's or a contract's own code: not a test, nor in a `tests` or hidden folder. */
const isSource = (path: string) => /\.(ts|tsx|js|mjs)$/.test(path) && !/\.test\./.test(path) && !/(^|\/)(tests|\.[^/]*)\//.test(relative(root, path));
/** A file's code: its strings kept, its comments gone. */
const code = (file: string) =>
  readFileSync(file, "utf8").replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_, string) => string ?? "",
  );
const packageName = (dir: string): string => (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { readonly name: string }).name;
const folders = (dir: string): string[] =>
  readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isDirectory() && existsSync(join(path, "package.json")));

const points = extensionPoints(root).map((point) => ({
  ...point,
  id: `${point.domain}.${point.name}`,
  pkg: packageName(join(root, "domains", point.domain, "contract")),
}));

// Users: every call in a domain's or an example's code that hands a point to anything but its owner's calls.
const used = new Set<string>();
for (const file of [join(root, "domains"), join(root, "examples")].flatMap(walk).filter(isSource)) {
  for (const [, call, name] of code(file).matchAll(/([\w$]+)\(\s*([A-Z]\w*)\b/g)) if (!OWNER_CALLS.has(call!)) used.add(name!);
}
const plugged = points.filter((point) => point.kind !== "capability");
const withUser = plugged.filter((point) => used.has(point.name));
const unused = plugged.filter((point) => !used.has(point.name));

/**
 * The names an example imports from each `@lemma/` package (a subpath counts as its package), and under `*` those a
 * web half written without a build takes from its `contracts` argument, which names no package.
 */
const importsOf = (dir: string): Map<string, Set<string>> => {
  const found = new Map<string, Set<string>>();
  for (const file of walk(dir).filter(isSource)) {
    const text = readFileSync(file, "utf8");
    const imported = [...text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(@lemma\/[\w-]+)(?:\/[^"]*)?"/g)].map(
      ([, names, from]) => [names!, from!] as const,
    );
    const given = [...text.matchAll(/\bcontracts:\s*\{([^}]*)\}/g)].map(([, names]) => [names!, "*"] as const);
    for (const [names, from] of [...imported, ...given]) {
      const set = found.get(from) ?? found.set(from, new Set()).get(from)!;
      for (const part of names.split(",")) {
        const name = part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+|:/)[0]
          ?.trim();
        if (name) set.add(name);
      }
    }
  }
  return found;
};
const examples = folders(join(root, "examples")).map((dir) => ({ name: relative(root, dir), imports: importsOf(dir) }));
const rows = points.map((point) => ({
  ...point,
  examples: examples
    .filter((example) => example.imports.get(point.pkg)?.has(point.name) || example.imports.get("*")?.has(point.name))
    .map((example) => example.name),
}));
const shown = rows.filter((row) => row.examples.length > 0);

console.log(
  `extension points with a user: ${withUser.length} of ${plugged.length} (registries, hooks, events, slots, parts); examples show ${shown.length} of ${rows.length}`,
);
if (process.argv.includes("--list")) {
  for (const row of shown) console.log(`  ${row.id}: ${row.examples.join(", ")}`);
  console.log(
    `  no example yet: ${rows
      .filter((row) => row.examples.length === 0)
      .map((row) => row.id)
      .join(", ")}`,
  );
}
if (unused.length > 0) {
  const script = relative(root, fileURLToPath(import.meta.url));
  console.error(`Extension points with no user (${script}): ${unused.map((point) => point.id).join(", ")}. Use each in a plugin or an example, or remove it.`);
  process.exit(1);
}
