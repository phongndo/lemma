import { For, Index, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { IntegrationKinds } from "@lemma/integrations";
import { PromptCommands } from "@lemma/threads";
import type { IntegrationAddProps, IntegrationDetailProps, IntegrationItem, IntegrationStatus } from "@lemma/integrations";
import { browserPlace } from "@lemma/llm/web";
import { McpChannels } from "@lemma/mcp";
import type { Exposure, McpAuthStatus, McpServerChange, McpServerConfig, McpServerStatus, McpState, McpToolInfo } from "@lemma/mcp";
import { Client, Notify, Slots, defineWebPlugin, usePlugin } from "@lemma/web";
import { AlertIcon, ChevronDownIcon, CopyButton, ExternalIcon, HammerIcon, PlusIcon, RefreshIcon, Segmented, Spinner, Toggle, XIcon } from "@lemma/look";
import { draftOf, entryOf, parsePasted, isImageAddress } from "./form.ts";
import type { Rows, ServerDraft } from "./form.ts";
import styles from "./mcp.css?inline";

const KIND = "mcp";

const EXPOSURES: readonly { readonly value: Exposure; readonly label: string }[] = [
  { value: "codemode", label: "Code mode" },
  { value: "direct", label: "Direct" },
  { value: "hidden", label: "Hidden" },
];
const LABELS = Object.fromEntries(EXPOSURES.map(({ value, label }) => [value, label])) as Readonly<Record<Exposure, string>>;
/** The exposure the file gives a tool by its name, or none of its own (`default`): a pattern's, the plugin's, or the server's. */
const TOOL_EXPOSURES = [{ value: "default", label: "Default" }, ...EXPOSURES];

const STATES: Readonly<Record<McpServerStatus["state"], string>> = {
  connected: "Connected",
  connecting: "Connecting…",
  failed: "Failed",
  "needs-sign-in": "Needs sign-in",
  off: "Off",
};

const EXAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}`;

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const statusOf = (server: McpServerStatus): IntegrationStatus => {
  const reached = server.tools.filter((tool) => tool.exposure !== "hidden").length;
  if (server.auth?.state === "signing-in") return { tone: "busy", text: "Signing in…" };
  switch (server.state) {
    case "connected":
      return { tone: "ok", text: `Connected · ${count(reached, "tool")}` };
    case "connecting":
      return { tone: "busy", text: "Connecting…" };
    case "failed":
      return { tone: "error", text: server.retryIn === undefined ? "Failed" : "Failed · retrying" };
    // Its tools wait on the person: as much trouble as a failure, and counted with them.
    case "needs-sign-in":
      return { tone: "error", text: "Needs sign-in" };
    case "off":
      return { tone: "off", text: server.error === undefined ? "Off" : "Off · needs attention" };
  }
};

interface Actions {
  readonly state: () => McpState | undefined;
  readonly reconnect: (server: string) => Promise<void>;
  readonly configure: (server: string, change: McpServerChange) => Promise<void>;
  /** Writes the server's whole entry, or removes it. */
  readonly put: (server: string, entry: McpServerConfig | null) => Promise<void>;
  readonly signIn: (server: string) => Promise<{ readonly url: string }>;
  readonly finishSignIn: (server: string, address: string) => Promise<void>;
  readonly cancelSignIn: (server: string) => Promise<void>;
  readonly signOut: (server: string) => Promise<void>;
}

/**
 * "in 40s", "in 4m": how long until `inMs` from when the host said it has passed, counted on this page's own clock from
 * when it arrived, since the host's may differ; a clock that ticks each second while it shows.
 */
function Countdown(props: { inMs: number }) {
  const plugin = usePlugin();
  const [now, setNow] = createSignal(Date.now());
  onCleanup(plugin.every(1000, () => setNow(Date.now())));
  const at = createMemo(() => Date.now() + props.inMs);
  const seconds = () => Math.max(0, Math.ceil((at() - now()) / 1000));
  return <>{seconds() === 0 ? "now" : seconds() < 90 ? `in ${seconds()}s` : `in ${Math.round(seconds() / 60)}m`}</>;
}

/**
 * For a browser that cannot reach Lemma (on another device than the host): the address it lands on after approving
 * finishes the sign-in. Open from the start when this page itself came from another machine.
 */
function PasteAddress(props: { server: string; actions: Actions }) {
  const plugin = usePlugin();
  const [value, setValue] = createSignal("");
  const [error, setError] = createSignal<string>();
  const [sending, setSending] = createSignal(false);
  // Its failure (an address from another sign-in, say) shows under the field.
  const submit = plugin.action("finish sign-in", async () => {
    if (value().trim() === "") return;
    setSending(true);
    setError(undefined);
    try {
      await props.actions.finishSignIn(props.server, value().trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  });
  return (
    <details class="mcp-paste" open={browserPlace(location.hostname) === "elsewhere"}>
      <summary>Browser on another device?</summary>
      <p class="integration-hint">
        After you approve, the browser may land on a page that doesn't load. That's expected: copy the page's address from the address bar and paste it here.
      </p>
      <form
        class="mcp-paste-form"
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
          aria-label="The address the browser landed on"
          placeholder="http://localhost:…/callback?code=…"
          value={value()}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
        <button type="submit" class="button small" disabled={sending() || value().trim() === ""}>
          {sending() ? "Signing in…" : "Continue"}
        </button>
      </form>
      <Show when={error()}>{(message) => <p class="integration-error">{message()}</p>}</Show>
    </details>
  );
}

/**
 * Signing in to a remote server that asks: a button while it has no sign-in, the page to approve on (here, or in a
 * browser anywhere, with the address it lands on pasted back) while one waits, and signing out once it has one.
 */
function SignInSection(props: { server: string; auth: McpAuthStatus; actions: Actions }) {
  const plugin = usePlugin();
  const signIn = plugin.action("sign in", () => props.actions.signIn(props.server));
  return (
    <section class="integration-section mcp-sign-in">
      <h3>Sign-in</h3>
      <Switch>
        <Match when={props.auth.state === "signing-in"}>
          <Show
            when={props.auth.url}
            fallback={
              <p class="mcp-waiting" role="status">
                <Spinner />
                <span>Finding where to sign in…</span>
              </p>
            }
          >
            {(url) => (
              <>
                <p class="mcp-sign-in-lead">Open this page in a browser and approve access. Lemma finishes signing in on its own.</p>
                <div class="mcp-target">
                  <code class="integration-code" title={url()}>
                    {url()}
                  </code>
                  <CopyButton text={url()} label="Copy link" />
                </div>
                <div class="integration-actions">
                  <a class="button small button-primary" href={url()} target="_blank" rel="noopener noreferrer">
                    Open in browser <ExternalIcon />
                  </a>
                  <button type="button" class="button small" onClick={plugin.action("cancel sign-in", () => props.actions.cancelSignIn(props.server))}>
                    Cancel
                  </button>
                </div>
                <p class="mcp-waiting" role="status">
                  <Spinner />
                  <span>Waiting for you to approve in the browser</span>
                </p>
                <PasteAddress server={props.server} actions={props.actions} />
              </>
            )}
          </Show>
        </Match>
        <Match when={props.auth.state === "signed-in"}>
          <p class="mcp-sign-in-lead">Signed in. Lemma renews the sign-in on its own while the server allows it.</p>
          <div class="integration-actions">
            <button type="button" class="button small" onClick={signIn}>
              Sign in again
            </button>
            <button type="button" class="button small" onClick={plugin.action("sign out", () => props.actions.signOut(props.server))}>
              Sign out
            </button>
          </div>
        </Match>
        <Match when={props.auth.state === "signed-out"}>
          <p class="mcp-sign-in-lead">{props.server} asks you to sign in before Lemma can use its tools.</p>
          <div class="integration-actions">
            <button type="button" class="button small button-primary" onClick={signIn}>
              Sign in
            </button>
          </div>
        </Match>
      </Switch>
      <Show when={props.auth.error}>
        {(error) => (
          <div class="callout callout-warn mcp-error">
            <AlertIcon />
            <span>{error()}</span>
          </div>
        )}
      </Show>
    </section>
  );
}

/**
 * A tool and how it reaches the model: its own exposure, or by default its server's, unless a pattern or the plugin
 * adding the server decides it, which it says.
 */
function ToolRow(props: { server: string; tool: McpToolInfo; actions: Actions }) {
  const plugin = usePlugin();
  /** What decides it when it has no exposure of its own: a pattern, or the plugin (which names it). */
  const rule = () => (props.tool.own === undefined ? props.tool.rule : undefined);
  return (
    <li class="mcp-tool">
      <span class="mcp-tool-info">
        <code class="mcp-tool-name">{props.tool.name}</code>
        <Show when={props.tool.description}>{(description) => <span class="mcp-tool-description">{description()}</span>}</Show>
        <Show when={rule()}>
          {(rule) => (
            <span class="mcp-tool-rule">
              {LABELS[props.tool.exposure]}, set by {rule() === props.tool.name ? "the plugin adding the server" : <code>{rule()}</code>}
            </span>
          )}
        </Show>
      </span>
      <Segmented
        label={`How ${props.tool.name} reaches the model`}
        value={props.tool.own ?? "default"}
        options={TOOL_EXPOSURES}
        onChange={plugin.action("set tool exposure", (value: string) =>
          props.actions.configure(props.server, { tools: { [props.tool.name]: value === "default" ? null : (value as Exposure) } }),
        )}
      />
    </li>
  );
}

/** Name and value rows (environment variables, headers): a row to add, and a remove button on each. */
function RowsEditor(props: { label: string; rows: Rows; onChange: (rows: Rows) => void; namePlaceholder: string; valuePlaceholder: string }) {
  const set = (index: number, patch: Partial<Rows[number]>) => props.onChange(props.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div class="integration-field">
      <span>{props.label}</span>
      <Index each={props.rows}>
        {(row, index) => (
          <div class="integration-kv">
            <input
              class="field"
              aria-label={`${props.label}: name`}
              placeholder={props.namePlaceholder}
              value={row().name}
              spellcheck={false}
              onInput={(event) => set(index, { name: event.currentTarget.value })}
            />
            <input
              class="field"
              aria-label={`${props.label}: value`}
              placeholder={props.valuePlaceholder}
              value={row().value}
              spellcheck={false}
              onInput={(event) => set(index, { value: event.currentTarget.value })}
            />
            <button
              type="button"
              class="icon-button"
              aria-label={`Remove ${row().name || "row"}`}
              onClick={() => props.onChange(props.rows.filter((_, i) => i !== index))}
            >
              <XIcon />
            </button>
          </div>
        )}
      </Index>
      <div>
        <button type="button" class="button small" onClick={() => props.onChange([...props.rows, { name: "", value: "" }])}>
          <PlusIcon />
          Add
        </button>
      </div>
    </div>
  );
}

/** An image, or `fallback` while there is none or it fails to load (an address that is gone, an image that is not one). */
function Picture(props: { src: string | undefined; fallback: JSX.Element }) {
  const [failed, setFailed] = createSignal<string>();
  return (
    <Show when={props.src !== undefined && props.src !== failed() ? props.src : undefined} fallback={props.fallback}>
      {(src) => <img src={src()} alt="" onError={() => setFailed(src())} />}
    </Show>
  );
}

/** A server's entry as a form: its name (only while adding), how it is reached, and a description for the model. */
function ServerForm(props: {
  draft: ServerDraft;
  naming: boolean;
  submitLabel: string;
  submit: (draft: ServerDraft) => Promise<void>;
  cancel: () => void;
  base?: McpServerConfig;
}) {
  const plugin = usePlugin();
  const [draft, setDraft] = createSignal(props.draft);
  const [error, setError] = createSignal<string>();
  const [saving, setSaving] = createSignal(false);
  const update = (patch: Partial<ServerDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const save = plugin.action("save server", async () => {
    const made = entryOf(draft(), props.base);
    if ("error" in made) return setError(made.error);
    setError(undefined);
    setSaving(true);
    try {
      await props.submit(draft());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  });
  return (
    <form
      class="mcp-form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <Show when={props.naming}>
        <label class="integration-field">
          <span>Name</span>
          <input
            class="field"
            value={draft().name}
            placeholder="github"
            spellcheck={false}
            data-autofocus
            onInput={(event) => update({ name: event.currentTarget.value })}
          />
          <span class="integration-hint">Its tools are named mcp__{draft().name || "name"}__…</span>
        </label>
      </Show>
      <Segmented
        label="How it is reached"
        value={draft().transport}
        options={[
          { value: "stdio", label: "Local command" },
          { value: "http", label: "Remote URL" },
        ]}
        onChange={(transport) => update({ transport: transport as ServerDraft["transport"] })}
      />
      <Show
        when={draft().transport === "stdio"}
        fallback={
          <>
            <label class="integration-field">
              <span>URL</span>
              <input
                class="field"
                value={draft().url}
                placeholder="https://example.com/mcp"
                spellcheck={false}
                onInput={(event) => update({ url: event.currentTarget.value })}
              />
              <span class="integration-hint">
                Streamable HTTP. A server that asks you to sign in offers a Sign in button once added; one that takes a token instead takes it in a header.
              </span>
            </label>
            <RowsEditor
              label="Headers"
              rows={draft().headers}
              onChange={(headers) => update({ headers })}
              namePlaceholder="Authorization"
              valuePlaceholder="Bearer ${TOKEN}"
            />
          </>
        }
      >
        <label class="integration-field">
          <span>Command</span>
          <input
            class="field"
            value={draft().command}
            placeholder="npx -y @modelcontextprotocol/server-filesystem ."
            spellcheck={false}
            onInput={(event) => update({ command: event.currentTarget.value })}
          />
          <span class="integration-hint">Run on the host, from its PATH. Quote an argument with spaces in it.</span>
        </label>
        <RowsEditor
          label="Environment"
          rows={draft().env}
          onChange={(env) => update({ env })}
          namePlaceholder="GITHUB_TOKEN"
          valuePlaceholder="${GITHUB_TOKEN}"
        />
      </Show>
      <label class="integration-field">
        <span>Description</span>
        <input
          class="field"
          value={draft().description}
          placeholder="What it offers, for the model"
          onInput={(event) => update({ description: event.currentTarget.value })}
        />
        <span class="integration-hint">{"${NAME}"} in any value reads the host's environment, so a secret need not be written here.</span>
      </label>
      <label class="integration-field">
        <span>Icon</span>
        <span class="mcp-icon-field">
          <span class="integration-icon" aria-hidden="true">
            <Picture src={isImageAddress((draft().icon ?? "").trim()) ? (draft().icon ?? "").trim() : undefined} fallback={<HammerIcon />} />
          </span>
          <input
            class="field"
            value={draft().icon ?? ""}
            placeholder="https://example.com/icon.svg, or a data:image/ URL"
            spellcheck={false}
            onInput={(event) => update({ icon: event.currentTarget.value })}
          />
        </span>
        <span class="integration-hint">Optional: an image of its own, over the one the server declares.</span>
      </label>
      <Show when={error()}>{(message) => <p class="integration-error">{message()}</p>}</Show>
      <div class="integration-buttons">
        <button type="button" class="button" onClick={() => props.cancel()}>
          Cancel
        </button>
        <button type="submit" class="button button-primary" disabled={saving()}>
          {saving() ? "Saving…" : props.submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Adding a server: by its form, or by pasting another client's JSON. */
function AddServer(props: IntegrationAddProps & { actions: Actions }) {
  const plugin = usePlugin();
  const [mode, setMode] = createSignal<"form" | "json">("form");
  const [text, setText] = createSignal("");
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal<string>();
  const [saving, setSaving] = createSignal(false);
  const parsed = createMemo(() => (text().trim() === "" ? undefined : parsePasted(text(), name().trim())));
  const one = () => {
    const result = parsed();
    return result !== undefined && "error" in result && result.error === "This is one server: give it a name";
  };
  const servers = () => {
    const result = parsed();
    return result !== undefined && "servers" in result ? result.servers : undefined;
  };
  const problem = () => {
    const result = parsed();
    return result !== undefined && "error" in result ? result.error : undefined;
  };
  const taken = (server: string) => props.actions.state()?.servers.some((existing) => existing.name === server && existing.sourceKind === "file") === true;
  const addPasted = plugin.action("add pasted servers", async () => {
    const found = servers();
    if (found === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      for (const server of found) await props.actions.put(server.name, server.entry);
      props.added(found[0]!.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  });
  return (
    <div class="mcp-add">
      <Segmented
        label="How to add it"
        value={mode()}
        options={[
          { value: "form", label: "Fill in" },
          { value: "json", label: "Paste JSON" },
        ]}
        onChange={(value) => setMode(value as "form" | "json")}
      />
      <Show
        when={mode() === "form"}
        fallback={
          <div class="mcp-form">
            <label class="integration-field">
              <span>JSON</span>
              <textarea
                class="field"
                rows={9}
                value={text()}
                placeholder={EXAMPLE}
                spellcheck={false}
                data-autofocus
                onInput={(event) => setText(event.currentTarget.value)}
              />
              <span class="integration-hint">
                From another client (Claude Desktop, Cursor, VS Code) or a server's README: a whole config, servers by name, or one server.
              </span>
            </label>
            <Show when={one()}>
              <label class="integration-field">
                <span>Name</span>
                <input class="field" value={name()} placeholder="github" spellcheck={false} onInput={(event) => setName(event.currentTarget.value)} />
              </label>
            </Show>
            <Show when={servers()}>
              {(found) => (
                <p class="integration-hint">
                  Adds{" "}
                  <For each={found()}>
                    {(server, index) => (
                      <>
                        {index() > 0 ? ", " : ""}
                        <code>{server.name}</code>
                        {taken(server.name) ? " (replacing the one you have)" : ""}
                      </>
                    )}
                  </For>
                  .
                </p>
              )}
            </Show>
            <Show when={!one() && problem()}>{(message) => <p class="integration-error">{message()}</p>}</Show>
            <Show when={error()}>{(message) => <p class="integration-error">{message()}</p>}</Show>
            <div class="integration-buttons">
              <button type="button" class="button" onClick={() => props.cancel()}>
                Cancel
              </button>
              <button type="button" class="button button-primary" disabled={saving() || servers() === undefined} onClick={addPasted}>
                {saving() ? "Adding…" : "Add"}
              </button>
            </div>
          </div>
        }
      >
        <ServerForm
          draft={draftOf("", undefined)}
          naming
          submitLabel="Add server"
          cancel={props.cancel}
          submit={async (draft) => {
            if (taken(draft.name)) throw new Error(`You have a server named ${draft.name}: pick another name, or edit that one`);
            const made = entryOf(draft);
            if ("error" in made) throw new Error(made.error);
            await props.actions.put(draft.name, made.entry);
            props.added(draft.name);
          }}
        />
      </Show>
    </div>
  );
}

/** One server's details: its state, why it failed, how it is reached, its tools, and editing or removing it. */
function ServerDetail(props: IntegrationDetailProps & { actions: Actions }) {
  const plugin = usePlugin();
  const server = () => props.actions.state()?.servers.find((candidate) => candidate.name === props.id);
  const [editing, setEditing] = createSignal(false);
  const [toolsOpen, setToolsOpen] = createSignal(false);
  const [removing, setRemoving] = createSignal(false);
  const reached = () => server()?.tools.filter((tool) => tool.exposure !== "hidden").length ?? 0;
  const remove = plugin.action("remove server", async () => {
    await props.actions.put(props.id, null);
    props.close();
  });
  return (
    <Show when={server()}>
      {(server) => (
        <div class="mcp-detail" data-state={server().state}>
          <header class="integration-head">
            <span class="integration-icon" aria-hidden="true">
              <Picture src={server().icon} fallback={<HammerIcon />} />
            </span>
            <div class="integration-head-text">
              <h2>
                {server().name}
                <Show when={server().server?.version}>{(version) => <code class="integration-version">v{version()}</code>}</Show>
              </h2>
              <span class="muted small">
                {server().auth?.state === "signing-in" ? "Signing in…" : STATES[server().state]}
                <Show when={server().retryIn !== undefined}>
                  {" "}
                  · retrying <Countdown inMs={server().retryIn!} />
                </Show>
                <Show when={server().state === "connected"}> · {count(reached(), "tool")}</Show>
                <Show when={server().server?.title ?? server().server?.name}>{(title) => <> · {title()}</>}</Show>
              </span>
            </div>
            <div class="integration-actions">
              <Show when={server().enabled && server().state !== "connecting"}>
                <button
                  type="button"
                  class="icon-button"
                  aria-label={`Reconnect ${server().name}`}
                  data-tip="Reconnect"
                  onClick={plugin.action("reconnect", () => props.actions.reconnect(server().name))}
                >
                  <RefreshIcon />
                </button>
              </Show>
              <Toggle
                label={`${server().name} on`}
                checked={server().enabled}
                onChange={plugin.action("turn server on or off", (enabled: boolean) => props.actions.configure(server().name, { enabled }))}
              />
            </div>
          </header>
          <Show when={server().description}>{(description) => <p class="mcp-server-description">{description()}</p>}</Show>
          <Show when={server().error}>
            {(error) => (
              <div class="callout callout-warn mcp-error">
                <AlertIcon />
                <span>{error()}</span>
              </div>
            )}
          </Show>
          <Show when={server().stderr !== undefined && server().state === "failed"}>
            <details class="mcp-stderr">
              <summary>What it printed</summary>
              <pre>{server().stderr}</pre>
            </details>
          </Show>
          <Show when={server().enabled && server().auth}>{(auth) => <SignInSection server={server().name} auth={auth()} actions={props.actions} />}</Show>

          <section class="integration-section">
            <h3>Connection</h3>
            <Show
              when={editing() && server().entry !== undefined}
              fallback={
                <>
                  <div class="mcp-target">
                    <code class="integration-code">{server().target}</code>
                    <CopyButton text={server().target} label="Copy" />
                  </div>
                  <Show when={server().sourceKind === "file"}>
                    <div class="integration-actions">
                      <Show when={server().entry !== undefined}>
                        <button type="button" class="button small" onClick={() => setEditing(true)}>
                          Edit
                        </button>
                      </Show>
                      <Show
                        when={removing()}
                        fallback={
                          <button type="button" class="button small" onClick={() => setRemoving(true)}>
                            Remove
                          </button>
                        }
                      >
                        <span class="muted small">Remove {server().name} from mcp.json?</span>
                        <button type="button" class="button small button-danger" onClick={remove}>
                          Remove
                        </button>
                        <button type="button" class="button small" onClick={() => setRemoving(false)}>
                          Keep
                        </button>
                      </Show>
                    </div>
                  </Show>
                </>
              }
            >
              <ServerForm
                draft={draftOf(server().name, server().entry)}
                naming={false}
                base={server().entry!}
                submitLabel="Save"
                cancel={() => setEditing(false)}
                submit={async (draft) => {
                  const made = entryOf(draft, server().entry);
                  if ("error" in made) throw new Error(made.error);
                  await props.actions.put(server().name, made.entry);
                  setEditing(false);
                }}
              />
            </Show>
            <Show when={server().sourceKind === "plugin"}>
              <p class="integration-hint">
                Added by the plugin {server().source}; turn it off or change its tools here, and the plugin's settings stay its own.
              </p>
            </Show>
          </section>

          <Show when={server().enabled}>
            <section class="integration-section">
              <h3>Tools</h3>
              <p class="integration-hint">
                Code mode keeps them out of the model's tool list until it searches for them; Direct lists them like a built-in tool.
              </p>
              <Segmented
                label={`How ${server().name}'s tools reach the model`}
                value={server().exposure}
                options={EXPOSURES}
                onChange={plugin.action("set exposure", (value: string) => props.actions.configure(server().name, { exposure: value as Exposure }))}
              />
              <Show when={server().tools.length > 0}>
                <div>
                  <button type="button" class="button small mcp-tools-toggle" aria-expanded={toolsOpen()} onClick={() => setToolsOpen(!toolsOpen())}>
                    {count(server().tools.length, "tool")}
                    <ChevronDownIcon />
                  </button>
                </div>
              </Show>
              <Show when={toolsOpen()}>
                <ul class="mcp-tools">
                  <For each={server().tools}>{(tool) => <ToolRow server={server().name} tool={tool} actions={props.actions} />}</For>
                </ul>
              </Show>
            </section>
          </Show>
        </div>
      )}
    </Show>
  );
}

