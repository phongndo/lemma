import { Index, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { cardTop, tickAt, tickNear, tickScale } from "../../model/prompt-rail.ts";
import type { PromptMark } from "../../model/transcript.ts";
import { ChevronIcon } from "../../ui/parts.tsx";
import { markdownText } from "../../lib/markdown.ts";

/** With less space than this beside the transcript's text, the prompt rail shows only while pointed at or focused. */
const RAIL_ROOM = 48;
/** How much of an answer the card reads: more than its three lines hold. */
const PREVIEW_SOURCE = 2000;
/** The card keeps this far inside the chat view. */
const CARD_INSET = 8;

/**
 * A tick per prompt along the chat's left edge, evenly spaced and squeezed
 * together when there are too many to fit. Pointing anywhere on the strip
 * picks the nearest tick and previews its prompt and answer in a card level
 * with it; clicking goes there. Each tick is also a button: one tab stop, the
 * arrow keys, Home, and End move between them. The ticks of the turns in view
 * are lit. The strip keeps to the space beside the transcript's text
 * (`--room`), so it never covers what the reader is selecting, and sits level
 * with the middle of the whole pane, the composer below the chat included
 * (`--below`), as far as the chat view leaves room.
 */
export function PromptRail(props: {
  marks: readonly PromptMark[];
  /** The index of the prompt being read. */
  current: number;
  /** Where the previous and next buttons go. */
  previous: number | undefined;
  next: number | undefined;
  /** The indices of the first and last prompts whose turns are in view. */
  seen: { readonly first: number; readonly last: number } | undefined;
  /** The space between the chat's left edge and the transcript's text, in pixels. */
  room: number;
  /** How far the pane the chat is in reaches below the chat view (its composer), in pixels. */
  below: number;
  onJump: (key: string) => void;
}) {
  let rail!: HTMLElement;
  let strip!: HTMLDivElement;
  let card: HTMLDivElement | undefined;
  const ticks: HTMLButtonElement[] = [];
  const count = () => props.marks.length;
  const [hovered, setHovered] = createSignal<number>();
  const [focused, setFocused] = createSignal<number>();
  /** The prompt the card shows: the one pointed at, else the one focused. */
  const active = () => {
    const index = hovered() ?? focused();
    return index !== undefined && index < count() ? index : undefined;
  };
  const shown = createMemo(() => {
    const index = active();
    if (index === undefined) return undefined;
    const mark = props.marks[index]!;
    return { index, prompt: mark.prompt, reply: markdownText(mark.reply.slice(0, PREVIEW_SOURCE)) };
  });
  const at = (index: number) => tickAt(index, count());
  /** The tick nearest the pointer's height on the strip. */
  const fromPointer = (event: MouseEvent) => {
    const box = strip.getBoundingClientRect();
    return tickNear(box.height <= 0 ? 0 : (event.clientY - box.top) / box.height, count());
  };
  const jump = (index: number | undefined) => {
    const mark = index === undefined ? undefined : props.marks[index];
    if (mark !== undefined) props.onJump(mark.key);
  };
  /** The tick the tab key reaches: the focused one, else the current prompt's. */
  const stop = () => focused() ?? Math.min(props.current, count() - 1);
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    // With a modifier it is an app shortcut, not a move along the rail.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const keys: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: count() - 1 };
    const to = keys[event.key];
    if (to === undefined) return;
    event.preventDefault();
    ticks[Math.max(0, Math.min(count() - 1, to))]?.focus();
  };
  // The card's middle is level with its tick unless that takes it out of the chat view, and it is no larger than the view leaves.
  // It is placed again whenever the strip moves under it: the composer settling below (`below`), the room beside the text, a new prompt.
  createEffect(
    on([shown, () => props.below, () => props.room, count], () => {
      const index = shown()?.index;
      if (index === undefined || card === undefined) return;
      const view = rail.getBoundingClientRect();
      const box = strip.getBoundingClientRect();
      card.style.maxWidth = `${Math.max(0, view.right - card.getBoundingClientRect().left - CARD_INSET)}px`;
      card.style.maxHeight = `${Math.max(0, view.height - 2 * CARD_INSET)}px`;
      const top = cardTop(box.top + (at(index) / 100) * box.height, card.offsetHeight, view, CARD_INSET);
      card.style.top = `${top - box.top}px`;
    }),
  );
  return (
    <nav
      class="prompt-rail"
      classList={{ tucked: props.room < RAIL_ROOM }}
      aria-label="Prompts"
      ref={rail}
      style={{ "--room": `${props.room}px`, "--below": `${props.below}px`, "--count": count() }}
    >
      <div class="prompt-strip" ref={strip}>
        <button class="prompt-step previous" aria-label="Previous prompt" disabled={props.previous === undefined} onClick={() => jump(props.previous)}>
          <ChevronIcon />
        </button>
        <div
          class="prompt-hit"
          aria-hidden="true"
          onMouseMove={(event) => setHovered(fromPointer(event))}
          onMouseLeave={() => setHovered(undefined)}
          // Going to a prompt leaves focus where the reader was typing.
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => jump(fromPointer(event))}
        />
        <div class="prompt-ticks">
          <Index each={props.marks}>
            {(mark, index) => (
              <button
                class="prompt-tick"
                classList={{ pointed: active() === index, seen: props.seen !== undefined && index >= props.seen.first && index <= props.seen.last }}
                style={{ top: `${at(index)}%`, "--scale": tickScale(index, active()) }}
                ref={(element) => (ticks[index] = element)}
                tabIndex={stop() === index ? 0 : -1}
                aria-label={`Prompt ${index + 1} of ${count()}: ${mark().prompt}`}
                aria-current={index === props.current ? "location" : undefined}
                onFocus={() => setFocused(index)}
                onBlur={() => setFocused(undefined)}
                onKeyDown={(event) => onKeyDown(event, index)}
                onClick={() => jump(index)}
              />
            )}
          </Index>
        </div>
        <button class="prompt-step next" aria-label="Next prompt" disabled={props.next === undefined} onClick={() => jump(props.next)}>
          <ChevronIcon />
        </button>
        <Show when={shown()}>
          {(preview) => (
            <div class="prompt-card" ref={card} aria-hidden="true">
              <div class="prompt-card-prompt">{preview().prompt}</div>
              <Show when={preview().reply}>
                <div class="prompt-card-reply">{preview().reply}</div>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </nav>
  );
}
