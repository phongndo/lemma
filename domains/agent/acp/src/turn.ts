import { Effect, Queue, Stream } from "effect";
import type * as acp from "@agentclientprotocol/sdk";
import { transcript } from "@lemma/agent";
import type { HarnessTurn, HarnessUpdate } from "@lemma/agent";
import type { Usage } from "@lemma/llm";
import { emptyUsage } from "@lemma/llm";
import type { McpLaunch } from "@lemma/mcp";
import { describeError } from "./connection.ts";
import type { AgentProcess } from "./connection.ts";

/** What a harness turn keeps of its ACP session, to continue it next turn. */
export interface SessionState {
  readonly session: string;
  /** The start of the agent's process that opened it (`AgentProcess.token`). */
  readonly process: string;
}

const isState = (value: unknown): value is SessionState =>
  typeof value === "object" && value !== null && typeof (value as SessionState).session === "string" && typeof (value as SessionState).process === "string";

/** A tool's logged name: its ACP kind, under `acp.`, so the chat shows every agent's calls one way. */
export const toolName = (kind: acp.ToolKind | null | undefined): string => `acp.${kind ?? "other"}`;

/** Characters of one diff's text a result keeps. */
const DIFF_CHARS = 8_000;

/** A finished call's result for the model and the log: its content as text, or its raw output. */
export function resultText(content: readonly acp.ToolCallContent[] | null | undefined, rawOutput: unknown): string {
  const parts = (content ?? []).flatMap((item): string[] => {
    if (item.type === "content") return item.content.type === "text" ? [item.content.text] : [`[${item.content.type}]`];
    if (item.type === "diff") {
      const text = item.newText.length > DIFF_CHARS ? `${item.newText.slice(0, DIFF_CHARS)}…` : item.newText;
      return [`${item.oldText == null ? "Wrote" : "Edited"} ${item.path}:\n${text}`];
    }
    return ["[terminal output]"];
  });
  if (parts.length > 0) return parts.join("\n\n");
  if (rawOutput === undefined || rawOutput === null) return "";
  return typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput, null, 2);
}

/**
 * A local server's command line, started in its folder: ACP's servers have none, so one with a `cwd` starts through
 * `sh`, which changes to it and runs the command in its place.
 */
const inFolder = (launch: McpLaunch & { readonly command: string }): { readonly command: string; readonly args: string[] } =>
  launch.cwd === undefined
    ? { command: launch.command, args: [...launch.args] }
    : { command: "/bin/sh", args: ["-c", 'cd "$1" && shift && exec "$@"', "sh", launch.cwd, launch.command, ...launch.args] };

/** The servers as ACP hands them to an agent: stdio ones, and http ones when it takes them. */
export function mcpServersFor(launches: readonly McpLaunch[], http: boolean): acp.McpServer[] {
  return launches.flatMap((launch): acp.McpServer[] => {
    if (launch.transport === "stdio" && launch.command !== undefined) {
      return [
        {
          name: launch.name,
          ...inFolder({ ...launch, command: launch.command }),
          env: Object.entries(launch.env).map(([name, value]) => ({ name, value })),
        },
      ];
    }
    if (launch.transport === "http" && launch.url !== undefined && http) {
      return [{ type: "http", name: launch.name, url: launch.url, headers: Object.entries(launch.headers).map(([name, value]) => ({ name, value })) }];
    }
    return [];
  });
}

/** The prompt an agent is sent: what it has not seen of the conversation, as text, then the turn's prompts. */
export function promptBlocks(turn: Pick<HarnessTurn, "prompts">, unseen: string, images: boolean): acp.ContentBlock[] {
  const blocks: acp.ContentBlock[] = [];
  if (unseen !== "") {
    blocks.push({
      type: "text",
      text: `<conversation>\n${unseen}\n</conversation>\n\nThat is the conversation so far, part of it with another coding agent you are taking over from. Continue it; the user's message follows.`,
    });
  }
  turn.prompts.forEach((content, index) => {
    if (index > 0) blocks.push({ type: "text", text: "\n" });
    for (const part of content) {
      if (part.type === "text") blocks.push({ type: "text", text: part.text });
      else if (images) blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
      else blocks.push({ type: "text", text: "[An image was attached, which this agent does not take.]" });
    }
  });
  return blocks;
}

