import { Show, createSignal } from "solid-js";
import { usePlugin } from "@lemma/web";

/*
 * Signing in as the web app shows it, whichever plugin's sign-in it is (a model provider's, an MCP server's). Handlers
 * bind to their element (`on:submit`), not through Solid's page-wide delegation, which runs when the module loads: a
 * contract loads without a page too, in the tests.
 */

/**
 * Where the person's browser is: on the host's machine when this page came from it (`localhost`), elsewhere otherwise.
 * A page reached through an SSH port forward says `here` too, so `here` makes no choice for the person; only
 * `elsewhere` does.
 */
export const browserPlace = (hostname: string): "here" | "elsewhere" => (/^(localhost|127(\.\d+){3}|\[::1\])$/.test(hostname) ? "here" : "elsewhere");

/**
 * For a browser that cannot reach the host (on another device), whose sign-in ends on a page that does not load: the
 * address of that page finishes the sign-in, pasted here (`submit`). Open from the start when this page itself came
 * from another machine than the host. A `submit` that fails says why under the field, which keeps the address.
 */
export function SignInPaste(props: { readonly class?: string; readonly placeholder?: string | undefined; readonly submit: (address: string) => unknown }) {
  const [value, setValue] = createSignal("");
  const [error, setError] = createSignal<string>();
  const [sending, setSending] = createSignal(false);
  const send = usePlugin().action("finish signing in", async () => {
    const address = value().trim();
    if (address === "" || sending()) return;
    setSending(true);
    setError(undefined);
    try {
      await props.submit(address);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  });
  return (
    <details class={props.class} open={browserPlace(location.hostname) === "elsewhere"}>
      <summary>Browser on another device?</summary>
      <p>
        After you approve, the browser may land on a page that doesn't load. That's expected: copy the page's address from the address bar and paste it here.
      </p>
      <form
        on:submit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <input
          class="field"
          type="text"
          autocomplete="off"
          spellcheck={false}
          aria-label="The address the browser landed on"
          placeholder={props.placeholder ?? "Paste the address"}
          value={value()}
          on:input={(event) => setValue(event.currentTarget.value)}
        />
        <button type="submit" class="button small" disabled={sending() || value().trim() === ""}>
          {sending() ? "Signing in…" : "Continue"}
        </button>
      </form>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
    </details>
  );
}
