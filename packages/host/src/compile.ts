import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import type { Message, Plugin } from "esbuild";
import { SHARED_MODULES } from "@lemma/contracts";

/*
 * A web half written in TypeScript (`notes.web.ts`, or with Solid's JSX, `notes.web.tsx`) is compiled by the host to
 * one ES module the page imports: its own files and npm packages bundled in, and its imports of the page's modules
 * (`solid-js`, `@lemma/*`) read from the page (`SHARED_MODULES`), so it shares Solid's reactivity and the contracts'
 * tags with the app as a `.web.js` does through its `api`. JSX is Solid's (`babel-preset-solid`), as the bundled
 * plugins' is. The source maps run back to its own files, so the browser's devtools show what was written.
 */

/** Whether the host compiles a web half at `path` (`.ts`, `.tsx`, `.jsx`) rather than serving it as it is. */
export const isCompiled = (path: string): boolean => /\.(tsx?|jsx)$/.test(path) && !path.endsWith(".d.ts");

/** What a web half imports from the page: Solid, and Lemma's packages (the runtime's and the domains' contracts). */
const PAGE = /^(solid-js(\/.*)?|@lemma\/.+)$/;

/** A compiled web half: its module, a hash of it for its URL, and the files it was made from. */
export type Compiled =
  | { readonly ok: true; readonly code: string; readonly hash: string; readonly inputs: ReadonlyMap<string, number> }
  | { readonly ok: false; readonly code: string; readonly hash: string; readonly error: string };

const hashOf = (code: string) => createHash("sha256").update(code).digest("hex").slice(0, 12);

/** The page's module `specifier`, as CommonJS exports it: esbuild reads names off it, whatever the page has. */
const pageModule = (specifier: string) =>
  [
    `const shared = globalThis[Symbol.for(${JSON.stringify(SHARED_MODULES)})];`,
    `if (shared === undefined || !Object.hasOwn(shared, ${JSON.stringify(specifier)}))`,
    `  throw new Error(${JSON.stringify(`the web app does not share ${specifier}: a web half imports solid-js and the contracts the page has (@lemma/web, a domain's contract), and bundles the rest`)});`,
    `module.exports = shared[${JSON.stringify(specifier)}];`,
  ].join("\n");

const page: Plugin = {
  name: "lemma-page",
  setup: (build) => {
    build.onResolve({ filter: PAGE }, (args) => ({ path: args.path, namespace: "lemma-page" }));
    // A second Effect beside the page's would not share its schemas; and the page does not share its own.
    build.onResolve({ filter: /^effect(\/.*)?$/ }, () => ({
      errors: [{ text: "a web half cannot import effect: declare its config with WebSchema from @lemma/web, and call channels by id" }],
    }));
    build.onLoad({ filter: /.*/, namespace: "lemma-page" }, (args) => ({ contents: pageModule(args.path), loader: "js" }));
  },
};

/** Solid's JSX, after esbuild strips the types: the transform the bundled plugins' build runs (`vite-plugin-solid`). */
const solidJsx = (transform: typeof import("esbuild").transform): Plugin => ({
  name: "solid-jsx",
  setup: (build) => {
    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const stripped = await transform(source, {
        loader: args.path.endsWith(".tsx") ? "tsx" : "jsx",
        jsx: "preserve",
        sourcefile: args.path,
        sourcemap: "inline",
        sourcesContent: true,
      }).catch((failure: { readonly errors?: readonly Message[] }) => ({ errors: failure.errors ?? [] }));
      if ("errors" in stripped) return { errors: [...stripped.errors] };
      const babel = await import("@babel/core");
      // A CommonJS package with no types: Babel takes it as a preset as it is.
      const solid = createRequire(import.meta.url)("babel-preset-solid") as import("@babel/core").PluginItem;
      const compiled = await babel
        .transformAsync(stripped.code, {
          filename: args.path,
          presets: [[solid, { generate: "dom" }]],
          babelrc: false,
          configFile: false,
          // The map esbuild left inline is read as its input (Babel's default), so this one runs back to the source.
          sourceMaps: "inline",
        })
        .catch((failure: Error & { readonly loc?: { readonly line: number; readonly column: number } }) => ({
          errors: [
            {
              text: failure.message,
              ...(failure.loc === undefined ? {} : { location: { file: args.path, line: failure.loc.line, column: failure.loc.column } }),
            },
          ],
        }));
      if (compiled !== null && "errors" in compiled) return { errors: compiled.errors };
      return { contents: compiled?.code ?? "", loader: "js", resolveDir: dirname(args.path) };
    });
  },
});

const describe = (entry: string, messages: readonly Message[]) =>
  messages
    .map((message) =>
      message.location === null
        ? message.text
        : // A location's file is the build's (relative to the entry's folder), a column from 0.
          `${relative(dirname(entry), resolve(dirname(entry), message.location.file))}:${message.location.line}:${message.location.column + 1}: ${message.text}`,
    )
    .join("\n");

/** The last compile of each web half, kept while the files it was made from are unchanged. */
const made = new Map<string, Compiled & { readonly ok: true }>();

const unchanged = async (inputs: ReadonlyMap<string, number>) => {
  for (const [path, mtime] of inputs) if ((await stat(path).catch(() => undefined))?.mtimeMs !== mtime) return false;
  return true;
};

/**
 * Compiles the web half at `entry`, or reuses its last compile when none of its files changed. One that does not
 * compile is a module that throws what went wrong, so the page reports it as it does a half that fails to load.
 */
export async function compileWebHalf(entry: string): Promise<Compiled> {
  const last = made.get(entry);
  if (last !== undefined && (await unchanged(last.inputs))) return last;
  const esbuild = await import("esbuild");
  const started = Date.now();
  const result = await esbuild
    .build({
      entryPoints: [entry],
      absWorkingDir: dirname(entry),
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      sourcemap: "inline",
      sourcesContent: true,
      metafile: true,
      logLevel: "silent",
      // The folder's tsconfig maps imports to this checkout's sources for the editor; the page's modules are read
      // from the page, and its own files resolve as they are.
      tsconfigRaw: {},
      loader: { ".css": "text" },
      plugins: [page, solidJsx(esbuild.transform)],
    })
    .then(
      (built) => ({ built }),
      (error: { readonly errors?: readonly Message[] }) => ({ error: describe(entry, error.errors ?? [{ text: String(error) } as Message]) }),
    );
  if ("error" in result) {
    made.delete(entry);
    const code = `throw new Error(${JSON.stringify(`cannot compile:\n${result.error}`)});\n`;
    return { ok: false, code, hash: hashOf(code), error: result.error };
  }
  const code = result.built.outputFiles[0]?.text ?? "";
  const inputs = new Map<string, number>();
  for (const input of Object.keys(result.built.metafile.inputs)) {
    if (input.includes(":")) continue; // the page's modules (`lemma-page:solid-js`)
    const path = resolve(dirname(entry), input);
    const mtime = (await stat(path).catch(() => undefined))?.mtimeMs ?? -1;
    // Saved while it compiled (or just before: a file system's clock is coarse), what was read may be the earlier
    // text, so the next listing compiles it again.
    inputs.set(path, mtime >= started - 50 ? -1 : mtime);
  }
  const compiled = { ok: true as const, code, hash: hashOf(code), inputs };
  made.set(entry, compiled);
  return compiled;
}
