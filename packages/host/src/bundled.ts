import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@lemma/core";
import agentCli from "@lemma/agent-cli";
import agentLoop from "@lemma/agent-loop";
import agentProfiles from "@lemma/agent-profiles";
import browserChromium from "@lemma/browser-chromium";
import browserTools from "@lemma/browser-tools";
import cliRegistry from "@lemma/cli-registry";
import commandsCli from "@lemma/commands-cli";
import commandsHost from "@lemma/commands-host";
import commandsRegistry from "@lemma/commands-registry";
import contextCompaction from "@lemma/context-compaction";
import contextPrune from "@lemma/context-prune";
import skillsFiles from "@lemma/skills-files";
import contextProject from "@lemma/context-project";
import credentialsFile from "@lemma/credentials-file";
import devtoolsTrace from "@lemma/devtools-trace";
import llmCli from "@lemma/llm-cli";
import llmCommands from "@lemma/llm-commands";
import llmPiAi from "@lemma/llm-pi-ai";
import mcpServers from "@lemma/mcp-servers";
import sessionsCli from "@lemma/sessions-cli";
import sessionsFiles from "@lemma/sessions-files";
import toolsAsk from "@lemma/tools-ask";
import toolsBash from "@lemma/tools-bash";
import toolsCodemode from "@lemma/tools-codemode";
import toolsEdit from "@lemma/tools-edit";
import toolsHtml from "@lemma/tools-html";
import toolsLemma from "@lemma/tools-lemma";
import toolsRead from "@lemma/tools-read";
import toolsRegistry from "@lemma/tools-registry";
import toolsSearchFff from "@lemma/tools-search-fff";
import toolsWrite from "@lemma/tools-write";
import transportServer from "@lemma/transport-server";
import workspaceCli from "@lemma/workspace-cli";
import workspaceCommands from "@lemma/workspace-commands";
import workspaceLocal from "@lemma/workspace-local";
import workspaceSearchFff from "@lemma/workspace-search-fff";

/** Bundled plugins that start off, each until a row turns it on: what changes behavior not yet measured to help everyone. */
export const optIn: ReadonlySet<string> = new Set(["context.prune"]);

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
  toolsSearchFff,
  toolsAsk,
  browserChromium,
  browserTools,
  toolsHtml,
  toolsLemma,
  mcpServers,
  sessionsFiles,
  agentLoop,
  agentProfiles,
  contextCompaction,
  contextPrune,
  contextProject,
  skillsFiles,
  workspaceLocal,
  workspaceSearchFff,
  workspaceCommands,
  commandsRegistry,
  commandsHost,
  devtoolsTrace,
  // The lemma command's: the commands and checks plugins add, then each domain's.
  cliRegistry,
  llmCli,
  sessionsCli,
  agentCli,
  workspaceCli,
  commandsCli,
  transportServer,
];

const domains = fileURLToPath(new URL("../../../domains/", import.meta.url));

/** Where each bundled plugin's code is: its package, `domains/<domain>/<name>` for the id `<domain>.<name>`. */
export const bundledCode = (plugins: readonly Plugin[]): readonly { readonly path: string; readonly id: string }[] =>
  plugins.flatMap((plugin) => {
    const [domain, name, ...rest] = plugin.id.split(".");
    return domain === undefined || name === undefined || rest.length > 0 ? [] : [{ path: join(domains, domain, name), id: plugin.id }];
  });

/**
 * The bundled web halves' ids: the web app runs them (`apps/web/src/bundled.ts`), and a row naming one is a plugin's,
 * not a typo. Listed rather than read from disk, so a host built elsewhere knows them; `tests/bundled.test.ts` checks
 * the list against the domains' manifests.
 */
export const bundledWeb: readonly string[] = [
  "actions.keymap",
  "actions.keys-page",
  "actions.palette",
  "agent.loop",
  "agent.profiles",
  "commands.client",
  "context.compaction",
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
  "integrations.page",
  "llm.client",
  "llm.model-picker",
  "llm.providers",
  "look.appearance",
  "look.appearance-page",
  "look.diagrams",
  "look.file-icons",
  "look.highlight",
  "look.kit",
  "mcp.servers",
  "settings.page",
  "settings.plugins",
  "skills.files",
  "threads.browser",
  "threads.client",
  "threads.composer",
  "threads.prompt-commands",
  "threads.trajectory",
  "threads.transcript",
  "threads.view",
  "tools.ask",
  "tools.bash",
  "tools.codemode",
  "tools.edit",
  "tools.html",
  "tools.read",
  "tools.search-fff",
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
