import { For, Match, Show, Switch, createSignal } from "solid-js";
import type { InteractionRequest } from "@lemma/contracts";
import { stepFor } from "@lemma/web/keys";
import { Layers } from "@lemma/frame";
import { ThreadWaits } from "@lemma/threads";
import { Interactions, Slots, defineWebPlugin } from "@lemma/web";
import type { InteractionsService } from "@lemma/web";
import { ConfigForm, Dialog } from "@lemma/look";
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

/** Each field's default, which is what the asker gets for it unset: the form starts from them, so they show. */
const defaults = (fields: Of<"form">["fields"]): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    fields.flatMap((field) => (field.default === undefined || field.secret === true || field.type === "other" ? [] : [[field.key, field.default]])),
  );

/**
 * Several values at once, drawn as a plugin's settings are (`ConfigForm`), but as a question's fields: under its title,
 * without their config keys, each starting at its default. Each is kept here as it is set, and all are sent together. A
 * field the form needs and has no default for must be set first.
 */
function Form(props: { interactions: InteractionsService; request: Of<"form"> }) {
  const initial = defaults(props.request.fields);
  const [values, setValues] = createSignal(initial);
  const missing = () => props.request.fields.filter((field) => !field.optional && values()[field.key] === undefined);
  const submit = () => props.interactions.answer(props.request.id, { type: "form", value: values() });
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
            disabled={missing().length > 0}
            data-tip={
              missing().length > 0
                ? `Needs ${missing()
                    .map((field) => field.title)
                    .join(", ")}`
                : undefined
            }
            onClick={submit}
          >
            Submit
          </button>
        </>
      }
    >
      <Show when={props.request.detail}>
        <p class="dialog-detail">{props.request.detail}</p>
      </Show>
      <div class="question-form">
        <ConfigForm
          fields={props.request.fields}
          config={{ values: values(), secretsSet: [] }}
          // A field set to null is back to its default (unset when it has none).
          onSave={async (changed) => {
            setValues((all) => {
              const next: Record<string, unknown> = { ...all };
              for (const [key, value] of Object.entries(changed)) {
                if (value !== null) next[key] = value;
                else if (initial[key] !== undefined) next[key] = initial[key];
                else delete next[key];
              }
              return next;
            });
          }}
        />
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
          <Match when={request.type === "form" && request}>{(r) => <Form interactions={props.interactions} request={r()} />}</Match>
        </Switch>
      )}
    </Show>
  );
}

/**
 * The host's questions as a dialog: an API key to enter, a change to confirm, an option to pick, a form to fill. And
 * the threads they wait in (`ThreadWaits`), which the sidebar, the palette, and Settings › Archived mark.
 */
export default defineWebPlugin({
  id: "frame.questions",
  styles,
  requires: { interactions: Interactions, slots: Slots },
  setup: ({ interactions, slots }) => {
    slots.add(Layers, { id: "interaction", order: 50, component: () => <InteractionModal interactions={interactions} /> });
    // A question a turn asked the host to put (an approval, a choice, a value) waits on the person in its thread.
    slots.add(ThreadWaits, {
      id: "frame.questions",
      order: 100,
      waiting: (sessionId) => {
        const request = interactions.open().find((open) => open.origin === `session:${sessionId}`);
        return request === undefined ? undefined : request.type === "ask" ? "Needs input" : "Needs approval";
      },
    });
  },
});
