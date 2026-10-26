import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkHostPackages } from "../src/links.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "lemma-links-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("linking what plugin files import", () => {
  it("links Effect, the kernel, the runtime's contracts, and each domain's contract, to the packages the host runs, and no plugin", async () => {
    const linked = await linkHostPackages(home);
    expect(linked).toEqual(expect.arrayContaining(["effect", "@lemma/core", "@lemma/contracts", "@lemma/agent", "@lemma/tools", "@lemma/sessions"]));
    expect(linked.some((name) => name.includes("-"))).toBe(false);
    expect(await realpath(join(home, "node_modules", "@lemma", "tools"))).toBe(
      await realpath(new URL("../node_modules/@lemma/tools", import.meta.url).pathname),
    );
    // Done once: the next start links nothing anew.
    expect(await linkHostPackages(home)).toEqual([]);
  });

  it("replaces a link that points elsewhere, and leaves the user's own directory alone", async () => {
    await mkdir(join(home, "node_modules", "@lemma"), { recursive: true });
    await symlink(home, join(home, "node_modules", "@lemma", "agent"));
    await mkdir(join(home, "node_modules", "@lemma", "tools"));
    await writeFile(join(home, "node_modules", "@lemma", "tools", "mine.txt"), "mine");
    const linked = await linkHostPackages(home);
    expect(linked).toContain("@lemma/agent");
    expect(await readlink(join(home, "node_modules", "@lemma", "agent"))).not.toBe(home);
    expect(linked).not.toContain("@lemma/tools");
    expect((await lstat(join(home, "node_modules", "@lemma", "tools"))).isDirectory()).toBe(true);
  });

  it("lets a plugin file in the home import a domain's contract with nothing installed and no hook", async () => {
    await linkHostPackages(home);
    await mkdir(join(home, "plugins"), { recursive: true });
    const file = join(home, "plugins", "probe.mjs");
    await writeFile(file, 'import { TOOLS_CONTRACT } from "@lemma/tools";\nconsole.log(TOOLS_CONTRACT);\n');
    const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=lemma-source", file]);
    expect(stdout.trim()).toBe("lemma/tools@2");
  });
});
