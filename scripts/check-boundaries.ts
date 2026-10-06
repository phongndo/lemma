import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The kernel stays domain-neutral: `packages/core` may depend on Effect only,
// may import nothing from the harness packages in this workspace, and names
// none of the harness's concepts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = join(root, "packages/core");
const problems: string[] = [];

/** Prints a boundary's verdict; every boundary is checked before the script fails. */
let failed = false;
const report = (heading: string, found: readonly string[], ok: string) => {
  if (found.length === 0) return console.log(ok);
  failed = true;
  console.error(`${heading}:\n${found.map((problem) => `  ${problem}`).join("\n")}`);
};

const manifest = JSON.parse(readFileSync(join(core, "package.json"), "utf8"));
for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
  if (name !== "effect") problems.push(`packages/core/package.json: runtime dependency "${name}" (only effect is allowed)`);
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === "node_modules" || name === "dist" ? [] : walk(path)) : [path];
  });
const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
for (const file of walk(core).filter((path) => /\.(ts|tsx|mts)$/.test(path))) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1]!;
    const escapes = specifier.startsWith(".") && !resolve(dirname(file), specifier).startsWith(core);
    if ((specifier.startsWith("@lemma/") && specifier !== "@lemma/core") || escapes) {
      problems.push(`${relative(root, file)}: imports "${specifier}"`);
    }
  }
}

// It stays domain-neutral in its words too: the harness's concepts belong to its contracts and plugins.
const harnessWords = /\b(tools?|agents?|sessions?|llms?|prompts?|transcripts?|chats?|models?|slots?|harness)\b/i;
for (const file of walk(join(core, "src")).filter((path) => /\.(ts|tsx|mts)$/.test(path))) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      const word = harnessWords.exec(line)?.[1];
      if (word !== undefined) problems.push(`${relative(root, file)}:${index + 1}: names "${word}", a harness concept`);
    });
}

report("Kernel boundary violations", problems, "kernel boundary: ok");

// The router and its Solid bindings are libraries others could use: each depends only on what it lists here,
// imports nothing else from this workspace (not even the core: entries come and go through `setEntries`), and names
// no harness concept.
const checkLibrary = (name: string, dir: string, allowed: readonly string[]) => {
  const problems: string[] = [];
  const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    if (!allowed.includes(dependency)) problems.push(`${dir}/package.json: runtime dependency "${dependency}" (only ${allowed.join(", ")})`);
  }
  for (const file of walk(join(root, dir, "src")).filter((path) => /\.(ts|tsx|mts)$/.test(path))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1]!;
      const escapes = specifier.startsWith(".") && !resolve(dirname(file), specifier).startsWith(join(root, dir, "src"));
      const known = allowed.some((dependency) => specifier === dependency || specifier.startsWith(`${dependency}/`));
      if (escapes || !(specifier.startsWith(".") || known)) problems.push(`${relative(root, file)}: imports "${specifier}"`);
    }
    text.split("\n").forEach((line, index) => {
      // A dependency's package name (`@lemma/router`) is where it is published, not a concept.
      const prose = line.replace(/(["'])@lemma\/[^"']+\1/g, "");
      const word = (/\b(threads?|lemma)\b/i.exec(prose) ?? harnessWords.exec(prose))?.[1];
      if (word !== undefined) problems.push(`${relative(root, file)}:${index + 1}: names "${word}", a harness concept`);
    });
  }
  report(`${name} boundary violations`, problems, `${name} boundary: ok`);
};
checkLibrary("router", "packages/router", ["effect"]);
checkLibrary("router-solid", "packages/router-solid", ["@lemma/router", "solid-js"]);

// A bundled host plugin is one a user could have written: it meets the others only through `packages/contracts`
// (AGENTS.md), so its package depends on no other plugin and its source imports none.
const pluginProblems: string[] = [];
for (const dir of readdirSync(join(root, "plugins"))) {
  const home = join(root, "plugins", dir);
  const manifest = JSON.parse(readFileSync(join(home, "package.json"), "utf8"));
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    if (dependency.startsWith("@lemma/plugin-")) pluginProblems.push(`plugins/${dir}/package.json: runtime dependency "${dependency}" (use a contract)`);
  }
  for (const file of walk(join(home, "src")).filter((path) => /\.(ts|tsx|mts)$/.test(path))) {
    for (const match of readFileSync(file, "utf8").matchAll(importPattern)) {
      const specifier = match[1]!;
      const escapes = specifier.startsWith(".") && !resolve(dirname(file), specifier).startsWith(home);
      if (specifier.startsWith("@lemma/plugin-") || escapes) pluginProblems.push(`${relative(root, file)}: imports "${specifier}" (use a contract)`);
    }
  }
}
report("Host plugin boundary violations", pluginProblems, "host plugin boundary: ok");

