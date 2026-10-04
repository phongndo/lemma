import { fileURLToPath } from "node:url";
import type { Composition, Plugin, PluginEntry } from "@lemma/core";
import agent from "@lemma/plugin-agent";
import commands from "@lemma/plugin-commands";
import compaction from "@lemma/plugin-compaction";
import * as builtinCommands from "@lemma/plugin-commands-builtin";
import credentials from "@lemma/plugin-credentials";
import interaction from "@lemma/plugin-interaction";
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
 * Everything a fresh install runs. The host plugin is built by main.ts with a
 * closure over the loader, so it arrives as an argument.
 */
export function bundled(host: Plugin): readonly Plugin[] {
  return [
    host,
    interaction,
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
    commands,
    builtinCommands.host,
    builtinCommands.llm,
    builtinCommands.workspace,
    transport,
  ];
}

/** Config the app supplies for bundled plugins, beneath whatever a config file sets. */
const appConfig: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  transport: { staticDir: webDist },
  agent: { cli: cliCommand },
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The default composition is every bundled and local plugin, enabled with its
 * default config. Config files patch it by plugin id: `enabled: false` removes a
 * plugin, and a `config` object replaces the default config. App-supplied
 * config (the web app's `staticDir`, the agent's `cli`) stays underneath a file's
 * `config` object key by key, so setting the transport's port does not also unset the web app.
 */
export function withDefaults(ids: readonly string[], patch: Composition): Composition {
  const plugins: Record<string, PluginEntry> = {};
  for (const id of ids) plugins[id] = appConfig[id] === undefined ? {} : { config: appConfig[id] };
  for (const [id, row] of Object.entries(patch.plugins)) {
    const base = appConfig[id];
    plugins[id] = { ...plugins[id], ...row, ...(base !== undefined && isRecord(row.config) ? { config: { ...base, ...row.config } } : {}) };
  }
  return { plugins };
}
