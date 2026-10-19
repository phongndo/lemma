import { lstat, mkdir, readFile, readlink, realpath, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The host package's own directory, whose `node_modules` holds what it was installed with. */
const HOST = dirname(dirname(fileURLToPath(import.meta.url)));

/** What a plugin file may import from the host: Effect, the kernel, the runtime's contracts, and each domain's contract. */
const forPlugins = (name: string) => name === "effect" || /^@lemma\/[a-z]+$/.test(name);

/**
 * Links the packages a plugin file imports (`forPlugins`, as the host has them) into `<home>/node_modules`, so a
 * file in `<home>/plugins` resolves them as any module resolves its packages, and an editor or a type checker finds
 * their types there, with nothing installed. Each link points at the very package the host runs, so a plugin shares
 * its module instances. A link that points elsewhere (the checkout moved) is replaced; anything there that is not a
 * link is the user's own, and left as it is. Returns the names linked anew. The host's fallback for bare imports
 * (`loadLocalPlugins`) still serves a project's plugins, which resolve upward through the project instead.
 */
export async function linkHostPackages(home: string): Promise<readonly string[]> {
  const manifest = JSON.parse(await readFile(join(HOST, "package.json"), "utf8")) as { readonly dependencies?: Readonly<Record<string, string>> };
  const linked: string[] = [];
  for (const name of Object.keys(manifest.dependencies ?? {}).filter(forPlugins)) {
    const target = await realpath(join(HOST, "node_modules", name)).catch(() => undefined);
    if (target === undefined) continue;
    const link = join(home, "node_modules", name);
    const current = await lstat(link).catch(() => undefined);
    if (current !== undefined && !current.isSymbolicLink()) continue;
    if (current !== undefined) {
      if ((await readlink(link).catch(() => undefined)) === target) continue;
      await unlink(link);
    }
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    linked.push(name);
  }
  return linked;
}
