import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The examples are the reference a plugin author reads: each extension point a domain's contract declares should have
// one that uses it, or failing that a bundled plugin, which is written the same way. This lists how far they reach,
// and the points neither uses, which nothing shows how to meet. It reports, and fails nothing: `pnpm check` runs it.
// `--list` names, for each point, the examples that use it, and the points no example does.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A contract's extension points: as `scripts/size.ts` counts them. */
const extensionPoint =
  /^export (?:const|class) ([A-Z]\w*)\b[^\n]*?(?:Registry\.make|Hook\.make|Event\.make|defineSlot|definePart|extends Context\.Service)\b/gm;

const sources = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((name) => {
        if (name === "node_modules" || name === "tests" || name === "dist" || name.startsWith(".")) return [];
        const path = join(dir, name);
        return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
      })
    : [];
const packageName = (dir: string): string => (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { readonly name: string }).name;
const folders = (dir: string): string[] =>
  readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isDirectory() && existsSync(join(path, "package.json")));

/** Every point, by the package that declares it: `@lemma/agent` and `AgentRequestHook`. */
const points: { readonly name: string; readonly pkg: string; readonly domain: string }[] = [];
for (const domain of readdirSync(join(root, "domains"))) {
  const contract = join(root, "domains", domain, "contract");
  if (!existsSync(join(contract, "package.json"))) continue;
  const pkg = packageName(contract);
  for (const file of sources(join(contract, "src"))) {
    for (const [, name] of readFileSync(file, "utf8").matchAll(extensionPoint)) {
      // A service declared as a class and its tag share a name: one point.
      if (!points.some((point) => point.pkg === pkg && point.name === name)) points.push({ name: name!, pkg, domain });
    }
  }
}

/**
 * The names a plugin's code imports from each `@lemma/` package (a subpath counts as its package), and under `*` those
 * a web half written without a build takes from its `contracts` argument, which names no package.
 */
const importsOf = (dir: string): Map<string, Set<string>> => {
  const found = new Map<string, Set<string>>();
  for (const file of sources(dir)) {
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
const bundled = readdirSync(join(root, "domains")).flatMap((domain) =>
  folders(join(root, "domains", domain))
    .filter((dir) => !dir.endsWith("/contract"))
    .map((dir) => ({ name: relative(root, dir), imports: importsOf(dir) })),
);
const users = (plugins: typeof examples, point: (typeof points)[number]) =>
  plugins.filter((plugin) => plugin.imports.get(point.pkg)?.has(point.name) || plugin.imports.get("*")?.has(point.name)).map((plugin) => plugin.name);

const rows = points.map((point) => ({ ...point, examples: users(examples, point), bundled: users(bundled, point) }));
const byExample = rows.filter((row) => row.examples.length > 0);
const byNeither = rows.filter((row) => row.examples.length === 0 && row.bundled.length === 0);
console.log(
  `examples cover ${byExample.length} of ${rows.length} extension points; bundled plugins ${rows.filter((row) => row.bundled.length > 0).length}; neither ${byNeither.length}`,
);
if (byNeither.length > 0) console.log(`  used by no example or bundled plugin: ${byNeither.map((row) => `${row.domain}.${row.name}`).join(", ")}`);
if (process.argv.includes("--list")) {
  for (const row of byExample) console.log(`  ${row.domain}.${row.name}: ${row.examples.join(", ")}`);
  console.log(
    `  no example yet: ${rows
      .filter((row) => row.examples.length === 0)
      .map((row) => `${row.domain}.${row.name}`)
      .join(", ")}`,
  );
}
