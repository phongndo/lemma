import type { Plugin } from "@lemma/core";
import addProject from "@lemma/workspace-add-project";
import agentLoop from "@lemma/agent-loop/web";
import appearance from "@lemma/look-appearance";
import appearancePage from "@lemma/look-appearance-page";
import browser from "@lemma/threads-browser";
import chat from "@lemma/threads-transcript";
import commands from "@lemma/commands-client";
import composer from "@lemma/threads-composer";
import promptCommands from "@lemma/threads-prompt-commands";
import connection from "@lemma/frame-connection";
import compaction from "@lemma/context-compaction/web";
import diagrams from "@lemma/look-diagrams";
import dialogs from "@lemma/frame-dialogs";
import devtools from "@lemma/devtools-dock";
import trace from "@lemma/devtools-trace/web";
import fileIcons from "@lemma/look-file-icons";
import fileMentions from "@lemma/workspace-file-mentions";
import highlight from "@lemma/look-highlight";
import integrations from "@lemma/integrations-page";
import interactionDialog from "@lemma/frame-questions";
import keymap from "@lemma/actions-keymap";
import keysPage from "@lemma/actions-keys-page";
import kit from "@lemma/look-kit";
import mcp from "@lemma/mcp-servers/web";
import skills from "@lemma/skills-files/web";
import modelPicker from "@lemma/llm-model-picker";
import profiles from "@lemma/agent-profiles/web";
import models from "@lemma/llm-client";
import pages from "@lemma/frame-pages";
import palette from "@lemma/actions-palette";
import pluginsPage from "@lemma/settings-plugins";
import projectsPage from "@lemma/workspace-projects";
import providers from "@lemma/llm-providers";
import reload from "@lemma/frame-reload";
import release from "@lemma/release-updates/web";
import threadView from "@lemma/threads-view";
import ask from "@lemma/tools-ask/web";
import bash from "@lemma/tools-bash/web";
import codemode from "@lemma/tools-codemode/web";
import edit from "@lemma/tools-edit/web";
import html from "@lemma/tools-html/web";
import patch from "@lemma/tools-patch/web";
import read from "@lemma/tools-read/web";
import search from "@lemma/tools-search-fff/web";
import write from "@lemma/tools-write/web";
import threads from "@lemma/threads-client";
import settings from "@lemma/settings-page";
import shell from "@lemma/frame-shell";
import sidebar from "@lemma/frame-sidebar";
import toasts from "@lemma/frame-toasts";
import tooltips from "@lemma/frame-tooltips";
import trajectory from "@lemma/threads-trajectory";
import workspaceBar from "@lemma/workspace-bar";
import workspace from "@lemma/workspace-client";
import workspaceTidy from "@lemma/workspace-tidy/web";

/**
 * The web app as shipped, every part a plugin: models of host state first,
 * then the frame and what fills it, and the web halves of host plugins (the
 * tools' views). Each can be turned off (its row, the Plugins page, `lemma
 * plugins disable`) or replaced by a web half in the plugin directories. The
 * boot provides the runtime they are written against (`src/runtime/`: the
 * connection, slots, the router, messages, the plugins, questions); it is
 * not in this list and cannot be turned off.
 */
export const bundled: readonly Plugin[] = [
  kit,
  fileIcons,
  toasts,
  threads,
  models,
  workspace,
  commands,
  dialogs,
  keymap,
  appearance,
  shell,
  pages,
  sidebar,
  threadView,
  chat,
  highlight,
  diagrams,
  trajectory,
  browser,
  read,
  write,
  edit,
  patch,
  bash,
  codemode,
  search,
  ask,
  html,
  composer,
  promptCommands,
  fileMentions,
  skills,
  profiles,
  agentLoop,
  modelPicker,
  compaction,
  workspaceBar,
  workspaceTidy,
  connection,
  reload,
  palette,
  settings,
  providers,
  integrations,
  mcp,
  pluginsPage,
  keysPage,
  appearancePage,
  projectsPage,
  addProject,
  release,
  devtools,
  trace,
  interactionDialog,
  tooltips,
];
