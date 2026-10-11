import { Show, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { Layers } from "@lemma/frame";
import { Slots, defineWebPlugin, usePlugin } from "@lemma/web";
import styles from "./tooltips.css?inline";

const DELAY = 450;
/** Moving between controls within this window shows the next tooltip at once. */
const WARM = 400;
const MARGIN = 8;

/**
 * One tooltip for the whole app, driven by `data-tip` attributes, so the
 * browser's native `title` bubbles never appear. Shown on hover after a delay
 * and on keyboard focus; hidden on press, scroll, or key input.
 */
function TooltipLayer() {
  const [tip, setTip] = createSignal<{ text: string; x: number; y: number; below: boolean } | undefined>();
  let bubble: HTMLDivElement | undefined;
  let timer: number | undefined;
  let target: HTMLElement | undefined;
  let hiddenAt = 0;

  const hide = () => {
    window.clearTimeout(timer);
    if (tip() !== undefined) hiddenAt = Date.now();
    setTip(undefined);
    target = undefined;
  };
  const show = (element: HTMLElement) => {
    const text = element.dataset.tip;
    if (text === undefined || text === "" || !element.isConnected) return;
    const rect = element.getBoundingClientRect();
    const below = rect.top < 40;
    setTip({ text, x: rect.left + rect.width / 2, y: below ? rect.bottom + 6 : rect.top - 6, below });
    // Clamp horizontally once the bubble has a width.
    requestAnimationFrame(() => {
      if (bubble === undefined) return;
      const width = bubble.offsetWidth;
      const left = Math.max(MARGIN, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - MARGIN));
      bubble.style.left = `${left}px`;
      bubble.style.visibility = "visible";
    });
  };
  const schedule = (element: HTMLElement) => {
    if (element === target) return;
    window.clearTimeout(timer);
    target = element;
    const warm = tip() !== undefined || Date.now() - hiddenAt < WARM;
    setTip(undefined);
    timer = window.setTimeout(() => show(element), warm ? 0 : DELAY);
  };

  const onOver = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const element = (event.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    if (element === null) {
      if (target !== undefined) hide();
      return;
    }
    schedule(element);
  };
  const onFocus = (event: FocusEvent) => {
    const element = event.target as HTMLElement;
    if (element.matches?.(":focus-visible") && element.dataset.tip !== undefined) schedule(element);
  };
  const plugin = usePlugin();
  for (const remove of [
    plugin.listen(document, "pointerover", onOver),
    plugin.listen(document, "focusin", onFocus),
    plugin.listen(document, "focusout", hide),
    plugin.listen(document, "pointerdown", hide, { capture: true }),
    plugin.listen(document, "keydown", hide, { capture: true }),
    plugin.listen(window, "scroll", hide, { capture: true }),
    plugin.listen(window, "blur", hide),
  ]) {
    onCleanup(remove);
  }
  onCleanup(() => window.clearTimeout(timer));

  return (
    <Show when={tip()} keyed>
      {(current) => (
        <Portal>
          <div
            ref={bubble}
            class="tooltip"
            classList={{ below: current.below }}
            role="tooltip"
            style={{ top: `${current.y}px`, left: `${current.x}px`, visibility: "hidden" }}
          >
            {current.text}
          </div>
        </Portal>
      )}
    </Show>
  );
}

/** Shows `data-tip` attributes as tooltips, for every plugin's controls. */
export default defineWebPlugin({
  id: "frame.tooltips",
  styles,
  requires: { slots: Slots },
  setup: ({ slots }) => {
    slots.add(Layers, { id: "tooltips", order: 200, component: TooltipLayer });
  },
});
