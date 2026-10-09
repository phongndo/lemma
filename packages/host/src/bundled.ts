import { fileURLToPath } from "node:url";
import type { Plugin } from "@lemma/core";
import type { BundleManifest } from "@lemma/contracts/runtime";
import agent from "@lemma/plugin-agent";
import commands from "@lemma/plugin-commands";
import compaction from "@lemma/plugin-compaction";
import * as builtinCommands from "@lemma/plugin-commands-builtin";
import credentials from "@lemma/plugin-credentials";
import fileSearch from "@lemma/plugin-file-search-fff";
import llm from "@lemma/plugin-llm-pi-ai";
import projectContext from "@lemma/plugin-project-context";
import sessions from "@lemma/plugin-sessions";
import tools from "@lemma/plugin-tools";
import { bash, codemode, edit, read, write } from "@lemma/plugin-tools-builtin";
import transport from "@lemma/plugin-transport";
import workspace from "@lemma/plugin-workspace";

/** The web app build the transport serves when no `staticDir` is configured. */
export const webDist = fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));

/** How the agent runs this checkout's `lemma` CLI from its shell; `node` is on PATH wherever the host runs. */
export const cliCommand = `node --conditions=lemma-source ${fileURLToPath(new URL("../../../apps/cli/src/main.ts", import.meta.url))}`;

/**
 * Everything a fresh install runs. What the host provides itself (`Paths`,
 * `HostControl`, `Interaction`, the host API) is its runtime, not a plugin.
 */
export const bundled: readonly Plugin[] = [
  credentials,
  llm,
  tools,
  read,
  write,
  edit,
  bash,
  codemode,
  sessions,
  agent,
  compaction,
  projectContext,
  workspace,
  fileSearch,
  commands,
  builtinCommands.host,
  builtinCommands.llm,
  builtinCommands.workspace,
  transport,
];

/**
 * Config the app supplies for bundled plugins (the planner's `defaults`): it
 * stays beneath a file's `config` object key by key, so setting the
 * transport's port does not also unset the web app.
 */
export const appDefaults: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  transport: { staticDir: webDist },
  agent: { cli: cliCommand },
};

/** Application features are metadata only: ids, never lifecycle wrappers. */
export const appBundles: readonly BundleManifest[] = [
  {
    id: "conversation",
    title: "Conversations",
    description: "Agent conversations, models, history, and their views",
    enabledByDefault: true,
    host: ["agent", "sessions", "llm", "credentials", "tools"],
    ui: ["threads", "models", "workspace", "thread-view", "chat", "composer", "model-picker", "providers", "sidebar", "archived-page"],
  },
  {
    id: "workspace",
    title: "Workspace",
    description: "Projects, context, file search, and workspace controls",
    enabledByDefault: true,
    host: ["workspace", "sessions", "project-context", "file-search"],
    ui: ["threads", "workspace", "workspace-bar", "projects-page", "add-project", "file-mentions"],
  },
  {
    id: "builtin-tools",
    title: "Built-in tools",
    description: "Read, write, edit, shell, and code tools",
    enabledByDefault: true,
    host: ["tools", "read", "write", "edit", "bash", "codemode"],
    ui: [],
  },
  {
    id: "commands",
    title: "Commands",
    description: "Host, model, and workspace commands and command palette",
    enabledByDefault: true,
    host: ["commands", "commands-host", "commands-llm", "commands-workspace"],
    ui: ["commands", "palette"],
  },
  { id: "compaction", title: "Compaction", description: "Compact conversation context", enabledByDefault: true, host: ["compaction"], ui: [] },
  {
    id: "appearance",
    title: "Appearance",
    description: "Theme and appearance settings",
    enabledByDefault: true,
    host: [],
    ui: ["appearance", "appearance-page"],
  },
  {
    id: "developer-tools",
    title: "Developer tools",
    description: "Inspect runtime activity and conversation trajectories",
    enabledByDefault: true,
    host: [],
    ui: ["devtools", "trajectory"],
  },
];
