import { For, createMemo, mergeProps, useContext } from "solid-js";
import type { Component, JSX } from "solid-js";
import { First } from "./draw.tsx";
import { highlight } from "./match.ts";
import { PluginOwner } from "./owner.ts";
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

/**
 * A component that renders `part`'s current provider with its props: its default when a replacement throws, its
 * fallback when nothing provides it. What the caller hands the part to draw, its `children`, stays the caller's: drawn
 * by the part's provider, but a component in it finds the caller's plugin with `usePlugin`.
 */
export const partView =
  <P extends Record<string, any>>(part: Part<P>): Component<P> =>
  (props) => {
    if (!("children" in props)) return <First slot={part} props={props as never} />;
    const caller = useContext(PluginOwner);
    /** `read`, run inside the caller's context: what it draws is the caller's, wherever the provider draws it. */
    const asCaller = <T,>(read: () => T): T => {
      let value!: T;
      <PluginOwner.Provider value={caller}>{(() => void (value = read()))()}</PluginOwner.Provider>;
      return value;
    };
    // Read lazily, as the provider reads them, however they were handed (a value, or a getter from a spread): children
    // the part calls (a popover's, given its close) stay a function, and draw what they return as the caller's.
    const children = {
      get children() {
        const given = asCaller(() => props.children as unknown);
        return typeof given === "function" ? (...args: unknown[]) => asCaller(() => (given as (...args: unknown[]) => JSX.Element)(...args)) : given;
      },
    };
    return <First slot={part} props={mergeProps(props, children) as never} />;
  };
