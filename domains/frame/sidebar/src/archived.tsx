import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useDroppable } from "@dnd-kit/solid";
import type { SessionInfo } from "@lemma/sessions";
import { loadJson, save } from "@lemma/web/storage";
import { dragEdge } from "@lemma/web/drag";
import { ChevronDownIcon } from "@lemma/look";
import { ARCHIVED_MIN, Heads, LIST_MIN, fitArchivedHeight } from "./list.ts";

const ARCHIVED_OPEN_KEY = "lemma.frame.sidebar.archived-open";
/** The archived panel's height (px), as dragged and kept: at first, and by a key's step. */
const ARCHIVED_HEIGHT_KEY = "lemma.frame.sidebar.archived-height";
const ARCHIVED_HEIGHT = 220;
const ARCHIVED_STEP = 24;

/**
 * The archived, in a panel of their own at the foot: it folds, it scrolls, its top edge resizes it, and a thread dropped
 * on it is archived. It is there with none archived too, so its fold stays as it was left rather than reappearing open.
 * Folded, it still shows the open thread when that is archived.
 */
export function ArchivedPanel(props: {
  /** The archived threads, in order. */
  archived: () => readonly SessionInfo[];
  activeId: () => string | undefined;
  /** A thread as it is now, by id, so its row follows it. */
  sessionOf: (id: string) => SessionInfo | undefined;
  row: (session: () => SessionInfo) => JSX.Element;
  /** A thread is being dragged: the sections' names show. */
  heads: boolean;
  /** The dragged thread is over the panel: dropping it archives it. */
  target: boolean;
  /** The list's area, which the panel shares with the rows above it. */
  area: () => HTMLElement | undefined;
}) {
  const [open, setOpen] = createSignal(loadJson(ARCHIVED_OPEN_KEY, false, (value): value is boolean => typeof value === "boolean"));
  const toggle = () => {
    setOpen(!open());
    save(ARCHIVED_OPEN_KEY, JSON.stringify(open()));
  };
  /** The archived rows shown: all of them while open, scrolling in the panel; the open thread among them always. */
  const rows = createMemo(() => {
    const all = props.archived();
    return open() ? all : all.filter((session) => session.id === props.activeId());
  });
  const count = () => props.archived().length;

  // Its height at most, as its top edge was dragged to, kept; within what leaves the list above room. Holding fewer
  // rows, it is shorter.
  const [height, setHeight] = createSignal(loadJson(ARCHIVED_HEIGHT_KEY, ARCHIVED_HEIGHT, (value): value is number => typeof value === "number"));
  let panel: HTMLElement | undefined;
  let list: HTMLUListElement | undefined;
  /** How tall the panel would be showing every row. */
  const fullHeight = () =>
    panel === undefined || list === undefined ? Number.POSITIVE_INFINITY : panel.getBoundingClientRect().height - list.clientHeight + list.scrollHeight;
  const fit = (to: number, kept: number) => fitArchivedHeight(to, kept, props.area()?.clientHeight ?? 600, fullHeight());
  const keep = (to: number) => {
    setHeight(to);
    save(ARCHIVED_HEIGHT_KEY, JSON.stringify(to));
  };
  /** How tall the panel shows: its rows', up to the height kept. A drag or a key's step goes from there. */
  const shownHeight = () => panel?.getBoundingClientRect().height ?? height();
  const resize = (event: PointerEvent) => {
    const startY = event.clientY;
    const startHeight = shownHeight();
    const kept = height();
    dragEdge(event, {
      move: (moved) => setHeight(fit(startHeight - (moved.clientY - startY), kept)),
      end: () => keep(height()),
    });
  };

  const zone = useDroppable({ id: Heads.archived });
  return (
    <section
      ref={(element) => {
        zone.ref(element);
        panel = element;
      }}
      class="archived-panel"
      classList={{ open: open(), target: props.target }}
      aria-label="Archived threads"
      // At most as kept, and short of the list above's room in a shorter window.
      style={open() ? { "max-height": `min(${Math.max(ARCHIVED_MIN, height())}px, calc(100% - ${LIST_MIN}px))` } : undefined}
    >
      <Show when={open()}>
        <div
          class="archived-edge"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize archived threads"
          aria-valuenow={height()}
          tabIndex={0}
          onPointerDown={resize}
          onDblClick={() => keep(ARCHIVED_HEIGHT)}
          onKeyDown={(event) => {
            const step = event.key === "ArrowUp" ? ARCHIVED_STEP : event.key === "ArrowDown" ? -ARCHIVED_STEP : 0;
            if (step === 0) return;
            event.preventDefault();
            keep(fit(shownHeight() + step, height()));
          }}
        />
      </Show>
      <button class="archived-head" aria-expanded={open()} onClick={toggle}>
        <span>{open() || props.heads || count() === 0 ? "Archived" : `Archived (${count()})`}</span>
        <span class="archived-rule" />
        <ChevronDownIcon />
      </button>
      <Show when={props.heads && (!open() || count() === 0)}>
        <span class="thread-head-slot">Drop here to archive</span>
      </Show>
      <Show when={open() && count() === 0 && !props.heads}>
        <p class="archived-panel-empty">No archived threads</p>
      </Show>
      <ul class="thread-section archived-rows" ref={list}>
        <For each={rows().map((session) => session.id)}>
          {(id) => <Show when={props.sessionOf(id)}>{(session) => <li data-section="archived">{props.row(session)}</li>}</Show>}
        </For>
      </ul>
    </section>
  );
}
