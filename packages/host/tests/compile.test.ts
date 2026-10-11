import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SHARED_MODULES } from "@lemma/contracts";
import { compileWebHalf, isCompiled } from "../src/compile.ts";
import { resolvePaths } from "../src/paths.ts";
import { listWebFiles, userPluginsDir } from "../src/web.ts";

/** Runs a compiled module with `modules` as the page's, and returns its default export. */
const run = async (code: string, modules: Record<string, unknown>) => {
  (globalThis as Record<symbol, unknown>)[Symbol.for(SHARED_MODULES)] = modules;
  try {
    return ((await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as { default: unknown }).default;
  } finally {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(SHARED_MODULES)];
  }
};

describe("compileWebHalf", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lemma-compile-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("compiles TypeScript to one module: its own files bundled, the page's modules read from the page", async () => {
    const folder = join(dir, "notes");
    await mkdir(folder);
    // A package of ES modules, so esbuild reads a default import as Node does: the page's export, not a namespace.
    await writeFile(join(folder, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(folder, "label.ts"), `export const label = (n: number): string => \`\${n} notes\`;\n`);
    await writeFile(join(folder, "notes.css"), ".notes { color: var(--text); }\n");
    await writeFile(join(folder, "host.ts"), `export interface Note { readonly text: string }\nthrow new Error("the host half ran");\n`);
    await writeFile(
      join(folder, "web.ts"),
      [
        `import html from "solid-js/html";`,
        `import { createSignal } from "solid-js";`,
        `import { defineWebPlugin, Slots } from "@lemma/web";`,
        `import type { Note } from "./host.ts";`,
        `import { label } from "./label.ts";`,
        `import styles from "./notes.css";`,
        `const notes: Note[] = [];`,
        `export default defineWebPlugin({ id: "notes", styles, requires: { slots: Slots }, view: html, title: label(notes.length), signal: createSignal });`,
      ].join("\n"),
    );
    const compiled = await compileWebHalf(join(folder, "web.ts"));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    // What the half is made from: not the host half it takes a type from.
    expect([...compiled.inputs.keys()].sort()).toEqual([join(folder, "label.ts"), join(folder, "notes.css"), join(folder, "web.ts")]);
    expect(compiled.code).not.toMatch(/^import /m);
    const html = () => "html";
    const createSignal = () => "signal";
    const plugin = await run(compiled.code, {
      "solid-js/html": html,
      "solid-js": { createSignal },
      "@lemma/web": { defineWebPlugin: (definition: unknown) => definition, Slots: "slots" },
    });
    expect(plugin).toEqual({
      id: "notes",
      styles: ".notes { color: var(--text); }\n",
      requires: { slots: "slots" },
      view: html,
      title: "0 notes",
      signal: createSignal,
    });
    // A module the page does not share fails as it loads, saying so.
    // (Its text changed, as Node keeps a module by its URL.)
    await expect(run(`${compiled.code}\n`, { "solid-js": {}, "@lemma/web": {} })).rejects.toThrow("the web app does not share solid-js/html");
  });

  test("compiles Solid's JSX to the page's solid-js/web, and again only when one of its files changes", async () => {
    const folder = join(dir, "board");
    await mkdir(folder);
    await writeFile(join(folder, "count.tsx"), `export const Count = (props: { n: number }) => <b class="count">{props.n}</b>;\n`);
    await writeFile(join(folder, "web.tsx"), `import { Count } from "./count.tsx";\nexport default () => <Count n={1} />;\n`);
    // Written a while ago: one saved as it compiles is compiled again next time, in case it was read before the save.
    const earlier = new Date(Date.now() - 60_000);
    for (const name of ["count.tsx", "web.tsx"]) await utimes(join(folder, name), earlier, earlier);
    const first = await compileWebHalf(join(folder, "web.tsx"));
    expect(first.ok).toBe(true);
    expect(first.code).toContain('shared["solid-js/web"]');
    expect(first.code).toMatch(/template\)\(`<b class=count>`\)/);
    expect(await compileWebHalf(join(folder, "web.tsx"))).toBe(first);
    // An edit to a file it imports, not to itself, compiles it again.
    await writeFile(join(folder, "count.tsx"), `export const Count = (props: { n: number }) => <i>{props.n}</i>;\n`);
    const second = await compileWebHalf(join(folder, "web.tsx"));
    expect(second.hash).not.toBe(first.hash);
    expect(second.code).toMatch(/template\)\(`<i>`\)/);
  });

  test("one that does not compile is a module that throws what went wrong, where", async () => {
    const folder = join(dir, "broken");
    await mkdir(folder);
    await writeFile(join(folder, "web.tsx"), `export default () => <span>open</div>;\n`);
    const broken = await compileWebHalf(join(folder, "web.tsx"));
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.error).toMatch(/^web\.tsx:1:\d+: Unexpected closing "div" tag/);
    await expect(run(broken.code, {})).rejects.toThrow(/^cannot compile:\nweb\.tsx:1:/);
    // Effect is not the page's to share: the half is told what to use instead.
    await writeFile(join(folder, "config.ts"), `import { Schema } from "effect";\nexport default Schema.String;\n`);
    const effect = await compileWebHalf(join(folder, "config.ts"));
    expect(effect.ok ? "" : effect.error).toMatch(/config\.ts:1:\d+: a web half cannot import effect: declare its config with WebSchema/);
  });

  test("compiles TypeScript and JSX, and serves JavaScript as it is", () => {
    expect(["a.web.ts", "a.web.tsx", "web.jsx", "a.web.js", "a.web.mjs", "a.d.ts"].map(isCompiled)).toEqual([true, true, true, false, false, false]);
  });

  test("listWebFiles lists a half in TypeScript as what it compiled to, by its hash, and says when it does not compile", async () => {
    const paths = resolvePaths({ env: { LEMMA_HOME: join(dir, "home") }, cwd: dir });
    await mkdir(userPluginsDir(paths), { recursive: true });
    await writeFile(join(userPluginsDir(paths), "good.web.tsx"), `export default () => <p>good</p>;\n`);
    await writeFile(join(userPluginsDir(paths), "bad.web.ts"), `export default = ;\n`);
    const { files, problems } = await Effect.runPromise(listWebFiles(paths, false));
    expect(files.map((file) => [file.name, file.compiled])).toEqual([
      ["bad.web.ts", join(paths.home, "cache", "web", "user", "bad.web.ts.js")],
      ["good.web.tsx", join(paths.home, "cache", "web", "user", "good.web.tsx.js")],
    ]);
    expect(files[1]!.url).toMatch(/^\/api\/web\/user\/good\.web\.tsx\?v=[0-9a-f]{12}$/);
    expect(problems.map((problem) => [problem.file.name, problem.error])).toEqual([["bad.web.ts", expect.stringMatching(/^bad\.web\.ts:1:\d+: /)]]);
  });
});
