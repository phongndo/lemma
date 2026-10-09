import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
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
    if ((specifier.startsWith("@lemma/") && specifier !== "@lemma/core" && !specifier.startsWith("@lemma/core/")) || escapes) {
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

// The core and the router can leave this repository as they are: their docs link within those packages only, never to
// the app's docs, so a copy of the directories keeps every link working.
const frameworks = ["packages/core", "packages/router", "packages/router-solid"].map((dir) => join(root, dir));
const linkProblems: string[] = [];
for (const home of frameworks) {
  for (const file of walk(home).filter((path) => path.endsWith(".md"))) {
    for (const match of readFileSync(file, "utf8").matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1]!.split("#")[0]!;
      if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = resolve(dirname(file), target);
      if (!frameworks.some((framework) => resolved === framework || resolved.startsWith(`${framework}/`))) {
        linkProblems.push(`${relative(root, file)}: links "${match[1]}", outside the framework packages`);
      }
    }
  }
}
report("Framework doc links leaving the framework packages", linkProblems, "framework doc links: ok");

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

// The runtime is the API every plugin is written against (AGENTS.md): the host's (packages/host, but not `bundled.ts`,
// the list of bundled plugins, which the walk does not enter), the planner both apps share (packages/composition), the
// web app's (`runtime/` and the boot's modules in `ui/`), and its contracts (`@lemma/contracts/runtime`). It knows no
// domain: nothing it imports, however indirectly and if only for a type, is a domain contract, which is any module of
// packages/contracts but the runtime's own (`runtimeContracts`; a new module counts as domain until it is listed
// there). The barrel `@lemma/contracts` is every contract, so the runtime imports `@lemma/contracts/runtime`. The walk
// follows relative imports, and workspace packages through their `exports`. The transport is a plugin, held to the
// runtime by its `requires` instead.
const contracts = join(root, "packages/contracts/src");
const runtimeContracts = ["addresses", "channels", "config", "discovery", "fs", "host", "inspectors", "interaction", "kernel", "rpc", "runtime", "status"];
const isCode = (path: string) => /\.(ts|tsx|mts|js|jsx|mjs)$/.test(path);
const bundledList = join(root, "packages/host/src/bundled.ts");
const runtimeCode = [
  ...walk(join(root, "packages/host/src")).filter((path) => path !== bundledList),
  ...walk(join(root, "packages/composition/src")),
  ...walk(join(root, "apps/web/src/runtime")),
  ...["boot.tsx", "define.ts", "draw.tsx", "files.ts", "runtime.ts", "slots.ts"].map((name) => join(root, "apps/web/src/ui", name)),
  join(contracts, "runtime.ts"),
].filter(isCode);
const workspacePackages = new Map<string, { readonly dir: string; readonly exports: Readonly<Record<string, unknown>> }>();
for (const group of ["apps", "examples", "packages", "plugins"]) {
  for (const name of readdirSync(join(root, group))) {
    const manifest = join(root, group, name, "package.json");
    if (!existsSync(manifest)) continue;
    const { name: id, exports = {} } = JSON.parse(readFileSync(manifest, "utf8"));
    workspacePackages.set(id, { dir: join(root, group, name), exports: typeof exports === "string" ? { ".": exports } : exports });
  }
}
const unresolved: string[] = [];
/** What a relative import may name besides code, which the walk does not enter. */
const isAsset = (path: string) => /\.(css|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|json|wasm)$/.test(path);
/** Bundler resolution and Vite read `./a.js` as `./a.ts` (or `.tsx`), `.jsx` as `.tsx`, and `.mjs` as `.mts`, when that source exists. */
const sourcesOf: Readonly<Record<string, readonly string[]>> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"] };
/** The module `specifier` names from `from`: a file, `node:<name>` for Node's own, or none for an asset or a package from outside. */
const resolveImport = (from: string, specifier: string): string | undefined => {
  if (isBuiltin(specifier)) return specifier.startsWith("node:") ? specifier : `node:${specifier}`;
  if (specifier.startsWith(".")) {
    const path = resolve(dirname(from), specifier.replace(/\?.*$/, ""));
    const extension = extname(path);
    const sources = (sourcesOf[extension] ?? []).map((source) => path.slice(0, -extension.length) + source);
    const found = [...sources, path].find((candidate) => isCode(candidate) && existsSync(candidate));
    if (found !== undefined) return found;
    if (isCode(path) || extension === "") unresolved.push(`${relative(root, from)}: imports "${specifier}", which names no file`);
    else if (!isAsset(path)) unresolved.push(`${relative(root, from)}: imports "${specifier}", which is neither code nor a known asset`);
    return undefined;
  }
  const [first = "", ...rest] = specifier.split("/");
  const name = first.startsWith("@") ? `${first}/${rest.shift()}` : first;
  const workspace = workspacePackages.get(name);
  if (workspace === undefined) return undefined;
  // A subpath's entry: a file, or conditions, of which processes here run `lemma-source` (docs/development.md).
  const entry = workspace.exports[[".", ...rest].join("/")] as string | Readonly<Record<string, string>> | undefined;
  const file = typeof entry === "string" ? entry : (entry?.["lemma-source"] ?? entry?.import);
  if (file !== undefined) return join(workspace.dir, file);
  unresolved.push(`${relative(root, from)}: imports "${specifier}", which ${name}'s exports do not name`);
  return undefined;
};
/**
 * Follows the imports of `roots` breadth-first, so each module is reached by its shortest chain. `onward` sees each
 * import of a module reached and says whether to follow it. Returns the chain from a root to a module reached.
 */
