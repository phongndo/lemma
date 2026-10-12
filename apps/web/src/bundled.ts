import type { Plugin } from "@lemma/core";
import addProject from "@lemma/workspace-add-project";
import appearance from "@lemma/look-appearance";
import appearancePage from "@lemma/look-appearance-page";
import archivedPage from "@lemma/threads-archived";
import chat from "@lemma/threads-transcript";
import commands from "@lemma/commands-client";
import composer from "@lemma/threads-composer";
import connection from "@lemma/frame-connection";
import diagrams from "@lemma/look-diagrams";
import dialogs from "@lemma/frame-dialogs";
import devtools from "@lemma/devtools-dock";
import fileIcons from "@lemma/look-file-icons";
import fileMentions from "@lemma/workspace-file-mentions";
import highlight from "@lemma/look-highlight";
import interactionDialog from "@lemma/frame-questions";
import keymap from "@lemma/actions-keymap";
import keysPage from "@lemma/actions-keys-page";
import kit from "@lemma/look-kit";
import modelPicker from "@lemma/llm-model-picker";
import models from "@lemma/llm-client";
import pages from "@lemma/frame-pages";
import palette from "@lemma/actions-palette";
import pluginsPage from "@lemma/settings-plugins";
import projectsPage from "@lemma/workspace-projects";
import providers from "@lemma/llm-providers";
import reload from "@lemma/frame-reload";
import threadView from "@lemma/threads-view";
import threads from "@lemma/threads-client";
import settings from "@lemma/settings-page";
import shell from "@lemma/frame-shell";
import sidebar from "@lemma/frame-sidebar";
import toasts from "@lemma/frame-toasts";
import tooltips from "@lemma/frame-tooltips";
import trajectory from "@lemma/threads-trajectory";
import workspaceBar from "@lemma/workspace-bar";
import workspace from "@lemma/workspace-client";

/**
 * The web app as shipped, every part a plugin: models of host state first,
 * then the frame and what fills it. Each can be turned off (`ui` rows, the
 * Plugins page, `lemma ui disable`) or replaced by a plugin from a UI file.
 * The boot provides the runtime they are written against (`src/runtime/`:
 * the connection, slots, the router, messages, the plugins, questions); it is
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
  composer,
  fileMentions,
  modelPicker,
  workspaceBar,
  connection,
  reload,
  palette,
  settings,
  providers,
  pluginsPage,
  keysPage,
  appearancePage,
  projectsPage,
  archivedPage,
  addProject,
  devtools,
  interactionDialog,
  tooltips,
];
