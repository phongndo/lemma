import { Effect, Result, Schema, Stream } from "effect";
import { definePlugin, Registries } from "@lemma/core";
import type { Contribution } from "@lemma/core";
import { Channels, Interaction } from "@lemma/contracts";
import type { Channel } from "@lemma/contracts";
import { ToolNamespaces, Tools } from "@lemma/tools";
import { answering, channelTool, NAMESPACE } from "./channels.ts";
import { DEFAULT_CONFIRM, EVERY_READ, termsOf, toolName } from "./policy.ts";

export { DEFAULT_CONFIRM, EVERY_READ, NEVER, termsOf, toolName } from "./policy.ts";

const ids = (defaults: readonly string[]) => Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultType(Effect.sync(() => [...defaults])));

const Config = Schema.Struct({
  channels: ids([EVERY_READ]).annotate({
    title: "Channels scripts call",
    description:
      "Channel ids offered as tools, called freely; * is every channel that declares it only reads. One that declares a write asks you first all the same, and credential channels are never offered.",
  }),
  confirm: ids(DEFAULT_CONFIRM).annotate({
    title: "Channels that ask first",
    description: "Channel ids offered as tools whose every call asks you first, showing what it sends: by default those that change something.",
  }),
});

const INSTRUCTIONS = `Lemma itself, through the channels its plugins serve clients (the web app, the \`lemma\` command): each tool \`lemma_<channel id, . and - as _>\` takes the channel's payload as JSON (a payload that is not an object goes in \`{ payload }\`) and resolves to its result's JSON. Streams take \`{ payload?, take?, timeoutMs? }\` and resolve to \`{ elements, ended, timedOut }\`; most begin with a \`subscribed\` element. Tools whose description says so ask the person before each call and reject when they decline. Loop and filter in the script, and return only what answers the question.

- Recent sessions: \`const sessions = await tools.lemma_sessions_list({})\` (newest first), \`await tools.lemma_sessions_search({ query: "flaky test" })\`.
- A session's log, or its tail: \`await tools.lemma_sessions_events({ sessionId, after: seq })\`; which are running: \`await tools.lemma_agent_running({})\`.
- What happened in a session, as its Trajectory view lists it: \`const { records } = await tools.lemma_sessions_records({ sessionId, filter: "is:error tool:bash" })\`, each \`{ kind, turn, status, name, error }\` and more by kind (a tool run's \`tool\`, \`arguments\`, \`result\`; a model call's \`model\`, \`usage\`, \`text\`). The filter takes \`is:error\`, \`kind:model\`, \`tool:bash\`, \`turn:2\`, \`req:5\`, words, and \`-term\`.
- Failures across sessions: \`for (const s of (await tools.lemma_sessions_list({})).slice(0, 20)) failed.push(...(await tools.lemma_sessions_records({ sessionId: s.id, filter: "is:error" })).records)\`, then count them by \`tool\` or \`name\`. Each read loads that session's whole log into the host for a while, so read the sessions the question needs (the recent ones, a directory's, \`lemma_sessions_search\`'s matches), not every one.
- What the model was sent: \`await tools.lemma_sessions_request({ sessionId, request: "last" })\` (or its number, or \`"2.1"\` for turn 2's first step): each system section and tool with the plugin that contributed it, and each plugin's share (\`plugins\`); \`rebuilt: true\` adds the exact request. How a session kept the prompt cache: \`await tools.lemma_sessions_cache({ sessionId })\`.
- The host and its plugins: \`await tools.lemma_devtools_host_info({})\` (where it runs, its plugin set); \`const plugins = await tools.lemma_devtools_host_plugins({})\`, every plugin on or off with its \`state\`, \`fault\`, \`problem\`, \`haltedBy\`, and \`config\`; those not running as enabled: \`plugins.filter((p) => p.enabled && p.state !== "active")\`. What a plugin shows of its state: \`await tools.lemma_devtools_host_inspectors({})\`, then \`await tools.lemma_devtools_host_inspect({ id })\`.
- Judge many sessions cheaply: read their titles or answers, then ask a classifier (\`models.classify\`) about each, and return only the summary.`;

/**
 * Lemma's own channels as tools scripts call, in the `lemma` namespace: those that declare they only read, and those the
 * config allows, kept in step with the channels plugins serve as they come and go. Writing channels ask the person
 * first (`Interaction`); credential channels are never offered.
 */
export default definePlugin({
  id: "tools.lemma",
  uses: ["lemma/agent@2", "lemma/llm@3", "lemma/sessions@2", "lemma/tools@2"],
  version: "0.1.0",
  config: Config,
  requires: { interaction: Interaction },
  setup: function* ({ interaction }, owner) {
    const registries = yield* Registries;
    const config = owner.config;

    yield* owner.add(ToolNamespaces, {
      name: NAMESPACE,
      description: "Lemma itself: its sessions and what happened in them, agent, plugins, commands, skills, models, and workspace, as the app's own channels",
      instructions: INSTRUCTIONS,
    });
    /** Channels already said to have no JSON form: each is warned of once, not at every change to the channels. */
    const unoffered = new WeakSet<Channel>();
    /** The tools added, by name, with the channel each was made from and how it is offered. */
    const added = new Map<string, { readonly channel: Channel; readonly confirm: boolean; readonly remove: Effect.Effect<void> }>();
    const sync = (items: readonly Contribution<Channel>[]) =>
      Effect.gen(function* () {
        const wanted = new Map<string, { readonly channel: Channel; readonly confirm: boolean }>();
        for (const { item } of answering(items)) {
          const offered = termsOf(item, config);
          const name = toolName(item.id);
          // Two ids that read alike as a tool name: the first keeps it.
          if (offered === undefined || wanted.has(name)) continue;
          wanted.set(name, { channel: item, confirm: offered === "confirm" });
        }
        for (const [name, tool] of added) {
          const next = wanted.get(name);
          if (next?.channel === tool.channel && next.confirm === tool.confirm) continue;
          added.delete(name);
          yield* tool.remove;
        }
        for (const [name, { channel, confirm }] of wanted) {
          if (added.has(name)) continue;
          const made = Result.try(() => channelTool(channel, { registries, interaction, confirm }));
          if (Result.isFailure(made)) {
            if (!unoffered.has(channel))
              yield* Effect.logWarning(`tools.lemma: "${channel.id}" was not offered: its schemas have no JSON form (${String(made.failure)})`);
            unoffered.add(channel);
            continue;
          }
          const remove = yield* Effect.result(owner.add(Tools, made.success));
          if (Result.isFailure(remove)) {
            // Another plugin holds the name: the rest are offered all the same.
            yield* Effect.logWarning(`tools.lemma: ${name} was not added: ${remove.failure.message}`);
            continue;
          }
          added.set(name, { channel, confirm, remove: remove.success });
        }
      });
    // Every list, the first too: channels served before this plugin started are in it.
    yield* owner.background("channel tools", Stream.runForEach(registries.changes(Channels), sync));
  },
});
