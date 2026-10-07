import { fileURLToPath } from "node:url";
import type { Plugin } from "@lemma/core";
import agent from "@lemma/plugin-agent";
import commands from "@lemma/plugin-commands";
import compaction from "@lemma/plugin-compaction";
import * as builtinCommands from "@lemma/plugin-commands-builtin";
import credentials from "@lemma/plugin-credentials";
import fileSearch from "@lemma/plugin-file-search-fff";
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

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Use the host's runtime even in an install with no Node on PATH. Quote paths for the agent's shell. */
export const cliCommand = `${process.versions.electron ? "ELECTRON_RUN_AS_NODE=1 " : ""}${quote(process.execPath)} --conditions=lemma-source ${quote(fileURLToPath(new URL("../../../apps/cli/src/main.ts", import.meta.url)))}`;

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
    fileSearch,
    commands,
    builtinCommands.host,
    builtinCommands.llm,
    builtinCommands.workspace,
    transport,
  ];
}

/**
 * Config the app supplies for bundled plugins (the planner's `defaults`): it
 * stays beneath a file's `config` object key by key, so setting the
 * transport's port does not also unset the web app.
 */
export const appDefaults: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  transport: { staticDir: webDist },
  agent: { cli: cliCommand },
};
