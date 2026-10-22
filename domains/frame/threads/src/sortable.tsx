import { createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid";
import { useSortable } from "@dnd-kit/solid/sortable";
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom";
import { RestrictToHorizontalAxis, RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import type { SessionInfo } from "@lemma/sessions";
import { ArchiveIcon, PinIcon, PinOffIcon, RedoIcon } from "@lemma/look";
import { Heads, dragItems, dragTo, dropVerb, dropped, sectionIn } from "./list.ts";
import type { DropVerb, Section } from "./list.ts";
import type { Deps } from "./deps.ts";

/** The words a dragged thread shows for what dropping it where it is would do. */
export const verbs: Readonly<Record<DropVerb, () => JSX.Element>> = {
  pin: () => (
    <>
      <PinIcon />
      Pin
    </>
  ),
  unpin: () => (
    <>
      <PinOffIcon />
      Unpin
    </>
  ),
  archive: () => (
    <>
      <ArchiveIcon />
      Archive
    </>
  ),
  unarchive: () => (
    <>
      <RedoIcon />
      Unarchive
    </>
  ),
};

/**
 * The threads as drag and drop arranges them, the sidebar's and the tab strip's alike: each section's head, then its
 * threads (`dragItems`), held as dragged (`items`) from a drag's start until its drop's change lands, so the list does
 * not move under the pointer nor jump back while the change is on its way. The archived are not among the items: their
 * place (`Heads.archived`, a panel or a button) takes one dropped on it as a whole.
 */
export interface Arrangement {
  readonly items: () => readonly string[];
  /** The thread being dragged. */
  readonly dragging: () => string | undefined;
  /** The dragged thread is over the archived place: dropping it archives it. */
  readonly toArchive: () => boolean;
  /**
   * The sections' names show, a frame after a drag starts: the dragged thread is placed under the pointer first, so
   * what they push moves under it rather than taking it with them.
   */
  readonly heads: () => boolean;
  /** The section the dragged thread is in now, where dropping it puts it. */
  readonly target: () => Section | undefined;
  /** What dropping the dragged thread where it is now would do. */
  readonly verb: () => DropVerb | undefined;
  /** Each item's section, where it is now. */
  readonly sectionOf: (id: string) => Section | undefined;
  readonly sessionOf: (id: string) => SessionInfo | undefined;
  readonly start: (id: string) => void;
  /** Whether `over` is before the dragged thread; undefined for itself, or with none dragged. */
  readonly before: (over: string) => boolean | undefined;
  /** What it is dragged onto: an item, itself again, or nothing (`undefined`). */
  readonly over: (over: string | undefined) => void;
  readonly end: (canceled: boolean) => void;
}

export function createArrangement(deps: Deps): Arrangement {
  const byId = createMemo(() => new Map(deps.threads.list().map((session) => [session.id, session])));
  const listed = createMemo(() => dragItems(deps.lists().pinned, deps.lists().active, []));
  const [arranged, setArranged] = createSignal<readonly string[]>();
  const [drag, setDrag] = createSignal<{ readonly id: string; readonly initial: readonly string[] }>();
  const [toArchive, setToArchive] = createSignal(false);
  const [heads, setHeads] = createSignal(false);
  const items = () => arranged() ?? listed();
  const sessionOf = (id: string) => byId().get(id);
  const target = (): Section | undefined => {
    const current = drag();
    if (current === undefined) return undefined;
    return toArchive() ? "archived" : sectionIn(items(), current.id);
  };
  /** The items with the dragged thread among the archived (after their head, last): what dropping on their place does. */
  const archivedWith = (id: string) => [...items().filter((item) => item !== id), id];
  const sections = createMemo(() => {
    const of = new Map<string, Section>();
    let section: Section = "pinned";
    for (const id of items()) {
      if (id === Heads.active) section = "active";
      else if (id === Heads.archived) section = "archived";
      of.set(id, section);
    }
    return of;
  });
  return {
    items,
    dragging: () => drag()?.id,
    toArchive,
    heads,
    target,
    verb: () => {
      const current = drag();
      return current === undefined ? undefined : dropVerb(sectionIn(current.initial, current.id), target());
    },
    sectionOf: (id) => sections().get(id),
    sessionOf,
    start: (id) => {
      setToArchive(false);
      setDrag({ id, initial: items() });
      requestAnimationFrame(() => setHeads(drag()?.id === id));
    },
    before: (over) => {
      const current = drag();
      if (current === undefined || over === current.id) return undefined;
      return items().indexOf(over) < items().indexOf(current.id);
    },
    over: (over) => {
      const current = drag();
      if (current === undefined) return;
      setToArchive(over === Heads.archived);
      if (over !== undefined && over !== Heads.archived) setArranged(dragTo(items(), current.initial, current.id, over));
    },
    end: (canceled) => {
      const current = drag();
      const at = toArchive() && current !== undefined ? archivedWith(current.id) : arranged();
      setDrag(undefined);
      setHeads(false);
      setToArchive(false);
      const session = current === undefined ? undefined : sessionOf(current.id);
      if (canceled || current === undefined || at === undefined || session === undefined) return void setArranged(undefined);
      const drop = dropped(deps.marks(), current.initial, at, current.id, session.pinned === true);
      void deps.drop(session, drop.marks, drop.change).finally(() => setArranged(undefined));
    },
  };
}

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
 * The list's drag and drop, down (`y`) or across (`x`): a thread follows the pointer along the list, the others make
 * room, and where it is when dropped says what the drop does (`dropped`). The arrangement hears each item it is dragged
 * onto and moves it (`dragTo`) rather than the sortable moving items itself. Only the pointer moves it: an item it is
 * over goes past it only while the pointer heads that way, so items the sections' names push under a still pointer do
 * not move it.
 */
export function SortableThreads(props: { axis: "x" | "y"; list: () => HTMLElement | undefined; arrangement: Arrangement; children: JSX.Element }) {
  let at: number | undefined;
  let back: boolean | undefined;
  /** The item it is over, until the pointer heads its way. */
  let waiting: string | undefined;
  const settle = () => {
    if (waiting === undefined || back === undefined) return;
    const before = props.arrangement.before(waiting);
    if (before !== undefined && before !== back) return;
    props.arrangement.over(waiting);
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
      modifiers={[props.axis === "x" ? RestrictToHorizontalAxis : RestrictToVerticalAxis, RestrictToElement.configure({ element: () => props.list() ?? null })]}
      plugins={(defaults) => [
        ...defaults.filter((plugin) => plugin !== Accessibility),
        AutoScroller.configure({ acceleration: 8, threshold: props.axis === "x" ? { x: 0.1, y: 0 } : { x: 0, y: 0.1 } }),
        Feedback.configure({ dropAnimation: null }),
      ]}
      onDragStart={(event) => {
        at = undefined;
        back = undefined;
        waiting = undefined;
        const source = event.operation.source;
        if (source !== null) props.arrangement.start(source.id.toString());
      }}
      onDragMove={(event) => {
        const next = event.operation.position.current[props.axis];
        if (at !== undefined && next !== at) back = next < at;
        at = next;
        settle();
      }}
      onDragOver={(event) => {
        // The arrangement moves the thread itself.
        event.preventDefault();
        waiting = event.operation.target?.id.toString();
        if (waiting === undefined) props.arrangement.over(undefined);
        else settle();
      }}
      onDragEnd={(event) => props.arrangement.end(event.canceled)}
    >
      {props.children}
    </DragDropProvider>
  );
}
