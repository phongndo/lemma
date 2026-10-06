import { For, Match, Show, Switch, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import type { InteractionRequest, NoticePayload, ProviderInfo } from "@lemma/contracts";
import { copyText } from "../../lib/clipboard.ts";
import { providerBrand, signInState } from "../../model/providers.ts";
import type { InteractionsService } from "../../ui/contracts.ts";
import { CopyButton, Dialog, ExternalIcon, ProviderLogo, Spinner } from "../../ui/parts.tsx";

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Focus on arrival: a step can appear after the dialog opened, so the dialog's own autofocus has passed. */
const focus = (element: HTMLElement) => queueMicrotask(() => element.focus());

/** A question's title as a label: pi-ai's end in a colon, as a terminal prompt does. */
const label = (title: string) => title.replace(/:\s*$/, "");

/** The address to open, whole and selectable, with a copy button: a browser on any machine can open it. */
function LinkBox(props: { url: string; label: string }) {
  return (
    <div class="connect-url">
      <code
        tabindex="0"
        title={props.url}
        onFocus={(event) => {
          // One click selects it all, for a copy from the keyboard or another tool.
          const range = document.createRange();
          range.selectNodeContents(event.currentTarget);
          const selection = getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }}
      >
        {props.url}
      </code>
      <CopyButton text={props.url} label={props.label} />
    </div>
  );
}

function Waiting(props: { text: string }) {
  return (
    <p class="connect-status" role="status">
      <Spinner />
      <span>{props.text}</span>
    </p>
  );
}

/** This page came from another machine, so the host's own address (`localhost`) is not reachable from this browser. */
const remoteHost = () => !/^(localhost|127(\.\d+){3}|\[::1\])$/.test(location.hostname);

/**
 * A browser that cannot reach the host (on another machine) ends on a page
 * that fails to load; its address finishes the sign-in. Open from the start
 * when this page itself came from a remote host.
 */
function PasteFallback(props: { interactions: InteractionsService; request: Extract<InteractionRequest, { type: "ask" }>; open?: boolean }) {
  const [value, setValue] = createSignal("");
  const submit = () => value().trim() !== "" && props.interactions.answer(props.request.id, { type: "ask", value: value().trim() });
  return (
    <details class="connect-paste" open={props.open === true || remoteHost()}>
      <summary>Browser on another device?</summary>
      <p>
        After you approve, the browser may land on a page that doesn't load. That's expected: copy the page's address from the address bar and paste it here.
      </p>
      <form
        class="connect-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          class="field"
          type="text"
          autocomplete="off"
          spellcheck={false}
          aria-label={label(props.request.title)}
          placeholder={props.request.placeholder ?? "Paste the address or code"}
          value={value()}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
        <button type="submit" class="button" disabled={value().trim() === ""}>
          Continue
        </button>
      </form>
    </details>
  );
}

/** An API key to paste: stored on the host, with a link to where the provider issues one. */
function KeyField(props: { interactions: InteractionsService; provider: ProviderInfo; request: Extract<InteractionRequest, { type: "ask" }> }) {
  const [value, setValue] = createSignal("");
  const keyUrl = () => providerBrand(props.provider.id).keyUrl;
  return (
    <form
      class="connect-question"
      onSubmit={(event) => {
        event.preventDefault();
        if (value().trim() !== "") props.interactions.answer(props.request.id, { type: "ask", value: value().trim() });
      }}
    >
      <label class="connect-lead" for={`connect-${props.request.id}`}>
        Paste your {props.provider.name} API key.
      </label>
      <div class="connect-form">
        <input
          id={`connect-${props.request.id}`}
          ref={focus}
          class="field"
          type="password"
          autocomplete="off"
          spellcheck={false}
          aria-label={label(props.request.title)}
          placeholder={props.request.placeholder ?? "API key"}
          value={value()}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
        <button type="submit" class="button button-primary" disabled={value().trim() === ""}>
          Save
        </button>
      </div>
      <p class="connect-note">
        Stored in the host's credential store and never shown again.
        <Show when={keyUrl()}>
          {(url) => (
            <>
              {" "}
              <a class="link-button connect-get-key" href={url()} target="_blank" rel="noopener noreferrer">
                Get a key <ExternalIcon />
              </a>
            </>
          )}
        </Show>
      </p>
    </form>
  );
}

/** A question the flow asks on its way (which account, which domain), in the dialog rather than over it. */
function Question(props: { interactions: InteractionsService; provider: ProviderInfo; request: InteractionRequest }) {
  const [value, setValue] = createSignal("");
  return (
    <Switch>
      <Match when={props.request.type === "select" && props.request}>
        {(request) => (
          <div class="connect-question" role="group" aria-label={label(request().title)}>
            <p class="connect-lead">{label(request().title)}</p>
            <div class="connect-choices">
              <For each={request().options}>
                {(option, index) => (
                  <button
                    type="button"
                    class="connect-choice"
                    ref={(button) => index() === 0 && focus(button)}
                    onClick={() => props.interactions.answer(request().id, { type: "select", value: option.value })}
                  >
                    <span class="connect-choice-label">{option.label}</span>
                    <Show when={option.description}>
                      <span class="connect-choice-desc">{option.description}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </div>
        )}
      </Match>
      <Match when={props.request.type === "ask" && props.request.secret === true && props.request}>
        {(request) => <KeyField interactions={props.interactions} provider={props.provider} request={request()} />}
      </Match>
      <Match when={props.request.type === "ask" && props.request}>
        {(request) => (
          <form
            class="connect-question"
            onSubmit={(event) => {
              event.preventDefault();
              // A blank answer is one: "blank for github.com".
              props.interactions.answer(request().id, { type: "ask", value: value() });
            }}
          >
            <label class="connect-lead" for={`connect-${request().id}`}>
              {label(request().title)}
            </label>
            <div class="connect-form">
              <input
                id={`connect-${request().id}`}
                ref={focus}
                class="field"
                type={request().secret ? "password" : "text"}
                autocomplete="off"
                spellcheck={false}
                placeholder={request().placeholder ?? ""}
                value={value()}
                onInput={(event) => setValue(event.currentTarget.value)}
              />
              <button type="submit" class="button button-primary">
                Continue
              </button>
            </div>
          </form>
        )}
      </Match>
      <Match when={props.request.type === "confirm" && props.request}>
        {(request) => (
          <div class="connect-question">
            <p class="connect-lead">{request().title}</p>
            <Show when={request().detail}>
              <p class="muted">{request().detail}</p>
            </Show>
            <div class="connect-form">
              <button
                type="button"
                ref={focus}
                class="button button-primary"
                onClick={() => props.interactions.answer(request().id, { type: "confirm", value: true })}
              >
                Yes
              </button>
              <button type="button" class="button" onClick={() => props.interactions.answer(request().id, { type: "confirm", value: false })}>
                No
              </button>
            </div>
          </div>
        )}
      </Match>
    </Switch>
  );
}

/**
 * Connecting a provider in one place, whichever way: the API key to paste, or
 * the page to open (here, or copied into a browser anywhere) and the code to
 * enter there, what it waits for, and the flow's other questions. Closing it
 * cancels the login.
 */
export function ConnectDialog(props: {
  provider: ProviderInfo;
  /** How it connects, when the title does not say: `Sign in with ChatGPT`, `API key`. */
  method?: string | undefined;
  notices: Accessor<readonly NoticePayload[]>;
  questions: Accessor<readonly InteractionRequest[]>;
  interactions: InteractionsService;
  onCancel: () => void;
}) {
  const state = () => signInState(props.notices());
  const question = () => props.questions()[0];
  /** The paste-the-address prompt racing the browser's return to the host, as the host marks it. */
  const paste = () => {
    const request = question();
    return request?.type === "ask" && request.kind === "sign-in-code" ? request : undefined;
  };
  const asking = () => (paste() === undefined ? question() : undefined);
  return (
    <Dialog
      class="connect"
      label={`Connect ${props.provider.name}`}
      title={
        <span class="connect-title">
          <ProviderLogo id={props.provider.id} name={props.provider.name} custom={props.provider.logo} />
          <span>
            Connect {props.provider.name}
            <Show when={props.method}>
              <span class="connect-method">{props.method}</span>
            </Show>
          </span>
        </span>
      }
      onClose={props.onCancel}
      // A stray click beside it, on the way back from the browser, should not cancel a login about to finish.
      closeOnBackdrop={false}
      footer={
        <button type="button" class="button" onClick={props.onCancel}>
          Cancel
        </button>
      }
    >
      <Show when={state().info}>
        {(info) => (
          <p class="connect-info">
            {info().message}
            <For each={info().links}>
              {(link) => (
                <>
                  {" "}
                  <a class="link-button connect-get-key" href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.label ?? hostOf(link.url)} <ExternalIcon />
                  </a>
                </>
              )}
            </For>
          </p>
        )}
      </Show>
      <Switch fallback={<Waiting text={state().status ?? "Connecting"} />}>
        <Match when={asking()} keyed>
          {(request) => <Question interactions={props.interactions} provider={props.provider} request={request} />}
        </Match>
        <Match when={state().device}>
          {(device) => (
            <>
              <p class="connect-lead">
                Enter this code at <strong>{hostOf(device().url)}</strong> to approve Lemma.
              </p>
              <div class="connect-code">
                <code aria-label="One-time code">{device().code}</code>
                <CopyButton text={device().code} label="Copy code" />
              </div>
              <a
                class="button button-primary connect-open"
                href={device().url}
                target="_blank"
                rel="noopener noreferrer"
                ref={focus}
                // Copied on the way, so the code is ready to paste on the page that opens.
                onClick={() => void copyText(device().code)}
              >
                Copy code and open {hostOf(device().url)} <ExternalIcon />
              </a>
              <LinkBox url={device().url} label="Copy link" />
              <Waiting text={state().status ?? "Waiting for you to approve"} />
              <p class="connect-note">Only enter this code if you started this sign-in in Lemma.</p>
            </>
          )}
        </Match>
        <Match when={state().link === undefined && paste()} keyed>
          {/* Its page went by before this window was watching: what the browser ended on still finishes it. */}
          {(request) => <PasteFallback interactions={props.interactions} request={request} open />}
        </Match>
        <Match when={state().link}>
          {(link) => (
            <>
              <p class="connect-lead">Open this page in a browser and approve access. Lemma finishes signing in on its own.</p>
              <LinkBox url={link().url} label="Copy link" />
              <div class="connect-actions">
                <a class="button button-primary connect-open" href={link().url} target="_blank" rel="noopener noreferrer" ref={focus}>
                  Open in browser <ExternalIcon />
                </a>
                <span class="connect-hint">or copy the link into any browser</span>
              </div>
              <Waiting text={state().status ?? (paste() === undefined ? "Finishing sign-in" : "Waiting for you to approve in the browser")} />
              <Show when={paste()} keyed>
                {(request) => <PasteFallback interactions={props.interactions} request={request} />}
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </Dialog>
  );
}
