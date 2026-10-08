import { ErrorBoundary, For, Show, createContext, useContext } from "solid-js";
import type { Accessor, Component, JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Region, Slot, SlotItem, SlotsService } from "./slots.ts";

/*
 * Drawing what slots hold. Everything a slot item brings is drawn contained:
 * a throw while it draws is reported as a fault of the plugin that added it
 * (`Slots.fail`), which leaves the slot's views, so a region shows its next
 * item, a part its default, and a list closes up, while the rest of the page
 * keeps drawing and updating. Plugins draw slot items through these, never
 * with a bare `Dynamic`; `ui/parts.tsx` re-exports them beside the parts.
 */

/** The page's slots, for whatever draws below: the boot provides them to the whole page. */
export const SlotsContext = createContext<Accessor<SlotsService | undefined>>(() => undefined);

/** `component` (an item's, or a piece of one: its icon, its intro) with `props`, drawn for `item` of `slot`, contained. */
export function Contained<P extends Record<string, any>>(props: {
  readonly slot: Slot<any>;
  readonly item: SlotItem<any>;
  readonly component: Component<P> | undefined;
  readonly props?: P;
}): JSX.Element {
  const slots = useContext(SlotsContext);
  return (
    <ErrorBoundary
      fallback={(error) => {
        // After this draw: the item leaving changes what the slot's readers draw.
        queueMicrotask(() => {
          const service = slots();
          if (service === undefined) console.error(`lemma ui: an item of ${props.slot.name} failed`, error);
          else service.fail(props.slot, props.item, error);
        });
        return null;
      }}
    >
      <Dynamic component={props.component} {...(props.props ?? ({} as P))} />
    </ErrorBoundary>
  );
}

/**
 * `component` with `props`, or nothing when it throws (logged): for a
 * component handed over as data, such as a completion's icon, whose throw must
 * not count against whoever draws it.
 */
export function Isolated<P extends Record<string, any>>(props: { readonly component: Component<P> | undefined; readonly props?: P }): JSX.Element {
  return (
    <ErrorBoundary
      fallback={(error) => {
        console.error("lemma ui: a component handed to another plugin failed", error);
        return null;
      }}
    >
      <Dynamic component={props.component} {...(props.props ?? ({} as P))} />
    </ErrorBoundary>
  );
}

/** The props a region's components take. */
type PropsOf<T> = T extends Region<infer P> ? P : never;

/** Every item of a list of components, in order, each contained; `filter` picks some. */
export function Each<T extends Region<any>>(props: {
  readonly slot: Slot<T>;
  readonly props?: PropsOf<T>;
  readonly filter?: (item: SlotItem<T>) => boolean;
}): JSX.Element {
  const slots = useContext(SlotsContext);
  const items = () => (slots()?.list(props.slot) ?? []).filter((item) => props.filter?.(item) ?? true);
  return (
    <For each={items()}>
      {(item) => <Contained slot={props.slot} item={item} component={item.component} {...(props.props === undefined ? {} : { props: props.props })} />}
    </For>
  );
}

/** The first working item of a region (or part), contained: when it throws, the next one shows; `fallback` when none does. */
export function First<T extends Region<any>>(props: { readonly slot: Slot<T>; readonly props?: PropsOf<T>; readonly fallback?: JSX.Element }): JSX.Element {
  const slots = useContext(SlotsContext);
  return (
    <Show when={slots()?.first(props.slot)} keyed fallback={props.fallback}>
      {(item) => <Contained slot={props.slot} item={item} component={item.component} {...(props.props === undefined ? {} : { props: props.props })} />}
    </Show>
  );
}
