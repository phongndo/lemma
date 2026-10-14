import { watch } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { Duration, Effect, Option, Schema, Stream, SubscriptionRef } from "effect";
import type * as acp from "@agentclientprotocol/sdk";
import { definePlugin, Event, Events, Registries } from "@lemma/core";
import { Channels, eventFeed, Paths, serveChannel } from "@lemma/contracts";
import { Harnesses, HarnessStatusChanged, NATIVE_HARNESS } from "@lemma/agent";
import type { Access, Harness, HarnessLogo, HarnessStatus } from "@lemma/agent";
import { McpLaunches } from "@lemma/mcp";
import { SessionRemoved } from "@lemma/sessions";
import { AcpChannels } from "@lemma/agent/acp";
import type { AcpAgentStatus, AcpState, AgentEntry, PermissionRequest, RegistryAgent } from "@lemma/agent/acp";
import { AGENT_ID, agentsOf, readAgentsFile, writeAgentEntry } from "./config.ts";
import { isImageAddress } from "./form.ts";
import type { Agent, AgentsRead } from "./config.ts";
import { allowsItself, offered } from "./access.ts";
import type { AgentMode } from "./access.ts";
import { AgentProcess, describeError } from "./connection.ts";
import type { KnownCall } from "./connection.ts";
import { runTurn } from "./turn.ts";

export { PRESETS } from "./presets.ts";

const Config = Schema.Struct({
  waitForClientMs: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 15_000)))
    .annotate({
      title: "Wait for a client (ms)",
      description: "With nobody following the agents' permission requests as one is made, how long to wait for someone before refusing it.",
    }),
  registry: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => true))).annotate({
    title: "Search the ACP Registry",
    description: "When adding an agent, list those the ACP Registry offers, read from cdn.agentclientprotocol.com.",
  }),
});

/** Published whenever an agent's entry or state changes. Losable: `acp.state` is the record. */
const AcpChanged = Event.make<AcpState>("agent.acp/changed");

/** Where registry icons are read from, and how large one may be. */
const ICON_ORIGIN = "https://cdn.agentclientprotocol.com/";
const ICON_BYTES = 64 * 1024;

/** Characters of a request's raw input it shows. */
const INPUT_CHARS = 2_000;

/** A permission request as clients show it: what the call does, from what the agent said of it. */
const requestView = (
  id: string,
  sessionId: string,
  agent: string,
  agentTitle: string,
  request: acp.RequestPermissionRequest,
  call: KnownCall,
): PermissionRequest => {
  const input = request.toolCall.rawInput ?? call.rawInput;
  const raw = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : undefined;
  const command = typeof raw?.["command"] === "string" ? raw["command"] : Array.isArray(raw?.["command"]) ? (raw["command"] as unknown[]).join(" ") : undefined;
  const content = request.toolCall.content ?? call.content;
  const diffs = content.flatMap((item) => (item.type === "diff" ? [{ path: item.path, oldText: item.oldText ?? null, newText: item.newText }] : []));
  const paths = request.toolCall.locations?.map((location) => location.path) ?? call.locations;
  const shown = command === undefined && diffs.length === 0 && input != null ? (typeof input === "string" ? input : JSON.stringify(input, null, 2)) : undefined;
  const kind = request.toolCall.kind ?? call.kind;
  return {
    id,
    sessionId,
    agent,
    agentTitle,
    title: request.toolCall.title ?? call.title ?? "Use a tool",
    ...(kind == null ? {} : { kind }),
    ...(command === undefined ? {} : { command }),
    paths: [...paths],
    diffs,
    ...(shown === undefined ? {} : { input: shown.length > INPUT_CHARS ? `${shown.slice(0, INPUT_CHARS)}…` : shown }),
    choices: request.options.map((option) => ({ id: option.optionId, name: option.name, kind: option.kind })),
    at: Date.now(),
  };
};

/** The Lemma session a probe's ACP session is opened for: none. */
const PROBE = "lemma.probe";

