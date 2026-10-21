import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The runtime is what no plugin can replace (AGENTS.md): the kernel, the runtime's contracts, the host and web
// runtimes, the planner, and the client. It stays small, so the parts that are plugins stay the ones that matter. Its
// size is held to a budget here, in lines of source, raised only by editing the budget in the change that needs it:
// growth is then a decision someone made where it shows, not drift. `pnpm check` runs this.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Lines of `src` per runtime package, at most. */
const BUDGET: Readonly<Record<string, number>> = {
  "packages/core": 5_600,
  "packages/contracts": 2_600,
  // Raised from 2,800 for renamed plugins: a row under a former id moves to the plugin's as it is written, the host's
  // own, beneath any plugin.
  "packages/host": 2_810,
  "packages/composition": 850,
  "packages/web": 2_000,
  "packages/client": 800,
};

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
const lines = (file: string) => readFileSync(file, "utf8").split("\n").length - 1;

let over = false;
let total = 0;
let budgeted = 0;
for (const [pkg, budget] of Object.entries(BUDGET)) {
  const count = sources(join(root, pkg, "src")).reduce((sum, file) => sum + lines(file), 0);
  total += count;
  budgeted += budget;
  const verdict = count > budget ? "OVER" : "ok";
  if (count > budget) over = true;
  console.log(`${pkg.padEnd(22)} ${String(count).padStart(6)} / ${String(budget).padStart(6)} lines  ${verdict}`);
}
console.log(`${"runtime".padEnd(22)} ${String(total).padStart(6)} / ${String(budgeted).padStart(6)} lines`);

// What a plugin author meets, per domain: the extension points its contract declares (as check-boundaries finds them).
const extensionPoint =
  /^export (?:const|class) ([A-Z]\w*)\b[^\n]*?(?:Registry\.make|Hook\.make|Event\.make|defineSlot|definePart|extends Context\.Service)\b/gm;
const domains = join(root, "domains");
const points = readdirSync(domains)
  .filter((domain) => statSync(join(domains, domain)).isDirectory())
  .map((domain) => {
    const contract = join(domains, domain, "contract", "src");
    let count = 0;
    try {
      for (const file of sources(contract)) count += [...readFileSync(file, "utf8").matchAll(extensionPoint)].length;
    } catch {
      // A domain with no contract (transport) declares none.
    }
    return [domain, count] as const;
  });
console.log(`extension points: ${points.reduce((sum, [, count]) => sum + count, 0)} (${points.map(([domain, count]) => `${domain} ${count}`).join(", ")})`);

if (over) {
  console.error(
    `The runtime is over its budget (${relative(root, fileURLToPath(import.meta.url))}): move what grew into a plugin, or raise the budget in this change and say why.`,
  );
  process.exit(1);
}
