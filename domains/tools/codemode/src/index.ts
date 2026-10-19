import { Effect, Schedule, Stream } from "effect";
import { definePlugin, Hook, Hooks, Registries } from "@lemma/core";
import { Paths } from "@lemma/contracts";
import { AgentRequestHook, PromptSections } from "@lemma/agent";
import { Llm } from "@lemma/llm";
import { SessionAppended, Sessions } from "@lemma/sessions";
import { ToolNamespaces, ToolRunner, Tools } from "@lemma/tools";
import type { ToolContribution, ToolNamespace } from "@lemma/tools";
import { codemodeTool } from "./codemode.ts";
import type { CodemodeDetails } from "./details.ts";
import { Journals } from "./journal.ts";

export { codemodeTool, CodemodeInput } from "./codemode.ts";
export type { CodemodeBranch, CodemodeDeps } from "./codemode.ts";
export type { CodemodeCallRecord, CodemodeDetails, CodemodeDisplay } from "./details.ts";

/**
 * Never handled: dispatching it says whether the core still dispatches hooks, which it stops doing as it shuts down.
 * Asked only once a script's call has failed, to tell a failure of shutting down from the call's own.
 */
const Probe = Hook.make<void, void>("tools.codemode/core-closing");

/** The system prompt's section naming the namespaces of the tools only scripts call. */
const SECTION = "codemode-namespaces";

/** The namespaces whose tools only scripts call in a request, as the system prompt names them; the MCP servers name their own. */
const section = (namespaces: readonly ToolNamespace[]): string =>
  [
    "Tool namespaces, whose tools only codemode scripts call: find them with `await searchTools(query, { namespace })`, and read how they work together with `await describeNamespace(name)` before using them.",
    ...namespaces.map(({ name, description }) => `- ${name}: ${description}`),
  ].join("\n");

/**
 * The `codemode` tool, whose scripts call the other tools through the `ToolRunner`, and classifier and image models
 * through `Llm`. Their `store()` lives in the session log (`Sessions`), and each script's journal in
 * `<home>/codemode/journals` (`Paths`).
 */
export default definePlugin({
  id: "tools.codemode",
  version: "0.1.0",
  requires: { runner: ToolRunner, llm: Llm, sessions: Sessions, paths: Paths },
  setup: function* ({ runner, llm, sessions, paths }, owner) {
    const registries = yield* Registries;
    const hooks = yield* Hooks;
    const closing = hooks
      .invoke(Probe, undefined, () => Effect.void)
      .pipe(
        Effect.as(false),
        Effect.catch((error) => Effect.succeed(error._tag === "CoreClosed")),
      );
    let namespaces: readonly ToolNamespace[] = (yield* registries.items(ToolNamespaces)).map(({ item }) => item);
    yield* owner.background(
      "namespaces",
      Stream.runForEach(registries.changes(ToolNamespaces), (items) => Effect.sync(() => void (namespaces = items.map(({ item }) => item)))),
    );

    const journals = new Journals(paths.home);
    // A call's journal goes once its result is logged; one never logged (cut off, and never resumed), after a week.
    yield* owner.observe(SessionAppended, ({ sessionId, event: { data } }) => {
      if (data.type !== "message" || data.message.role !== "toolResult" || data.message.toolName !== "codemode") return Effect.void;
      const { toolCallId } = data.message;
      return Effect.promise(() => journals.remove(sessionId, toolCallId));
    });
    yield* owner.background("prune journals", Effect.promise(() => journals.prune(Date.now())).pipe(Effect.repeat(Schedule.spaced("1 hour"))));

    // What earlier scripts on the branch stored, in the order they ran, and the codemode calls it has results of.
    const branch = (sessionId: string, leafId: string | undefined) =>
      leafId === undefined
        ? Effect.succeed({ store: {}, answered: new Set<string>() })
        : sessions.branch(sessionId, { leaf: leafId }).pipe(
            Effect.map((events) => {
              const store: Record<string, unknown> = {};
              const answered = new Set<string>();
              for (const { data } of events) {
                if (data.type !== "message" || data.message.role !== "toolResult" || data.message.toolName !== "codemode") continue;
                answered.add(data.message.toolCallId);
                const writes = (data.details as Partial<CodemodeDetails> | undefined)?.storeWrites;
                if (writes === undefined) continue;
                for (const key of writes.delete) delete store[key];
                Object.assign(store, writes.set);
              }
              return { store, answered };
            }),
            Effect.orElseSucceed(() => ({ store: {}, answered: new Set<string>() })),
          );

    yield* owner.add(Tools, codemodeTool({ registry: runner, llm, namespaces: () => namespaces, branch, journals, closing }));
    // Where codemode is offered, the namespaces of the tools it alone calls there.
    const listedIn = (tools: readonly ToolContribution[]): readonly ToolNamespace[] => {
      if (!tools.some((tool) => tool.spec.name === "codemode")) return [];
      const used = new Set(tools.filter((tool) => tool.nested === true && tool.namespace !== undefined).map((tool) => tool.namespace));
      return namespaces.filter((namespace) => used.has(namespace.name) && !namespace.name.startsWith("mcp__"));
    };
    yield* owner.add(
      PromptSections,
      {
        id: SECTION,
        text: ({ tools }) => {
          const listed = listedIn(tools);
          return listed.length === 0 ? undefined : section(listed);
        },
      },
      // After the MCP servers' section, before the environment, whose date changes daily.
      { order: 610 },
    );
    // The section is written for the tools on offer before the request's are chosen (a thread's profile keeps some):
    // once they are, it names only the namespaces still offered, and goes with codemode.
    yield* owner.on(
      AgentRequestHook,
      (draft, next) =>
        Effect.map(next(draft), (plan) => {
          if (!plan.sections.some((each) => each.id === SECTION)) return plan;
          const listed = listedIn(plan.tools);
          return {
            ...plan,
            sections:
              listed.length === 0
                ? plan.sections.filter((each) => each.id !== SECTION)
                : plan.sections.map((each) => (each.id === SECTION ? { ...each, text: section(listed) } : each)),
          };
        }),
      { phase: "select" },
    );
  },
});