/** A body's bytes, read until they pass `limit`, when it is dropped: none then. */
async function readAtMost(body: ReadableStream<Uint8Array>, limit: number): Promise<Buffer | undefined> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
}

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const REGISTRY_TTL = 60 * 60 * 1000;

/** Where `command` resolves on PATH, or undefined when it does not. */
async function which(command: string, env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
  const executable = async (path: string) =>
    access(path, constants.X_OK).then(
      () => true,
      () => false,
    );
  if (command === "") return undefined;
  if (isAbsolute(command) || command.includes("/")) return (await executable(command)) ? command : undefined;
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    const path = join(dir, command);
    if (await executable(path)) return path;
  }
  return undefined;
}

/** The registry's agents Lemma can start: those it distributes through npx or uvx. */
function registryAgents(json: unknown): Omit<RegistryAgent, "runnable">[] {
  const agents = (json as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((raw): Omit<RegistryAgent, "runnable">[] => {
    const agent = raw as Record<string, unknown>;
    const distribution = agent["distribution"] as Record<string, { package?: unknown; args?: unknown } | undefined> | undefined;
    if (typeof agent["id"] !== "string" || typeof agent["name"] !== "string" || distribution === undefined) return [];
    const runner = distribution["npx"] !== undefined ? "npx" : distribution["uvx"] !== undefined ? "uvx" : undefined;
    const spec = runner === undefined ? undefined : distribution[runner];
    if (runner === undefined || typeof spec?.package !== "string") return [];
    const extra = Array.isArray(spec.args) ? spec.args.filter((arg): arg is string => typeof arg === "string") : [];
    const text = (key: string) => (typeof agent[key] === "string" ? { [key]: agent[key] as string } : {});
    return [
      {
        id: agent["id"],
        name: agent["name"],
        ...text("description"),
        ...text("version"),
        ...text("icon"),
        ...(typeof agent["website"] === "string"
          ? { website: agent["website"] }
          : typeof agent["repository"] === "string"
            ? { website: agent["repository"] }
            : {}),
        command: runner,
        args: runner === "npx" ? ["-y", spec.package, ...extra] : [spec.package, ...extra],
      },
    ];
  });
}

const failure = (cause: unknown) => new Error(describeError(cause).message);

/**
 * Runs turns on other coding agents over the Agent Client Protocol: the presets (Claude Code, Codex, Gemini CLI,
 * OpenCode) and the agents in `<home>/agents.json`, each added to the agent's `Harnesses`. Serves them to clients as
 * the `acp.*` channels, which its web half draws in Settings › Integrations.
 */
export default definePlugin({
  id: "agent.acp",
  version: "0.1.0",
  config: Config,
  requires: { paths: Paths },
  setup: function* ({ paths }, owner) {
    const events = yield* Events;
    const registries = yield* Registries;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const file = join(paths.home, "agents.json");
    const env = process.env;

    let read: AgentsRead = { entries: new Map() };
    let agents: Agent[] = [];
    /** Whether each agent's command, and those it runs itself, are on PATH, as last looked for. */
    const found = new Map<string, boolean>();
    /** The command an agent needs that is not on PATH. */
    const missingOf = new Map<string, string>();
    /** The modes each agent offered when it last ran, kept once its process stops. */
    const knownModes = new Map<string, readonly AgentMode[]>();
    /** The models each agent offered when it last ran. */
    const knownModels = new Map<string, NonNullable<AgentProcess["models"]>>();
    /** Registry icons, by address, read once. */
    const icons = new Map<string, HarnessLogo>();
    /** Its own icon, else the preset's mark, else the registry's icon. */
    const logoOf = (agent: Agent): HarnessLogo | undefined => {
      const own = agent.entry?.icon;
      if (own !== undefined && isImageAddress(own)) return { image: own };
      const icon = agent.entry?.registry?.icon;
      return agent.preset?.logo ?? (icon === undefined ? undefined : icons.get(icon));
    };
    /** A registry icon as a mask, read from the registry's CDN only, at most 64 KB; none when it cannot be. */
    const iconOf = async (url: string): Promise<HarnessLogo | undefined> => {
      const known = icons.get(url);
      if (known !== undefined) return known;
      if (!url.startsWith(ICON_ORIGIN)) return undefined;
      try {
        const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
        const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
        if (!response.ok || !type.startsWith("image/") || response.body === null) return undefined;
        const bytes = await readAtMost(response.body, ICON_BYTES);
        if (bytes === undefined) return undefined;
        const logo: HarnessLogo = { mask: `data:${type};base64,${bytes.toString("base64")}` };
        icons.set(url, logo);
        return logo;
      } catch {
        return undefined;
      }
    };
    /**
     * Starts the agent, and opens a session it is not asked anything in, in the host's temporary folder, to read the
     * modes it offers, which only a session says. A failure is the agent's state, which the page shows.
     */
    const probe = async (agent: AgentProcess) => {
      try {
        await agent.start();
        if (agent.modes.length === 0 || agent.models === undefined) {
          await agent.newSession(PROBE, tmpdir(), []);
          agent.forget(PROBE);
        }
      } catch {
        // Its error is kept on it.
      }
    };
    /** Looks for the agent's command and what it needs on PATH. */
    const look = async (agent: Agent) => {
      const extra = { ...env, ...agent.spec.env };
      for (const command of [agent.spec.command, ...(agent.preset?.requires ?? [])]) {
        if ((await which(command, extra)) === undefined) {
          missingOf.set(agent.spec.id, command);
          found.set(agent.spec.id, false);
          return;
        }
      }
      missingOf.delete(agent.spec.id);
      found.set(agent.spec.id, true);
    };
    const processes = new Map<string, AgentProcess>();
    /** The writes to the file, in turn. */
    let written: Promise<unknown> = Promise.resolve();
    const writing = <T>(work: () => Promise<T>): Promise<T> => {
      const next = written.then(work, work);
      written = next.catch(() => {});
      return next;
    };
    const harnesses = new Map<string, { readonly key: string; readonly remove: Effect.Effect<void> }>();

    const statusOf = (agent: Agent): AcpAgentStatus => {
      const { spec } = agent;
      const running = processes.get(spec.id);
      const missing = found.get(spec.id) === false;
      const state =
        !agent.enabled && agent.error === undefined
          ? "off"
          : agent.error !== undefined
            ? "failed"
            : missing
              ? "missing"
              : running?.error !== undefined
                ? "failed"
                : "ready";
      const absent = missingOf.get(spec.id) ?? spec.command;
      const detail =
        agent.error ??
        (state === "missing" ? `\`${absent}\` is not on the host's PATH.${spec.install === undefined ? "" : ` ${spec.install}`}` : undefined) ??
        (state === "failed" ? running?.error : undefined);
      const info = running?.initialized?.agentInfo;
      const icon = agent.entry?.registry?.icon;
      const logo = logoOf(agent);
      return {
        id: spec.id,
        title: spec.title,
        ...(spec.description === undefined ? {} : { description: spec.description }),
        source: agent.source,
        enabled: agent.enabled,
        state,
        ...(detail === undefined ? {} : { detail }),
        command: spec.command,
        args: [...spec.args],
        ...(agent.entry === undefined ? {} : { entry: agent.entry }),
        ...(spec.install === undefined ? {} : { install: spec.install }),
        ...(spec.docs === undefined ? {} : { docs: spec.docs }),
        ...(icon === undefined ? {} : { icon }),
        mcp: spec.mcp !== false,
        ...(info == null ? {} : { agent: { name: info.name, version: info.version, ...(info.title == null ? {} : { title: info.title }) } }),
        authMethods: running?.authMethods() ?? [],
        sessions: running?.sessions ?? 0,
        ...(logo === undefined ? {} : { logo }),
        access: offered(running?.modes ?? knownModes.get(spec.id) ?? []).map((level) => ({ ...level })),
      };
    };
    const state = (): AcpState => ({ file, ...(read.error === undefined ? {} : { fileError: read.error }), agents: agents.map(statusOf) });
    const changed = (id?: string) => {
      void run(events.publish(AcpChanged, state())).catch(() => {});
      for (const agent of agents)
        if (id === undefined || agent.spec.id === id) void run(events.publish(HarnessStatusChanged, { id: agent.spec.id })).catch(() => {});
    };

    const harnessStatus = (id: string): HarnessStatus => {
      const agent = agents.find((candidate) => candidate.spec.id === id);
      if (agent === undefined) return { state: "unavailable", detail: "It was removed." };
      const status = statusOf(agent);
      const access = status.access.map((level) => level.access);
      const models = processes.get(id)?.models ?? knownModels.get(id);
      const offers = models === undefined ? {} : { models: models.options, ...(models.current === undefined ? {} : { model: models.current }) };
      return status.state === "ready"
        ? { state: "ready", ...(status.agent?.version === undefined ? {} : { version: status.agent.version }), access, ...offers }
        : { state: "unavailable", ...(status.detail === undefined ? {} : { detail: status.detail }), access, ...offers };
    };

    /** Clients following `acp.permissions`: those that can answer. */
    const watchers = yield* SubscriptionRef.make(0);
    const open = yield* SubscriptionRef.make<readonly PermissionRequest[]>([]);
    const answers = new Map<string, (choice: string | undefined) => void>();
    /** Whether a client that answers is connected, or connects within `waitForClientMs` (a reload, a host restart). */
    const someoneWatches = Effect.flatMap(SubscriptionRef.get(watchers), (count) =>
      count > 0
        ? Effect.succeed(true)
        : Stream.runHead(Stream.filter(SubscriptionRef.changes(watchers), (now) => now > 0)).pipe(
            Effect.timeoutOption(Duration.millis(owner.config.waitForClientMs)),
            Effect.map(Option.isSome),
          ),
    );
    let asked = 0;

    /**
     * A permission request: allowed at once when the session's access level allows it, else put to whoever has the
     * thread open (`acp.permissions`), and refused when nobody can answer. Withdrawn when the turn is cancelled.
     */
    const permission = async (
      sessionId: string,
      request: acp.RequestPermissionRequest,
      { call, access, signal }: { readonly call: KnownCall; readonly access: Access | undefined; readonly signal: AbortSignal },
    ): Promise<acp.RequestPermissionResponse> => {
      const choose = (optionId: string): acp.RequestPermissionResponse => ({ outcome: { outcome: "selected", optionId } });
      const allow = request.options.find((option) => option.kind === "allow_once") ?? request.options.find((option) => option.kind === "allow_always");
      const refuse = request.options.find((option) => option.kind === "reject_once") ?? request.options.find((option) => option.kind === "reject_always");
      const refused: acp.RequestPermissionResponse = refuse === undefined ? { outcome: { outcome: "cancelled" } } : choose(refuse.optionId);
      const kind = request.toolCall.kind ?? call.kind;
      if (access !== undefined && allow !== undefined && allowsItself(access, kind ?? undefined)) return choose(allow.optionId);
      if (!(await run(someoneWatches))) return refused;
      const agent = agents.find((candidate) => processes.get(candidate.spec.id)?.knows(request.sessionId));
      const view = requestView(`p-${++asked}`, sessionId, agent?.spec.id ?? "", agent?.spec.title ?? "The agent", request, call);
      const choice = await new Promise<string | undefined>((resolve) => {
        if (signal.aborted) return resolve(undefined);
        answers.set(view.id, resolve);
        signal.addEventListener("abort", () => resolve(undefined), { once: true });
        void run(SubscriptionRef.update(open, (list) => [...list, view])).catch(() => {});
      }).finally(() => {
        answers.delete(view.id);
        void run(SubscriptionRef.update(open, (list) => list.filter((other) => other.id !== view.id))).catch(() => {});
      });
      return choice === undefined ? { outcome: { outcome: "cancelled" } } : choose(choice);
    };

    const processOf = (agent: Agent): AgentProcess => {
      let running = processes.get(agent.spec.id);
      if (running === undefined) {
        const started: AgentProcess = new AgentProcess(agent.spec, {
          permission,
          changed: () => {
            if (started.modes.length > 0) knownModes.set(agent.spec.id, started.modes);
            if (started.models !== undefined) knownModels.set(agent.spec.id, started.models);
            changed(agent.spec.id);
          },
        });
        running = started;
        processes.set(agent.spec.id, running);
      }
      return running;
    };

    const harnessOf = (agent: Agent): Harness => ({
      id: agent.spec.id,
      title: agent.spec.title,
      ...(logoOf(agent) === undefined ? {} : { logo: logoOf(agent)! }),
      ...(agent.spec.description === undefined ? {} : { description: agent.spec.description }),
      status: Effect.sync(() => harnessStatus(agent.spec.id)),
      run: (turn) =>
        runTurn(
          {
            process: processOf(agents.find((candidate) => candidate.spec.id === agent.spec.id) ?? agent),
            mcpServers: () => run(Effect.map(registries.items(McpLaunches), (items) => items.map(({ item }) => item))),
          },
          turn,
        ),
    });

    /** Reads the file again: agents whose command line changed are stopped, and the harnesses follow the agents. */
    let applying = Promise.resolve();
    const apply = () =>
      (applying = applying.then(async () => {
        const next = await readAgentsFile(file);
        read = next.error === undefined ? next : { ...read, error: next.error };
        agents = agentsOf(read);
        for (const agent of agents) await look(agent);
        await Promise.all(agents.map((agent) => (agent.entry?.registry?.icon === undefined ? undefined : iconOf(agent.entry.registry.icon))));
        const ids = new Set(agents.map((agent) => agent.spec.id));
        for (const [id, running] of processes) {
          const agent = agents.find((candidate) => candidate.spec.id === id);
          if (agent === undefined || !agent.enabled || JSON.stringify(agent.spec) !== JSON.stringify(running.spec)) {
            running.close();
            processes.delete(id);
          }
        }
        for (const [id, { key, remove }] of harnesses) {
          const agent = agents.find((candidate) => candidate.spec.id === id);
          if (agent !== undefined && ids.has(id) && agent.enabled && agent.error === undefined && JSON.stringify(agent.spec) === key) continue;
          harnesses.delete(id);
          await run(remove);
        }
        for (const agent of agents) {
          if (!agent.enabled || agent.error !== undefined || harnesses.has(agent.spec.id)) continue;
          harnesses.set(agent.spec.id, { key: JSON.stringify(agent.spec), remove: await run(owner.add(Harnesses, harnessOf(agent))) });
        }
        changed();
      }));

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const running of processes.values()) running.close();
      }),
    );
    // A thread deleted takes its agents' sessions with it.
    yield* owner
      .background(
        "agent.acp.forget",
        events.stream(SessionRemoved).pipe(
          Stream.runForEach(({ sessionId }) =>
            Effect.sync(() => {
              for (const running of processes.values()) running.forget(sessionId);
            }),
          ),
        ),
      )
      .pipe(Effect.orDie);
    yield* Effect.promise(() => apply());

    // The file, read again whenever it changes: its directory is watched, since editors replace a file to save it.
    yield* Effect.promise(() => mkdir(dirname(file), { recursive: true }));
    let pending: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(dirname(file), { signal: owner.signal }, (_, name) => {
      if (name !== basename(file)) return;
      clearTimeout(pending);
      pending = setTimeout(() => void apply().catch(() => {}), 50);
    });
    watcher.on("error", () => {});
    owner.signal.addEventListener("abort", () => clearTimeout(pending));

    const find = (id: string) =>
      Effect.suspend(() => {
        const agent = agents.find((candidate) => candidate.spec.id === id);
        return agent === undefined ? Effect.fail(new Error(`No agent is named "${id}"`)) : Effect.succeed(agent);
      });

    let cached: { readonly at: number; readonly agents: readonly Omit<RegistryAgent, "runnable">[] } | undefined;
    const registry = Effect.tryPromise({
      try: async (signal) => {
        if (!owner.config.registry) throw new Error("Searching the ACP Registry is turned off (agent.acp's registry setting)");
        if (cached === undefined || Date.now() - cached.at > REGISTRY_TTL) {
          const response = await fetch(REGISTRY_URL, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
          if (!response.ok) throw new Error(`The ACP Registry answered ${response.status}`);
          cached = { at: Date.now(), agents: registryAgents(await response.json()) };
        }
        const runnable = new Map<string, boolean>();
        for (const command of new Set(cached.agents.map((agent) => agent.command))) runnable.set(command, (await which(command, env)) !== undefined);
        const logos = await Promise.all(cached.agents.map((agent) => (agent.icon === undefined ? undefined : iconOf(agent.icon))));
        return cached.agents.map((agent, index): RegistryAgent => ({
          ...agent,
          runnable: runnable.get(agent.command) ?? false,
          ...(logos[index] === undefined ? {} : { logo: logos[index] }),
        }));
      },
      catch: failure,
    });

    yield* owner.add(
      Channels,
      serveChannel(AcpChannels.state, () => Effect.sync(state)),
    );
    yield* owner.add(
      Channels,
      serveChannel(AcpChannels.changes, () => eventFeed(Effect.sync(state), [events.stream(AcpChanged, { buffer: 1 })], 1)),
    );
    yield* owner.add(
      Channels,
      serveChannel(AcpChannels.put, ({ id, entry }) =>
        Effect.tryPromise({
          // One at a time: each reads the file the one before wrote, so none overwrites another's change.
          try: () =>
            writing(async () => {
              if (!AGENT_ID.test(id) || id === NATIVE_HARNESS)
                throw new Error(`"${id}" is not an agent id: lowercase letters, digits, _, and -, and not "${NATIVE_HARNESS}"`);
              if (read.error !== undefined) throw new Error(`Fix ${file} first: ${read.error}`);
              await writeAgentEntry(file, id, entry as AgentEntry | null);
              await apply();
            }),
          catch: failure,
        }),
      ),
    );
    yield* owner.add(
      Channels,
      serveChannel(AcpChannels.check, ({ id }) =>
        Effect.flatMap(find(id), (agent) =>
          Effect.tryPromise({
            try: async () => {
              await look(agent);
              if (agent.enabled && agent.error === undefined && found.get(id) === true) await probe(processOf(agent));
              changed(id);
              return statusOf(agent);
            },
            catch: failure,
          }),
        ),
      ),
    );
    yield* owner.add(
      Channels,
      serveChannel(AcpChannels.authenticate, ({ id, method }) =>
        Effect.flatMap(find(id), (agent) =>
          Effect.tryPromise({
            try: async () => {
              await processOf(agent).authenticate(method);
              changed(id);
            },
            catch: failure,
          }),
        ),
      ),
    );
    yield* owner.add(
      Channels,
      serveChannel(AcpChannels.registry, () => registry),
    );
    // A client that falls behind gets the latest list, not a backlog.
    yield* owner.add(
      Channels,
      serveChannel(AcpChannels.permissions, () =>
        Stream.unwrap(
          Effect.as(
            Effect.acquireRelease(
              SubscriptionRef.update(watchers, (count) => count + 1),
              () => SubscriptionRef.update(watchers, (count) => count - 1),
            ),
            SubscriptionRef.changes(open).pipe(Stream.buffer({ capacity: 1, strategy: "sliding" })),
          ),
        ),
      ),
    );
    yield* owner.add(
      Channels,
      serveChannel(AcpChannels.respond, ({ id, choice }) =>
        Effect.flatMap(SubscriptionRef.get(open), (list) => {
          const answer = answers.get(id);
          const request = list.find((candidate) => candidate.id === id);
          if (answer === undefined || request === undefined) {
            return Effect.fail(new Error(`No permission request "${id}" is open: it was answered, or its turn ended`));
          }
          if (!request.choices.some((option) => option.id === choice)) return Effect.fail(new Error(`"${choice}" is not one of the request's choices`));
          answer(choice);
          return Effect.void;
        }),
      ),
    );
  },
});
