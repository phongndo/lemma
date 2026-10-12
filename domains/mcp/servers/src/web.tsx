import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { McpChannels } from "@lemma/mcp";
import type { Exposure, McpServerChange, McpServerStatus, McpState, McpToolInfo } from "@lemma/mcp";
import { SettingsGroups, SettingsSections } from "@lemma/settings";
import { Client, Notify, Slots, defineWebPlugin } from "@lemma/web";
import { AlertIcon, ChevronDownIcon, CopyButton, HammerIcon, RefreshIcon, Segmented, Toggle } from "@lemma/look";
import styles from "./mcp.css?inline";

const SECTION = "mcp";

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
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer \${DOCS_TOKEN}" }
    }
  }
}`;

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

interface Actions {
  readonly reconnect: (server: string) => void;
  readonly configure: (server: string, change: McpServerChange) => void;
  /** Whether a server's tools are listed, kept here so a row drawn again keeps it. */
  readonly open: (server: string) => boolean;
  readonly setOpen: (server: string, open: boolean) => void;
}

/**
 * A tool and how it reaches the model: its own exposure, or by default its server's, unless a pattern or the plugin
 * adding the server decides it, which it says.
 */
function ToolRow(props: { server: string; tool: McpToolInfo; actions: Actions }) {
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
        onChange={(value) => props.actions.configure(props.server, { tools: { [props.tool.name]: value === "default" ? null : (value as Exposure) } })}
      />
    </li>
  );
}

/** One server: its state and switch, how its tools reach the model, why it failed, and its tools. */
function ServerRow(props: { server: () => McpServerStatus; actions: Actions }): JSX.Element {
  const server = () => props.server();
  const open = () => props.actions.open(server().name);
  const reached = () => server().tools.filter((tool) => tool.exposure !== "hidden").length;
  return (
    <div class="mcp-server" data-state={server().state}>
      <div class="mcp-server-head">
        <span class="mcp-state" title={STATES[server().state]} />
        <span class="mcp-server-info">
          <span class="mcp-server-name">
            {server().name}
            <Show when={server().server?.version}>{(version) => <span class="muted small"> {version()}</span>}</Show>
          </span>
          <span class="mcp-server-meta">
            {STATES[server().state]}
            <Show when={server().state === "connected"}> · {count(reached(), "tool")}</Show>
            {" · "}
            <code title={server().target}>{server().target}</code>
          </span>
        </span>
        <Show when={server().enabled && server().state !== "connecting"}>
          <button class="icon-button" aria-label={`Reconnect ${server().name}`} title="Reconnect" onClick={() => props.actions.reconnect(server().name)}>
            <RefreshIcon />
          </button>
        </Show>
        <Toggle label={`${server().name} on`} checked={server().enabled} onChange={(enabled) => props.actions.configure(server().name, { enabled })} />
      </div>
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
      <Show when={server().enabled}>
        <div class="mcp-server-controls">
          <Segmented
            label={`How ${server().name}'s tools reach the model`}
            value={server().exposure}
            options={EXPOSURES}
            onChange={(value) => props.actions.configure(server().name, { exposure: value as Exposure })}
          />
          <Show when={server().tools.length > 0}>
            <button class="button small mcp-tools-toggle" aria-expanded={open()} onClick={() => props.actions.setOpen(server().name, !open())}>
              {count(server().tools.length, "tool")}
              <ChevronDownIcon />
            </button>
          </Show>
        </div>
      </Show>
      <Show when={open() && server().enabled}>
        <ul class="mcp-tools">
          <For each={server().tools}>{(tool) => <ToolRow server={server().name} tool={tool} actions={props.actions} />}</For>
        </ul>
      </Show>
      <Show when={server().sourceKind === "plugin"}>
        <p class="muted small mcp-source">Added by the plugin {server().source}</p>
      </Show>
    </div>
  );
}

/**
 * The web half of `mcp.servers`: Settings › MCP, every server with its state, why one failed, a switch, and how its
 * tools reach the model, written to the user's `mcp.json`. It runs while the host half does.
 */
export default defineWebPlugin({
  id: "mcp.servers",
  requires: { slots: Slots, client: Client, notify: Notify },
  styles,
  setup: ({ slots, client, notify }, plugin) => {
    const [state, setState] = createSignal<McpState>();
    // The state when subscribed, and again after every change: a server connecting, failing, or the file edited.
    plugin.onCleanup(client.follow(McpChannels.changes, undefined, setState));
    const call = (what: string, work: () => Promise<unknown>) => work().catch((error: unknown) => notify.report(error, what));
    const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set());
    const actions: Actions = {
      open: (server) => opened().has(server),
      setOpen: (server, open) =>
        setOpened((current) => {
          const next = new Set(current);
          if (open) next.add(server);
          else next.delete(server);
          return next;
        }),
      reconnect: plugin.action("reconnect", (server: string) => call(`Reconnecting ${server}`, () => client.channel.call(McpChannels.reconnect, { server }))),
      configure: plugin.action("configure", (server: string, change: McpServerChange) =>
        call(`Changing ${server}`, () => client.channel.call(McpChannels.configure, { server, change })),
      ),
    };
    const file = () => state()?.file ?? "mcp.json";
    const failed = createMemo(() => state()?.servers.filter((server) => server.state === "failed").length ?? 0);

    slots.add(SettingsSections, {
      id: SECTION,
      order: 25,
      title: "MCP",
      icon: HammerIcon,
      badge: () => (failed() === 0 ? undefined : String(failed())),
      intro: () => (
        <>
          <p class="settings-intro">
            Model Context Protocol servers, from <code>{file()}</code> and plugins. Their tools reach the model through code mode, which finds them by
            searching, unless set to Direct.
          </p>
          <Show when={state()?.fileError}>
            {(error) => (
              <div class="callout callout-warn">
                <AlertIcon />
                <span>
                  {file()}: {error()}
                </span>
              </div>
            )}
          </Show>
        </>
      ),
      empty: () => (
        <Show when={state() !== undefined} fallback={<p class="settings-empty">Loading servers…</p>}>
          <div class="mcp-empty">
            <p class="settings-empty">
              No MCP servers yet. Add one to <code>{file()}</code>, in the shape other MCP clients use; it connects as soon as the file is saved.
            </p>
            <div class="mcp-example">
              <pre>{EXAMPLE}</pre>
              <CopyButton text={EXAMPLE} label="Copy example" />
            </div>
          </div>
        </Show>
      ),
    });
    /**
     * Each server's name and what a search matches in it: the rows are drawn again only when these change, and each
     * reads its server's state as it changes, so a list of tools opened stays open.
     */
    const listed = createMemo(
      () =>
        (state()?.servers ?? []).map((server) => ({
          name: server.name,
          text: `mcp server ${server.name} ${server.target} ${server.description ?? ""} ${server.tools.map((tool) => tool.name).join(" ")}`,
        })),
      [],
      { equals: (a, b) => a.length === b.length && a.every((row, i) => row.name === b[i]!.name && row.text === b[i]!.text) },
    );
    const statusOf = (name: string) => state()?.servers.find((server) => server.name === name);
    slots.add(SettingsGroups, {
      id: `${SECTION}.servers`,
      section: SECTION,
      title: "Servers",
      entries: () =>
        listed().map(({ name, text }) => ({
          text,
          view: () => <Show when={statusOf(name)}>{(server) => <ServerRow server={server} actions={actions} />}</Show>,
        })),
    });
  },
});