// The web app is replaceable piece by piece: everything it shows comes from a
// plugin (turn it off or replace it by id), and plugins reach each other only
// through `ui/contracts.ts` (capabilities, slots, parts). So a plugin imports
// no other plugin and no rendering component: it draws shared pieces through
// `ui/parts.tsx`, whose providers anyone can replace. Only `kit` supplies the
// shared parts' defaults, so only it imports `components/`. See apps/web/AGENTS.md.
const web = join(root, "apps/web/src");
const uiProblems: string[] = [];
const within = (file: string, dir: string) => relative(join(web, dir), file).split("/")[0] !== "..";
const target = (file: string, specifier: string) => relative(web, resolve(dirname(file), specifier));
for (const file of walk(web).filter((path) => /\.(ts|tsx)$/.test(path))) {
  const text = readFileSync(file, "utf8");
  const name = relative(web, file);
  const rule = (message: string) => uiProblems.push(`apps/web/src/${name}: ${message}`);
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1]!;
    if (!specifier.startsWith(".")) {
      // Pure modules stay pure: no DOM rendering in models.
      if (within(file, "model") && specifier.startsWith("solid-js")) rule(`imports "${specifier}" (models are pure data)`);
      continue;
    }
    const to = target(file, specifier);
    if (within(file, "plugins")) {
      if (name === "plugins/index.ts") continue;
      // A plugin is a file with its own stylesheet beside it (`plugins/<id>.tsx`, `plugins/<id>.css`), or a directory
      // (`plugins/<id>/`) whose files are all its own; anything else under plugins/ is another plugin.
      const [, dir, ...inside] = name.split("/");
      const own = inside.length > 0 ? to.startsWith(`plugins/${dir}/`) : to.replace(/\?inline$/, "") === name.replace(/\.tsx?$/, ".css");
      if (to.startsWith("plugins/") && !own) rule(`imports another plugin "${specifier}" (use a capability, slot, or part)`);
      else if (to.startsWith("components/") && name !== "plugins/kit.tsx") rule(`imports "${specifier}" (draw it through ui/parts.tsx, so it can be replaced)`);
      else if (to.startsWith("ui/") && !["ui/contracts.ts", "ui/define.ts", "ui/slots.ts", "ui/parts.tsx"].includes(to))
        rule(`imports "${specifier}" (plugins use ui/contracts, define, slots, and parts)`);
    } else if (within(file, "components")) {
      if (to.startsWith("plugins/")) rule(`imports a plugin "${specifier}"`);
      else if (to.startsWith("components/")) rule(`imports "${specifier}" (a part draws other parts through ui/parts.tsx)`);
    } else if (within(file, "model") || within(file, "lib")) {
      if (to.startsWith("plugins/") || to.startsWith("components/") || to === "ui/parts.tsx")
        rule(`imports "${specifier}" (models and helpers render nothing)`);
    } else if (to.startsWith("plugins/") && to !== "plugins/index.ts") {
      // The boot and the app's frame know plugins only as the bundled list: what runs is up to the composition.
      rule(`imports the plugin "${specifier}" (only plugins/index.ts, the bundled list)`);
    }
  }
  if (within(file, "model") && name.endsWith(".tsx")) rule("is a .tsx model (models are pure data)");
  if (within(file, "plugins")) {
    // A plugin keeps to what it owns: its DOM (through refs), its slot items, and the page's look only through lib/paint.
    for (const [pattern, why] of [
      [/document\.(querySelector|querySelectorAll|getElementById|getElementsBy\w+)\b/, "queries the whole page (use a ref, or query your own element)"],
      [/document\.body\b/, "reaches into <body> (draw overlays as Layers items)"],
      [/document\.documentElement\b/, "touches <html> (the look goes through lib/paint.ts)"],
    ] as const) {
      if (pattern.test(text)) rule(why);
    }
    // What a slot holds is drawn contained (`Contained`, `Each`, `First` in ui/parts.tsx), so a throw fails that item alone,
    // named for its plugin, rather than freezing every view updated after it.
    if (/import\s*\{[^}]*\bDynamic\b[^}]*\}\s*from\s*["']solid-js\/web["']/.test(text)) {
      rule("draws with Dynamic (draw slot items with Contained, Each, or First from ui/parts.tsx, so a throw fails alone)");
    }
    // One owner of global keys: overlays handle keys on their own element, and app keys are Actions.
    if (!["plugins/keymap.ts", "plugins/tooltips.tsx"].includes(name) && /(document|window)\.addEventListener\(\s*["']key/.test(text)) {
      rule("listens to keys page-wide (add an Action, or handle keys on your own element)");
    }
  }
}
// What covers the page stacks by the `--z-*` tokens, so a layer from a UI file can slot in between.
for (const file of walk(web).filter((path) => path.endsWith(".css"))) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      const value = /z-index:\s*(\d+)/.exec(line)?.[1];
      if (value !== undefined && Number(value) > 20) uiProblems.push(`${relative(root, file)}:${index + 1}: z-index ${value} (use a --z-* token)`);
    });
}
report("Web UI boundary violations (see apps/web/AGENTS.md)", uiProblems, "web ui boundary: ok");

