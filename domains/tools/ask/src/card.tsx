import { For, Show, createComputed, createEffect, on, onMount } from "solid-js";
import { CheckIcon, ChevronDownIcon, SkipIcon, XIcon } from "@lemma/look";
import type { Asking } from "./asking.ts";
import { answerOf, describeAnswer, emptyDraft } from "./draft.ts";
import { displayLabel } from "./questions.ts";

/** A field the person types in, empty or not: the banner never takes the focus from one, so a digit meant for it picks nothing. */
const editable = (element: Element | null): boolean =>
  element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement || (element instanceof HTMLElement && element.isContentEditable);

/**
 * The agent's open questions, just above the composer's text box in the completion menu's look (the shared `.menu-*`
 * rows): one question at a time, with tabs and a review when there are several. Picking answers; the composer's text
 * box is the person's own answer, or a note on their pick.
 * Escape, or the chevron, gives the composer back (`release`), discarding nothing: a message sent then answers as a
 * reply.
 */
export function QuestionCard(props: { readonly asking: Asking; readonly release: () => void; readonly focusComposer: () => void }) {
  const asking = props.asking;
  const questions = () => asking.open.questions;
  const count = () => questions().length;
  const several = () => count() > 1;
  let card: HTMLElement | undefined;

  const focusOption = (index: number) => {
    asking.setActive(index);
    card?.querySelector<HTMLElement>(`[data-option="${index}"]`)?.focus();
  };
  /** The option the keys reach the options at: the highlighted one, else the first. */
  const landing = () => asking.active() ?? 0;
  // Another question shows. Whether the focus was in the banner is read as the tab changes, before the change removes
  // the option it was on; if it was, it goes to the question's option, or for the review to the text box, where Enter
  // submits.
  let wasInside = false;
  createComputed(
    on(
      asking.tab,
      () => {
        wasInside = card?.contains(document.activeElement) === true;
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      asking.tab,
      () => {
        const at = landing();
        if (wasInside) queueMicrotask(() => (asking.question() === undefined ? props.focusComposer() : focusOption(at)));
      },
      { defer: true },
    ),
  );
  const letGo = () => {
    props.release();
    props.focusComposer();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      letGo();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const current = asking.question();
    const digit = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : undefined;
    if (current !== undefined && digit !== undefined && digit < current.options.length) {
      event.preventDefault();
      focusOption(digit);
      asking.choose(digit);
    } else if (event.key.length === 1 && event.key !== " " && digit === undefined) {
      // Typing on an option writes the person's own answer: the composer takes the focus, and with it the key.
      props.focusComposer();
    } else if (current !== undefined && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const length = current.options.length;
      const at = asking.active();
      focusOption(at === undefined ? (event.key === "ArrowDown" ? 0 : length - 1) : (at + (event.key === "ArrowDown" ? 1 : length - 1)) % length);
    } else if (several() && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      asking.goTo(asking.tab() + (event.key === "ArrowRight" ? 1 : -1));
    }
  };

  // Shown while no field has the focus (the person took the box, say): an option takes it, ready for a key.
  onMount(() => {
    if (!editable(document.activeElement)) queueMicrotask(() => focusOption(landing()));
  });

  const answered = (index: number) => answerOf(asking.drafts()[index] ?? emptyDraft) !== undefined;

  return (
    <section class="ask" ref={card} aria-label="The agent's questions" onKeyDown={onKeyDown}>
      <header class="ask-head">
        <Show when={!several()}>
          <span class="ask-title">{questions()[0]!.header}</span>
        </Show>
        <Show when={several()}>
          <div class="ask-tabs" role="tablist" aria-label="Questions">
            <For each={questions()}>
              {(entry, index) => (
                <button
                  type="button"
                  role="tab"
                  class="ask-tab"
                  aria-selected={asking.tab() === index()}
                  data-done={answered(index())}
                  title={entry.question}
                  onClick={() => asking.goTo(index())}
                >
                  <Show when={answered(index())}>
                    <CheckIcon />
                  </Show>
                  {entry.header}
                </button>
              )}
            </For>
            <button type="button" role="tab" class="ask-tab" aria-selected={asking.tab() === count()} onClick={() => asking.goTo(count())}>
              Review
            </button>
          </div>
        </Show>
        <span class="spacer" />
        <Show when={asking.question() !== undefined}>
          <button
            type="button"
            class="icon-button ask-head-button"
            aria-label="Skip this question"
            data-tip="Skip: leave this one to the agent"
            disabled={asking.closed()}
            onClick={() => asking.skip()}
          >
            <SkipIcon />
          </button>
        </Show>
        <button
          type="button"
          class="icon-button ask-head-button"
          aria-label="Hide the questions"
          data-tip="Hide, to write a message instead (Esc)"
          onClick={letGo}
        >
          <ChevronDownIcon />
        </button>
        <button
          type="button"
          class="icon-button ask-head-button"
          aria-label="Dismiss the questions"
          data-tip="Dismiss: answer none, leave them all to the agent"
          disabled={asking.closed()}
          onClick={() => asking.dismiss()}
        >
          <XIcon />
        </button>
      </header>

      <Show
        when={asking.question()}
        keyed
        fallback={
          <ol class="ask-review" aria-label="Your answers">
            <For each={questions()}>
              {(entry, index) => (
                <li>
                  <button type="button" class="menu-item ask-review-row" onClick={() => asking.goTo(index())}>
                    <span class="ask-review-question">{entry.question}</span>
                    <span class="ask-review-answer" data-empty={answerOf(asking.drafts()[index()] ?? emptyDraft)?.kind !== "answered"}>
                      {describeAnswer(answerOf(asking.drafts()[index()] ?? emptyDraft))}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ol>
        }
      >
        {(current) => (
          <div class="ask-body">
            <div class="ask-main">
              <p class="ask-question" id={`ask-q-${asking.open.toolCallId}`}>
                {current.question}
                <Show when={current.multiSelect === true}>
                  <span class="muted small"> Pick any.</span>
                </Show>
              </p>
              <div class="ask-options" role={current.multiSelect === true ? "group" : "radiogroup"} aria-labelledby={`ask-q-${asking.open.toolCallId}`}>
                <For each={current.options}>
                  {(option, index) => {
                    const label = displayLabel(option.label);
                    const picked = () => asking.draft().picked.includes(option.label);
                    return (
                      <button
                        type="button"
                        class="menu-item ask-option"
                        role={current.multiSelect === true ? "checkbox" : "radio"}
                        aria-checked={picked()}
                        data-option={index()}
                        data-active={asking.active() === index()}
                        data-quick-key={index() + 1}
                        title={option.description}
                        tabindex={landing() === index() ? 0 : -1}
                        onFocus={() => asking.setActive(index())}
                        onMouseEnter={() => asking.setActive(index())}
                        onClick={() => asking.choose(index())}
                      >
                        <span class="ask-mark" data-multi={current.multiSelect === true} aria-hidden="true">
                          <Show when={picked() && current.multiSelect === true}>
                            <CheckIcon />
                          </Show>
                        </span>
                        <span class="menu-label">{label.text}</span>
                        <Show when={label.recommended}>
                          <span class="tag ask-recommended">Recommended</span>
                        </Show>
                        <Show when={option.description}>{(description) => <span class="menu-hint">{description()}</span>}</Show>
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>
          </div>
        )}
      </Show>
    </section>
  );
}
