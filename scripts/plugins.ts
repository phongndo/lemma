import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const domains = fileURLToPath(new URL("../domains", import.meta.url));

/** A plugin in `domains/`: the files of its halves, as its package's `lemma` manifest lists them. */
export interface DomainPlugin {
  readonly dir: string;
  readonly host?: string;
  readonly web?: string;
}

/**
 * The plugins in `domains/`, by the id their folder names (`domains/tools/bash` is `tools.bash`). A bundled plugin's
 * package says where its halves are as a user's folder plugin does, in its package.json's `lemma` manifest; the bundled
 * lists (packages/host/src/bundled.ts, apps/web/src/bundled.ts) hold each half, and their tests check them against
 * this. A domain's `contract` is no plugin. Throws for a plugin package without a manifest, or a half that is missing.
 */
export function domainPlugins(): ReadonlyMap<string, DomainPlugin> {
  const plugins = new Map<string, DomainPlugin>();
  // Folders only: a stray file in domains/ (a README, `.DS_Store`) is no domain, nor one in a domain's folder a plugin.
  const folders = (dir: string) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  for (const domain of folders(domains)) {
    for (const name of folders(join(domains, domain))) {
      const dir = join(domains, domain, name);
      if (name === "contract" || !existsSync(join(dir, "package.json"))) continue;
      const { lemma } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { lemma?: { host?: string; web?: string } };
      if (lemma?.host === undefined && lemma?.web === undefined) throw new Error(`${dir}/package.json: no "lemma" manifest naming a host or web half`);
      const half = (file: string | undefined) => {
        if (file === undefined) return {};
        const path = resolve(dir, file);
        if (!existsSync(path)) throw new Error(`${dir}/package.json: its "lemma" manifest names ${file}, which is missing`);
        return { path };
      };
      const host = half(lemma.host).path;
      const web = half(lemma.web).path;
      plugins.set(`${domain}.${name}`, { dir, ...(host === undefined ? {} : { host }), ...(web === undefined ? {} : { web }) });
    }
  }
  return plugins;
}