const usageOf = (usage: acp.Usage | null | undefined): Usage | undefined =>
  usage == null
    ? undefined
    : {
        ...emptyUsage,
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cachedReadTokens ?? 0,
        cacheWrite: usage.cachedWriteTokens ?? 0,
        ...(usage.thoughtTokens == null ? {} : { reasoning: usage.thoughtTokens }),
        totalTokens: usage.totalTokens,
      };

/** The model a session says it runs on, among its options. */
const modelOf = (options: readonly acp.SessionConfigOption[] | null | undefined): string | undefined => {
  const option = options?.find((candidate) => candidate.category === "model" && candidate.type === "select");
  return option !== undefined && "currentValue" in option && typeof option.currentValue === "string" ? option.currentValue : undefined;
};

/** A call as the turn has heard of it so far. */
interface Call {
  name: string;
  arguments: Record<string, unknown>;
  status: acp.ToolCallStatus;
  /** Characters of its running output reported already. */
  printed: number;
  finished: boolean;
  /** Its content and raw output as last reported: an update names only what changed. */
  content: readonly acp.ToolCallContent[];
  rawOutput: unknown;
}

/**
 * Turns one ACP session's updates into a harness's: message and thought chunks become text and thinking, tool calls
 * become calls under `acp.<kind>`, and a call's result is reported once it is completed or failed.
 */
export class UpdateMapper {
  private readonly calls = new Map<string, Call>();

  map(update: acp.SessionUpdate): HarnessUpdate[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return update.content.type === "text" ? [{ type: "text", delta: update.content.text }] : [];
      case "agent_thought_chunk":
        return update.content.type === "text" ? [{ type: "thinking", delta: update.content.text }] : [];
      case "tool_call":
        return this.call(update.toolCallId, update);
      case "tool_call_update":
        return this.call(update.toolCallId, update);
      case "config_option_update": {
        const model = modelOf(update.configOptions);
        return model === undefined ? [] : [{ type: "model", model }];
      }
      default:
        return [];
    }
  }

  private call(id: string, update: Partial<acp.ToolCall> | acp.ToolCallUpdate): HarnessUpdate[] {
    const known = this.calls.get(id);
    if (known?.finished === true) return [];
    const out: HarnessUpdate[] = [];
    const input = update.rawInput !== undefined && update.rawInput !== null ? { input: update.rawInput } : {};
    const locations =
      update.locations != null && update.locations.length > 0
        ? { locations: update.locations.map(({ path, line }) => (line == null ? { path } : { path, line })) }
        : {};
    const call: Call = known ?? {
      name: toolName(update.kind),
      arguments: {},
      status: "pending",
      printed: 0,
      finished: false,
      content: [],
      rawOutput: undefined,
    };
    const args = { ...call.arguments, ...(update.title == null ? {} : { title: update.title }), ...input, ...locations };
    if (known === undefined || JSON.stringify(args) !== JSON.stringify(call.arguments)) {
      call.arguments = args;
      out.push({ type: "tool-call", id, name: call.name, arguments: args });
    }
    this.calls.set(id, call);
    if (update.status != null) call.status = update.status;
    // Content, when sent, replaces what was; raw output too.
    if (update.content != null) call.content = update.content;
    if (update.rawOutput !== undefined && update.rawOutput !== null) call.rawOutput = update.rawOutput;
    const text = resultText(call.content, undefined);
    if (call.status === "in_progress" && text.length > call.printed) {
      out.push({ type: "tool-output", id, chunk: text.slice(call.printed) });
      call.printed = text.length;
    }
    if (call.status === "completed" || call.status === "failed") {
      call.finished = true;
      const diffs = call.content.flatMap((item) => (item.type === "diff" ? [{ path: item.path, oldText: item.oldText ?? null, newText: item.newText }] : []));
      out.push({
        type: "tool-result",
        id,
        content: [{ type: "text", text: resultText(call.content, call.rawOutput) || (call.status === "failed" ? "Failed." : "Done.") }],
        isError: call.status === "failed",
        details: { title: call.arguments["title"], ...(diffs.length === 0 ? {} : { diffs }) },
      });
    }
    return out;
  }
}

