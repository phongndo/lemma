import { Show, createSignal } from "solid-js";
import { Layers } from "@lemma/frame";
import { CodeBlocks, Dialog, LOOK_PLUGINS } from "@lemma/look";
import { Slots, defineWebPlugin } from "@lemma/web";
import { currentToken, onLookChange, tokenColor } from "@lemma/web/paint";
import type { DiagramLook } from "./pele.ts";
import { viewerScale } from "./viewer.ts";
import styles from "./diagrams.css?inline";

/**
 * How diagrams are drawn: in the page's colors, with each `--diagram-*` token
 * a look sets over them; a plain color is all an image can take.
 */
const diagramLook = (): DiagramLook => {
  const color = (token: string, fallback: string, under = "--bg-raised") => tokenColor(currentToken(token) === "" ? fallback : token, under);
  return {
    font: currentToken("--font-ui"),
    colors: {
      background: color("--diagram-background", "--bg-raised", "--bg"),
      node: color("--diagram-node", "--bg-active"),
      border: color("--diagram-border", "--border-strong"),
      text: color("--diagram-text", "--text"),
      muted: tokenColor("--text-2", "--bg-raised"),
      line: color("--diagram-line", "--text-3"),
      note: color("--diagram-note", "--accent-soft"),
      accent: tokenColor("--accent", "--bg-raised"),
    },
  };
};

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
 * Mermaid diagrams for ```mermaid blocks, through the `markdown.code` slot,
 * drawn by Pele. A block is drawn once its fence closes (until then it streams
 * as code), and its source stays a click away. A diagram is drawn in the
 * page's colors, with any `--diagram-*` token the look sets over them
 * (`--diagram-node`, `--diagram-border`, `--diagram-line`, `--diagram-text`,
 * `--diagram-background`, `--diagram-note`), and drawn again when the look
 * changes. Pele loads on first use.
 */
export default defineWebPlugin({
  id: LOOK_PLUGINS.diagrams,
  styles,
  requires: { slots: Slots },
  setup: ({ slots }, plugin) => {
    /** Each diagram's source, to draw it again in another theme. */
    const sources = new WeakMap<HTMLImageElement, string>();
    let loading: Promise<typeof import("./pele.ts")> | undefined;
    const load = () => {
      const start = performance.now();
      return (loading ??= import("./pele.ts").then((module) => {
        performance.measure("lemma:diagram-load", { start });
        return module;
      }));
    };
    /** The look diagrams are drawn in, read once until it changes. */
    let look: DiagramLook | undefined;
    const draw = async (image: HTMLImageElement, code: string) => {
      const { renderDiagram } = await load();
      image.src = await renderDiagram(code, (look ??= diagramLook()));
    };
    const [viewing, setViewing] = createSignal<Viewing>();
    slots.add(Layers, {
      id: "diagram-viewer",
      order: 20,
      component: () => <Show when={viewing()}>{(shown) => <Viewer viewing={shown()} onClose={() => setViewing(undefined)} />}</Show>,
    });
    /** Its diagrams on the page, redrawn in the new colors when the look changes. */
    const drawn = new Set<HTMLImageElement>();
    const redraw = () => {
      look = undefined;
      for (const image of drawn) {
        if (!image.isConnected) {
          drawn.delete(image);
          continue;
        }
        const code = sources.get(image);
        if (code !== undefined) void draw(image, code).catch(() => {});
      }
    };
    plugin.onCleanup(onLookChange(redraw));
    slots.add(CodeBlocks, {
      id: "mermaid",
      order: 50,
      preview: true,
      match: (lang) => lang === "mermaid",
      render: async (block, target) => {
        if (!block.complete) {
          // A diagram is on its way: load Pele now, while the model writes it, not when it is done.
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
