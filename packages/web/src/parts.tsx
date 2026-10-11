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
    // Children the part calls (a popover's, given its close) draw what they return as the caller's; others are read
    // lazily, inside the caller's context, as the provider draws them.
    const given = Object.getOwnPropertyDescriptor(props, "children");
    const children =
      given !== undefined && "value" in given && typeof given.value === "function"
        ? {
            children: (...args: unknown[]) => (
              <PluginOwner.Provider value={caller}>{(given.value as (...args: unknown[]) => JSX.Element)(...args)}</PluginOwner.Provider>
            ),
          }
        : {
            get children() {
              return <PluginOwner.Provider value={caller}>{props.children}</PluginOwner.Provider>;
            },
          };
    return <First slot={part} props={mergeProps(props, children) as never} />;
  };
