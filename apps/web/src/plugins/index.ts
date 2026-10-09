import type { Plugin } from "@lemma/core";
import addProject from "./add-project.tsx";
import appearance from "./appearance/index.ts";
import appearancePage from "./appearance-page/index.tsx";
import archivedPage from "./archived-page.tsx";
import chat from "./chat/index.tsx";
import commands from "./commands.ts";
import composer from "./composer.tsx";
import connection from "./connection.tsx";
import diagrams from "./diagrams.tsx";
import dialogs from "./dialogs.ts";
import devtools from "./devtools/index.tsx";
import fileIcons from "./file-icons.tsx";
import fileMentions from "./file-mentions.tsx";
import highlight from "./highlight.ts";
import interactionDialog from "./interaction-dialog.tsx";
import keymap from "./keymap.ts";
import keysPage from "./keys-page.tsx";
import kit from "./kit.tsx";
import modelPicker from "./model-picker.tsx";
import models from "./models.ts";
import pages from "./pages.tsx";
import palette from "./palette.tsx";
import pluginsPage from "./plugins-page.tsx";
import projectsPage from "./projects-page.tsx";
import providers from "./providers/index.tsx";
import reload from "./reload.tsx";
import threadView from "./thread-view.tsx";
import threads from "./threads.ts";
import settings from "./settings.tsx";
import shell from "./shell.tsx";
import sidebar from "./sidebar.tsx";
import toasts from "./toasts.tsx";
import tooltips from "./tooltips.tsx";
import trajectory from "./trajectory/index.tsx";
import workspaceBar from "./workspace-bar.tsx";
import workspace from "./workspace.ts";

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
