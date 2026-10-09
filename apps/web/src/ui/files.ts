import type { UiFile } from "@lemma/contracts/runtime";
import type { Plugin } from "@lemma/core";
import type { LocalPlugin } from "@lemma/composition";
import { extractCandidates } from "../model/candidates.ts";

interface LoadedFiles {
  readonly plugins: readonly LocalPlugin[];
  /** Files that failed to load or export no plugin, each naming the file. */
  readonly problems: readonly string[];
}

const isPlugin = (value: unknown): value is Plugin =>
  typeof value === "object" && value !== null && typeof (value as Plugin).id === "string" && typeof (value as Plugin).layer === "function";

/**
 * Loads the host's UI files into the page. A script is an ES module whose
 * default export is a plugin, an array of them, or a function that receives
 * `api` (Solid, the contracts, `defineUiPlugin`, the app's components and
 * bundled plugins) and returns either; it runs with the page's permissions
 * and token. A stylesheet
 * is linked after the app's own, so it can override any `--` token. File URLs
 * change when a file does, so an edited file is imported again.
 *
 * A script's Tailwind classes work as the app's own do: while any script is
 * loaded, the page compiles the app's classes and the scripts' into one sheet
 * of utilities (`ui/utilities.ts`), and drops it when none is.
 */
export function createFileLoader(token: string | undefined, api: () => Promise<unknown>) {
  const withToken = (url: string) => (token === undefined ? url : `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`);
  const links = new Map<string, HTMLLinkElement>();
  // By URL: an unchanged file keeps the same plugin definitions, which the kernel leaves running on reload.
  const scripts = new Map<string, Promise<LoadedFiles>>();
  const candidates = new Map<string, Promise<readonly string[]>>();
  let utilities: HTMLStyleElement | undefined;
  // The latest load's sheet wins over an earlier one still compiling.
  let generation = 0;

  const candidatesOf = (file: UiFile) => {
    let found = candidates.get(file.url);
    if (found === undefined) {
      found = fetch(withToken(file.url)).then(async (response) => (response.ok ? extractCandidates(await response.text()) : []));
      candidates.set(file.url, found);
    }
    return found;
  };

  /** Compiles the utilities the scripts use, with the app's own; a problem when that fails. */
  const syncUtilities = async (files: readonly UiFile[]): Promise<readonly string[]> => {
    const current = ++generation;
    const scriptFiles = files.filter((file) => file.kind === "script");
    if (scriptFiles.length === 0) {
      utilities?.remove();
      utilities = undefined;
      return [];
    }
    try {
      const used = (await Promise.all(scriptFiles.map(candidatesOf))).flat();
      const css = await (await import("./utilities.ts")).compileUtilities(used);
      if (current !== generation) return [];
      if (utilities === undefined) {
        utilities = document.createElement("style");
        utilities.dataset.lemmaUtilities = "";
        document.head.append(utilities);
      }
      utilities.textContent = css;
      return [];
    } catch (error) {
      return [`UI files' Tailwind classes: cannot compile: ${error instanceof Error ? error.message : String(error)}`];
    }
  };

  const syncStyles = (files: readonly UiFile[]) => {
    const wanted = new Set(files.filter((file) => file.kind === "style").map((file) => file.url));
    for (const [url, link] of links) {
      if (wanted.has(url)) continue;
      link.remove();
      links.delete(url);
    }
    for (const url of wanted) {
      if (links.has(url)) continue;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = withToken(url);
      link.dataset.lemmaUi = "";
      document.head.append(link);
      links.set(url, link);
    }
  };

  const importScript = async (file: UiFile): Promise<LoadedFiles> => {
    const where = `${file.source === "user" ? "~/.lemma/ui" : ".lemma/ui"}/${file.name}`;
    try {
      const module: { default?: unknown } = await import(/* @vite-ignore */ withToken(file.url));
      const made =
        typeof module.default === "function" && !isPlugin(module.default) ? (module.default as (api: unknown) => unknown)(await api()) : module.default;
      const exported = Array.isArray(made) ? made : [made];
      const plugins = exported.filter(isPlugin);
      return {
        plugins: plugins.map((plugin) => ({ plugin, source: file.source })),
        problems:
          plugins.length === 0 ? [`${where}: its default export is no plugin; export defineUiPlugin({ … }), or a function of the api returning one`] : [],
      };
    } catch (error) {
      return { plugins: [], problems: [`${where}: cannot load: ${error instanceof Error ? error.message : String(error)}`] };
    }
  };

  return {
    load: async (files: readonly UiFile[]): Promise<LoadedFiles> => {
      syncStyles(files);
      const compiled = syncUtilities(files);
      const loaded = await Promise.all(
        files
          .filter((file) => file.kind === "script")
          .map((file) => {
            let found = scripts.get(file.url);
            if (found === undefined) {
              found = importScript(file);
              scripts.set(file.url, found);
            }
            return found;
          }),
      );
      return { plugins: loaded.flatMap((entry) => entry.plugins), problems: [...loaded.flatMap((entry) => entry.problems), ...(await compiled)] };
    },
  };
}