// Tests and checks wait for a condition, not for time: a fixed wait is too short on a loaded machine (a flake) and
// too long everywhere else (a slow suite). Nor do they name a file directly under the OS temp directory, which runs
// at once (`pnpm stress`) would share; mkdtemp makes one of their own. Each file's count of either may only fall,
// TigerBeetle "tidy" style: a count above its ceiling fails, and one below asks for the ceiling to come down with it.
// The ceilings record what is left to fix, not what is allowed.
const waitCeilings: Readonly<Record<string, number>> = {
  "apps/web/scripts/shots.ts": 1,
  "apps/web/tests/ui.test.ts": 1,
  "packages/client/tests/rpc.test.ts": 1,
  "packages/client/tests/session-log.test.ts": 1,
  "packages/core/tests/events.test.ts": 5,
  "packages/core/tests/lifecycle-regressions.test.ts": 1,
  "packages/core/tests/supervision.test.ts": 3,
  "packages/core/tests/support.ts": 1,
  "packages/host/scripts/dev.ts": 2,
  "plugins/agent/tests/crash.ts": 1,
  "plugins/agent/tests/fakes.ts": 1,
  "plugins/agent/tests/recovery.test.ts": 5,
  "plugins/compaction/tests/compaction.test.ts": 1,
  "plugins/credentials/tests/credentials.test.ts": 1,
  "plugins/file-search-fff/tests/file-search.test.ts": 1,
  "plugins/host/tests/watch.test.ts": 6,
  "plugins/llm-pi-ai/tests/llm.test.ts": 2,
  "plugins/sessions/tests/sessions.test.ts": 7,
  "plugins/sessions/tests/simulation.test.ts": 1,
  "plugins/tools-builtin/tests/bash.test.ts": 2,
  "plugins/tools-builtin/tests/codemode.test.ts": 1,
  "plugins/tools/tests/tools.test.ts": 3,
  "scripts/e2e.ts": 1,
  "scripts/mock-openai.ts": 1,
};
const tempNameCeilings: Readonly<Record<string, number>> = {
  "plugins/host/tests/ui.test.ts": 2,
  "plugins/transport/tests/transport.test.ts": 2,
};
const fixedWaits = [
  // A promise its own timer resolves: `new Promise((resolve) => setTimeout(resolve, 100))`.
  /new Promise(?:<[^>]*>)?\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*setTimeout\(\s*\1\s*,/g,
  /\bwaitForTimeout\(/g,
  /(?<![\w$.])sleep\(/g,
  /\bEffect\.sleep\(/g,
];
// `join(tmpdir(), "name")` and the like, but not a prefix handed to mkdtemp.
const fixedTempName = /(?<!mkdtemp(?:Sync)?\(\s*(?:\w+\.)?)\b(?:join|resolve)\(\s*(?:\w+\.)?tmpdir\(\)\s*,\s*(?:"[^"]*"|'[^']*'|`[^`$]*`)/g;
const testProblems: string[] = [];
const lower: string[] = [];
const ratchet = (counts: ReadonlyMap<string, number>, ceilings: Readonly<Record<string, number>>, table: string, what: string, instead: string) => {
  for (const file of new Set([...counts.keys(), ...Object.keys(ceilings)])) {
    const count = counts.get(file) ?? 0;
    const ceiling = ceilings[file] ?? 0;
    if (count > ceiling) testProblems.push(`${file}: ${count} ${what}, above its ceiling of ${ceiling} (${table}): ${instead}`);
    else if (count < ceiling)
      lower.push(`${file}: ${count} ${what}, under its ceiling of ${ceiling}: set it to ${count} in ${table}${count === 0 ? " (remove the row)" : ""}`);
  }
};
const waits = new Map<string, number>();
const tempNames = new Map<string, number>();
for (const dir of ["apps", "examples", "packages", "plugins", "scripts"]) {
  for (const path of walk(join(root, dir)).filter((file) => /\.(ts|tsx|mts)$/.test(file))) {
    const file = relative(root, path);
    // This file names the patterns it looks for.
    if (file === "scripts/check-boundaries.ts" || (!/(^|\/)(tests|scripts)\//.test(file) && !/\.test\.tsx?$/.test(file))) continue;
    const text = readFileSync(path, "utf8");
    const waited = fixedWaits.reduce((sum, pattern) => sum + [...text.matchAll(pattern)].length, 0);
    const named = [...text.matchAll(fixedTempName)].length;
    if (waited > 0) waits.set(file, waited);
    if (named > 0) tempNames.set(file, named);
  }
}
ratchet(waits, waitCeilings, "waitCeilings", "fixed-time waits (a timer's promise, waitForTimeout, sleep, Effect.sleep)", "wait for the condition instead");
ratchet(tempNames, tempNameCeilings, "tempNameCeilings", "fixed names under the OS temp directory", "make a directory with mkdtemp");
if (lower.length) console.log(`Ceilings to lower in scripts/check-boundaries.ts, so they stay down:\n${lower.map((note) => `  ${note}`).join("\n")}`);
report("Test hygiene violations (scripts/check-boundaries.ts)", testProblems, "test hygiene: ok");

// Code behind a seam reaches time, randomness, and the disk only through it, so a simulation controls all three
// (plugins/sessions/README.md#testing): Effect's `Clock` and `Random`, and the `FileSystem` it is given.
const reach = {
  clock: [/\bDate\.now\(/g, "Date.now() (use Effect's Clock)"],
  random: [/\bMath\.random\(|\brandom(?:Bytes|UUID|Int)\(/g, "a random source other than Effect's Random"],
  disk: [/from\s+["']node:fs\/promises["']|\bpromises\b[^;]*from\s+["']node:fs["']/g, "node:fs's file operations (use the FileSystem given)"],
} as const;
const seamed: Readonly<Record<string, readonly (keyof typeof reach)[]>> = {
  "plugins/sessions/src": ["clock", "random", "disk"],
  "plugins/agent/src/turn.ts": ["clock"],
  "plugins/agent/src/live.ts": ["clock", "random"],
};
// What a seamed file may still reach directly, and why.
const unseamed: Readonly<Record<string, readonly (keyof typeof reach)[]>> = {
  // The lock's lease is wall-clock time that other processes compare with the lock file's mtime; its token only
  // has to be unique.
  "plugins/sessions/src/lock.ts": ["clock", "random"],
  // Turn and step ids only have to be unique; nothing a simulation checks depends on them.
  "plugins/agent/src/turn.ts": ["random"],
};
const seamProblems: string[] = [];
for (const [prefix, kinds] of Object.entries(seamed)) {
  const target = join(root, prefix);
  const files = statSync(target).isDirectory() ? walk(target).filter((path) => /\.(ts|tsx|mts)$/.test(path)) : [target];
  for (const path of files) {
    const file = relative(root, path);
    const text = readFileSync(path, "utf8");
    for (const kind of kinds) {
      if (unseamed[file]?.includes(kind)) continue;
      const [pattern, what] = reach[kind];
      for (const match of text.matchAll(pattern)) {
        seamProblems.push(`${file}:${text.slice(0, match.index).split("\n").length}: reaches ${what}`);
      }
    }
  }
}
report("Seam violations (scripts/check-boundaries.ts)", seamProblems, "seams: ok");

if (failed) process.exit(1);
