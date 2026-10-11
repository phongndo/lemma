import { For, createMemo } from "solid-js";
import type { Component, JSX } from "solid-js";
import { First } from "./draw.tsx";
import { highlight } from "./match.ts";
import type { Part } from "./slots.ts";

/**
 * How plugins draw parts (see `definePart`). Each export renders whatever
 * currently fills its part, so replacing a part changes it everywhere at
 * once, and a part that nothing fills renders its plain fallback, or nothing
 * when it declares none. The boot provides the registry to the whole page
 * through `SlotsContext`.
 */

export { Contained, Each, First, Isolated, SlotsContext } from "./draw.tsx";

/** `text` with the characters at `matches` (a search's hits) marked. */
export function Highlighted(props: { readonly text: string; readonly matches: readonly number[] }): JSX.Element {
  const parts = createMemo(() => highlight(props.text, props.matches));
  return <For each={parts()}>{(part) => (part.hit ? <mark>{part.text}</mark> : part.text)}</For>;
}

/** A component that renders `part`'s current provider with its props: its default when a replacement throws, its fallback when nothing provides it. */
export const partView =
  <P extends Record<string, any>>(part: Part<P>): Component<P> =>
  (props) => <First slot={part} props={props as never} />;
