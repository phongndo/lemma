import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { AgentChannels } from "@lemma/agent";
import type { SessionInfo } from "@lemma/sessions";
import { ComposerNotices, ContextViews, sessionTitle, ThreadHeader, Threads, ThreadWaits, ToolViews, waitingOn } from "@lemma/threads";
import type { ContextViewProps, ThreadsService, ToolBodyProps, ToolDisplaysProps } from "@lemma/threads";
import { AgentIcon, Avatar, ChevronDownIcon, ChevronIcon, Icon, StopIcon } from "@lemma/look";
import { Client, Slots, defineWebPlugin, usePlugin } from "@lemma/web";
import type { SlotsService } from "@lemma/web";
import { createNow } from "@lemma/web/now";
import {
  agentOfCall,
  agentsLabel,
  callDetails,
  childrenOf,
  DELEGATE,
  elapsed,
  endedState,
  groupStatus,
  isActive,
  outcomesOf,
  parseNotice,
  SOURCE,
  stateLabel,
  stateOf,
} from "./agents.ts";
import type { AgentOutcome, AgentState } from "./agents.ts";
import { DelegateChannels } from "./channels.ts";
import styles from "./delegate.css?inline";

/** How many avatars a group stacks before "+n". */
const STACKED = 4;

/** A time of day, as a finished agent's row gives it: `2:07 AM`. */
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const firstLine = (text: string | undefined) => (text ?? "").trim().split("\n")[0]!.trim();

