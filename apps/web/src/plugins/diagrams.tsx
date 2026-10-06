import { Show, createSignal } from "solid-js";
import { CodeBlocks, Layers, Slots } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { Dialog } from "../ui/parts.tsx";
import { currentTheme, onThemeChange } from "../lib/paint.ts";
import { viewerScale } from "../model/viewer.ts";
import styles from "./diagrams.css?inline";

const dark = () => currentTheme() === "dark";

/** Resolves when the browser has a moment between frames, so Mermaid's synchronous work does not land in one mid-stream. */
const idle = (): Promise<void> =>
  new Promise((resolve) => (typeof requestIdleCallback === "function" ? requestIdleCallback(() => resolve(), { timeout: 1_000 }) : setTimeout(resolve, 0)));

/** Room the viewer's dialog takes around a diagram, in pixels. */
const VIEWER_MARGIN = 160;
interface Viewing {
  readonly src: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
}

/**
 * A diagram in a dialog over the page, as large as is useful (see
 * `viewerScale`); clicking it switches to its drawn size and back. Drawn
 * with the `dialog` part, which closes it on Escape, the close button, or a
 * click outside.
 */
function Viewer(props: { viewing: Viewing; onClose: () => void }) {
  const scale = viewerScale(props.viewing.width, props.viewing.height, window.innerWidth - VIEWER_MARGIN, window.innerHeight - VIEWER_MARGIN);
  const [actual, setActual] = createSignal(false);
  return (
    <Dialog title="Diagram" class="diagram-dialog" onClose={props.onClose}>
      <img
        class="diagram-full"
        src={props.viewing.src}
        alt={props.viewing.alt}
        style={{ width: `${Math.round(props.viewing.width * (actual() ? 1 : scale))}px` }}
        data-tip={scale === 1 ? undefined : actual() ? "Enlarge" : "Actual size"}
        onClick={() => scale !== 1 && setActual(!actual())}
      />
    </Dialog>
  );
}

/**
 * Mermaid diagrams for ```mermaid blocks, through the `markdown.code` slot.
 * A block is drawn once its fence closes (until then it streams as code),
 * and its source stays a click away. Diagrams on the page are drawn again
 * in the new colors when the theme changes. Mermaid loads on first use.
 */
export default defineUiPlugin({
  id: "diagrams",
  styles,
  requires: { slots: Slots },
  setup: ({ slots }, plugin) => {
    /** Each diagram's source, to draw it again in another theme. */
    const sources = new WeakMap<HTMLImageElement, string>();
    let loading: Promise<typeof import("../lib/mermaid.ts")> | undefined;
    const load = () => {
      const start = performance.now();
      return (loading ??= idle().then(async () => {
        const module = await import("../lib/mermaid.ts");
        performance.measure("lemma:mermaid-load", { start });
        return module;
      }));
    };
    const draw = async (image: HTMLImageElement, code: string) => {
      const { renderDiagram } = await load();
      await idle();
      image.src = await renderDiagram(code, dark());
    };
    const [viewing, setViewing] = createSignal<Viewing>();
    slots.add(Layers, {
      id: "diagram-viewer",
      component: () => <Show when={viewing()}>{(shown) => <Viewer viewing={shown()} onClose={() => setViewing(undefined)} />}</Show>,
    });
    /** Its diagrams on the page, redrawn in the new colors when the theme changes. */
    const drawn = new Set<HTMLImageElement>();
    const redraw = () => {
      for (const image of drawn) {
        if (!image.isConnected) {
          drawn.delete(image);
          continue;
        }
        const code = sources.get(image);
        if (code !== undefined) void draw(image, code).catch(() => {});
      }
    };
    plugin.onCleanup(onThemeChange(redraw));
    slots.add(CodeBlocks, {
      id: "mermaid",
      order: 50,
      preview: true,
      match: (lang) => lang === "mermaid",
      render: async (block, target) => {
        if (!block.complete) {
          // A diagram is on its way: load Mermaid now, while the model writes it, not when it is done.
          void load().catch(() => {});
          return;
        }
        if (block.code.trim() === "") return;
        const image = document.createElement("img");
        image.className = "mermaid-diagram";
        image.alt = "Mermaid diagram";
        image.dataset.tip = "Open";
        image.addEventListener("click", () => setViewing({ src: image.src, alt: image.alt, width: image.naturalWidth, height: image.naturalHeight }));
        await draw(image, block.code);
        sources.set(image, block.code);
        drawn.add(image);
        target.append(image);
      },
    });
  },
});
