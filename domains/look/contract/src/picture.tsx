import { Show, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { usePlugin } from "@lemma/web";
import { currentTheme, onThemeChange } from "@lemma/web/paint";
import { pickSvg, readSvg } from "./svg.ts";
import type { SvgFile } from "./svg.ts";

/*
 * Images from addresses plugins and people give: plain elements, which the plugin drawing them styles through its own
 * class. Handlers bind to their element (`on:error`), not through Solid's page-wide delegation, which runs when the
 * module loads: a contract loads without a page too, in the tests.
 */

/**
 * An image, or `fallback` while there is none or it fails to load (an address that is gone, an image that is not one);
 * with `dark`, that one on a dark theme. Fetched once in view, without telling its host the page it is on.
 */
export function Picture(props: { readonly src: string | undefined; readonly dark?: string | undefined; readonly fallback: JSX.Element }) {
  const [theme, setTheme] = createSignal(currentTheme());
  onCleanup(onThemeChange((next) => setTheme(next)));
  const [failed, setFailed] = createSignal<readonly string[]>([]);
  const usable = (src: string | undefined) => (src === undefined || failed().includes(src) ? undefined : src);
  const shown = () => (theme() === "dark" ? usable(props.dark) : undefined) ?? usable(props.src);
  return (
    <Show when={shown()} keyed fallback={props.fallback}>
      {(src) => <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" on:error={() => setFailed((all) => [...all, src])} />}
    </Show>
  );
}

/**
 * A button that takes an SVG file of the person's own, picked with a click or dropped on it, holding what the caller
 * draws in it (the image, or words): the file's text goes to `onSvg`, and what is wrong with a file that is not one to
 * take (or nothing, once one is) to `onProblem`. It is `data-over` while a file is dragged over it.
 */
export function SvgDrop(props: {
  readonly class?: string;
  /** Its accessible name, when what it holds gives none. */
  readonly label?: string;
  readonly tip?: string;
  readonly onSvg: (svg: string) => void;
  readonly onProblem: (problem: string | undefined) => void;
  readonly children: JSX.Element;
}) {
  const [over, setOver] = createSignal(false);
  const take = usePlugin().action("read an SVG file", async (reading: Promise<SvgFile | undefined>) => {
    const read = await reading;
    if (read === undefined) return;
    props.onProblem("problem" in read ? read.problem : undefined);
    if ("svg" in read) props.onSvg(read.svg);
  });
  return (
    <button
      type="button"
      class={props.class}
      aria-label={props.label}
      data-tip={props.tip}
      data-over={over() ? "" : undefined}
      on:click={() => take(pickSvg())}
      on:dragover={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      on:dragleave={() => setOver(false)}
      on:drop={(event) => {
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer?.files[0];
        if (file !== undefined) take(readSvg(file));
      }}
    >
      {props.children}
    </button>
  );
}
