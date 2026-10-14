import { For, Index, Show, createMemo, createResource, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { IntegrationKinds } from "@lemma/integrations";
import type {
  IntegrationAddProps,
  IntegrationCatalog,
  IntegrationDetailProps,
  IntegrationItem,
  IntegrationOffer,
  IntegrationStatus,
} from "@lemma/integrations";
import { ComposerTakeovers, Threads, ThreadsActionIds, ToolViews } from "@lemma/threads";
import { Actions } from "@lemma/actions";
import { ACCESS_LEVELS } from "@lemma/agent";
import type { HarnessLogo } from "@lemma/agent";
import type { ToolView } from "@lemma/threads";
import { Client, Notify, Slots, defineWebPlugin, usePlugin } from "@lemma/web";
import { AlertIcon, BotIcon, CopyButton, ExternalIcon, PlusIcon, RefreshIcon, Toggle, XIcon } from "@lemma/look";
import type { IconName } from "@lemma/look";
import { AcpChannels } from "@lemma/agent/acp";
import type { AcpAgentStatus, AcpState, AgentEntry, PermissionRequest, RegistryAgent } from "@lemma/agent/acp";
import { entryFrom, idFrom, isImageAddress, joinCommand } from "./form.ts";
import type { AgentDraft, Rows } from "./form.ts";
import { PRESETS } from "./presets.ts";
import { approvalTakeover } from "./approval.tsx";
import { Logo } from "./logo.tsx";
import styles from "./acp.css?inline";

const KIND = "agents";

/** An agent's mark: the host's, or, before it has said one, the supported agent's of its id. */
const markOf = (agent: AcpAgentStatus): HarnessLogo | undefined => agent.logo ?? PRESETS.find((preset) => preset.id === agent.id)?.logo;

const statusOf = (agent: AcpAgentStatus): IntegrationStatus => {
  switch (agent.state) {
    case "off":
      return { tone: "off", text: "Off" };
    case "missing":
      return { tone: "warn", text: "Not installed" };
    case "failed":
      return { tone: "error", text: "Failed" };
    case "ready":
      return { tone: "ok", text: agent.sessions === 0 ? "Ready" : `Running · ${agent.sessions} thread${agent.sessions === 1 ? "" : "s"}` };
  }
};

const STATES: Readonly<Record<AcpAgentStatus["state"], string>> = {
  off: "Off",
  missing: "Not installed",
  failed: "Failed",
  ready: "Ready",
};

interface Actions {
  readonly state: () => AcpState | undefined;
  readonly put: (id: string, entry: AgentEntry | null) => Promise<void>;
  readonly check: (id: string) => Promise<AcpAgentStatus>;
  readonly authenticate: (id: string, method: string) => Promise<void>;
  readonly registry: () => Promise<readonly RegistryAgent[]>;
}

/** The entry that turns the agent on or off, the rest of its entry kept (a preset's may be left empty, which keeps it added). */
const switched = (agent: AcpAgentStatus, enabled: boolean): AgentEntry => {
  const { enabled: _, ...rest } = agent.entry ?? {};
  return enabled ? rest : { ...rest, enabled: false };
};

const presetOf = (id: string) => PRESETS.find((preset) => preset.id === id);

/** Environment rows: a row to add, and a remove button on each. */
function EnvEditor(props: { rows: Rows; onChange: (rows: Rows) => void }) {
  const set = (index: number, patch: Partial<Rows[number]>) => props.onChange(props.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div class="integration-field">
      <span>Environment</span>
      <Index each={props.rows}>
        {(row, index) => (
          <div class="integration-kv">
            <input
              class="field"
              aria-label="Variable name"
              placeholder="ANTHROPIC_API_KEY"
              value={row().name}
              spellcheck={false}
              onInput={(event) => set(index, { name: event.currentTarget.value })}
            />
            <input
              class="field"
              aria-label="Variable value"
              placeholder="value"
              value={row().value}
              spellcheck={false}
              onInput={(event) => set(index, { value: event.currentTarget.value })}
            />
            <button
              type="button"
              class="icon-button"
              aria-label={`Remove ${row().name || "variable"}`}
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
          Add variable
        </button>
      </div>
      <span class="integration-hint">Added to the host's environment for it. A key here is written to agents.json as it is.</span>
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

/** An icon's address, with the icon it draws beside it. */
function IconField(props: { value: string; onInput: (value: string) => void }) {
  const shown = () => (isImageAddress(props.value.trim()) ? props.value.trim() : undefined);
  return (
    <label class="integration-field">
      <span>Icon</span>
      <span class="acp-icon-field">
        <span class="integration-icon" aria-hidden="true">
          <Picture src={shown()} fallback={<BotIcon />} />
        </span>
        <input
          class="field"
          value={props.value}
          placeholder="https://example.com/icon.svg, or a data:image/ URL"
          spellcheck={false}
          onInput={(event) => props.onInput(event.currentTarget.value)}
        />
      </span>
      <span class="integration-hint">Optional: an image of its own, over the mark Lemma knows it by.</span>
    </label>
  );
}

/** An agent's settings as a form: its name, the command that starts it, its environment, and whether it gets the MCP servers. */
function AgentForm(props: { draft: AgentDraft; submitLabel: string; submit: (draft: AgentDraft) => Promise<void>; cancel: () => void; naming?: boolean }) {
  const plugin = usePlugin();
  const [draft, setDraft] = createSignal(props.draft);
  const [error, setError] = createSignal<string>();
  const [saving, setSaving] = createSignal(false);
  const update = (patch: Partial<AgentDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const save = plugin.action("save agent", async () => {
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
      class="acp-form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label class="integration-field">
        <span>Name</span>
        <input
          class="field"
          value={draft().title}
          placeholder="My agent"
          data-autofocus={props.naming === true ? "" : undefined}
          onInput={(event) => update({ title: event.currentTarget.value })}
        />
        <Show when={props.naming}>
          <span class="integration-hint">Its id, which each turn it runs is logged under: {idFrom(draft().title) || "…"}</span>
        </Show>
      </label>
      <label class="integration-field">
        <span>Command</span>
        <input
          class="field"
          value={draft().command}
          placeholder="my-agent --acp"
          spellcheck={false}
          onInput={(event) => update({ command: event.currentTarget.value })}
        />
        <span class="integration-hint">Starts it speaking the Agent Client Protocol over stdin and stdout, on the host, from its PATH.</span>
      </label>
      <IconField value={draft().icon ?? ""} onInput={(icon) => update({ icon })} />
      <EnvEditor rows={draft().env} onChange={(env) => update({ env })} />
      <div class="acp-switch-row">
        <span class="integration-hint">Hand it the MCP servers set up here (Settings › Integrations › MCP servers) with each thread.</span>
        <Toggle label="Hand it the MCP servers" checked={draft().mcp} onChange={(mcp) => update({ mcp })} />
      </div>
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

const draftOf = (agent: AcpAgentStatus): AgentDraft => ({
  title: agent.title,
  command: joinCommand([agent.command, ...agent.args]),
  env: Object.entries(agent.entry?.env ?? {}).map(([name, value]) => ({ name, value })),
  mcp: agent.mcp,
  icon: agent.entry?.icon ?? "",
});

/** One agent's details: whether it can run, how it signs in, its command line, and editing, resetting, or removing it. */
function AgentDetail(props: IntegrationDetailProps & { actions: Actions }) {
  const plugin = usePlugin();
  const agent = () => props.actions.state()?.agents.find((candidate) => candidate.id === props.id);
  const [editing, setEditing] = createSignal(false);
  const [checking, setChecking] = createSignal(false);
  const [signing, setSigning] = createSignal<string>();
  const [problem, setProblem] = createSignal<string>();
  const [confirming, setConfirming] = createSignal(false);
  const attempt = async (what: () => Promise<unknown>) => {
    setProblem(undefined);
    try {
      await what();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const check = plugin.action("check agent", async () => {
    setChecking(true);
    await attempt(() => props.actions.check(props.id));
    setChecking(false);
  });
  const signIn = plugin.action("sign in to agent", async (method: string) => {
    setSigning(method);
    await attempt(() => props.actions.authenticate(props.id, method));
    setSigning(undefined);
  });
  const remove = plugin.action("remove agent", async () => {
    await attempt(() => props.actions.put(props.id, null));
    setConfirming(false);
    props.close();
  });
  const commandLine = () => (agent() === undefined ? "" : joinCommand([agent()!.command, ...agent()!.args]));
  return (
    <Show when={agent()}>
      {(agent) => (
        <div class="acp-detail">
          <header class="integration-head">
            <span class="integration-icon" aria-hidden="true">
              <Show when={markOf(agent()!)} fallback={<BotIcon />}>
                {(logo) => <Logo logo={logo()} size={30} />}
              </Show>
            </span>
            <div class="integration-head-text">
              <h2>
                {agent().title}
                <Show when={agent().agent?.version}>{(version) => <code class="integration-version">v{version()}</code>}</Show>
              </h2>
              <span class="muted small">
                {STATES[agent().state]}
                <Show when={agent().agent}>{(info) => <> · {info().title ?? info().name}</>}</Show>
                {agent().source === "preset" ? " · Supported" : ""}
              </span>
            </div>
            <div class="integration-actions">
              <Show when={agent().enabled}>
                <button
                  type="button"
                  class="icon-button"
                  classList={{ spinning: checking() }}
                  disabled={checking()}
                  aria-label={checking() ? "Checking" : `Check ${agent().title}`}
                  data-tip={checking() ? "Checking…" : "Check"}
                  onClick={check}
                >
                  <RefreshIcon />
                </button>
              </Show>
              <Toggle
                label={`${agent().title} on`}
                checked={agent().enabled}
                onChange={plugin.action("turn agent on or off", (enabled: boolean) => attempt(() => props.actions.put(agent().id, switched(agent(), enabled))))}
              />
            </div>
          </header>
          <Show when={agent().description}>{(description) => <p class="acp-description">{description()}</p>}</Show>
          <Show when={agent().detail}>
            {(detail) => (
              <div class="callout callout-warn">
                <AlertIcon />
                <span>{detail()}</span>
              </div>
            )}
          </Show>
          <Show when={problem()}>{(message) => <p class="integration-error">{message()}</p>}</Show>

          <Show when={agent().enabled && agent().state !== "missing"}>
            <section class="integration-section">
              <h3>Sign in</h3>
              <Show
                when={agent().authMethods.length > 0}
                fallback={
                  <p class="integration-hint">
                    {agent().agent === undefined
                      ? "Check it to see how it signs in. Most agents use the sign-in of their own CLI, made once in a terminal."
                      : "It names no way to sign in from here: it uses its own CLI's sign-in, or an API key in its environment."}
                  </p>
                }
              >
                <p class="integration-hint">A turn that needs signing in fails and says so. Sign in here, or once with the agent's own CLI.</p>
                <div class="integration-actions">
                  <For each={agent().authMethods}>
                    {(method) => (
                      <Show
                        when={method.kind === "agent"}
                        fallback={
                          <span class="integration-hint">
                            {method.name}: run it in a terminal{method.description === undefined ? "" : ` (${method.description})`}
                          </span>
                        }
                      >
                        <button
                          type="button"
                          class="button small"
                          disabled={signing() !== undefined}
                          title={method.description}
                          onClick={() => signIn(method.id)}
                        >
                          {signing() === method.id ? "Signing in…" : method.name}
                        </button>
                      </Show>
                    )}
                  </For>
                </div>
              </Show>
            </section>
          </Show>

          <section class="integration-section">
            <h3>Command</h3>
            <Show
              when={editing()}
              fallback={
                <>
                  <div class="acp-command">
                    <code class="integration-code">{commandLine()}</code>
                    <CopyButton text={commandLine()} label="Copy" />
                  </div>
                  {/* While it is missing, the warning above says it already. */}
                  <Show when={agent().state !== "missing" && agent().install}>{(install) => <p class="integration-hint">{install()}</p>}</Show>
                  <div class="integration-actions">
                    <button type="button" class="button small" onClick={() => setEditing(true)}>
                      Edit
                    </button>
                    <Show when={agent().docs}>
                      {(docs) => (
                        <a class="button small" href={docs()} target="_blank" rel="noreferrer">
                          <ExternalIcon />
                          Docs
                        </a>
                      )}
                    </Show>
                    <Show
                      when={confirming()}
                      fallback={
                        <button type="button" class="button small" onClick={() => setConfirming(true)}>
                          Remove
                        </button>
                      }
                    >
                      <span class="muted small">
                        Remove {agent().title}?{agent().source === "preset" ? " You can add it again from +." : ""}
                      </span>
                      <button type="button" class="button small acp-danger" onClick={remove}>
                        Remove
                      </button>
                      <button type="button" class="button small" onClick={() => setConfirming(false)}>
                        Keep
                      </button>
                    </Show>
                  </div>
                </>
              }
            >
              <AgentForm
                draft={draftOf(agent())}
                submitLabel="Save"
                cancel={() => setEditing(false)}
                submit={async (draft) => {
                  const preset = presetOf(agent().id);
                  const made = entryFrom(
                    draft,
                    agent().entry,
                    preset === undefined ? undefined : { title: preset.title, command: [preset.command, ...preset.args] },
                  );
                  if ("error" in made) throw new Error(made.error);
                  await props.actions.put(agent().id, made.entry);
                  setEditing(false);
                }}
              />
            </Show>
          </section>

          <Show when={agent().access.length > 0}>
            <section class="integration-section">
              <h3>Access</h3>
              <p class="integration-hint">
                Pick a level in the composer, beside the agent. Where {agent().title} has a mode of its own for it, Lemma puts it in that mode; otherwise Lemma
                answers its requests as the level says.
              </p>
              <div class="acp-access">
                <For each={agent().access}>
                  {(level) => (
                    <>
                      <span>{ACCESS_LEVELS.find((known) => known.access === level.access)?.title ?? level.access}</span>
                      <span class="muted small">{level.mode === undefined ? "Lemma answers its requests" : <code>{level.mode}</code>}</span>
                    </>
                  )}
                </For>
              </div>
              <Show when={agent().agent === undefined}>
                <p class="integration-hint">Check it to read its own modes.</p>
              </Show>
            </section>
          </Show>

          <section class="integration-section">
            <h3>Using it</h3>
            <p class="integration-hint">
              Pick it in the composer's agent menu, beside the model, and the thread's next turn runs on it: Lemma keeps the thread, and the agent works in the
              thread's folder with its own tools, asking you before it acts as it would in a terminal. A thread that moves to another agent hands it the
              conversation so far.
            </p>
            <Show when={!agent().mcp}>
              <p class="integration-hint">It is not handed the MCP servers set up here.</p>
            </Show>
          </section>
        </div>
      )}
    </Show>
  );
}

/** Adding an agent: from the ACP Registry, or any command that speaks ACP. */
/** Adding an agent Lemma does not offer, by the command that starts it. */
function AddAgent(props: IntegrationAddProps & { actions: Actions }) {
  const known = () => new Set(props.actions.state()?.agents.map((agent) => agent.id) ?? []);
  return (
    <div class="acp-add">
      <p class="integration-hint">
        Any coding agent that speaks the{" "}
        <a href="https://agentclientprotocol.com" target="_blank" rel="noreferrer">
          Agent Client Protocol
        </a>{" "}
        over its stdin and stdout, started on the host: <code>npx -y @qwen-code/qwen-code@0.9.1 --acp</code>, say.
      </p>
      <AgentForm
        naming
        draft={{ title: "", command: "", env: [], mcp: true }}
        submitLabel="Add agent"
        cancel={props.cancel}
        submit={async (draft) => {
          const id = idFrom(draft.title);
          if (id === "") throw new Error("Give it a name");
          if (known().has(id)) throw new Error(`You have an agent named ${id}: pick another name, or edit that one`);
          const made = entryFrom(draft);
          if ("error" in made) throw new Error(made.error);
          await props.actions.put(id, { title: draft.title.trim(), ...made.entry });
          props.added(id);
        }}
      />
    </div>
  );
}

/**
 * The agents offered in the Add dialog: those Lemma supports, then the rest of the ACP Registry's, read as the dialog
 * opens. Adding one checks it at once, so its sign-in, modes, and models show as it opens.
 */
function agentCatalog(actions: Actions): IntegrationCatalog {
  const [listed] = createResource(() => actions.registry());
  const known = createMemo(() => new Set(actions.state()?.agents.map((agent) => agent.id) ?? []));
  const added = async (id: string, entry: AgentEntry) => {
    await actions.put(id, entry);
    void actions.check(id).catch(() => {});
    return id;
  };
  const supported = (): readonly IntegrationOffer[] =>
    PRESETS.map((preset) => ({
      id: preset.id,
      title: preset.title,
      ...(preset.description === undefined ? {} : { description: preset.description }),
      logo: () => <Logo logo={preset.logo} size={22} />,
      keywords: `${preset.id} ${preset.registry ?? ""} ${preset.command} ${(preset.args ?? []).join(" ")}`,
      ...(known().has(preset.id) ? { added: preset.id } : {}),
      // An empty entry of its id adds it as Lemma knows it.
      add: () => added(preset.id, {}),
    }));
  const fromRegistry = (): readonly IntegrationOffer[] =>
    (listed.error === undefined ? (listed() ?? []) : [])
      .filter((entry) => !PRESETS.some((preset) => preset.registry === entry.id))
      .map((entry) => {
        const id = idFrom(entry.id);
        return {
          id: `registry:${entry.id}`,
          title: entry.name,
          ...(entry.description === undefined ? {} : { description: entry.description }),
          ...(entry.logo === undefined ? {} : { logo: () => <Logo logo={entry.logo!} size={22} /> }),
          keywords: `${entry.id} ${entry.command} ${entry.args.join(" ")}`,
          ...(known().has(id) ? { added: id } : entry.runnable ? {} : { unavailable: `Needs ${entry.command}` }),
          add: () =>
            added(id, {
              title: entry.name,
              ...(entry.description === undefined ? {} : { description: entry.description }),
              command: entry.command,
              args: [...entry.args],
              ...(entry.website === undefined ? {} : { docs: entry.website }),
              registry: {
                id: entry.id,
                ...(entry.version === undefined ? {} : { version: entry.version }),
                ...(entry.icon === undefined ? {} : { icon: entry.icon }),
              },
            }),
        };
      });
  return {
    offers: () => [...supported(), ...fromRegistry()],
    loading: () => listed.loading,
    problem: () =>
      listed.error === undefined ? undefined : `More agents could not be listed: ${(listed.error as Error | undefined)?.message ?? String(listed.error)}`,
  };
}

/** A view for each kind of call an agent reports (`acp.<kind>`): its title, the way the agent put it. */
const callView = (icon: IconName, action?: readonly [string, string, string]): ToolView => ({
  icon,
  summary: (args) => {
    const input = args?.["input"] as Record<string, unknown> | undefined;
    const command = typeof input?.["command"] === "string" ? (input["command"] as string) : undefined;
    if (icon === "terminal" && command !== undefined) return { primary: command, shell: true };
    const title = typeof args?.["title"] === "string" ? (args["title"] as string) : undefined;
    const location = (args?.["locations"] as readonly { readonly path?: unknown }[] | undefined)?.[0]?.path;
    return {
      ...(title === undefined ? {} : { primary: title }),
      ...(typeof location === "string" && (icon === "file" || icon === "pencil") ? { file: { path: location, kind: "file" as const } } : {}),
    };
  },
  streaming: "title",
  ...(action === undefined ? {} : { action }),
});

const CALL_VIEWS: Readonly<Record<string, ToolView>> = {
  "acp.read": callView("file", ["read", "file", "files"]),
  "acp.edit": callView("pencil", ["changed", "file", "files"]),
  "acp.delete": callView("trash", ["deleted", "file", "files"]),
  "acp.move": callView("file", ["moved", "file", "files"]),
  "acp.search": callView("search", ["searched", "time", "times"]),
  "acp.execute": callView("terminal", ["ran", "command", "commands"]),
  "acp.think": callView("brain"),
  "acp.fetch": callView("external", ["fetched", "page", "pages"]),
  "acp.switch_mode": callView("sliders"),
  "acp.other": callView("hammer"),
};

/**
 * The web half of `agent.acp`: the agents' part of Settings › Integrations (each agent's state, signing in, its
 * command, adding one from the ACP Registry or by its command), and how the chat shows the calls agents report.
 */
export default defineWebPlugin({
  id: "agent.acp",
  styles,
  requires: { slots: Slots, client: Client, notify: Notify, threads: Threads },
  setup: ({ slots, client, notify, threads }, plugin) => {
    const [state, setState] = createSignal<AcpState>();
    plugin.onCleanup(client.follow(AcpChannels.changes, undefined, setState));
    // Following the requests is what tells the host someone can answer them.
    const [requests, setRequests] = createSignal<readonly PermissionRequest[]>([]);
    plugin.onCleanup(client.follow(AcpChannels.permissions, undefined, setRequests));
    const focusComposer = () => slots.get(Actions, ThreadsActionIds.focusComposer)?.run();
    slots.add(ComposerTakeovers, {
      id: "agent.acp.approvals",
      ...approvalTakeover({
        requests,
        activeId: threads.activeId,
        respond: (request, choice) =>
          void client.channel
            .call(AcpChannels.respond, { id: request.id, choice: choice.id })
            .then(focusComposer, (error: unknown) => notify.report(error, `Answering ${request.agentTitle}`)),
      }),
    });
    const actions: Actions = {
      state,
      put: (id, entry) => client.channel.call(AcpChannels.put, { id, entry }),
      check: (id) => client.channel.call(AcpChannels.check, { id }),
      authenticate: (id, method) => client.channel.call(AcpChannels.authenticate, { id, method }),
      registry: () => client.channel.call(AcpChannels.registry, undefined),
    };
    const items = createMemo((): readonly IntegrationItem[] =>
      (state()?.agents ?? []).map((agent) => ({
        id: agent.id,
        title: agent.title,
        ...(agent.agent?.version === undefined ? {} : { version: agent.agent.version }),
        status: statusOf(agent),
        enabled: agent.enabled,
        setEnabled: (enabled) =>
          void actions
            .put(agent.id, switched(agent, enabled))
            .catch((error: unknown) => notify.report(error, `Turning ${agent.title} ${enabled ? "on" : "off"}`)),
        keywords: `agent acp harness ${agent.id} ${agent.command} ${agent.description ?? ""}`,
        ...(markOf(agent) === undefined ? {} : { logo: () => <Logo logo={markOf(agent)!} size={22} /> }),
      })),
    );
    slots.add(IntegrationKinds, {
      id: KIND,
      order: 10,
      title: "Agents",
      icon: BotIcon,
      items,
      loaded: () => state() !== undefined,
      problem: () => {
        const error = state()?.fileError;
        return error === undefined ? undefined : `${state()!.file}: ${error}`;
      },
      detail: (props) => <AgentDetail {...props} actions={actions} />,
      catalog: () => agentCatalog(actions),
      add: {
        label: "Custom agent",
        description: "Any agent that speaks ACP, by the command that starts it",
        component: (props) => <AddAgent {...props} actions={actions} />,
      },
    });
    for (const [id, view] of Object.entries(CALL_VIEWS)) slots.add(ToolViews, { id, ...view });
  },
});
