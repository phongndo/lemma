import { For, Show, createComputed, createEffect, createSignal, on, onMount } from "solid-js";
import { ChatIcon, CheckIcon, ChevronDownIcon, Markdown } from "@lemma/look";
import type { Asking } from "./asking.ts";
import { answerOf, describeAnswer, emptyDraft } from "./draft.ts";
import { displayLabel } from "./questions.ts";

/** A field the person types in, empty or not: the banner never takes the focus from one, so a digit meant for it picks nothing. */
const editable = (element: Element | null): boolean =>
  element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement || (element instanceof HTMLElement && element.isContentEditable);

/**
 * The agent's open questions, inside the composer above its text box: one question at a time, with tabs and a review
 * when there are several. Picking answers; the composer's text box is the person's own answer, or a note on their pick.
 * Escape, or the chevron, gives the composer back (`release`), discarding nothing: a message sent then answers as a
 * reply.
 */
export function QuestionCard(props: { readonly asking: Asking; readonly release: () => void; readonly focusComposer: () => void }) {
  const asking = props.asking;
  const questions = () => asking.open.questions;
  const count = () => questions().length;
  const several = () => count() > 1;
  const [focused, setFocused] = createSignal(0);
  let card: HTMLElement | undefined;

  const focusOption = (index: number) => {
    setFocused(index);
    card?.querySelector<HTMLElement>(`[data-option="${index}"]`)?.focus();
  };
  /** Where a question shows from: its picked option (whose preview then shows), else its first. */
  const landing = () => {
    const current = asking.question();
    const picked = current?.options.findIndex((option) => asking.draft().picked.includes(option.label)) ?? -1;
    return Math.max(0, picked);
  };
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
        setFocused(at);
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
      focusOption((focused() + (event.key === "ArrowDown" ? 1 : length - 1)) % length);
    } else if (several() && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      asking.goTo(asking.tab() + (event.key === "ArrowRight" ? 1 : -1));
    }
  };

  // Shown while no field has the focus (the person took the box, say): an option takes it, ready for a key.
  onMount(() => {
    const at = landing();
    setFocused(at);
    if (!editable(document.activeElement)) queueMicrotask(() => focusOption(at));
  });

  const answered = (index: number) => answerOf(asking.drafts()[index] ?? emptyDraft) !== undefined;
  const preview = () => {
    const current = asking.question();
    if (current === undefined || !current.options.some((option) => option.preview !== undefined)) return undefined;
    return current.options[focused()]?.preview ?? "";
  };

  return (
    <section class="ask" ref={card} aria-label="The agent's questions" onKeyDown={onKeyDown}>
      <header class="ask-head">
        <span class="ask-title">
          <ChatIcon />
          <Show when={!several()}>{questions()[0]!.header}</Show>
        </span>
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
          <button type="button" class="link-button ask-skip" disabled={asking.closed()} onClick={() => asking.skip()} data-tip="Leave it to the agent">
            Skip
          </button>
        </Show>
        <button type="button" class="icon-button ask-hide" aria-label="Hide the questions" data-tip="Hide, to write a message instead (Esc)" onClick={letGo}>
          <ChevronDownIcon />
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
                  <button type="button" class="ask-review-row" onClick={() => asking.goTo(index())}>
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
          <div class="ask-body" classList={{ "ask-with-preview": preview() !== undefined }}>
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
                        class="ask-option"
                        role={current.multiSelect === true ? "checkbox" : "radio"}
                        aria-checked={picked()}
                        data-option={index()}
                        data-picked={picked()}
                        tabindex={focused() === index() ? 0 : -1}
                        onFocus={() => setFocused(index())}
                        onMouseEnter={() => setFocused(index())}
                        onClick={() => asking.choose(index())}
                      >
                        <span class="ask-option-text">
                          <span class="ask-label">
                            {label.text}
                            <Show when={label.recommended}>
                              <span class="tag ask-recommended">Recommended</span>
                            </Show>
                          </span>
                          <Show when={option.description}>{(description) => <span class="ask-description">{description()}</span>}</Show>
                        </span>
                        <span class="ask-end">
                          <Show when={picked()} fallback={<kbd class="ask-key">{index() + 1}</kbd>}>
                            <CheckIcon />
                          </Show>
                        </span>
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>
            <Show when={preview() !== undefined}>
              <div class="ask-preview" aria-label="Preview of the focused option">
                <Show when={preview() !== ""} fallback={<p class="muted small">No preview for this option.</p>}>
                  <Markdown text={preview()!} />
                </Show>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </section>
  );
}
