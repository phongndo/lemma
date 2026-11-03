import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { XIcon } from "@lemma/look";

/* The pieces the dock's own panels' details are made of. */

/** A part of a row's details, under its heading; `aside` says more beside the heading. */
export function Section(props: { title: string; aside?: JSX.Element; children: JSX.Element }) {
  return (
    <section class="dt-section">
      <h4>
        <span>{props.title}</span>
        <Show when={props.aside}>
          <span class="dt-section-aside">{props.aside}</span>
        </Show>
      </h4>
      {props.children}
    </section>
  );
}

/** The selected row's details beside its table: its title row, then the rest; `onClose` gives it a close button. */
export function Details(props: { label: string; title: JSX.Element; onClose?: () => void; children: JSX.Element }) {
  return (
    <aside class="dt-details dt-side" aria-label={props.label}>
      <div class="dt-details-title">
        {props.title}
        <Show when={props.onClose}>
          {(close) => (
            <button class="dt-close devtools-end" aria-label="Close details" onClick={() => close()()}>
              <XIcon />
            </button>
          )}
        </Show>
      </div>
      <div class="dt-side-body">{props.children}</div>
    </aside>
  );
}
