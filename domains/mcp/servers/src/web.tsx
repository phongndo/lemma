import { For, Index, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import { SignInPaste } from "@lemma/credentials/web";
import { Settings } from "@lemma/settings";
import { McpChannels } from "@lemma/mcp";
import type { Exposure, McpAuthStatus, McpServerChange, McpServerConfig, McpServerStatus, McpState, McpToolInfo } from "@lemma/mcp";
import { Client, Notify, Slots, defineWebPlugin, usePlugin } from "@lemma/web";
import {
  AlertIcon,
  ChevronDownIcon,
  ConfirmDelete,
  CopyButton,
  ExternalIcon,
  HammerIcon,
  ImageIcon,
  PencilIcon,
  Picture,
  PlusIcon,
  PuzzleIcon,
  QuestionIcon,
  RefreshIcon,
  Segmented,
  Spinner,
  SvgDrop,
  svgSource,
  Toggle,
  XIcon,
} from "@lemma/look";
import { errorMessage } from "@lemma/contracts";
import { plural } from "@lemma/web/format";
import { createNow } from "@lemma/web/now";
import { addMcpCommand } from "./command.ts";
import { EXPOSURES, LABELS, TOOL_EXPOSURES } from "./exposures.ts";
import { draftOf, entryOf, parsePasted, isImageAddress } from "./form.ts";
import type { Rows, ServerDraft } from "./form.ts";
import { statusOf } from "./items.ts";
import type { ServerItem } from "./items.ts";
import { addIntegrationsPage } from "./page.tsx";
import styles from "./mcp.css?inline";
import pageStyles from "./page.css?inline";

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
  const now = createNow(1000);
  const at = createMemo(() => Date.now() + props.inMs);
  const seconds = () => Math.max(0, Math.ceil((at() - now()) / 1000));
  return <>{seconds() === 0 ? "now" : seconds() < 90 ? `in ${seconds()}s` : `in ${Math.round(seconds() / 60)}m`}</>;
}

/** What went wrong with a server or its sign-in, as the host says it. */
function Warning(props: { message: string }) {
  return (
    <div class="callout callout-warn mcp-error">
      <AlertIcon />
      <span>{props.message}</span>
    </div>
  );
}

/**
 * A form's saving, as the plugin's action `what`: whether it is under way, and what it failed with, which the form
 * shows rather than a toast.
 */
function createSave(what: string, work: () => Promise<void>) {
  const plugin = usePlugin();
  const [error, setError] = createSignal<string>();
  const [saving, setSaving] = createSignal(false);
  const save = plugin.action(what, async () => {
    setError(undefined);
    setSaving(true);
    try {
      await work();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  });
  return { save, error, saving };
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
                <SignInPaste
                  class="mcp-paste"
                  placeholder="http://localhost:…/callback?code=…"
                  submit={(address) => props.actions.finishSignIn(props.server, address)}
                />
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
      <Show when={props.auth.error}>{(error) => <Warning message={error()} />}</Show>
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
        <Show when={props.tool.description}>{(description) => <span class="mcp-tool-description tw:truncate">{description()}</span>}</Show>
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
      <span class="mcp-field-head">
        {props.label}
        <button
          type="button"
          class="icon-button"
          aria-label={`Add to ${props.label}`}
          data-tip="Add"
          onClick={() => props.onChange([...props.rows, { name: "", value: "" }])}
        >
          <PlusIcon />
        </button>
      </span>
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
              data-tip="Remove"
              onClick={() => props.onChange(props.rows.filter((_, i) => i !== index))}
            >
              <XIcon />
            </button>
          </div>
        )}
      </Index>
    </div>
  );
}

/**
 * A server's icon: an SVG file of the user's (picked, or dropped on the tile), written into its entry, or an image's
 * address; empty, the one the server declares.
 */