const followImports = (roots: readonly string[], onward: (from: string, to: string) => boolean) => {
  const via = new Map<string, string | undefined>(roots.map((file) => [file, undefined]));
  const queue = [...via.keys()];
  for (let next = 0; next < queue.length; next++) {
    const file = queue[next]!;
    for (const match of readFileSync(file, "utf8").matchAll(importPattern)) {
      const to = resolveImport(file, match[1]!);
      if (to === undefined || via.has(to) || !onward(file, to) || to.startsWith("node:")) continue;
      via.set(to, file);
      queue.push(to);
    }
  }
  return (file: string) => {
    const chain: string[] = [];
    for (let at: string | undefined = file; at !== undefined; at = via.get(at)) chain.unshift(relative(root, at));
    return chain;
  };
};
const isDomain = (path: string) =>
  !path.startsWith("node:") && !relative(contracts, path).startsWith("..") && !runtimeContracts.includes(relative(contracts, path).replace(/\.ts$/, ""));
const crossings = new Map<string, { readonly from: string; readonly to: string }>();
const runtimeChain = followImports(runtimeCode, (from, to) => {
  if (to === bundledList) return false;
  if (!isDomain(to)) return true;
  crossings.set(`${relative(root, from)} → ${relative(root, to)}`, { from, to });
  return false;
});
// The web app bundles the planner, so nothing it reaches is Node's.
const nodeImports: { readonly from: string; readonly to: string }[] = [];
const compositionChain = followImports(walk(join(root, "packages/composition/src")).filter(isCode), (from, to) => {
  if (to.startsWith("node:")) nodeImports.push({ from, to });
  return true;
});
const runtimeProblems = [...new Set(unresolved)];
for (const { from, to } of crossings.values()) {
  const what = relative(contracts, to) === "index.ts" ? "every contract, the domain's too (import @lemma/contracts/runtime)" : "a domain contract";
  runtimeProblems.push(`${[...runtimeChain(from), relative(root, to)].join(" → ")}: ${what}`);
}
for (const { from, to } of nodeImports) {
  runtimeProblems.push(`${[...compositionChain(from), to].join(" → ")}: Node's, in @lemma/composition, which the web app bundles`);
}
report("Runtime boundary violations (scripts/check-boundaries.ts)", runtimeProblems, "runtime boundary: ok");