/** What a turn on an agent needs: its process, and the servers it is handed. */
export interface TurnContext {
  readonly process: AgentProcess;
  readonly mcpServers: () => Promise<readonly McpLaunch[]>;
}

/**
 * Runs one turn in the agent: continues the session's ACP session when this process opened it, or takes it up when
 * the agent can resume it, telling it what it has not seen; else opens one, and tells it the whole conversation.
 */
export function runTurn(context: TurnContext, turn: HarnessTurn): Stream.Stream<HarnessUpdate, { readonly message: string }> {
  const { process } = context;
  return Stream.callback<HarnessUpdate, { readonly message: string }>((queue) =>
    Effect.gen(function* () {
      const offer = (updates: readonly HarnessUpdate[]) => {
        for (const update of updates) Queue.offerUnsafe(queue, update);
      };
      let asked: string | undefined;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (asked !== undefined) process.cancel(asked);
        }),
      );
      yield* Effect.forkScoped(
        Effect.tryPromise({
          // `signal` aborts as the turn ends: one cancelled while the agent starts or opens its session sends no prompt.
          try: async (signal) => {
            const stillWanted = () => {
              if (signal.aborted) throw new Error("The turn was cancelled");
            };
            const initialized = await process.start();
            stillWanted();
            const http = initialized.agentCapabilities?.mcpCapabilities?.http === true;
            const servers = process.spec.mcp === false ? [] : mcpServersFor(await context.mcpServers(), http);
            stillWanted();
            const kept = turn.previous !== undefined && isState(turn.previous.state) ? turn.previous.state : undefined;
            let session: string;
            let unseen: string;
            if (kept !== undefined && kept.process === process.token && process.knows(kept.session)) {
              session = kept.session;
              unseen = transcript(turn.previous!.since);
            } else if (kept !== undefined && (await process.resumeSession(turn.sessionId, kept.session, turn.cwd, servers))) {
              session = kept.session;
              unseen = transcript(turn.previous!.since);
            } else {
              const created = await process.newSession(turn.sessionId, turn.cwd, servers);
              session = created.sessionId;
              unseen = transcript(turn.history);
              const model = modelOf(created.configOptions);
              if (model !== undefined) offer([{ type: "model", model }]);
            }
            stillWanted();
            offer([{ type: "state", data: { session, process: process.token } satisfies SessionState }]);
            // The agent's own mode for the access level, where it has one; Lemma answers the requests it still makes.
            await process.useAccess(session, turn.access);
            await process.useModel(session, turn.model);
            stillWanted();
            if (turn.model !== undefined && process.models !== undefined) offer([{ type: "model", model: turn.model }]);
            const mapper = new UpdateMapper();
            asked = session;
            /** It said or did something: an agent that ends a turn having done neither failed and did not say so. */
            let spoke = false;
            const answered = await process.prompt(
              session,
              promptBlocks(turn, unseen, initialized.agentCapabilities?.promptCapabilities?.image === true),
              (update) => {
                const mapped = mapper.map(update);
                if (mapped.some((item) => item.type === "text" || item.type === "thinking" || item.type === "tool-call")) spoke = true;
                offer(mapped);
              },
            );
            asked = undefined;
            const usage = usageOf(answered.usage);
            if (usage !== undefined) offer([{ type: "usage", usage }]);
            if (answered.stopReason === "refusal") throw new Error(`${process.spec.title} refused to go on`);
            if (!spoke && answered.stopReason === "end_turn") {
              throw new Error(
                `it ended its turn without answering, which usually means it could not reach its model: check that it is signed in, by running it in a terminal${process.spec.install === undefined ? "" : ` (${process.spec.install})`}`,
              );
            }
          },
          catch: (cause) => {
            const { message, auth } = describeError(cause);
            return { message: auth ? `sign in first (Settings › Integrations › ${process.spec.title}): ${message}` : message };
          },
        }).pipe(
          Effect.matchEffect({
            onFailure: (error) => Queue.fail(queue, error),
            onSuccess: () => Queue.end(queue),
          }),
        ),
      );
    }),
  );
}
