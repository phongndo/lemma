import { For, Index, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { IntegrationKinds } from "@lemma/integrations";
import type { IntegrationAddProps, IntegrationDetailProps, IntegrationItem, IntegrationStatus } from "@lemma/integrations";
import { McpChannels } from "@lemma/mcp";
import type { Exposure, McpServerChange, McpServerConfig, McpServerStatus, McpState, McpToolInfo } from "@lemma/mcp";
import { Client, Notify, Slots, defineWebPlugin, usePlugin } from "@lemma/web";
import { AlertIcon, ChevronDownIcon, CopyButton, HammerIcon, PlusIcon, RefreshIcon, Segmented, Toggle, XIcon } from "@lemma/look";
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

const STATES: Readonly<Record<McpServerStatus["state"], string>> = { connected: "Connected", connecting: "Connecting…", failed: "Failed", off: "Off" };

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
  switch (server.state) {
    case "connected":
      return { tone: "ok", text: `Connected · ${count(reached, "tool")}` };
    case "connecting":
      return { tone: "busy", text: "Connecting…" };
    case "failed":
      return { tone: "error", text: "Failed" };
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
              <span class="integration-hint">Streamable HTTP. A server that needs signing in takes a token in a header.</span>
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
                {STATES[server().state]}
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
                        <button type="button" class="button small mcp-danger" onClick={remove}>
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
  },
});