// The host's streams, `Host.Events` and `Channel.Open`, are read only in packages/client/src, which hands each element to
// a callback at once. Effect's RPC client reads a WebSocket on one fiber, which puts a stream's chunk into that request's
// bounded queue before it reads on, so a reader that stops taking a stream's elements stalls every call and stream on its
// socket (`makeHostRpc` in packages/client/src/rpc.ts). The client @lemma/client hands out (`HostRpcClient`) has no such
// RPCs, so reading one raw fails to compile. What types cannot see is a client made elsewhere with Effect's `RpcClient`,
// which this finds: a value import of `RpcClient` (the module, from `effect/rpc` or `effect/rpc/RpcClient`) outside
// packages/client/src; `RpcClientError` and type-only imports are fine. Tests are left out: they make their own to test
// the host, a reader that stops included.
const clientSource = join(root, "packages/client/src");
const rpcImport = /import\s+(?!type\s)(\{[^}]*\}|\*\s+as\s+\w+)\s*from\s*["']effect\/rpc(\/RpcClient)?["']/g;
const importsRpcClient = (names: string, module: string | undefined) =>
  names.startsWith("*")
    ? true
    : module !== undefined ||
      names
        .slice(1, -1)
        .split(",")
        .some((name) => /^RpcClient(\s+as\s+\w+)?$/.test(name.trim()));
const clientProblems: string[] = [];
for (const dir of ["apps", "examples", "packages", "plugins", "scripts"]) {
  for (const path of walk(join(root, dir)).filter(isCode)) {
    const file = relative(root, path);
    if (path.startsWith(`${clientSource}/`) || /(^|\/)tests\//.test(file) || /\.test\.tsx?$/.test(file)) continue;
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(rpcImport)) {
      if (!importsRpcClient(match[1]!, match[2])) continue;
      clientProblems.push(
        `${file}:${text.slice(0, match.index).split("\n").length}: makes an RPC client of its own: connect through @lemma/client (connect, or makeHostRpcHttp for one-shot calls), whose client reads the host's streams only into callbacks, since a reader that waits stalls every request on its connection`,
      );
    }
  }
}
report("RPC clients outside @lemma/client (scripts/check-boundaries.ts)", clientProblems, "rpc clients: ok");

// The web app is replaceable piece by piece: everything it shows comes from a
// plugin (turn it off or replace it by id), and plugins reach each other only
// through `ui/contracts.ts` (capabilities, slots, parts). So a plugin imports
// no other plugin and no rendering component: it draws shared pieces through
// `ui/parts.tsx`, whose providers anyone can replace. Only `kit` supplies the
// shared parts' defaults, so only it imports `components/`. The runtime
// (`runtime/`) is what plugins are written against: they reach it through its
// capabilities, and it knows only its own contracts (`ui/runtime.ts`), never a
// plugin, a component, or what plugins provide; the runtime boundary above
// keeps it, and the boot, from every domain contract. See apps/web/AGENTS.md.
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
    if (to.startsWith("runtime/") && !within(file, "runtime") && name !== "ui/boot.tsx") {
      rule(`imports the runtime "${specifier}" (require its capability from ui/contracts)`);
    } else if (within(file, "runtime")) {
      if (!to.startsWith("runtime/") && !["ui/runtime.ts", "ui/slots.ts"].includes(to) && !to.startsWith("lib/"))
        rule(`imports "${specifier}" (the runtime uses its own files, ui/runtime, ui/slots, and lib/)`);
    } else if (within(file, "plugins")) {
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
    // A part's fallback is plain markup that draws while no plugin provides the part, so neither it nor the contracts
    // declaring it reach a component (`kit`'s, gone with it) or a part (`ui/parts.tsx` imports the contracts: a cycle).
    if (["ui/contracts.ts", "ui/fallbacks.tsx"].includes(name) && (to.startsWith("components/") || to === "ui/parts.tsx"))
      rule(`imports "${specifier}" (a part's fallback is plain markup: it draws no component and no part)`);
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
// What covers the page stacks by the `--z-*` tokens, so a layer from a UI file can slot in between. And the look is
// tokens all through, so a theme or a setting reaches every plugin: a color is written only where a token is declared
// (its default), and a font size or a corner's radius is scaled by `--text-scale` or `--radius-scale`.
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(/i;
// CSS's named colors, which count as literals in a declaration's value (not in a selector or a property's name).
const NAMED_COLOR = new RegExp(
  `(?<![\\w-])(?:${"aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(" ").join("|")})(?![\\w-])`,
  "i",
);
/**
 * Each declaration a stylesheet's rules hold, with the line it starts on: the
 * text before each `;` or `}` inside a rule's block, past comments and strings
 * (which may hold any character, escaped quotes too). A block opened by an
 * at-rule (`@media`, `@layer`, `@property`) holds rules, not declarations, as a
 * selector is none, unless it is nested in a rule, which it then continues.
 */
const declarations = (css: string): { readonly property: string; readonly value: string; readonly line: number }[] => {
  const found: { property: string; value: string; line: number }[] = [];
  const blocks: ("rule" | "group")[] = [];
  let segment = "";
  let line = 1;
  let starts: number | undefined;
  for (let at = 0; at < css.length; at++) {
    const char = css[at]!;
    if (char === "/" && css[at + 1] === "*") {
      const end = css.indexOf("*/", at + 2);
      const skipped = css.slice(at, end === -1 ? css.length : end + 2);
      line += skipped.split("\n").length - 1;
      at += skipped.length - 1;
      continue;
    }
    if (char === "\n") line++;
    if (starts === undefined && !/\s/.test(char)) starts = line;
    if (char === '"' || char === "'") {
      // To the quote that closes it, past escaped ones (`"\\""`).
      let end = at + 1;
      while (end < css.length && css[end] !== char) end += css[end] === "\\" ? 2 : 1;
      const quoted = css.slice(at, end + 1);
      segment += quoted;
      line += quoted.split("\n").length - 1;
      at += quoted.length - 1;
      continue;
    }
    if (char !== "{" && char !== "}" && char !== ";") {
      segment += char;
      continue;
    }
    const colon = segment.indexOf(":");
    if (char !== "{" && blocks.at(-1) === "rule" && colon !== -1) {
      found.push({ property: segment.slice(0, colon).trim(), value: segment.slice(colon + 1).trim(), line: starts ?? line });
    }
    // An at-rule's block holds rules, unless it sits in a rule (CSS nesting), where it holds that rule's declarations.
    if (char === "{") blocks.push(/^\s*@(?!font-face|page)/.test(segment) && blocks.at(-1) !== "rule" ? "group" : "rule");
    if (char === "}") blocks.pop();
    segment = "";
    starts = undefined;
  }
  return found;
};

for (const file of walk(web).filter((path) => path.endsWith(".css"))) {
  for (const { property, value, line } of declarations(readFileSync(file, "utf8"))) {
    const where = `${relative(root, file)}:${line}`;
    const stacking = property === "z-index" ? Number(value) : 0;
    if (stacking > 20) uiProblems.push(`${where}: z-index ${value} (use a --z-* token)`);
    // A token's declaration is where its default is written.
    if (property.startsWith("--")) continue;
    const bare = value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
    if (COLOR_LITERAL.test(bare) || NAMED_COLOR.test(bare.replace(/--[\w-]+/g, "")))
      uiProblems.push(`${where}: a color outside a token (declare a --token for it)`);
    if (/^(?:font|font-size|line-height)$/.test(property) && /\b[\d.]+px/.test(bare.replace(/calc\([\d.]+px \* var\(--text-scale\)\)/g, ""))) {
      uiProblems.push(`${where}: a font size in px (scale it: calc(12px * var(--text-scale)))`);
    }
    if (property.endsWith("radius") && /\b[\d.]+px/.test(bare.replace(/calc\([\d.]+px \* var\(--radius-scale\)\)/g, ""))) {
      uiProblems.push(`${where}: a radius in px (scale it: calc(6px * var(--radius-scale)))`);
    }
  }
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
  "packages/core/tests/events.test.ts": 5,
  "packages/core/tests/lifecycle-regressions.test.ts": 1,
  "packages/core/tests/supervision.test.ts": 3,
  "packages/core/tests/support.ts": 1,
  "packages/host/scripts/dev.ts": 2,
  "packages/host/tests/watch.test.ts": 5,
  "plugins/agent/tests/crash.ts": 1,
  "plugins/agent/tests/fakes.ts": 1,
  "plugins/agent/tests/recovery.test.ts": 5,
  "plugins/compaction/tests/compaction.test.ts": 1,
  "plugins/credentials/tests/credentials.test.ts": 1,
  "plugins/file-search-fff/tests/file-search.test.ts": 1,
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
  "packages/host/tests/ui.test.ts": 2,
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