/** One line of an answer for a row: markdown's marks and links made plain. */
const plain = (text: string | undefined) =>
  firstLine(
    (text ?? "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_#>]/g, "")
      .replace(/\s+/g, " "),
  );

interface Deps {
  readonly threads: ThreadsService;
  readonly slots: SlotsService;
  readonly now: () => number;
}

/** An agent's picture with a dot for what it is doing: its seed's identicon, or the agent icon before it has a thread. */
function AgentAvatar(props: { seed?: string | undefined; state: AgentState; size?: number }) {
  return (
    <span class="agent-avatar" data-state={props.state}>
      <Show when={props.seed} fallback={<span class="agent-avatar-blank">{<AgentIcon />}</span>}>
        {(seed) => <Avatar seed={seed()} size={props.size ?? 20} />}
      </Show>
      <span class="agent-dot" aria-hidden="true" />
    </span>
  );
}

/**
 * An agent as a row, as T3 Code shows one: its picture and state, its name (its thread's title) and how it is doing, a
 * line of what it said, its time, and a chevron; pressing it opens the agent's thread, where the person can read it
 * whole and write to it themselves.
 */
function AgentRow(props: {
  deps: Deps;
  session?: SessionInfo | undefined;
  title: string;
  state: AgentState;
  detail?: string | undefined;
  time?: string | undefined;
  stop?: (() => void) | undefined;
}) {
  const plugin = usePlugin();
  const open = plugin.action("open an agent's thread", () => (props.session === undefined ? Promise.resolve() : props.deps.threads.select(props.session.id)));
  return (
    <div class="agent-row" data-state={props.state}>
      <button
        type="button"
        class="agent-open"
        disabled={props.session === undefined}
        aria-label={`Open ${props.title}`}
        aria-description={stateLabel[props.state]}
        data-tip={props.session === undefined ? props.title : `Open ${props.title}: read it whole, or write to it yourself`}
        onClick={() => open()}
        onPointerEnter={() => props.session !== undefined && props.deps.threads.preload(props.session.id)}
      >
        <AgentAvatar seed={props.session?.id} state={props.state} size={22} />
        <span class="agent-text">
          <span class="agent-line">
            <span class="agent-title">{props.title}</span>
            <span class="agent-state">{stateLabel[props.state]}</span>
          </span>
          <Show when={props.detail}>{(detail) => <span class="agent-detail">{detail()}</span>}</Show>
        </span>
        <Show when={props.time}>{(time) => <span class="agent-time">{time()}</span>}</Show>
        <Show when={props.session !== undefined}>
          <span class="agent-chevron" aria-hidden="true">
            <ChevronIcon />
          </span>
        </Show>
      </button>
      <Show when={props.stop}>
        {(stop) => (
          <button
            type="button"
            class="icon-button agent-stop"
            aria-label={`Stop ${props.title}`}
            data-tip={props.state === "queued" ? "Stop it: it never starts, and its empty thread goes" : "Stop it: its turn is cancelled"}
            onClick={() => stop()()}
          >
            <StopIcon />
          </button>
        )}
      </Show>
    </div>
  );
}

/** The agents of a thread, with what each is doing and how each finished, kept current. */
const agentModel = (deps: Deps) => {
  const waits = () => deps.slots.list(ThreadWaits);
  /** How the open thread's agents finished, from its log. */
  const outcomes = createMemo(() => outcomesOf(deps.threads.branch()));
  const live = (session: SessionInfo) => ({ running: deps.threads.running().includes(session.id), waiting: waitingOn(waits(), session.id) });
  /** What `session` is doing: its thread's log says how it ended, else `told` (what a call's own result says). */
  const state = (session: SessionInfo, told?: AgentOutcome): AgentState => stateOf(session, live(session), outcomes().get(session.id) ?? told);
  const time = (session: SessionInfo, agentState: AgentState) => (isActive(agentState) ? elapsed(session.createdAt, deps.now()) : clock(session.updatedAt));
  const detail = (session: SessionInfo, agentState: AgentState, preview?: string) =>
    agentState === "queued"
      ? "Waiting for a slot"
      : agentState === "waiting"
        ? "Waiting on you: open it to answer"
        : isActive(agentState)
          ? undefined
          : plain(outcomes().get(session.id)?.preview ?? preview);
  return { outcomes, state, time, detail };
};

/** Avatars stacked, at most `STACKED` and then a count. */
function Stack(props: { seeds: readonly string[]; states: readonly AgentState[] }) {
  return (
    <span class="agent-stack">
      <For each={props.seeds.slice(0, STACKED)}>{(seed, at) => <AgentAvatar seed={seed} state={props.states[at()] ?? "done"} size={20} />}</For>
      <Show when={props.seeds.length > STACKED}>
        <span class="agent-stack-more">+{props.seeds.length - STACKED}</span>
      </Show>
    </span>
  );
}

export default defineWebPlugin({
  id: "tools.delegate",
  styles,
  requires: { slots: Slots, threads: Threads, client: Client },
  setup: ({ slots, threads, client }) => {
    /** Ticks each second while an agent of the open thread works, for the times that count. */
    const anyWorking = () => childrenOf(threads.list(), threads.activeId()).some((session) => threads.running().includes(session.id));
    const now = createNow(1000, anyWorking);
    const deps: Deps = { threads, slots, now };
    const model = agentModel(deps);

    /** A delegating call's agent: named by its result, or found by its parent link while the call runs. */
    const callAgent = (call: Pick<ToolBodyProps, "id" | "args" | "result" | "state">) => {
      const details = callDetails(call.result?.details);
      const session =
        (details.sessionId === undefined ? undefined : threads.list().find((candidate) => candidate.id === details.sessionId)) ??
        agentOfCall(threads.list(), threads.activeId(), call.id);
      const asked = typeof call.args?.["prompt"] === "string" ? (call.args["prompt"] as string) : "";
      const named = typeof call.args?.["title"] === "string" ? (call.args["title"] as string).trim() : "";
      const title = session !== undefined ? sessionTitle(session) : (details.title ?? (named !== "" ? named : firstLine(asked) || "Agent"));
      const waiting = call.state === "running" || call.state === "queued";
      // How its thread heard it ended, which outlives the agent's thread (one dropped while it waited for a slot): for a
      // background call, whose own result says only that it started; a waited-on call's result is its own.
      const heard = details.sessionId === undefined ? undefined : model.outcomes().get(details.sessionId);
      const own = details.ended === "running" ? undefined : details.ended;
      // A call stopped or failed with no word of its agent: its turn went with it.
      const ended = own ?? heard?.ended ?? details.ended ?? (call.state === "interrupted" ? "cancelled" : call.state === "error" ? "error" : undefined);
      const current = session === undefined ? undefined : model.state(session, ended === undefined ? undefined : { ended, emptyAt: details.emptyAt });
      // While the call waits, an agent not at work has yet to start: it waits for a slot, or for its prompt.
      const state: AgentState = current === undefined ? (waiting ? "queued" : endedState(ended)) : waiting && !isActive(current) ? "queued" : current;
      return {
        session,
        title,
        state,
        // Only a background agent waits for a slot in the plugin's own work, where Stop can drop it.
        stoppable: session !== undefined && (state === "working" || state === "waiting" || (state === "queued" && details.background === true)),
        detail:
          session === undefined
            ? call.state === "error"
              ? plain(call.result?.content.find((part) => part.type === "text")?.text)
              : plain(heard?.preview)
            : model.detail(session, state, details.preview),
        time: session === undefined ? undefined : model.time(session, state),
      };
    };

    /** A delegating call where its display goes: the agent it started, as a row, kept current while it works. */
    function CallDisplay(props: ToolBodyProps) {
      const plugin = usePlugin();
      const agent = createMemo(() => callAgent(props));
      // The host half stops it as it is (`delegate.stop`); with no host half serving that (off, or delegations off), its
      // turn is cancelled.
      const stop = plugin.action("stop an agent", async (sessionId: string) => {
        await client.channel.call(DelegateChannels.stop, { sessionId }).catch(() => client.channel.call(AgentChannels.cancel, { sessionId }));
      });
      return (
        <AgentRow
          deps={deps}
          session={agent().session}
          title={agent().title}
          state={agent().state}
          detail={agent().detail}
          time={agent().time}
          stop={agent().stoppable ? () => stop(agent().session!.id) : undefined}
        />
      );
    }

    /** Several delegating calls in a row: one line for them all ("3 agents · 3 working"), which opens to each. */
    function CallsDisplay(props: ToolDisplaysProps) {
      const [open, setOpen] = createSignal(false);
      const agents = createMemo(() => props.calls.map((call) => callAgent(call)));
      const status = createMemo(() => groupStatus(agents().map((agent) => agent.state)));
      const since = createMemo(() => Math.min(...agents().map((agent) => agent.session?.createdAt ?? Number.POSITIVE_INFINITY)));
      const until = createMemo(() => Math.max(...agents().map((agent) => agent.session?.updatedAt ?? 0)));
      return (
        <div class="agent-group">
          <button type="button" class="agent-group-head" aria-expanded={open()} onClick={() => setOpen((was) => !was)}>
            <Stack seeds={agents().flatMap((agent) => (agent.session === undefined ? [] : [agent.session.id]))} states={agents().map((agent) => agent.state)} />
            <span class="agent-text">
              <span class="agent-title">{agentsLabel(props.calls.length)}</span>
              <span class="agent-group-status" classList={{ active: status().active }}>
                {status().label}
              </span>
            </span>
            <span class="agent-time">{Number.isFinite(since()) ? (status().active ? elapsed(since(), now()) : elapsed(since(), until())) : ""}</span>
            <span class="agent-group-chevron" aria-hidden="true">
              <ChevronDownIcon />
            </span>
          </button>
          <Show when={open()}>
            <div class="agent-group-rows">
              <For each={props.calls}>{(call) => <CallDisplay {...call} />}</For>
            </div>
          </Show>
        </div>
      );
    }

    /** A finished agent's notice, where its thread heard it: the agent as a row, finished, failed, or stopped. */
    function NoticeView(props: ContextViewProps) {
      const notice = createMemo(() => parseNotice(props.content));
      const session = createMemo(() => {
        const id = notice()?.session;
        return id === undefined ? undefined : threads.list().find((candidate) => candidate.id === id);
      });
      return (
        <Show when={notice()} fallback={<div class="divider">{props.display ?? firstLine(props.content)}</div>}>
          {(heard) => (
            <AgentRow
              deps={deps}
              session={session()}
              title={session() === undefined ? heard().title : sessionTitle(session())}
              state={endedState(heard().ended)}
              detail={plain(heard().body)}
              time={clock(props.at)}
            />
          )}
        </Show>
      );
    }

    slots.add(ToolViews, {
      id: DELEGATE,
      icon: "agent",
      summary: (args) => {
        const title = typeof args?.["title"] === "string" ? args["title"] : undefined;
        const prompt = typeof args?.["prompt"] === "string" ? firstLine(args["prompt"]) : undefined;
        return title === undefined && prompt === undefined ? {} : { primary: title ?? prompt! };
      },
      streaming: "prompt",
      action: ["started", "agent", "agents"],
      live: true,
      display: CallDisplay,
      displays: CallsDisplay,
    });
    slots.add(ContextViews, { id: SOURCE, component: NoticeView });

    // Above the composer while the open thread's agents work: who, and for how long; each opens.
    slots.add(ComposerNotices, {
      id: "tools.delegate.working",
      order: 20,
      component: () => {
        const plugin = usePlugin();
        const working = createMemo(() =>
          childrenOf(threads.list(), threads.activeId())
            .map((session) => ({ session, state: model.state(session) }))
            .filter((agent) => isActive(agent.state)),
        );
        const open = plugin.action("open an agent's thread", (sessionId: string) => threads.select(sessionId));
        const since = () => Math.min(...working().map((agent) => agent.session.createdAt));
        return (
          <Show when={working().length > 0}>
            <div class="agents-notice" role="status">
              <span class="agent-stack">
                <For each={working().slice(0, STACKED)}>
                  {(agent) => (
                    <button
                      type="button"
                      class="agent-stack-button"
                      aria-label={`Open ${sessionTitle(agent.session)}`}
                      data-tip={`${sessionTitle(agent.session)}: ${stateLabel[agent.state]}`}
                      onClick={() => open(agent.session.id)}
                    >
                      <AgentAvatar seed={agent.session.id} state={agent.state} size={18} />
                    </button>
                  )}
                </For>
              </span>
              <span class="agents-notice-text">
                {threads.busy() ? `${agentsLabel(working().length)} working` : `Waiting on ${agentsLabel(working().length)}`}
              </span>
              <span class="agent-time">{elapsed(since(), now())}</span>
            </div>
          </Show>
        );
      },
    });

    // An agent's thread says, before its title, which thread it works for: one press goes back.
    slots.add(ThreadHeader, {
      id: "tools.delegate.parent",
      order: 5,
      side: "start",
      component: (): JSX.Element => {
        const plugin = usePlugin();
        const parent = createMemo(() => {
          const id = threads.active()?.parent?.sessionId;
          return id === undefined ? undefined : threads.list().find((session) => session.id === id);
        });
        const back = plugin.action("open the parent thread", () => threads.select(parent()!.id));
        return (
          <Show when={parent()}>
            {(session) => (
              <button type="button" class="agent-crumb" data-tip="The thread this agent works for" onClick={() => back()}>
                <Icon name="arrow-left" />
                <span class="agent-crumb-title">{sessionTitle(session())}</span>
                <span class="agent-crumb-sep" aria-hidden="true">
                  /
                </span>
              </button>
            )}
          </Show>
        );
      },
    });
  },
});
