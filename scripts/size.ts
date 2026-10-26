import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionPoints, walk } from "./sources.ts";

// The runtime is what no plugin can replace (AGENTS.md): the kernel, the runtime's contracts, the host and web
// runtimes, the planner, and the client. It stays small, so the parts that are plugins stay the ones that matter. Its
// size is held to a budget here, in lines of source, raised only by editing the budget in the change that needs it:
// growth is then a decision someone made where it shows, not drift. `pnpm check` runs this.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Lines of `src` per runtime package, at most: TypeScript and JavaScript alike. */
const BUDGET: Readonly<Record<string, number>> = {
  "packages/core": 5_600,
  // Raised from 2,600 for profiles: which home a host runs for, and the port it keeps, are decided before any plugin
  // runs (`@lemma/contracts/profiles`, `Paths.root` and `Paths.profile`), so they cannot be a plugin's. And for how every
  // channel answers (channels.ts): a stream's elements sent a chunk at a time, and a request's errors made only when it
  // fails, which no plugin could do for the others. Raised from 2,700 for the frontmatter parser (frontmatter.ts), one
  // for the plugins that read Markdown files with fields (skills, modes), which kept two that read them differently.
  "packages/contracts": 2_750,
  // Raised from 2,800 for profiles: a host refuses a profile never made, and keeps its port, before any plugin runs.
  // Its launch is JavaScript (start.mjs, launch.mjs: the compile cache, Effect's bundle, its Node.js flags), which
  // loads before the compile cache is on, and is counted with the rest. Raised from 3,000 to keep an installed Lemma and
  // a checkout apart (paths.ts: each one's home and port, the other's home refused, what its tools are told of its own),
  // which the host, the CLI, and the desktop app decide before any plugin runs.
  "packages/host": 3_050,
  "packages/composition": 850,
  "packages/web": 2_000,
  "packages/client": 800,
};

const lines = (file: string) => readFileSync(file, "utf8").split("\n").length - 1;

let over = false;
let total = 0;
let budgeted = 0;
for (const [pkg, budget] of Object.entries(BUDGET)) {
  const count = walk(join(root, pkg, "src"))
    .filter((file) => /\.(ts|tsx|mts|js|mjs|cjs)$/.test(file))
    .reduce((sum, file) => sum + lines(file), 0);
  total += count;
  budgeted += budget;
  const verdict = count > budget ? "OVER" : "ok";
  if (count > budget) over = true;
  console.log(`${pkg.padEnd(22)} ${String(count).padStart(6)} / ${String(budget).padStart(6)} lines  ${verdict}`);
}
console.log(`${"runtime".padEnd(22)} ${String(total).padStart(6)} / ${String(budgeted).padStart(6)} lines`);

// What a plugin author meets, per domain: the extension points its contract declares.
const points = extensionPoints(root);
const domains = readdirSync(join(root, "domains"))
  .filter((domain) => statSync(join(root, "domains", domain)).isDirectory())
  .map((domain) => [domain, points.filter((point) => point.domain === domain).length] as const);
console.log(`extension points: ${points.length} (${domains.map(([domain, count]) => `${domain} ${count}`).join(", ")})`);

if (over) {
  console.error(
    `The runtime is over its budget (${relative(root, fileURLToPath(import.meta.url))}): move what grew into a plugin, or raise the budget in this change and say why.`,
  );
  process.exit(1);
}
