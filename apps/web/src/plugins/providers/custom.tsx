import { For, Show, createSignal } from "solid-js";
import { CUSTOM_APIS, customProviderProblem, logoProblem, logoSource } from "../../model/providers.ts";
import type { CustomProviderDraft } from "../../model/providers.ts";
import { Dialog, PlusIcon, Spinner } from "../../ui/parts.tsx";

/** Asks for an SVG file and hands over its text. */
export const pickSvg = (use: (svg: string) => void) => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".svg,image/svg+xml";
  input.onchange = () => void input.files?.[0]?.text().then(use);
  input.click();
};

/** Adding a provider of the user's: its endpoint, wire API, models, an optional key, and a logo. Closes once it is added (and connected, with a key). */
export function CustomProviderDialog(props: {
  add: (draft: CustomProviderDraft, key: string, logo: string | undefined) => Promise<boolean>;
  onClose: () => void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [name, setName] = createSignal("");
  const [baseUrl, setBaseUrl] = createSignal("");
  const [api, setApi] = createSignal<CustomProviderDraft["api"]>("openai-completions");
  const [modelIds, setModelIds] = createSignal("");
  const [key, setKey] = createSignal("");
  const [logo, setLogo] = createSignal<string>();
  const [logoError, setLogoError] = createSignal<string>();
  const chooseLogo = () =>
    pickSvg((svg) => {
      const problem = logoProblem(svg);
      setLogoError(problem);
      if (problem === undefined) setLogo(svg);
    });
  const draft = (): CustomProviderDraft => ({ name: name(), baseUrl: baseUrl(), api: api(), models: modelIds(), hasKey: key() !== "" });
  const problem = () => customProviderProblem(draft());
  const touched = () => name() !== "" || baseUrl() !== "" || modelIds() !== "";
  const submit = async () => {
    if (problem() !== undefined || busy()) return;
    setBusy(true);
    const ok = await props.add(draft(), key(), logo()).finally(() => setBusy(false));
    if (ok) props.onClose();
  };
  return (
    <Dialog
      class="connect custom-provider"
      label="Add a custom provider"
      title={
        <span class="connect-title">
          <span class="custom-provider-mark" aria-hidden="true">
            <Show when={logo()} fallback={<PlusIcon />}>
              {(svg) => <img class="provider-logo" src={logoSource(svg())} alt="" />}
            </Show>
          </span>
          <span>
            Add a custom provider
            <span class="connect-method">Any OpenAI-, Anthropic-, or Gemini-compatible endpoint</span>
          </span>
        </span>
      }
      onClose={() => !busy() && props.onClose()}
      footer={
        <>
          <span class="custom-provider-problem">{touched() ? (problem() ?? "") : ""}</span>
          <button type="button" class="button" disabled={busy()} onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" form="custom-provider-form" class="button button-primary" disabled={problem() !== undefined || busy()}>
            <Show when={busy()} fallback="Add provider">
              <Spinner /> Adding
            </Show>
          </button>
        </>
      }
    >
      <form
        id="custom-provider-form"
        class="custom-provider-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label class="custom-provider-field">
          <span>Name</span>
          <input class="field" data-autofocus placeholder="Ollama" value={name()} onInput={(event) => setName(event.currentTarget.value)} />
        </label>
        <label class="custom-provider-field">
          <span>Base URL</span>
          <input
            class="field"
            spellcheck={false}
            placeholder="http://localhost:11434/v1"
            value={baseUrl()}
            onInput={(event) => setBaseUrl(event.currentTarget.value)}
          />
        </label>
        <label class="custom-provider-field">
          <span>API</span>
          <select class="field" value={api()} onChange={(event) => setApi(event.currentTarget.value as CustomProviderDraft["api"])}>
            <For each={CUSTOM_APIS}>{(option) => <option value={option.value}>{option.label}</option>}</For>
          </select>
        </label>
        <label class="custom-provider-field">
          <span>Models</span>
          <input
            class="field"
            spellcheck={false}
            placeholder="qwen3:8b, llama3.2"
            value={modelIds()}
            onInput={(event) => setModelIds(event.currentTarget.value)}
          />
        </label>
        <label class="custom-provider-field">
          <span>API key</span>
          <input
            class="field"
            type="password"
            autocomplete="off"
            placeholder="Optional; local servers need none"
            value={key()}
            onInput={(event) => setKey(event.currentTarget.value)}
          />
          <small>Stored in the host's credential store, not in config.</small>
        </label>
        <div class="custom-provider-field">
          <span>Logo</span>
          <span class="custom-provider-logo">
            <button type="button" class="button small" onClick={chooseLogo}>
              {logo() === undefined ? "Choose SVG…" : "Change…"}
            </button>
            <Show when={logo() !== undefined}>
              <button type="button" class="link-button" onClick={() => setLogo(undefined)}>
                Remove
              </button>
            </Show>
            <small>{logoError() ?? "Optional; shown beside its name"}</small>
          </span>
        </div>
      </form>
    </Dialog>
  );
}
