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
 * The bundled web halves' ids: the web app runs them (`apps/web/src/bundled.ts`), and a row naming one is a plugin's,
 * not a typo. Listed rather than read from disk, so a host built elsewhere knows them; `tests/bundled.test.ts` checks
 * the list against the domains' manifests.
 */
export const bundledWeb: readonly string[] = [
  "actions.keymap",
  "actions.keys-page",
  "actions.palette",
  "commands.client",
  "devtools.dock",
  "devtools.trace",
  "frame.connection",
  "frame.dialogs",
  "frame.pages",
  "frame.questions",
  "frame.reload",
  "frame.shell",
  "frame.sidebar",
  "frame.toasts",
  "frame.tooltips",
  "llm.client",
  "llm.model-picker",
  "llm.providers",
  "look.appearance",
  "look.appearance-page",
  "look.diagrams",
  "look.file-icons",
  "look.highlight",
  "look.kit",
  "settings.page",
  "settings.plugins",
  "threads.archived",
  "threads.client",
  "threads.composer",
  "threads.trajectory",
  "threads.transcript",
  "threads.view",
  "tools.bash",
  "tools.edit",
  "tools.read",
  "tools.write",
  "workspace.add-project",
  "workspace.bar",
  "workspace.client",
  "workspace.file-mentions",
  "workspace.projects",
];

/**
 * Config the app supplies for bundled plugins (the planner's `defaults`): it
 * stays beneath a file's `config` object key by key, so setting the
 * transport's port does not also unset the web app.
 */
export const appDefaults: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "transport.server": { staticDir: webDist },
  "agent.loop": { cli: cliCommand },
};
