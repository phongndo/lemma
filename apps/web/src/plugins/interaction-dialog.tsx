import { For, Match, Show, Switch, createSignal } from "solid-js";
import type { InteractionRequest } from "@lemma/contracts";
import { stepFor } from "../lib/keys.ts";
import { Interactions, Layers, Slots } from "../ui/contracts.ts";
import type { InteractionsService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { Dialog } from "../ui/parts.tsx";
import styles from "./interaction-dialog.css?inline";

type Of<T extends InteractionRequest["type"]> = Extract<InteractionRequest, { type: T }>;

function Ask(props: { interactions: InteractionsService; request: Of<"ask"> }) {
  const [value, setValue] = createSignal("");
  return (
    <Dialog
      title={props.request.title}
      onClose={() => props.interactions.dismiss(props.request.id)}
      footer={
        <>
          <button type="button" class="button" onClick={() => props.interactions.dismiss(props.request.id)}>
            Cancel
          </button>
          <button
            type="button"
            class="button button-primary"
            disabled={value() === ""}
            onClick={() => props.interactions.answer(props.request.id, { type: "ask", value: value() })}
          >
            Submit
          </button>
        </>
      }
    >
      <input
        class="field"
        data-autofocus
        type={props.request.secret ? "password" : "text"}
        autocomplete={props.request.secret ? "off" : "on"}
        placeholder={props.request.placeholder ?? ""}
        value={value()}
        onInput={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && value() !== "") {
            event.preventDefault();
            props.interactions.answer(props.request.id, { type: "ask", value: value() });
          }
        }}
      />
      <Show when={props.request.secret}>
        <p class="muted small">Sent to the host and stored in its credential store; never shown again.</p>
      </Show>
    </Dialog>
  );
}

function Confirm(props: { interactions: InteractionsService; request: Of<"confirm"> }) {
  return (
    <Dialog
      title={props.request.title}
      onClose={() => props.interactions.dismiss(props.request.id)}
      footer={
        <>
          <button class="button" onClick={() => props.interactions.answer(props.request.id, { type: "confirm", value: false })}>
            No
          </button>
          <button class="button button-primary" data-autofocus onClick={() => props.interactions.answer(props.request.id, { type: "confirm", value: true })}>
            Yes
          </button>
        </>
      }
    >
      <Show when={props.request.detail}>
        <p class="dialog-detail">{props.request.detail}</p>
      </Show>
    </Dialog>
  );
}

function Select(props: { interactions: InteractionsService; request: Of<"select"> }) {
  const pick = (value: string) => props.interactions.answer(props.request.id, { type: "select", value });
  const onKey = (event: KeyboardEvent) => {
    const items = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(".choice")];
    const next = stepFor(event.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (next === undefined) return;
    event.preventDefault();
    items[next]?.focus();
  };
  return (
    <Dialog title={props.request.title} onClose={() => props.interactions.dismiss(props.request.id)}>
      <Show when={props.request.detail}>
        <p class="dialog-detail">{props.request.detail}</p>
      </Show>
      <div class="choices" role="listbox" onKeyDown={onKey}>
        <For each={props.request.options}>
          {(option, index) => (
            <button class="choice" role="option" {...(index() === 0 ? { "data-autofocus": "" } : {})} onClick={() => pick(option.value)}>
              <span class="choice-label">{option.label}</span>
              <Show when={option.description}>
                <span class="choice-desc">{option.description}</span>
              </Show>
            </button>
          )}
        </For>
      </div>
    </Dialog>
  );
}

/** The oldest open question from the host; answering or dismissing reveals the next. A view that claims questions (the palette, the Providers page) shows those itself. */
function InteractionModal(props: { interactions: InteractionsService }) {
  const current = () => props.interactions.open().find((request) => !props.interactions.claimed(request));
  return (
    <Show when={current()} keyed>
      {(request) => (
        <Switch>
          <Match when={request.type === "ask" && request}>{(r) => <Ask interactions={props.interactions} request={r()} />}</Match>
          <Match when={request.type === "confirm" && request}>{(r) => <Confirm interactions={props.interactions} request={r()} />}</Match>
          <Match when={request.type === "select" && request}>{(r) => <Select interactions={props.interactions} request={r()} />}</Match>
        </Switch>
      )}
    </Show>
  );
}

/** The host's questions as a dialog: an API key to enter, a change to confirm, an option to pick. */
export default defineUiPlugin({
  id: "interaction-dialog",
  styles,
  requires: { interactions: Interactions, slots: Slots },
  setup: ({ interactions, slots }) => {
    slots.add(Layers, { id: "interaction", order: 50, component: () => <InteractionModal interactions={interactions} /> });
  },
});
