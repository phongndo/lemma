import type { WebFile } from "@lemma/contracts";
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
 * Loads the web halves and stylesheets the host lists into the page. A web
 * half (a script) is an ES module whose
 * default export is a plugin, or a function that receives
 * `api` (Solid, the contracts, `defineWebPlugin`, the app's components and
 * bundled plugins) and returns one; it runs with the page's permissions
 * and token. It must be the plugin its file is named for (`WebFile.plugin`):
 * the host knows a web half's id by that, without running it. A stylesheet
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

  const candidatesOf = (file: WebFile) => {
    let found = candidates.get(file.url);
    if (found === undefined) {
      found = fetch(withToken(file.url)).then(async (response) => (response.ok ? extractCandidates(await response.text()) : []));
      candidates.set(file.url, found);
    }
    return found;
  };

  /** Compiles the utilities the scripts use, with the app's own; a problem when that fails. */
  const syncUtilities = async (files: readonly WebFile[]): Promise<readonly string[]> => {
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
      return [`Web halves' Tailwind classes: cannot compile: ${error instanceof Error ? error.message : String(error)}`];
    }
  };

  const syncStyles = (files: readonly WebFile[]) => {
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

  const importScript = async (file: WebFile): Promise<LoadedFiles> => {
    const where = `${file.source === "user" ? "~/.lemma/plugins" : ".lemma/plugins"}/${file.name}`;
    try {
      const module: { default?: unknown } = await import(/* @vite-ignore */ withToken(file.url));
      const made =
        typeof module.default === "function" && !isPlugin(module.default) ? (module.default as (api: unknown) => unknown)(await api()) : module.default;
      if (!isPlugin(made)) {
        return { plugins: [], problems: [`${where}: its default export is no plugin; export defineWebPlugin({ … }), or a function of the api returning one`] };
      }
      // Named for another plugin, the host would take its row for this file's, and this plugin's for a typo.
      if (file.plugin !== undefined && made.id !== file.plugin) {
        return {
          plugins: [],
          problems: [`${where}: defines "${made.id}", but a web half is the plugin its file is named for: give it the id "${file.plugin}", or rename the file`],
        };
      }
      return { plugins: [{ plugin: made, source: file.source }], problems: [] };
    } catch (error) {
      return { plugins: [], problems: [`${where}: cannot load: ${error instanceof Error ? error.message : String(error)}`] };
    }
  };

  return {
    load: async (files: readonly WebFile[]): Promise<LoadedFiles> => {
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