function IconField(props: { value: string; onChange: (icon: string) => void }) {
  const [problem, setProblem] = createSignal<string>();
  const icon = () => props.value.trim();
  const change = (next: string) => {
    setProblem(undefined);
    props.onChange(next);
  };
  return (
    <div class="integration-field">
      <span>Icon</span>
      <div class="mcp-icon-field">
        <SvgDrop
          class={isImageAddress(icon()) ? "mcp-icon-drop" : "mcp-icon-drop empty"}
          label="Choose an SVG file for its icon"
          tip="Choose an SVG, or drop one here"
          onSvg={(svg) => change(svgSource(svg))}
          onProblem={setProblem}
        >
          <Picture src={isImageAddress(icon()) ? icon() : undefined} fallback={<ImageIcon />} />
        </SvgDrop>
        {/* An image written into the entry, whole, is shown by the tile, not as its address. */}
        <Show
          when={icon().startsWith("data:") && isImageAddress(icon())}
          fallback={
            <input
              class="field"
              value={props.value}
              placeholder="https://example.com/icon.svg"
              aria-label="Icon address"
              spellcheck={false}
              onInput={(event) => change(event.currentTarget.value)}
            />
          }
        >
          <span class="mcp-icon-file">An image of your own</span>
        </Show>
        <Show when={icon() !== ""}>
          <button type="button" class="icon-button" aria-label="Remove the icon" data-tip="Remove" onClick={() => change("")}>
            <XIcon />
          </button>
        </Show>
      </div>
      <Show when={problem()}>{(message) => <span class="integration-error">{message()}</span>}</Show>
    </div>
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
  const [draft, setDraft] = createSignal(props.draft);
  const update = (patch: Partial<ServerDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const { save, error, saving } = createSave("save server", async () => {
    const made = entryOf(draft(), props.base);
    if ("error" in made) throw new Error(made.error);
    await props.submit(draft());
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
      </label>
      <IconField value={draft().icon ?? ""} onChange={(icon) => update({ icon })} />
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
function AddServer(props: { added: (id: string) => void; cancel: () => void; actions: Actions }) {
  const [mode, setMode] = createSignal<"form" | "json">("form");
  const [text, setText] = createSignal("");
  const [name, setName] = createSignal("");
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
  const paste = createSave("add pasted servers", async () => {
    const found = servers();
    if (found === undefined) return;
    for (const server of found) await props.actions.put(server.name, server.entry);
    props.added(found[0]!.name);
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
            <Show when={paste.error()}>{(message) => <p class="integration-error">{message()}</p>}</Show>
            <div class="integration-buttons">
              <button type="button" class="button" onClick={() => props.cancel()}>
                Cancel
              </button>
              <button type="button" class="button button-primary" disabled={paste.saving() || servers() === undefined} onClick={paste.save}>
                {paste.saving() ? "Adding…" : "Add"}
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
function ServerDetail(props: { id: string; close: () => void; actions: Actions }) {
  const plugin = usePlugin();
  const server = () => props.actions.state()?.servers.find((candidate) => candidate.name === props.id);
  const [editing, setEditing] = createSignal(false);
  const [toolsOpen, setToolsOpen] = createSignal(false);
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
              <Picture src={server().icon} dark={server().iconDark} fallback={<HammerIcon />} />
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
                <Show when={server().state === "connected"}> · {plural(reached(), "tool")}</Show>
                <Show when={server().server?.title ?? server().server?.name}>{(title) => <> · {title()}</>}</Show>
              </span>
            </div>
            <div class="integration-actions">
              <Show when={server().sourceKind === "plugin"}>
                <span class="mcp-source" role="img" aria-label={`Added by ${server().source}`} data-tip={`Added by ${server().source}`}>
                  <PuzzleIcon />
                </span>
              </Show>
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
              <Show when={server().sourceKind === "file" && server().entry !== undefined && !editing()}>
                <button type="button" class="icon-button" aria-label={`Edit ${server().name}`} data-tip="Edit" onClick={() => setEditing(true)}>
                  <PencilIcon />
                </button>
              </Show>
              <Show when={server().sourceKind === "file"}>
                <ConfirmDelete label={`Delete ${server().name}`} tip="Delete from mcp.json" onConfirm={remove} />
              </Show>
              <Toggle
                label={`${server().name} on`}
                checked={server().enabled}
                onChange={plugin.action("turn server on or off", (enabled: boolean) => props.actions.configure(server().name, { enabled }))}
              />
            </div>
          </header>
          <Show when={server().description}>{(description) => <p class="mcp-server-description">{description()}</p>}</Show>
          <Show when={server().error}>{(error) => <Warning message={error()} />}</Show>
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
                <div class="mcp-target">
                  <code class="integration-code">{server().target}</code>
                  <CopyButton text={server().target} label="Copy" />
                </div>
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
          </section>

          <Show when={server().enabled}>
            <section class="integration-section">
              <h3 class="mcp-section-head">
                Tools
                <span
                  class="mcp-help"
                  role="img"
                  aria-label="Code mode keeps them out of the model's tool list until it searches for them; Direct lists them like a built-in tool"
                  data-tip="Code mode keeps them out of the model's tool list until it searches for them; Direct lists them like a built-in tool"
                >
                  <QuestionIcon />
                </span>
              </h3>
              <Segmented
                label={`How ${server().name}'s tools reach the model`}
                value={server().exposure}
                options={EXPOSURES}
                onChange={plugin.action("set exposure", (value: string) => props.actions.configure(server().name, { exposure: value as Exposure }))}
              />
              <Show when={server().tools.length > 0}>
                <div>
                  <button type="button" class="button small mcp-tools-toggle" aria-expanded={toolsOpen()} onClick={() => setToolsOpen(!toolsOpen())}>
                    {plural(server().tools.length, "tool")}
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
 * The web half of `mcp.servers`: Settings › Integrations, every server with its state and switch, its details (why it
 * failed, how it is reached, its tools and how they reach the model), editing and removing it, and adding one by a form
 * or by pasting another client's JSON, written to the user's `mcp.json`; and `/mcp` in the prompt. It runs while the
 * host half does.
 */
export default defineWebPlugin({
  id: "mcp.servers",
  requires: { slots: Slots, client: Client, notify: Notify, settings: Settings },
  styles: `${pageStyles}\n${styles}`,
  setup: ({ slots, client, notify, settings }, plugin) => {
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
    const items = createMemo((): readonly ServerItem[] =>
      (state()?.servers ?? []).map((server) => ({
        id: server.name,
        title: server.name,
        ...(server.server?.version === undefined ? {} : { version: server.server.version }),
        ...(server.icon === undefined ? {} : { icon: server.icon }),
        ...(server.iconDark === undefined ? {} : { iconDark: server.iconDark }),
        status: statusOf(server),
        enabled: server.enabled,
        setEnabled: (enabled) => void actions.configure(server.name, { enabled }).catch(() => {}),
        keywords: `mcp server ${server.target} ${server.description ?? ""} ${server.tools.map((tool) => tool.name).join(" ")}`,
      })),
    );
    addIntegrationsPage(slots, settings, {
      items,
      loaded: () => state() !== undefined,
      problem: () => {
        const error = state()?.fileError;
        return error === undefined ? undefined : `${state()!.file}: ${error}`;
      },
      detail: (props) => <ServerDetail {...props} actions={actions} />,
      add: (props) => <AddServer {...props} actions={actions} />,
    });
    addMcpCommand(slots, client, notify, state);
  },
});
