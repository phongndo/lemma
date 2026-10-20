import { Show } from "solid-js";
import { Layers } from "@lemma/frame";
import { ImageIcon } from "@lemma/look";
import { ToolViews, Views } from "@lemma/threads";
import type { ThreadViewProps } from "@lemma/threads";
import { Router, Slots, defineWebPlugin } from "@lemma/web";
import { PAGE_VIEW, PageTab, PageViewer, createPages } from "./pages.tsx";
import { htmlRenderView } from "./view.tsx";
import styles from "./html.css?inline";

/**
 * The web half of `tools.html`: `html_render`'s pages, drawn in the chat, and how its calls show; a page full screen,
 * over the app; and a page in a tab of the thread's pane (`Page`, P in its + menu), opened through the thread's address
 * (`ThreadRoute`), so it needs nothing of the pane's plugin, and draws its pages without one. It runs while the tool
 * does.
 */
export default defineWebPlugin({
  id: "tools.html",
  styles,
  requires: { slots: Slots, router: Router },
  setup: ({ slots, router }, plugin) => {
    const pages = createPages({
      router,
      after: (ms, run) => void plugin.after(ms, run),
      listen: (target, type, listener) => void plugin.listen(target, type, listener),
    });
    slots.add(ToolViews, { id: "html_render", ...htmlRenderView(pages) });
    slots.add(Views, {
      id: PAGE_VIEW,
      order: 30,
      title: "Page",
      icon: ImageIcon,
      letter: "p",
      label: (tab) => {
        const key = pages.tabPage(tab);
        return pages.drawn().find((page) => page.key === key)?.page.title;
      },
      component: (props: ThreadViewProps) => <PageTab tab={props.tab} pages={pages} />,
    });
    slots.add(Layers, {
      id: "html.viewer",
      order: 20,
      component: () => <Show when={pages.viewing()}>{(page) => <PageViewer page={page()} onClose={() => pages.view(undefined)} />}</Show>,
    });
  },
});
