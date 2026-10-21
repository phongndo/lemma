import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appUrl, DEEP_LINK_SCHEME } from "@lemma/contracts";
import type { Io, Target } from "./command.ts";

/*
 * Opening a page for the person: the web app at one of its addresses (in the
 * desktop app when it runs here), or a page elsewhere (a sign-in). In the
 * browser here when there is one (a display, not over SSH), else printed on a
 * line of its own so it copies whole into a browser anywhere.
 */

/**
 * The built web app the host serves by default: a checkout's, which `pnpm start` builds. Found from this file's
 * folder, which is the bundle's too (`dist/lemma.mjs`), so the bundle finds it where the sources do.
 */
export const webIndex = fileURLToPath(new URL("../../web/dist/index.html", import.meta.url));

/**
 * Opens a page elsewhere (a sign-in) when this machine has a browser, after
 * asking `prompt` at the terminal when there is one and the command answers
 * there (Enter opens it). The command that names it prints it itself. Aborting
 * `signal` (the command ending) closes the prompt.
 */
export const openPage = (io: Io, url: string | undefined, prompt: string | undefined, asks: boolean, signal: AbortSignal): void => {
  if (url === undefined) return;
  const open = io.open;
  if (open === undefined) return;
  const ask = io.ask;
  if (prompt === undefined || !asks || ask === undefined) {
    open(url);
    return;
  }
  void ask(prompt, false, signal).then(
    () => open(url),
    () => undefined,
  );
};

/**
 * The running desktop app's way in (`<home>/desktop.json`, which it writes):
 * the command that hands it a `lemma://` link. Undefined when none runs.
 */
const desktop = (home: string): readonly string[] | undefined => {
  try {
    const entry = JSON.parse(readFileSync(join(home, "desktop.json"), "utf8")) as { readonly pid?: unknown; readonly open?: unknown };
    if (typeof entry.pid !== "number" || !Array.isArray(entry.open) || !entry.open.every((word) => typeof word === "string") || entry.open.length === 0)
      return undefined;
    process.kill(entry.pid, 0);
    return entry.open as string[];
  } catch {
    return undefined;
  }
};

/**
 * Opens the web app at `path` of `target`: in the desktop app when it runs
 * here and shows the same host (the one a command finds by default, not one
 * `--env` or a variable named), else in the browser; prints the address when
 * neither opens. True when it opened somewhere.
 */
export const openWebPath = (io: Io, home: string, target: Target, path: string): boolean => {
  const sameAsDesktop = target.source === "local" || (target.source === "saved" && target.from.endsWith("environments.json"));
  const app = sameAsDesktop ? desktop(home) : undefined;
  if (app !== undefined) {
    spawn(app[0]!, [...app.slice(1), `${DEEP_LINK_SCHEME}://${path.replace(/^\/+/, "")}`], { detached: true, stdio: "ignore" })
      .on("error", () => {})
      .unref();
    return true;
  }
  const url = appUrl(target.url, path, target.token);
  if (io.open === undefined) return false;
  io.open(url);
  return true;
};
