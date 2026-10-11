import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@lemma/core";
import agentLoop from "@lemma/agent-loop";
import commandsHost from "@lemma/commands-host";
import commandsRegistry from "@lemma/commands-registry";
import contextCompaction from "@lemma/context-compaction";
import contextProject from "@lemma/context-project";
import credentialsFile from "@lemma/credentials-file";
import devtoolsTrace from "@lemma/devtools-trace";
import llmCommands from "@lemma/llm-commands";
import llmPiAi from "@lemma/llm-pi-ai";
import sessionsFiles from "@lemma/sessions-files";
import toolsBash from "@lemma/tools-bash";
import toolsCodemode from "@lemma/tools-codemode";
import toolsEdit from "@lemma/tools-edit";
import toolsRead from "@lemma/tools-read";
import toolsRegistry from "@lemma/tools-registry";
import toolsWrite from "@lemma/tools-write";
import transportServer from "@lemma/transport-server";
import workspaceCommands from "@lemma/workspace-commands";
import workspaceLocal from "@lemma/workspace-local";
import workspaceSearchFff from "@lemma/workspace-search-fff";

/** The web app build the transport serves when no `staticDir` is configured. */
export const webDist = fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));

/** How the agent runs this checkout's `lemma` CLI from its shell; `node` is on PATH wherever the host runs. */
export const cliCommand = `node --conditions=lemma-source ${fileURLToPath(new URL("../../../apps/cli/src/main.ts", import.meta.url))}`;

/**
 * Everything a fresh install runs. What the host provides itself (`Paths`,
 * `HostControl`, `Interaction`, `Trace`, the host API) is its runtime, not a plugin.
 */
export const bundled: readonly Plugin[] = [
  credentialsFile,
  llmPiAi,
  llmCommands,
  toolsRegistry,
  toolsRead,
  toolsWrite,
  toolsEdit,
  toolsBash,
  toolsCodemode,
  sessionsFiles,
  agentLoop,
  contextCompaction,
  contextProject,
  workspaceLocal,
  workspaceSearchFff,
  workspaceCommands,
  commandsRegistry,
  commandsHost,
  devtoolsTrace,
  transportServer,
];

/**
 * The bundled web halves' ids, read from the domains' manifests: a package in `domains/<domain>/<name>` whose
 * package.json names a web half (`lemma.web`) is the plugin `<domain>.<name>`. The host plans no web half, but a row
 * naming one is a plugin's, not a typo (see `elsewhere` in main.ts).
 */
export const bundledWebIds: readonly string[] = (() => {
  const domains = fileURLToPath(new URL("../../../domains", import.meta.url));
  const ids: string[] = [];
  const list = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      return [];
    }
  };
  for (const domain of list(domains)) {
    for (const name of list(join(domains, domain.name))) {
      try {
        const manifest = JSON.parse(readFileSync(join(domains, domain.name, name.name, "package.json"), "utf8")) as {
          readonly lemma?: { readonly web?: unknown };
        };
        if (typeof manifest.lemma?.web === "string") ids.push(`${domain.name}.${name.name}`);
      } catch {
        // Not a package.
      }
    }
  }
  return ids.sort();
})();

/**
 * Config the app supplies for bundled plugins (the planner's `defaults`): it
 * stays beneath a file's `config` object key by key, so setting the
 * transport's port does not also unset the web app.
 */
export const appDefaults: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "transport.server": { staticDir: webDist },
  "agent.loop": { cli: cliCommand },
};
