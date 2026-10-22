import { For, Match, Show, Switch, createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import { asksAnswer } from "@lemma/llm";
import type { ProviderInfo, SignIn, SignInStep } from "@lemma/llm";
import { copyText } from "@lemma/web/clipboard";
import { browserPlace, SignInPaste } from "@lemma/credentials/web";
import { providerBrand, timeLeft, ProviderLogo } from "@lemma/llm/web";
import { usePlugin } from "@lemma/web";
import { CopyButton, Dialog, ExternalIcon, Spinner } from "@lemma/look";

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Focus on arrival: a step can appear after the dialog opened, so the dialog's own autofocus has passed. */
const focus = (element: HTMLElement) => queueMicrotask(() => element.focus());

type Step<T extends SignInStep["type"]> = Extract<SignInStep, { type: T }>;

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

/** An API key to paste: stored on the host, with a link to where the provider issues one, and why the last was refused. */
function KeyField(props: { provider: ProviderInfo; step: Step<"key">; answer: (value: string) => void }) {
  const [value, setValue] = createSignal("");
  const keyUrl = () => providerBrand(props.provider.id).keyUrl;
  return (
    <form
      class="connect-question"
      onSubmit={(event) => {
        event.preventDefault();
        if (value().trim() !== "") props.answer(value().trim());
      }}
    >
      <label class="connect-lead" for="connect-key">
        Paste your {props.step.label}.
      </label>
      <Show when={props.step.problem}>
        {(problem) => (
          <p class="connect-problem" role="alert">
            {problem()}
          </p>
        )}
      </Show>
      <div class="connect-form">
        <input
          id="connect-key"
          ref={focus}
          class="field"
          type="password"
          autocomplete="off"
          spellcheck={false}
          aria-invalid={props.step.problem !== undefined}
          placeholder="API key"
          value={value()}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
        <button type="submit" class="button button-primary" disabled={value().trim() === ""}>
          Save
        </button>
      </div>
      <p class="connect-note">
        Lemma checks it with {props.provider.name}, then stores it on the host; it is never shown again.
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
function TextField(props: { step: Step<"text">; answer: (value: string) => void }) {
  const [value, setValue] = createSignal("");
  return (
    <form
      class="connect-question"
      onSubmit={(event) => {
        event.preventDefault();
        // A blank answer is one: "blank for github.com".
        props.answer(value());
      }}
    >
      <label class="connect-lead" for="connect-text">
        {props.step.title}
      </label>
      <div class="connect-form">
        <input
          id="connect-text"
          ref={focus}
          class="field"
          type={props.step.secret ? "password" : "text"}
          autocomplete="off"
          spellcheck={false}
          placeholder={props.step.placeholder ?? ""}
          value={value()}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
        <button type="submit" class="button button-primary">
          Continue
        </button>
      </div>
    </form>
  );
}

function Choice(props: { step: Step<"choice">; answer: (value: string) => void }) {
  return (
    <div class="connect-question" role="group" aria-label={props.step.title}>
      <p class="connect-lead">{props.step.title}</p>
      <div class="connect-choices">
        <For each={props.step.options}>
          {(option, index) => (
            <button type="button" class="connect-choice" ref={(button) => index() === 0 && focus(button)} onClick={() => props.answer(option.value)}>
              <span class="connect-choice-label">{option.label}</span>
              <Show when={option.description}>
                <span class="connect-choice-desc">{option.description}</span>
              </Show>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

/** The one-time code to enter on the provider's site, how long it lasts, and the page to enter it on. */
function DeviceCode(props: { step: Step<"code"> }) {
  const plugin = usePlugin();
  const [now, setNow] = createSignal(Date.now());
  onCleanup(plugin.every(1000, () => setNow(Date.now())));
  // Counted from when this page first showed the code, on its own clock: the host's may differ. A page that opened late
  // shows more time than is left, never less; the host ends the sign-in when the code expires.
  const deadline = props.step.expiresIn === undefined ? undefined : Date.now() + props.step.expiresIn * 1000;
  const left = () => (deadline === undefined ? undefined : timeLeft(deadline, now()));
  return (
    <>
      <p class="connect-lead">
        Enter this code at <strong>{hostOf(props.step.url)}</strong> to approve Lemma.
      </p>
      <div class="connect-code">
        <code aria-label="One-time code">{props.step.code}</code>
        <CopyButton text={props.step.code} label="Copy code" />
      </div>
      <a
        class="button button-primary connect-open"
        href={props.step.url}
        target="_blank"
        rel="noopener noreferrer"
        ref={focus}
        // Copied on the way, so the code is ready to paste on the page that opens.
        onClick={plugin.action("copy code", () => copyText(props.step.code))}
      >
        Copy code and open {hostOf(props.step.url)} <ExternalIcon />
      </a>
      <LinkBox url={props.step.url} label="Copy link" />
      <Show when={deadline !== undefined} fallback={<Waiting text="Waiting for you to approve" />}>
        <Show when={left()} fallback={<p class="connect-problem">The code expired. Cancel and connect again for a new one.</p>}>
          {(remaining) => <Waiting text={`Waiting for you to approve · the code expires in ${remaining()}`} />}
        </Show>
      </Show>
      <p class="connect-note">Only enter this code if you started this sign-in in Lemma.</p>
    </>
  );
}

/**
 * Connecting a provider in one place, whichever way: what its sign-in on the host asks now (`SignIn.step`), whichever
 * client started it. The API key to paste, or the page to open (here, or copied into a browser anywhere) and the code to
 * enter there, what it waits for, and the flow's other questions. Answers go to the host, which moves the sign-in on.
 * Closing it cancels the login.
 */
export function ConnectDialog(props: {
  provider: ProviderInfo;
  /** How it connects, when the title does not say: `Sign in with ChatGPT`, `API key`. */
  method?: string | undefined;
  signIn: Accessor<SignIn | undefined>;
  /** Answers the sign-in's open step. */
  answer: (signIn: SignIn, value: string) => void;
  onCancel: () => void;
}) {
  const answer = (value: string) => {
    const signIn = props.signIn();
    if (signIn !== undefined) props.answer(signIn, value);
  };
  const step = <T extends SignInStep["type"]>(type: T) => {
    const current = props.signIn()?.step;
    return current?.type === type ? (current as Step<T>) : undefined;
  };
  /**
   * What the body is keyed by: a step that asks by its number, so one asked again (a refused key) starts with a clean
   * field; another by what it shows, so the same page or code shown again (once a paste is withdrawn) stays as it was.
   */
  const stepKey = () => {
    const signIn = props.signIn();
    if (signIn === undefined) return undefined;
    const { step } = signIn;
    if (asksAnswer(step)) return `ask ${signIn.seq}`;
    return step.type === "browser" ? `browser ${step.url}` : step.type === "code" ? `code ${step.code}` : step.type;
  };
  /** A page from another machine than the host: what is stored, is stored on the host. */
  const remote = () => browserPlace(location.hostname) === "elsewhere";
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
        <>
          <Show when={remote()}>
            <span class="connect-host">Stored on the host at {location.hostname}</span>
          </Show>
          <button type="button" class="button" onClick={props.onCancel}>
            Cancel
          </button>
        </>
      }
    >
      <Show when={props.signIn()?.info}>
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
      {/* Before the host lists the sign-in, and once it has ended while the page catches up, it is connecting. */}
      <Show when={stepKey()} keyed fallback={<Waiting text="Connecting" />}>
        <Switch fallback={<Waiting text="Connecting" />}>
          <Match when={step("working")}>{(working) => <Waiting text={working().message} />}</Match>
          <Match when={step("key")}>{(key) => <KeyField provider={props.provider} step={key()} answer={answer} />}</Match>
          <Match when={step("text")}>{(text) => <TextField step={text()} answer={answer} />}</Match>
          <Match when={step("choice")}>{(choice) => <Choice step={choice()} answer={answer} />}</Match>
          <Match when={step("code")}>{(code) => <DeviceCode step={code()} />}</Match>
          <Match when={step("browser")}>
            {(browser) => (
              <>
                <p class="connect-lead">Open this page in a browser and approve access. Lemma finishes signing in on its own.</p>
                <LinkBox url={browser().url} label="Copy link" />
                <div class="connect-actions">
                  <a class="button button-primary connect-open" href={browser().url} target="_blank" rel="noopener noreferrer" ref={focus}>
                    Open in browser <ExternalIcon />
                  </a>
                  <span class="connect-hint">or copy the link into any browser</span>
                </div>
                <Waiting text="Waiting for you to approve in the browser" />
                <Show when={browser().paste}>{(paste) => <SignInPaste class="connect-paste" placeholder={paste().placeholder} submit={answer} />}</Show>
              </>
            )}
          </Match>
        </Switch>
      </Show>
    </Dialog>
  );
}
