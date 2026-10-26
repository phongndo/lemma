import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { domainPlugins } from "../../../scripts/plugins.ts";
import { contractModules } from "../src/ui/contracts.ts";

const domains = fileURLToPath(new URL("../../../domains", import.meta.url));

/**
 * Each domain's web contract, by the module it is imported as: its `./web` entry when its package declares one (a host
 * domain's, `@lemma/llm/web`), or the whole contract when the domain has no host half (`@lemma/frame`).
 */
const webContracts = (): Set<string> => {
  const plugins = [...domainPlugins()];
  const entries = new Set<string>();
  for (const domain of readdirSync(domains, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const manifest = join(domains, domain.name, "contract", "package.json");
    if (!existsSync(manifest)) continue;
    const { name, exports } = JSON.parse(readFileSync(manifest, "utf8")) as { name: string; exports?: Record<string, string> };
    if (exports?.["./web"] !== undefined) entries.add(`${name}/web`);
    else if (!plugins.some(([id, plugin]) => id.startsWith(`${domain.name}.`) && plugin.host !== undefined)) entries.add(name);
  }
  return entries;
};

/** The packages a module imports, and those of the files it imports in turn, within `dir`. */
const importsOf = (entry: string, dir: string): Set<string> => {
  const found = new Set<string>();
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file) || !file.startsWith(dir) || !existsSync(file)) return;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      if (specifier!.startsWith(".")) visit(resolve(dirname(file), specifier!.replace(/\?.*$/, "")));
      else found.add(specifier!);
    }
  };
  visit(entry);
  return found;
};

describe("the api a web half receives", () => {
  it("offers every domain's web contract the bundled web halves import, as the domains' manifests name them", () => {
    const web = webContracts();
    const imported = new Set<string>();
    for (const [, plugin] of domainPlugins()) {
      if (plugin.web === undefined) continue;
      for (const specifier of importsOf(plugin.web, plugin.dir)) if (web.has(specifier)) imported.add(specifier);
    }
    // What they import today, so a reading that finds nothing cannot pass.
    expect([...imported]).toEqual(expect.arrayContaining(["@lemma/frame", "@lemma/settings", "@lemma/llm/web", "@lemma/threads"]));
    const offered = Object.keys(contractModules);
    expect([...imported].filter((module) => !offered.includes(module)).sort(), "contracts the bundled plugins import that a web half is not given").toEqual([]);
  });
});
