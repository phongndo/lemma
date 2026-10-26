import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// What the repository's checks scan (check-boundaries.ts, size.ts, examples-coverage.ts): its files, and the extension
// points the domains' contracts declare in them.

/** Every file under `dir`, but those in `node_modules` and `dist`. */
export const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === "node_modules" || name === "dist" ? [] : walk(path)) : [path];
  });

/** What a declaration makes a point, by what the declaration calls or extends. */
const KINDS = {
  "Registry.make": "registry",
  "Hook.make": "hook",
  "Event.make": "event",
  defineSlot: "slot",
  definePart: "part",
  "extends Context.Service": "capability",
} as const;

export interface ExtensionPoint {
  /** The domain whose contract declares it: `agent`. */
  readonly domain: string;
  /** Its name, as the contract exports it: `AgentRequestHook`. */
  readonly name: string;
  readonly kind: (typeof KINDS)[keyof typeof KINDS];
  /** The file that declares it. */
  readonly file: string;
}

/** A point's declaration in a contract: its name, then what makes it a point. */
const declaration = /^export (?:const|class) ([A-Z]\w*)\b[^\n]*?(Registry\.make|Hook\.make|Event\.make|defineSlot|definePart|extends Context\.Service)\b/gm;

/**
 * The extension points each domain's contract declares (`domains/<domain>/contract/src`), in the order of the domains'
 * folders and their files. A capability declared as a class and its tag share a name: it is one point.
 */
export const extensionPoints = (root: string): ExtensionPoint[] => {
  const points: ExtensionPoint[] = [];
  for (const domain of readdirSync(join(root, "domains")).sort()) {
    const contract = join(root, "domains", domain, "contract", "src");
    if (!existsSync(contract)) continue;
    for (const file of walk(contract).filter((path) => /\.(ts|tsx)$/.test(path))) {
      for (const [, name, how] of readFileSync(file, "utf8").matchAll(declaration)) {
        if (!points.some((point) => point.domain === domain && point.name === name))
          points.push({ domain, name: name!, kind: KINDS[how as keyof typeof KINDS], file });
      }
    }
  }
  return points;
};
