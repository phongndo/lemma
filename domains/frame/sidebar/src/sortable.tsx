import type { JSX } from "solid-js";
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid";
import { useSortable } from "@dnd-kit/solid/sortable";
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom";
import { RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import type { Section } from "./list.ts";

/** An item of the list drag and drop arranges: a thread, which drags, or a section's head, which stays. */
export function SortableItem(props: { id: string; index: number; section: Section | undefined; head?: boolean; class?: string; children: JSX.Element }) {
  const sortable = useSortable({
    get id() {
      return props.id;
    },
    get index() {
      return props.index;
    },
    get disabled() {
      return props.head === true ? { draggable: true, droppable: false } : false;
    },
  });
  return (
    <li ref={sortable.ref} class={props.class} classList={{ "drag-source": sortable.isDragSource() }} data-section={props.section}>
      {props.children}
    </li>
  );
}

/**
 * The list's drag and drop: a thread follows the pointer up and down the list, the others make room, and where it is
 * when dropped says what the drop does (`dropped`). `over` hears each item it is dragged onto, and the list moves it
 * (`dragTo`) rather than the sortable moving rows itself. Only the pointer moves it: an item it is over goes past it
 * only while the pointer heads that way (`above` says which way the item is), so rows the sections' names push under a
 * still pointer do not move it.
 */
export function SortableThreads(props: {
  list: () => HTMLElement | undefined;
  start: (id: string) => void;
  above: (id: string) => boolean | undefined;
  /** What it is dragged onto: an item, itself again, or nothing (`undefined`). */
  over: (id: string | undefined) => void;
  end: (canceled: boolean) => void;
  children: JSX.Element;
}) {
  let y: number | undefined;
  let up: boolean | undefined;
  /** The item it is over, until the pointer heads its way. */
  let waiting: string | undefined;
  const settle = () => {
    if (waiting === undefined || up === undefined) return;
    const above = props.above(waiting);
    if (above !== undefined && above !== up) return;
    props.over(waiting);
    waiting = undefined;
  };
  return (
    <DragDropProvider
      sensors={[
        PointerSensor.configure({
          activationConstraints: (event) => [new PointerActivationConstraints.Distance({ value: event.pointerType === "touch" ? 10 : 6 })],
          // Its buttons and the title being renamed keep their own pointer.
          preventActivation: (event) => event.target instanceof Element && event.target.closest("button, input") !== null,
        }),
      ]}
      modifiers={[RestrictToVerticalAxis, RestrictToElement.configure({ element: () => props.list() ?? null })]}
      plugins={(defaults) => [
        ...defaults.filter((plugin) => plugin !== Accessibility),
        AutoScroller.configure({ acceleration: 8, threshold: { x: 0, y: 0.1 } }),
        Feedback.configure({ dropAnimation: null }),
      ]}
      onDragStart={(event) => {
        y = undefined;
        up = undefined;
        waiting = undefined;
        const source = event.operation.source;
        if (source !== null) props.start(source.id.toString());
      }}
      onDragMove={(event) => {
        const next = event.operation.position.current.y;
        if (y !== undefined && next !== y) up = next < y;
        y = next;
        settle();
      }}
      onDragOver={(event) => {
        // The list moves the thread itself.
        event.preventDefault();
        waiting = event.operation.target?.id.toString();
        if (waiting === undefined) props.over(undefined);
        else settle();
      }}
      onDragEnd={(event) => props.end(event.canceled)}
    >
      {props.children}
    </DragDropProvider>
  );
}
