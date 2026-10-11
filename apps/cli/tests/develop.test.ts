import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "../src/cli.ts";
import { invoke } from "./invoke.ts";

describe("writing a plugin", () => {
  let dir: string;
  let folder: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lemma-develop-"));
    folder = join(dir, "acme.greet");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("plugins new makes a folder plugin to start from: both halves, a test, and types against this checkout", async () => {
    const made = await invoke(["plugins", "new", "acme.greet", "--path", folder, "--json"], dir, dir);
    expect(made.code).toBe(ExitCode.ok);
    expect(JSON.parse(made.out).files).toEqual(["package.json", "plugin.ts", "web.js", "tests/plugin.test.ts", "tsconfig.json", "README.md"]);
    expect(JSON.parse(await readFile(join(folder, "package.json"), "utf8")).lemma).toEqual({ host: "./plugin.ts", web: "./web.js" });
    const tsconfig = JSON.parse(await readFile(join(folder, "tsconfig.json"), "utf8"));
    expect(tsconfig.compilerOptions.paths["@lemma/core/plain"][0]).toMatch(/packages\/core\/src\/plain\/index\.ts$/);
    // Not over what is there, and not with an id that is none.
    expect((await invoke(["plugins", "new", "acme.greet", "--path", folder], dir, dir)).err).toMatch(/is not empty/);
    expect((await invoke(["plugins", "new", "Acme Greet"], dir, dir)).code).toBe(ExitCode.usage);
  });

  test("plugins test runs its tests in real turns, importing what the host supplies", async () => {
    const tested = await invoke(["plugins", "test", folder, "--json"], dir, dir);
    expect(JSON.parse(tested.out)).toMatchObject({ exit: 0 });
  }, 30_000);

  test("plugins check starts a host with it, and says what it does, or why it cannot run", async () => {
    const checked = await invoke(["plugins", "check", folder, "--json"], dir, dir);
    expect(checked.code).toBe(ExitCode.ok);
    expect(JSON.parse(checked.out)).toMatchObject({
      plugins: [{ id: "acme.greet", state: "active", adds: ["lemma/tools: acme_greet"] }],
      web: "./web.js",
      problems: [],
    });
    const plugin = join(folder, "plugin.ts");
    await writeFile(
      plugin,
      (await readFile(plugin, "utf8")).replace("setup: (_, { add }) => {", 'setup: (_, { add }) => {\n    throw new Error("setup went wrong");'),
    );
    const broken = await invoke(["plugins", "check", folder], dir, dir);
    expect(broken.code).toBe(ExitCode.failed);
    expect(broken.out).toMatch(/did not start with it[\s\S]*setup went wrong/);
    expect(broken.out).not.toMatch(/--safe/);
  }, 60_000);
});