/**
 * The web half of `mcp.servers`: the MCP servers' part of Settings › Integrations. Every server with its state and
 * switch, its details (why it failed, how it is reached, its tools and how they reach the model), editing and removing
 * it, and adding one by a form or by pasting another client's JSON, written to the user's `mcp.json`. It runs while the host half does.
 */
export default defineWebPlugin({
  id: "mcp.servers",
  requires: { slots: Slots, client: Client, notify: Notify },
  styles,
  setup: ({ slots, client, notify }, plugin) => {
    const [state, setState] = createSignal<McpState>();
    // The state when subscribed, and again after every change: a server connecting, failing, or the file edited.
    plugin.onCleanup(client.follow(McpChannels.changes, undefined, setState));
    const reported = <A,>(what: string, work: () => Promise<A>) =>
      work().catch((error: unknown) => {
        notify.report(error, what);
        throw error;
      });
    const actions: Actions = {
      state,
      reconnect: (server) => reported(`Reconnecting ${server}`, () => client.channel.call(McpChannels.reconnect, { server })),
      configure: (server, change) => reported(`Changing ${server}`, () => client.channel.call(McpChannels.configure, { server, change })),
      put: (server, entry) => client.channel.call(McpChannels.put, { server, entry }),
      signIn: (server) => reported(`Signing in to ${server}`, () => client.channel.call(McpChannels.signIn, { server })),
      // Its failure (a wrong address) is the paste field's to show.
      finishSignIn: (server, address) => client.channel.call(McpChannels.finishSignIn, { server, address }),
      cancelSignIn: (server) => reported(`Stopping the sign-in to ${server}`, () => client.channel.call(McpChannels.cancelSignIn, { server })),
      signOut: (server) => reported(`Signing out of ${server}`, () => client.channel.call(McpChannels.signOut, { server })),
    };
    const items = createMemo((): readonly IntegrationItem[] =>
      (state()?.servers ?? []).map((server) => ({
        id: server.name,
        title: server.name,
        ...(server.server?.version === undefined ? {} : { version: server.server.version }),
        ...(server.icon === undefined ? {} : { icon: server.icon }),
        status: statusOf(server),
        enabled: server.enabled,
        setEnabled: (enabled) => void actions.configure(server.name, { enabled }).catch(() => {}),
        keywords: `mcp server ${server.target} ${server.description ?? ""} ${server.tools.map((tool) => tool.name).join(" ")}`,
      })),
    );
    slots.add(IntegrationKinds, {
      id: KIND,
      order: 20,
      title: "MCP servers",
      icon: HammerIcon,
      items,
      loaded: () => state() !== undefined,
      problem: () => {
        const error = state()?.fileError;
        return error === undefined ? undefined : `${state()!.file}: ${error}`;
      },
      detail: (props) => <ServerDetail {...props} actions={actions} />,
      add: {
        label: "Custom MCP server",
        description: "A local command or a remote URL, or another client's JSON pasted",
        component: (props) => <AddServer {...props} actions={actions} />,
      },
    });

    // `/mcp …`: each subcommand over the servers as they are now, offered by name with their state. Its failures are
    // the composer's to report, so it calls the host directly rather than through `actions`, which report too.
    const reconnect = (server: string) => client.channel.call(McpChannels.reconnect, { server });
    const configure = (server: string, change: McpServerChange) => client.channel.call(McpChannels.configure, { server, change });
    // The message `/mcp login` leaves with the page to open, by server: gone once that sign-in is.
    const signInToasts = new Map<string, number>();
    createEffect(() => {
      // Read first, whether any message waits or not, so a later change runs this again.
      const servers = state()?.servers ?? [];
      for (const [name, id] of signInToasts) {
        if (servers.find((server) => server.name === name)?.auth?.state === "signing-in") continue;
        notify.dismiss(id);
        signInToasts.delete(name);
      }
    });
    const named = (name: string | undefined) => {
      const server = state()?.servers.find((candidate) => candidate.name === name);
      if (server === undefined) throw new Error(name === undefined ? "Name a server" : `No MCP server “${name}”`);
      return server;
    };
    const servers = (which: (server: McpServerStatus) => boolean = () => true) => ({
      name: "server",
      values: () => (state()?.servers ?? []).filter(which).map((server) => ({ value: server.name, detail: statusOf(server).text })),
    });
    const exposure = (withDefault: boolean) => ({
      name: "exposure",
      values: () => (withDefault ? TOOL_EXPOSURES : EXPOSURES).map(({ value }) => ({ value })),
    });
    const exposureOf = (value: string | undefined, withDefault: boolean) => {
      const found = (withDefault ? TOOL_EXPOSURES : EXPOSURES).find((candidate) => candidate.value === value);
      if (found === undefined) throw new Error(`Choose one of ${(withDefault ? TOOL_EXPOSURES : EXPOSURES).map((candidate) => candidate.value).join(", ")}`);
      return found.value;
    };
    slots.add(PromptCommands, {
      id: "mcp",
      order: 50,
      description: "See and change the MCP servers",
      icon: HammerIcon,
      subcommands: [
        {
          name: "list",
          aliases: ["ls"],
          description: "Each server and its state",
          run: () => {
            const all = state()?.servers ?? [];
            notify.toast({
              level: "info",
              message: all.length === 0 ? "No MCP servers yet" : all.map((server) => `${server.name}: ${statusOf(server).text}`).join("\n"),
            });
          },
        },
        {
          name: "reconnect",
          description: "Close a server's connection and connect again",
          args: [servers((server) => server.enabled)],
          run: ({ args }) => reconnect(named(args[0]).name),
        },
        {
          name: "login",
          aliases: ["sign-in"],
          description: "Sign in to a remote server that asks",
          args: [servers((server) => server.auth !== undefined)],
          run: async ({ args }) => {
            const { name } = named(args[0]);
            const { url } = await client.channel.call(McpChannels.signIn, { server: name });
            const previous = signInToasts.get(name);
            if (previous !== undefined) notify.dismiss(previous);
            signInToasts.set(
              name,
              notify.toast({
                level: "info",
                message: `Approve Lemma's access to ${name} in the browser; Lemma finishes on its own. A browser on another device lands on a page that doesn't load: paste its address in Settings › Integrations › ${name}.`,
                links: [{ url, label: "Open the sign-in page" }],
              }),
            );
          },
        },
        {
          name: "logout",
          aliases: ["sign-out"],
          description: "Forget the sign-in to a server",
          args: [servers((server) => server.auth?.state === "signed-in")],
          run: ({ args }) => client.channel.call(McpChannels.signOut, { server: named(args[0]).name }),
        },
        {
          name: "enable",
          aliases: ["on"],
          description: "Turn a server on",
          args: [servers((server) => !server.enabled)],
          run: ({ args }) => configure(named(args[0]).name, { enabled: true }),
        },
        {
          name: "disable",
          aliases: ["off"],
          description: "Turn a server off",
          args: [servers((server) => server.enabled)],
          run: ({ args }) => configure(named(args[0]).name, { enabled: false }),
        },
        {
          name: "exposure",
          description: "How a server's tools reach the model",
          args: [servers(), exposure(false)],
          run: ({ args }) => configure(named(args[0]).name, { exposure: exposureOf(args[1], false) as Exposure }),
        },
        {
          name: "tool",
          description: "How one tool reaches the model",
          args: [
            servers(),
            {
              name: "tool",
              values: ({ args }) =>
                (state()?.servers.find((server) => server.name === args[0])?.tools ?? []).map((tool) => ({ value: tool.name, detail: LABELS[tool.exposure] })),
            },
            exposure(true),
          ],
          run: ({ args }) => {
            const server = named(args[0]);
            const tool = server.tools.find((candidate) => candidate.name === args[1]);
            if (tool === undefined) throw new Error(`${server.name} has no tool “${args[1] ?? ""}”`);
            const chosen = exposureOf(args[2], true);
            return configure(server.name, { tools: { [tool.name]: chosen === "default" ? null : (chosen as Exposure) } });
          },
        },
      ],
    });
  },
});
