import { Show, createSignal } from "solid-js";
import { pickSvg, readSvg } from "@lemma/look";
import type { PictureProps, SvgDropProps, SvgFile } from "@lemma/look";
import { usePlugin } from "@lemma/web";

/**
 * `PicturePart`: the image, or its fallback once there is none that loads. With a dark one, both are drawn and the
 * stylesheet hides the one the theme does not use (`.picture-light`, `.picture-dark`); one that fails to load goes, the
 * other standing in for it.
 */
export function Picture(props: PictureProps) {
  const [failed, setFailed] = createSignal<readonly string[]>([]);
  const usable = (src: string | undefined) => (src === undefined || failed().includes(src) ? undefined : src);
  const image = (src: string, shownOn: "light" | "dark" | undefined) => (
    <img
      class={shownOn === undefined ? undefined : `picture-${shownOn}`}
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      on:error={() => setFailed((all) => [...all, src])}
    />
  );
  const both = () => usable(props.src) !== undefined && usable(props.dark) !== undefined;
  return (
    <Show when={usable(props.src) ?? usable(props.dark)} fallback={props.fallback}>
      <Show when={usable(props.src)}>{(src) => image(src(), both() ? "light" : undefined)}</Show>
      <Show when={usable(props.dark)}>{(dark) => image(dark(), both() ? "dark" : undefined)}</Show>
    </Show>
  );
}

/** `SvgDropPart`: a button that reads the SVG file picked with a click, or dropped on it. */
export function SvgDrop(props: SvgDropProps) {
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
