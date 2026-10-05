import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import type { JSX } from "solid-js";
import { HostError, MCP_HIDDEN, parseMcpInput } from "@lemma/contracts";
import type { ImportedServer, InteractionRequest, McpImport, McpLogEntry, McpServerInfo, McpToolInfo } from "@lemma/contracts";
import { summarizeToolArgs } from "../model/format.ts";
import {
  describeStatus,
  hintLabels,
  listWords,
  matchServers,
  matchTools,
  needsAttention,
  plural,
  readEdit,
  secretChanges,
  serverName,
  serverSearchText,
  serverTarget,
  shortStatus,
  specText,
  statusTone,
  toolCallSummary,
  toolSearchText,
  toolTitle,
  transportLabel,
  transportOf,
} from "../model/mcp.ts";
import {
  ActionIds,
  Actions,
  ComposerNotices,
  Dialogs,
  Interactions,
  Layers,
  Mcp,
  Notify,
  Settings,
  SettingsGroups,
  SettingsSections,
  Slots,
  ToolViews,
} from "../ui/contracts.ts";
import type { InteractionsService, McpService, NotifyService, SettingsService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { DEFAULT_PART_ORDER } from "../ui/slots.ts";
import {
  AlertIcon,
  Dialog,
  ExternalIcon,
  KeyIcon,
  Markdown,
  MoreIcon,
  PlugIcon,
  PlusIcon,
  Popover,
  RefreshIcon,
  SearchField,
  Spinner,
  Toggle,
  TrashIcon,
  XIcon,
} from "../ui/parts.tsx";
import styles from "./mcp-page.css?inline";

const SECTION = "mcp";
const SERVER_DIALOG = "mcp-page.server";
const REMOVE_DIALOG = "mcp-page.remove";

/** One of each thing the add dialog reads. */
const PLACEHOLDER = `https://mcp.linear.app/mcp
npx -y @playwright/mcp@latest
{ "mcpServers": { "github": { "url": "https://api.githubcopilot.com/mcp/" } } }`;

/** What the server dialog opens to: a server to edit, else adding. */
interface DialogRequest {
  readonly id?: string | undefined;
}

/** What the page's pieces share. */
interface Page {
  readonly mcp: McpService;
  readonly notify: NotifyService;
  readonly interactions: InteractionsService;
  readonly settings: SettingsService;
  readonly query: () => string;
  readonly setQuery: (query: string) => void;
  readonly selectedId: () => string | undefined;
  readonly select: (id: string) => void;
  /** Shows a server on the page, opening the page when it is not shown. */
  readonly show: (id: string) => void;
  /** Opens the dialog to edit server `id`, or without one, to add servers. */
  readonly openDialog: (id?: string) => void;
  readonly askRemove: (id: string) => void;
  /** A switch's value while its change is on its way to the host, by key: `server:<id>` (on), `tool:<id>:<name>` (offered). */
  readonly wanted: (key: string) => boolean | undefined;
  readonly setEnabled: (server: McpServerInfo, enabled: boolean) => void;
  readonly setTool: (server: McpServerInfo, tool: McpToolInfo, enabled: boolean) => void;
  /** Runs a change named `key` (a spinner shows while it runs), reporting a failure with `context`. */
  readonly run: (key: string, context: string, action: () => Promise<void>) => void;
  readonly busy: (key: string) => boolean;
  readonly signIn: (server: McpServerInfo) => void;
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const isUrlServer = (server: McpServerInfo) => server.type !== "stdio";

function Dot(props: { server: McpServerInfo }) {
  return <span class={`mcp-dot mcp-dot-${statusTone(props.server.status)}`} />;
}

// ------------------------------------------------------------------ the list

function ServerRow(props: { page: Page; server: McpServerInfo; selected: boolean }) {
  const name = () => serverName(props.server.spec);
  const enabled = () => props.page.wanted(`server:${props.server.id}`) ?? props.server.spec.enabled !== false;
  return (
    <div
      class="mcp-row"
      classList={{ selected: props.selected, off: !enabled() }}
      role="option"
      aria-selected={props.selected}
      data-server={props.server.id}
      onClick={() => props.page.select(props.server.id)}
    >
      <Dot server={props.server} />
      <span class="mcp-row-text">
        <span class="mcp-row-name">{name()}</span>
        <span class="mcp-row-target">{serverTarget(props.server.spec)}</span>
      </span>
      <span class={`mcp-row-status mcp-tone-${statusTone(props.server.status)}`}>{shortStatus(props.server)}</span>
      <span class="mcp-row-toggle" onClick={(event) => event.stopPropagation()} data-tip={enabled() ? `Turn ${name()} off` : `Turn ${name()} on`}>
        <Toggle label={`${name()} on`} checked={enabled()} onChange={(next) => props.page.setEnabled(props.server, next)} />
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ the inspector

/** A sign-in's question, inline: the page it redirected to, a choice, a confirmation. */
function InlineQuestion(props: { interactions: InteractionsService; request: InteractionRequest }) {
  const [value, setValue] = createSignal("");
  const dismiss = () => props.interactions.dismiss(props.request.id);
  return (
    <div class="mcp-question" onKeyDown={(event) => event.key === "Escape" && (event.stopPropagation(), dismiss())}>
      <Switch>
        <Match when={props.request.type === "ask" && props.request}>
          {(request) => (
            <form
              class="mcp-question-row"
              onSubmit={(event) => {
                event.preventDefault();
                if (value() !== "") props.interactions.answer(request().id, { type: "ask", value: value() });
              }}
            >
              <span class="mcp-question-title">{request().title}</span>
              <input
                class="field"
                type={request().secret ? "password" : "text"}
                autocomplete="off"
                spellcheck={false}
                aria-label={request().title}
                placeholder={request().placeholder ?? ""}
                value={value()}
                onInput={(event) => setValue(event.currentTarget.value)}
              />
              <button type="submit" class="button button-primary small" disabled={value() === ""}>
                Continue
              </button>
              <button type="button" class="button small" onClick={dismiss}>
                Cancel
              </button>
            </form>
          )}
        </Match>
        <Match when={props.request.type === "select" && props.request}>
          {(request) => (
            <div class="mcp-question-row" role="group" aria-label={request().title}>
              <span class="mcp-question-title">{request().title}</span>
              <For each={request().options}>
                {(option, index) => (
                  <button
                    class="button small"
                    classList={{ "button-primary": index() === 0 }}
                    data-tip={option.description}
                    onClick={() => props.interactions.answer(request().id, { type: "select", value: option.value })}
                  >
                    {option.label}
                  </button>
                )}
              </For>
              <button class="button small" onClick={dismiss}>
                Cancel
              </button>
            </div>
          )}
        </Match>
        <Match when={props.request.type === "confirm" && props.request}>
          {(request) => (
            <div class="mcp-question-row">
              <span class="mcp-question-title">{request().title}</span>
              <button class="button button-primary small" onClick={() => props.interactions.answer(request().id, { type: "confirm", value: true })}>
                Yes
              </button>
              <button class="button small" onClick={() => props.interactions.answer(request().id, { type: "confirm", value: false })}>
                No
              </button>
            </div>
          )}
        </Match>
      </Switch>
    </div>
  );
}

function SignIn(props: { page: Page; server: McpServerInfo }) {
  const id = () => props.server.id;
  const question = () => props.page.interactions.open().find((request) => request.origin === `mcp:${id()}`);
  const url = () => props.page.mcp.signInUrl(id());
  return (
    <Show when={props.page.mcp.signingIn() === id() || question() !== undefined}>
      <div class="mcp-signin">
        <div class="mcp-signin-head">
          <Spinner />
          <span class="mcp-signin-text">
            {url() === undefined ? "Starting the sign-in…" : `Continue in your browser to sign in to ${serverName(props.server.spec)}.`}
          </span>
          <Show when={url()}>
            {(href) => (
              <a class="button small" href={href()} target="_blank" rel="noreferrer">
                Open sign-in page <ExternalIcon />
              </a>
            )}
          </Show>
        </div>
        <Show when={question()} keyed>
          {(request) => <InlineQuestion interactions={props.page.interactions} request={request} />}
        </Show>
      </div>
    </Show>
  );
}

function ToolRow(props: { page: Page; server: McpServerInfo; tool: McpToolInfo }) {
  const [open, setOpen] = createSignal(false);
  const enabled = () => props.page.wanted(`tool:${props.server.id}:${props.tool.name}`) ?? props.tool.enabled;
  const long = () => (props.tool.description?.length ?? 0) > 150;
  return (
    <li class="mcp-tool" classList={{ off: !enabled() }}>
      <div class="mcp-tool-text">
        <div class="mcp-tool-head">
          <span class="mcp-tool-name" classList={{ code: props.tool.title === undefined }}>
            {props.tool.title ?? props.tool.name}
          </span>
          <Show when={props.tool.title !== undefined}>
            <span class="mcp-tool-id">{props.tool.name}</span>
          </Show>
          <For each={hintLabels(props.tool.hints)}>{(hint) => <span class="mcp-hint">{hint}</span>}</For>
        </div>
        {/* A description that only repeats the title says nothing more. */}
        <Show when={props.tool.description !== props.tool.title && props.tool.description}>
          {(description) => (
            <Show when={long()} fallback={<p class="mcp-tool-desc">{description()}</p>}>
              <button
                type="button"
                class="mcp-tool-desc"
                classList={{ open: open() }}
                aria-expanded={open()}
                data-tip={open() ? undefined : "Show all"}
                onClick={() => setOpen(!open())}
              >
                {description()}
              </button>
            </Show>
          )}
        </Show>
      </div>
      <Toggle label={`Offer ${props.tool.name}`} checked={enabled()} onChange={(next) => props.page.setTool(props.server, props.tool, next)} />
    </li>
  );
}

function Tools(props: { page: Page; server: McpServerInfo }) {
  const tools = () => matchTools(props.server, props.page.query());
  const offered = () => props.server.tools.filter((tool) => tool.enabled).length;
  const count = () => {
    const all = props.server.tools.length;
    if (all === 0) return "";
    if (tools().length !== all) return `${tools().length} of ${all} match`;
    return offered() === all ? String(all) : `${offered()} of ${all} offered`;
  };
  const none = () => {
    switch (props.server.status) {
      case "ready":
        return "It offers no tools.";
      case "off":
        return "Turn it on to list its tools.";
      case "starting":
        return "Listing its tools…";
      case "auth":
        return "Sign in to list its tools.";
      case "error":
        return "Its tools are listed once it connects.";
    }
  };
  return (
    <section class="mcp-section" aria-label="Tools">
      <h3 class="mcp-section-title">
        Tools <span class="mcp-count">{count()}</span>
      </h3>
      <Show when={props.server.tools.length > 0} fallback={<p class="mcp-quiet">{none()}</p>}>
        <ul class="mcp-tools">
          {/* By name, so a row keeps its open description while the server's state refreshes. */}
          <For each={tools().map((tool) => tool.name)} fallback={<li class="mcp-quiet">No tools match “{props.page.query().trim()}”</li>}>
            {(name) => (
              <Show when={props.server.tools.find((tool) => tool.name === name)}>
                {(tool) => <ToolRow page={props.page} server={props.server} tool={tool()} />}
              </Show>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/** What the config does not say: how it is reached, what it signed in to and offers, and where it is saved. Edit shows the config. */
function Details(props: { server: McpServerInfo }) {
  /** Label, value (none: no row), and whether the value is code. */
  const rows = (): readonly (readonly [string, string | undefined, boolean?])[] => {
    const server = props.server;
    const about = server.server;
    return [
      ["Transport", transportLabel(server.type)],
      [server.type === "stdio" ? "Command" : "URL", server.type === "stdio" ? serverTarget(server.spec) : server.spec.url, true],
      ["Secrets", server.secrets.length === 0 ? undefined : server.secrets.join(", "), true],
      ["Sign-in", server.signedIn === true ? "Signed in" : server.status === "auth" ? "Not signed in" : undefined],
      ["Server", about === undefined ? undefined : `${about.title ?? about.name} ${about.version}`],
      ["Protocol", server.protocol],
      [
        "Offers",
        server.status !== "ready"
          ? undefined
          : [plural(server.tools.length, "tool"), plural(server.resources, "resource"), plural(server.prompts, "prompt")].join(" · "),
      ],
      ["Saved in", server.scope === "project" ? "The project's config (.lemma/config.jsonc)" : "Your config (config.jsonc in Lemma's home)"],
    ];
  };
  return (
    <section class="mcp-section" aria-label="Details">
      <h3 class="mcp-section-title">Details</h3>
      <dl class="mcp-facts">
        <For each={rows().filter(([, value]) => value !== undefined)}>
          {([label, value, code]) => (
            <>
              <dt>{label}</dt>
              <dd classList={{ mono: code === true }}>{value}</dd>
            </>
          )}
        </For>
      </dl>
    </section>
  );
}

const sourceLabel = (entry: McpLogEntry) => (entry.source === "server" ? (entry.level ?? "log") : entry.source === "host" ? "lemma" : entry.source);

function LogLines(props: { entries: readonly McpLogEntry[]; ref?: (element: HTMLDivElement) => void }) {
  return (
    <div class="mcp-log" ref={(element) => props.ref?.(element)}>
      <For each={props.entries}>
        {(entry) => (
          <div
            class={`mcp-log-line mcp-log-${entry.source}`}
            classList={{
              "mcp-log-error": entry.level === "error" || entry.level === "critical" || entry.level === "alert" || entry.level === "emergency",
              "mcp-log-warning": entry.level === "warning",
            }}
          >
            <span class="mcp-log-time">{clock(entry.at)}</span>
            <span class="mcp-log-source">{sourceLabel(entry)}</span>
            <span class="mcp-log-text">{entry.text}</span>
          </div>
        )}
      </For>
    </div>
  );
}

function Logs(props: { page: Page; id: string }) {
  const [open, setOpen] = createSignal(false);
  const [entries, setEntries] = createSignal<readonly McpLogEntry[]>();
  const [loading, setLoading] = createSignal(false);
  let lines: HTMLDivElement | undefined;
  const load = async () => {
    setLoading(true);
    try {
      setEntries(await props.page.mcp.logs(props.id));
      // Newest at the bottom, in view.
      queueMicrotask(() => lines?.scrollTo({ top: lines.scrollHeight }));
    } catch (error) {
      props.page.notify.report(error, "Could not read its logs");
    } finally {
      setLoading(false);
    }
  };
  return (
    <details
      class="mcp-disclosure"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (event.currentTarget.open) void load();
      }}
    >
      <summary>
        <span>Logs</span>
        <Show when={open()}>
          <button
            class="icon-button mcp-summary-button"
            aria-label="Refresh logs"
            data-tip="Refresh"
            disabled={loading()}
            onClick={(event) => {
              event.preventDefault();
              void load();
            }}
          >
            <Show when={loading()} fallback={<RefreshIcon />}>
              <Spinner />
            </Show>
          </button>
        </Show>
      </summary>
      <Show
        when={entries()}
        fallback={
          <p class="mcp-quiet">
            <Spinner /> Reading…
          </p>
        }
      >
        {(list) => (
          <Show when={list().length > 0} fallback={<p class="mcp-quiet">Nothing logged yet.</p>}>
            <LogLines entries={list()} ref={(element) => (lines = element)} />
          </Show>
        )}
      </Show>
    </details>
  );
}

function Inspector(props: { page: Page; server: McpServerInfo; now: () => number }) {
  const { page } = props;
  const server = () => props.server;
  const id = () => server().id;
  const name = () => serverName(server().spec);
  const tone = () => statusTone(server().status);
  const busy = () => page.busy(`restart:${id()}`) || page.busy(`logout:${id()}`);
  const signingIn = () => page.mcp.signingIn() !== undefined;
  /** Signing in again and out, in the menu, once signed in; a server waiting on a sign-in has its own button. */
  const signItems = () => isUrlServer(server()) && server().signedIn === true;
  const missing = () => {
    const names = server().missing;
    if (names.length === 0) return undefined;
    const one = names.length === 1;
    return `${listWords(names)} ${one ? "is" : "are"} not set: edit the server to give ${one ? "it a value" : "them values"}, or set ${one ? "it" : "them"} in the host's environment.`;
  };
  return (
    <>
      <header class="mcp-head">
        <Dot server={server()} />
        <div class="mcp-head-text">
          <h2>{name()}</h2>
          <p class={`mcp-status mcp-tone-${tone()}`}>{describeStatus(server(), props.now())}</p>
        </div>
        <div class="mcp-actions">
          <Show when={busy()}>
            <Spinner />
          </Show>
          <Show when={isUrlServer(server()) && server().status === "auth"}>
            <button class="button button-primary small" disabled={signingIn()} onClick={() => page.signIn(server())}>
              Sign in
            </button>
          </Show>
          <button
            class="button small"
            disabled={busy() || server().status === "off"}
            data-tip="Disconnect and connect again"
            onClick={() => page.run(`restart:${id()}`, `Could not restart ${name()}`, () => page.mcp.restart(id()))}
          >
            Restart
          </button>
          <button class="button small" onClick={() => page.openDialog(id())}>
            Edit
          </button>
          <Popover label={`${name()} options`} tip="More" trigger={<MoreIcon />} triggerClass="icon-button" placement="bottom-end">
            {(close) => (
              <>
                <Show when={signItems()}>
                  <button
                    class="menu-item"
                    role="menuitem"
                    aria-disabled={signingIn()}
                    onClick={() => {
                      close();
                      if (!signingIn()) page.signIn(server());
                    }}
                  >
                    <span class="menu-label">Sign in again</span>
                  </button>
                  <button
                    class="menu-item"
                    role="menuitem"
                    onClick={() => {
                      close();
                      page.run(`logout:${id()}`, `Could not sign out of ${name()}`, async () => {
                        await page.mcp.logout(id());
                        page.notify.toast({ level: "info", message: `Signed out of ${name()}` });
                      });
                    }}
                  >
                    <span class="menu-label">Sign out</span>
                  </button>
                  <div class="menu-sep" />
                </Show>
                <button
                  class="menu-item mcp-menu-danger"
                  role="menuitem"
                  onClick={() => {
                    close();
                    page.askRemove(id());
                  }}
                >
                  <TrashIcon />
                  <span class="menu-label">Remove server…</span>
                </button>
              </>
            )}
          </Popover>
        </div>
      </header>
      <SignIn page={page} server={server()} />
      <Show when={missing()}>
        {(text) => (
          <div class="callout callout-warn mcp-callout-block">
            <AlertIcon />
            <span>{text()}</span>
            <button class="button small" onClick={() => page.openDialog(id())}>
              Edit
            </button>
          </div>
        )}
      </Show>
      <Tools page={page} server={server()} />
      <Show when={server().instructions}>
        {(text) => (
          <details class="mcp-disclosure">
            <summary>
              <span>Instructions from the server</span>
            </summary>
            <Markdown text={text()} class="mcp-instructions" />
          </details>
        )}
      </Show>
      <Details server={server()} />
      <Logs page={page} id={id()} />
    </>
  );
}

// ------------------------------------------------------------------ the page

/** No servers yet, or MCP turned off: what the page is for, and the one thing to do. */
function Blank(props: { lead: string; detail: string; children: JSX.Element }) {
  return (
    <div class="mcp-empty">
      <span class="mcp-empty-mark">
        <PlugIcon />
      </span>
      <p class="mcp-empty-lead">{props.lead}</p>
      <p class="mcp-empty-detail">{props.detail}</p>
      <div class="mcp-empty-actions">{props.children}</div>
    </div>
  );
}

/**
 * Every MCP server beside the selected one's inspector: its state, each tool,
 * and its details and logs. The search narrows servers and tools alike.
 */
function McpBody(props: { page: Page }) {
  const { page } = props;
  const mcp = page.mcp;
  // While the page shows, sign-ins' questions appear with their server rather than in a dialog.
  onCleanup(page.interactions.claim((request) => request.origin?.startsWith("mcp:") === true));
  const [now, setNow] = createSignal(Date.now());
  // A countdown to the next attempt ticks while some server has one.
  createEffect(() => {
    if (!mcp.servers().some((server) => server.retryAt !== undefined)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const shown = createMemo(() => matchServers(mcp.servers(), page.query()));
  const current = createMemo(() => {
    const id = page.selectedId();
    return shown().find((server) => server.id === id) ?? shown()[0];
  });
  let list: HTMLDivElement | undefined;
  createEffect(
    on(
      () => current()?.id,
      (id) => {
        if (id !== undefined) list?.querySelector(`[data-server="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
      },
    ),
  );
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = shown();
    const at = rows.findIndex((server) => server.id === current()?.id);
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))];
    if (next !== undefined) page.select(next.id);
  };
  const count = () => {
    const all = mcp.servers().length;
    return shown().length === all ? plural(all, "server") : `${shown().length} of ${all}`;
  };
  return (
    <div class="mcp-page">
      <Switch>
        <Match when={!mcp.loaded()}>
          <p class="settings-empty mcp-loading">
            <Spinner /> Loading servers…
          </p>
        </Match>
        <Match when={mcp.unavailable()}>
          {(why) => (
            <Blank lead="MCP is off" detail={why()}>
              <button class="button small" onClick={() => page.settings.open("plugins", { plugin: "mcp", kind: "host" })}>
                Open Plugins
              </button>
            </Blank>
          )}
        </Match>
        <Match when={mcp.servers().length === 0}>
          <Blank
            lead="MCP servers give the model tools: a browser, your issue tracker, a database…"
            detail="Add one by its URL or the command that starts it, or paste its config from a README or another app."
          >
            <button class="button button-primary small" onClick={() => page.openDialog()}>
              <PlusIcon /> Add server
            </button>
          </Blank>
        </Match>
        <Match when={true}>
          <SearchField value={page.query()} onInput={page.setQuery} placeholder="Search servers and tools" label="Search MCP servers and tools">
            <span class="muted small mcp-total">{count()}</span>
            <button class="button button-primary small" onClick={() => page.openDialog()}>
              <PlusIcon /> Add server
            </button>
          </SearchField>
          <div class="mcp-split">
            <div class="mcp-list" role="listbox" aria-label="MCP servers" tabindex="0" ref={list} onKeyDown={onKey}>
              {/* By id, so a row stays put (and keeps focus) while its server's state refreshes. */}
              <For each={shown().map((server) => server.id)} fallback={<p class="mcp-quiet mcp-none">No servers or tools match “{page.query().trim()}”</p>}>
                {(id) => (
                  <Show when={mcp.servers().find((server) => server.id === id)}>
                    {(server) => <ServerRow page={page} server={server()} selected={current()?.id === id} />}
                  </Show>
                )}
              </For>
            </div>
            <section class="mcp-detail" aria-label="Server details">
              {/* A new selection starts fresh (closed disclosures); a refresh of the same server does not. */}
              <Show when={current()?.id} keyed>
                {(id) => (
                  <Show when={mcp.servers().find((server) => server.id === id)}>{(server) => <Inspector page={page} server={server()} now={now} />}</Show>
                )}
              </Show>
            </section>
          </div>
        </Match>
      </Switch>
    </div>
  );
}

// ------------------------------------------------------------------ the dialogs

/** A server the dialog read: what it is called and where it is, the values kept as secrets, and what to check. */
function Found(props: { server: ImportedServer }) {
  const spec = () => props.server.spec;
  const secrets = () => Object.keys(props.server.secrets);
  return (
    <div class="mcp-found">
      <div class="mcp-found-head">
        <span class="mcp-found-name">{serverName(spec())}</span>
        <Show when={serverName(spec()) !== spec().id}>
          <span class="mcp-found-id">{spec().id}</span>
        </Show>
        <span class="mcp-found-type">{transportLabel(transportOf(spec()))}</span>
      </div>
      <span class="mcp-found-target">{serverTarget(spec())}</span>
      <Show when={secrets().length > 0}>
        <p class="mcp-note">
          <KeyIcon /> {listWords(secrets())} {secrets().length === 1 ? "is kept as a secret" : "are kept as secrets"}, out of the config
        </p>
      </Show>
      <For each={props.server.notes}>
        {(note) => (
          <p class="mcp-note mcp-tone-warn">
            <AlertIcon /> {note}
          </p>
        )}
      </For>
    </div>
  );
}

/**
 * Adding servers from what is pasted (a URL, a command line, or a config from
 * a README or another app), or editing one as its config holds it. Below the
 * text, what saving it would save.
 */
function ServerDialog(props: { page: Page; request: DialogRequest; close: () => void }) {
  const { page } = props;
  const editing = untrack(() => page.mcp.servers().find((server) => server.id === props.request.id));
  const initial = editing === undefined ? "" : specText(editing.spec);
  const [text, setText] = createSignal(initial);
  const [saving, setSaving] = createSignal(false);
  // Held while saving, so the servers it adds do not rename the rest in view.
  const read = createMemo<McpImport>(
    (last) =>
      saving()
        ? last
        : editing === undefined
          ? parseMcpInput(text(), { taken: page.mcp.servers().map((server) => server.id) })
          : readEdit(text(), editing.spec),
    { servers: [], problems: [] },
  );
  const count = () => read().servers.length;
  const save = async () => {
    const servers = read().servers;
    if (servers.length === 0 || saving()) return;
    setSaving(true);
    try {
      for (const server of servers) await page.mcp.save(server.spec, { secrets: secretChanges(server, editing?.secrets) });
      props.close();
      if (editing === undefined) {
        page.show(servers[0]!.spec.id);
        page.notify.toast({ level: "info", message: `Added ${servers.length === 1 ? serverName(servers[0]!.spec) : plural(servers.length, "server")}` });
      }
    } catch (error) {
      page.notify.report(error, editing === undefined ? "Could not add it" : `Could not save ${serverName(editing.spec)}`);
      setSaving(false);
    }
  };
  return (
    <Dialog
      title={editing === undefined ? "Add an MCP server" : `Edit ${serverName(editing.spec)}`}
      onClose={props.close}
      class="mcp-dialog"
      footer={
        <>
          <button class="button" onClick={props.close}>
            Cancel
          </button>
          <button class="button button-primary" disabled={count() === 0 || saving()} onClick={() => void save()}>
            <Show when={saving()}>
              <Spinner />
            </Show>
            {editing !== undefined ? "Save" : count() > 1 ? `Add ${count()} servers` : "Add server"}
          </button>
        </>
      }
    >
      <label class="mcp-paste">
        <span class="mcp-label">{editing === undefined ? "Paste a URL, a command, or a config" : "Its config"}</span>
        <textarea
          class="field mcp-text"
          data-autofocus
          rows={editing === undefined ? 4 : 12}
          spellcheck={false}
          autocomplete="off"
          placeholder={editing === undefined ? PLACEHOLDER : undefined}
          value={text()}
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            }
          }}
        />
      </label>
      <Show
        when={editing === undefined}
        fallback={
          <Show when={initial.includes(MCP_HIDDEN)}>
            <p class="mcp-help">{MCP_HIDDEN} keeps the value stored on the host.</p>
          </Show>
        }
      >
        <p class="mcp-help">From a server's README or another app: Claude, Cursor, VS Code, OpenCode.</p>
      </Show>
      <Show when={count() > 0 || read().problems.length > 0}>
        <div class="mcp-preview" role="status" aria-label="What it saves">
          <For each={read().servers}>{(server) => <Found server={server} />}</For>
          <For each={read().problems}>
            {(problem) => (
              <p class="mcp-note mcp-tone-err">
                <AlertIcon /> {problem}
              </p>
            )}
          </For>
        </div>
      </Show>
    </Dialog>
  );
}

function RemoveDialog(props: { page: Page; server: McpServerInfo; close: () => void }) {
  const name = () => serverName(props.server.spec);
  const remove = () => {
    // Read before closing: the dialog's server is gone with it.
    const { id } = props.server;
    const label = name();
    props.close();
    props.page.run(`remove:${id}`, `Could not remove ${label}`, async () => {
      await props.page.mcp.remove(id);
      props.page.notify.toast({ level: "info", message: `Removed ${label}` });
    });
  };
  return (
    <Dialog
      title={`Remove ${name()}?`}
      onClose={props.close}
      class="mcp-remove-dialog"
      footer={
        <>
          <button class="button" data-autofocus onClick={props.close}>
            Cancel
          </button>
          <button class="button mcp-danger-button" onClick={remove}>
            Remove server
          </button>
        </>
      }
    >
      <p class="mcp-dialog-text">
        The model loses {props.server.tools.length === 0 ? "its tools" : `its ${plural(props.server.tools.length, "tool")}`}. It leaves{" "}
        {props.server.scope === "project" ? "the project's config" : "your config"}, with its stored secrets
        {isUrlServer(props.server) ? " and sign-in" : ""}.
      </p>
    </Dialog>
  );
}

// ------------------------------------------------------------------ the plugin

/**
 * The MCP servers page (Settings › MCP servers), adding and editing servers,
 * the composer's notice when one needs a sign-in, and how the chat titles
 * calls to their tools. Draws the `mcp` plugin's model.
 */
export default defineUiPlugin({
  id: "mcp-page",
  styles,
  requires: { mcp: Mcp, settings: Settings, slots: Slots, notify: Notify, interactions: Interactions, dialogs: Dialogs },
  setup: ({ mcp, settings, slots, notify, interactions, dialogs }, plugin) => {
    // In the address (`?server=github&q=issue`): a link, a reload, and back and forward return to them.
    const params = () => (settings.section() === SECTION ? settings.params() : {});
    const show = (id: string) => {
      if (settings.section() === SECTION) settings.setParams({ server: id, q: undefined });
      else settings.open(SECTION, { server: id });
    };
    const [wanted, setWanted] = createSignal<Readonly<Record<string, boolean>>>({});
    const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
    const run = (key: string, context: string, action: () => Promise<void>) => {
      setBusy((keys) => new Set([...keys, key]));
      action()
        .catch((error) => notify.report(error, context))
        .finally(() => setBusy((keys) => new Set([...keys].filter((other) => other !== key))));
    };
    /** Shows `value` on a switch until the host has it (or refuses). */
    const want = (key: string, value: boolean, context: string, action: () => Promise<void>) => {
      setWanted((all) => ({ ...all, [key]: value }));
      action()
        .catch((error) => notify.report(error, context))
        .finally(() => setWanted(({ [key]: _done, ...rest }) => rest));
    };
    const signIn = (server: McpServerInfo) => {
      const name = serverName(server.spec);
      if (settings.section() !== SECTION || params().server !== server.id) show(server.id);
      mcp.login(server.id).then(
        () => notify.toast({ level: "info", message: `Signed in to ${name}` }),
        (error) => {
          if (!(error instanceof HostError && error.code === "Cancelled")) notify.report(error, `Could not sign in to ${name}`);
        },
      );
    };
    const [request, setRequest] = createSignal<DialogRequest>();
    const [removing, setRemoving] = createSignal<string>();
    const page: Page = {
      mcp,
      notify,
      interactions,
      settings,
      query: () => params().q ?? "",
      setQuery: (query) => settings.setParams({ q: query }),
      selectedId: () => params().server,
      select: (id) => settings.setParams({ server: id }),
      show,
      openDialog: (id) => {
        setRequest({ id });
        dialogs.open(SERVER_DIALOG);
      },
      askRemove: (id) => {
        setRemoving(id);
        dialogs.open(REMOVE_DIALOG);
      },
      wanted: (key) => wanted()[key],
      setEnabled: (server, enabled) =>
        want(`server:${server.id}`, enabled, `Could not turn ${serverName(server.spec)} ${enabled ? "on" : "off"}`, () => mcp.setEnabled(server.id, enabled)),
      setTool: (server, tool, enabled) =>
        want(`tool:${server.id}:${tool.name}`, enabled, `Could not ${enabled ? "offer" : "withhold"} ${tool.name}`, () =>
          mcp.setTool(server.id, tool.name, enabled),
        ),
      run,
      busy: (key) => busy().has(key),
      signIn,
    };

    const add = (remove: () => void) => plugin.onCleanup(remove);
    add(
      slots.add(SettingsSections, {
        id: SECTION,
        // Right after Providers: what the model can use.
        order: 25,
        title: "MCP servers",
        icon: PlugIcon,
        badge: () => {
          const count = mcp.servers().filter(needsAttention).length;
          return count === 0 ? undefined : String(count);
        },
        body: () => <McpBody page={page} />,
      }),
    );
    // What the settings search finds; picking one shows it on the page.
    add(
      slots.add(SettingsGroups, {
        id: `${SECTION}.servers`,
        section: SECTION,
        entries: () =>
          mcp.servers().map((server) => ({
            text: serverSearchText(server),
            view: () => (
              <button class="setting-row mcp-result" onClick={() => settings.open(SECTION, { server: server.id })}>
                <Dot server={server} />
                <span class="mcp-result-name">{serverName(server.spec)}</span>
                <span class="mcp-result-detail">{serverTarget(server.spec)}</span>
                <span class="spacer" />
                <span class={`mcp-result-status mcp-tone-${statusTone(server.status)}`}>{shortStatus(server)}</span>
              </button>
            ),
          })),
      }),
    );
    add(
      slots.add(SettingsGroups, {
        id: `${SECTION}.tools`,
        order: 1,
        section: SECTION,
        title: "Tools",
        entries: () =>
          mcp.servers().flatMap((server) =>
            server.tools.map((tool) => ({
              text: toolSearchText(server, tool),
              view: () => (
                <button class="setting-row mcp-result" onClick={() => settings.open(SECTION, { server: server.id, q: tool.name })}>
                  <span class="mcp-result-name">{toolTitle(tool)}</span>
                  <span class="mcp-result-detail">{serverName(server.spec)}</span>
                  <span class="spacer" />
                  <span class="mcp-result-status">{tool.enabled ? "" : "not offered"}</span>
                </button>
              ),
            })),
          ),
      }),
    );
    add(
      slots.add(Layers, {
        id: SERVER_DIALOG,
        component: () => (
          <Show when={dialogs.current() === SERVER_DIALOG && request()} keyed>
            {(next) => <ServerDialog page={page} request={next} close={() => dialogs.open(undefined)} />}
          </Show>
        ),
      }),
    );
    add(
      slots.add(Layers, {
        id: REMOVE_DIALOG,
        component: () => (
          <Show when={dialogs.current() === REMOVE_DIALOG && mcp.servers().find((server) => server.id === removing())}>
            {(server) => <RemoveDialog page={page} server={server()} close={() => dialogs.open(undefined)} />}
          </Show>
        ),
      }),
    );

    // One quiet notice for every server waiting on a sign-in; "Not now" hides it until another one is.
    const [dismissed, setDismissed] = createSignal<string>();
    add(
      slots.add(ComposerNotices, {
        id: SECTION,
        order: 20,
        component: () => {
          const waiting = createMemo(() => mcp.servers().filter((server) => server.spec.enabled !== false && server.status === "auth"));
          const key = () =>
            waiting()
              .map((server) => server.id)
              .join(" ");
          return (
            <Show when={waiting().length > 0 && dismissed() !== key()}>
              <div class="callout mcp-callout" role="status">
                <PlugIcon />
                <span class="mcp-callout-text">
                  {waiting().length === 1 ? `${serverName(waiting()[0]!.spec)} needs you to sign in` : `${waiting().length} MCP servers need you to sign in`}
                </span>
                <button class="button small" disabled={mcp.signingIn() !== undefined} onClick={() => signIn(waiting()[0]!)}>
                  Sign in
                </button>
                <button class="icon-button" aria-label="Not now" data-tip="Not now" onClick={() => setDismissed(key())}>
                  <XIcon />
                </button>
              </div>
            </Show>
          );
        },
      }),
    );

    // Each server's tools titled in the chat (`GitHub · Create issue`), kept in step with the servers.
    const toolViews = new Map<string, () => void>();
    createEffect(() => {
      const names = new Set(mcp.servers().flatMap((server) => server.tools.map((tool) => tool.tool)));
      untrack(() => {
        for (const [name, remove] of toolViews) {
          if (names.has(name)) continue;
          remove();
          toolViews.delete(name);
        }
        for (const name of names) {
          if (toolViews.has(name)) continue;
          toolViews.set(
            name,
            slots.add(ToolViews, {
              id: name,
              // A plugin's own view of the tool, at a lower order, comes first.
              order: DEFAULT_PART_ORDER,
              summary: (args, context) => {
                const owner = mcp.toolOwner(name);
                return owner === undefined ? summarizeToolArgs(name, args, context) : toolCallSummary(owner.server, owner.tool, args);
              },
            }),
          );
        }
      });
    });
    plugin.onCleanup(() => {
      for (const remove of toolViews.values()) remove();
      toolViews.clear();
    });

    const keywords = ["mcp", "tools", "servers", "connectors", "model context protocol"];
    add(
      slots.add(Actions, {
        id: ActionIds.mcp,
        order: 6,
        title: "Manage MCP servers…",
        category: "MCP",
        keywords,
        icon: PlugIcon,
        run: (id) => (id === undefined || id === "" ? settings.open(SECTION) : show(id)),
      }),
    );
    add(
      slots.add(Actions, {
        id: "mcp-page.add",
        order: 6,
        title: "Add MCP server…",
        category: "MCP",
        keywords: [...keywords, "add", "connect", "install"],
        icon: PlusIcon,
        when: () => mcp.unavailable() === undefined,
        run: () => page.openDialog(),
      }),
    );
  },
});
