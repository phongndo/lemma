import type { Plugin } from "@lemma/core";
import addProject from "./add-project.tsx";
import appearance from "./appearance.tsx";
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
import hostPlugins from "./host-plugins.ts";
import interactionDialog from "./interaction-dialog.tsx";
import interactions from "./interactions.ts";
import keymap from "./keymap.ts";
import keysPage from "./keys-page.tsx";
import kit from "./kit.tsx";
import modelPicker from "./model-picker.tsx";
import models from "./models.ts";
import notify from "./notify.ts";
import pages from "./pages.tsx";
import palette from "./palette.tsx";
import pluginsPage from "./plugins-page.tsx";
import projectsPage from "./projects-page.tsx";
import providers from "./providers/index.tsx";
import reload from "./reload.tsx";
import router from "./router.ts";
import threadView from "./thread-view.tsx";
import threads from "./threads.ts";
import settings from "./settings.tsx";
import shell from "./shell.tsx";
import sidebar from "./sidebar.tsx";
import slots from "./slots.ts";
import toasts from "./toasts.tsx";
import tooltips from "./tooltips.tsx";
import trajectory from "./trajectory/index.tsx";
import workspaceBar from "./workspace-bar.tsx";
import workspace from "./workspace.ts";

/**
 * The web app as shipped, every part a plugin: models of host state first,
 * then the frame and what fills it. Each can be turned off (`ui` rows, the
 * Plugins page, `lemma ui disable`) or replaced by a plugin from a UI file.
 * The boot adds `client` (the connection) and `app` (runs this list).
 */
export const bundled: readonly Plugin[] = [
  slots,
  router,
  kit,
  fileIcons,
  notify,
  toasts,
  threads,
  models,
  workspace,
  hostPlugins,
  commands,
  interactions,
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
  projectsPage,
  archivedPage,
  addProject,
  devtools,
  interactionDialog,
  tooltips,
];
