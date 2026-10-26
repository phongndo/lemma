import { isDeepStrictEqual } from "node:util";
import { Effect, Option } from "effect";
import { assert, PluginContext, Verify } from "@lemma/core";
import type { HandlerStep } from "@lemma/core";
import { creditOf, inChainOrder } from "@lemma/contracts";
import type { HandlerCredit } from "@lemma/contracts";
import { addUsage } from "@lemma/llm";
import type { LlmRequest, ModelInfo, ToolSpec } from "@lemma/llm";
import { deriveHistory, historyOf, modelEntries, rebuildRequest, requestFrom, requestState } from "@lemma/sessions";
import type { Contribution, History, ModelEntry, RequestRestart, RequestState, SectionUpdate, SessionEvent } from "@lemma/sessions";
import { declaredTools } from "@lemma/tools";
import { AgentRequestHook } from "../../agent.ts";
import type { RequestDraft, RequestPlan, SystemSection } from "../../agent.ts";
import { handlerChanges } from "../credit.ts";
import { failedAs } from "../errors.ts";
import { hookError } from "./context.ts";
import type { Turn } from "./context.ts";

/*
 * A step's request: the draft `AgentRequestHook`'s handlers shape, what of the previous request it extends, the
 * `request` event that logs it, and the request sent, as the log rebuilds it.
 */

/** The tools, by name, a step's request offered its calls (`ToolInvocation.offered`), and declared to the model (`declared`). */
export interface Offer {
  readonly offered: readonly string[];
  readonly declared: readonly string[];
}

/** Each tool spec's JSON length, kept per spec: the registry hands out the same object for a tool until it changes. */
const specLengths = new WeakMap<ToolSpec, number>();
const specChars = (spec: ToolSpec): number => {
  let chars = specLengths.get(spec);
  if (chars === undefined) specLengths.set(spec, (chars = JSON.stringify(spec).length));
  return chars;
};

/** The same spec objects, in the same order: unchanged without comparing their contents. */
const sameSpecs = (logged: readonly ToolSpec[] | undefined, specs: readonly ToolSpec[]): boolean =>
  logged !== undefined && logged.length === specs.length && logged.every((spec, index) => spec === specs[index]);

/**
 * Why a request declares its prompt and tools afresh (`RequestRestart`), or undefined when it extends the previous
 * request on `branch`: that request said what it asked of `model` with the same tools (`specs` it declared, or fewer),
 * and no compaction has replaced the start of its history since.
 */
export function restartOf(branch: readonly SessionEvent[], previous: RequestState, model: string, specs: readonly ToolSpec[]): RequestRestart | undefined {
  // None it can continue: the branch has no request, or one whose prompt does not split into its sections.
  if (previous.model === undefined || previous.system === undefined || previous.sections === undefined || previous.contributions === undefined) return "start";
  for (let i = branch.length - 1; i >= 0; i--) {
    const type = branch[i]!.data.type;
    if (type === "request") break;
    if (type === "compaction") return "compaction";
    // What the model sees of earlier events changed: no longer the previous request's history with more after it.
    if (type === "context-edit") return "edit";
  }
  if (model !== previous.model) return "model";
  const declared = new Map((previous.tools ?? []).map((spec) => [spec.name, spec]));
  const added = specs.some((spec) => {
    const was = declared.get(spec.name);
    return was === undefined || (was !== spec && !isDeepStrictEqual(was, spec));
  });
  return added ? "tools" : undefined;
}

/**
 * What a request that extends the previous one tells the model in a `prompt-update` event: each section whose text differs
 * from what the model was last told (`RequestState.sections`), with "" for one gone; and, when that changed, the declared
 * tools it no longer offers (`offered`, by name: the registry refuses those, `ToolInvocation.offered`; a tool now only
 * nested is offered still, and runs). Undefined when nothing changed.
 */
export function promptUpdate(
  previous: RequestState,
  sections: readonly SystemSection[],
  offeredNames: readonly string[],
): { readonly sections: SectionUpdate[]; readonly unavailable?: string[] } | undefined {
  const told = previous.sections ?? [];
  const now = sections.filter((section) => section.text.length > 0);
  const changed: SectionUpdate[] = [
    ...now.filter((section) => told.find((known) => known.id === section.id)?.text !== section.text).map(({ id, source, text }) => ({ id, source, text })),
    ...told.filter((known) => !now.some((section) => section.id === known.id)).map(({ id, source }) => ({ id, source, text: "" })),
  ];
  const offered = new Set(offeredNames);
  const unavailable = (previous.tools ?? []).map((spec) => spec.name).filter((name) => !offered.has(name));
  const toolsChanged = !isDeepStrictEqual(unavailable, previous.unavailable ?? []);
  if (changed.length === 0 && !toolsChanged) return undefined;
  return { sections: changed, ...(toolsChanged ? { unavailable } : {}) };
}

/**
 * The step's draft (`branch` as it stands, and its model's `view`), through `AgentRequestHook`: the plan its handlers
 * made, and what each changed. A handler appends through the turn's own log, so its event chains after the turn's last
 * one and the turn continues from it.
 */
const askHandlers = (turn: Turn, asking: ModelInfo, branch: readonly SessionEvent[], view: readonly ModelEntry[]) =>
  Effect.gen(function* () {
    const { services, input, log, state } = turn;
    const { sessionId, turnId, cwd } = input;
    const listed = yield* services.tools.list;
    const sections = yield* services.sections({
      sessionId,
      turnId,
      cwd,
      model: asking.ref,
      tools: listed,
      branch,
      ...(input.plugins === undefined ? {} : { plugins: input.plugins }),
    });
    /** The events each plugin's handler appended, by type, for its credit. */
    const appended = new Map<string, string[]>();
    const draft: RequestDraft = {
      sessionId,
      turnId,
      cwd,
      model: asking.ref,
      ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
      ...(input.plugins === undefined ? {} : { plugins: input.plugins }),
      sections,
      tools: listed,
      ...(state.streak.shorten ? { overflow: true } : {}),
      branch,
      history: view.map((entry) => entry.message),
      append: (data) =>
        Effect.uninterruptible(
          log.append(data).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (data.type === "compaction" && data.usage !== undefined) state.usage = addUsage(state.usage, data.usage);
              }),
            ),
            // Credited to the handler that appended it, which runs as its plugin.
            Effect.tap(() =>
              Effect.map(Effect.serviceOption(PluginContext), (by) => {
                if (Option.isSome(by)) appended.set(by.value.id, [...(appended.get(by.value.id) ?? []), data.type]);
              }),
            ),
          ),
        ),
    };
    const steps: HandlerStep<RequestDraft, RequestPlan>[] = [];
    const plan = yield* services.hooks
      .invoke(
        AgentRequestHook,
        draft,
        (final): Effect.Effect<RequestPlan> =>
          Effect.succeed({
            model: final.model,
            ...(final.thinking === undefined ? {} : { thinking: final.thinking }),
            sections: final.sections,
            tools: final.tools,
            ...(final.providerOptions === undefined ? {} : { providerOptions: final.providerOptions }),
          }),
        { onStep: (step) => void steps.push(step) },
      )
      .pipe(Effect.mapError(hookError(turn, "AgentRequestHook")));
    const handlers: readonly HandlerCredit[] = inChainOrder(steps).map((step) => creditOf(step, handlerChanges(step, appended.get(step.pluginId) ?? [])));
    return { plan, handlers };
  });

/**
 * What the request declares, as `plan` asks: the prompt and tools as the request that declared them sent them, so it
 * extends that request's prefix (and the provider's cache of it), with what changed in the sections told in a
 * `prompt-update` event it appends; unless it cannot extend it, and declares them afresh (`restart`). `branch` and
 * `view` are what the handlers were handed.
 */
const declare = (turn: Turn, plan: RequestPlan, branch: readonly SessionEvent[], view: readonly ModelEntry[]) =>
  Effect.gen(function* () {
    const { log, state } = turn;
    // A nested tool is offered but not declared, when a tool that runs others is there to call it.
    const declared = declaredTools(plan.tools);
    const specs: ToolSpec[] = declared.map((tool) => tool.spec);
    // The branch as handlers left it (one may have appended a compaction), and what the request before it said.
    let before = yield* log.branchNow;
    const previous = log.request!;
    const restart = restartOf(before, previous, plan.model, specs);
    if (restart === undefined) {
      const update = promptUpdate(
        previous,
        plan.sections,
        plan.tools.map((tool) => tool.spec.name),
      );
      if (update !== undefined) {
        yield* log.append({ type: "prompt-update", turnId: turn.input.turnId, ...update });
        before = yield* log.branchNow;
      }
    }
    const system =
      restart === undefined
        ? previous.system!
        : plan.sections
            .map((section) => section.text)
            .filter((text) => text.length > 0)
            .join("\n\n");
    const sent = restart === undefined ? (previous.tools ?? []) : specs;
    const contributions: readonly Contribution[] =
      restart === undefined
        ? previous.contributions!
        : [
            ...plan.sections.map((section): Contribution => ({ source: section.source, kind: "system", label: section.id, chars: section.text.length })),
            ...declared.map((tool): Contribution => ({ source: tool.source, kind: "tool", label: tool.spec.name, chars: specChars(tool.spec) })),
          ];
    const history =
      restart === undefined && before.length === branch.length && before.at(-1) === branch.at(-1)
        ? historyOf(branch, view)
        : deriveHistory(before, { restart: restart !== undefined });
    const unchanged = sameSpecs(state.loggedSpecs, sent) || isDeepStrictEqual(previous.tools ?? [], sent);
    // Offered beside them, logged so a call resumed after a restart is held to them (the first request logs none too).
    const declaredNames = new Set(sent.map((spec) => spec.name));
    const nested = plan.tools.flatMap((tool) => (declaredNames.has(tool.spec.name) ? [] : [tool.spec.name]));
    return { previous, restart, system, sent, contributions, history, unchanged, nested };
  });

/**
 * The request sent: what the log says was sent, the request as the branch now ending at the `request` event `logged`
 * rebuilds it, from the state kept as the turn appended. Checked against a rebuild from the store's branch where it is
 * `Verify`d.
 */
const sentRequest = (turn: Turn, logged: SessionEvent, history: History, contributions: readonly Contribution[]) =>
  Effect.gen(function* () {
    const { services, input, log } = turn;
    const { sessionId, turnId } = input;
    const sessionError = failedAs(sessionId, "Session");
    const request =
      log.request === undefined
        ? rebuildRequest(yield* services.sessions.branch(sessionId, { leaf: logged.id }).pipe(Effect.mapError(sessionError)), logged.id, sessionId)
        : requestFrom(log.request, history, logged, sessionId);
    if (request === undefined) return yield* Effect.die(new Error(`request ${logged.id} is not on its own branch`));
    if (yield* Verify) {
      const stored = yield* services.sessions.branch(sessionId, { leaf: logged.id }).pipe(Effect.mapError(sessionError));
      assert(isDeepStrictEqual(rebuildRequest(stored, logged.id, sessionId), request), `request ${logged.id} is not what its branch rebuilds`);
      assert(
        isDeepStrictEqual(requestState(stored).contributions, contributions),
        `request ${logged.id}: its branch does not credit its parts to the plugins that contributed them`,
      );
      if (log.branch !== undefined) {
        assert(log.branch.length === stored.length, `turn ${turnId} keeps ${log.branch.length} events of a branch of ${stored.length}`);
        assert(
          log.branch.every((event, index) => event.id === stored[index]!.id),
          `turn ${turnId} keeps a branch that is not the store's`,
        );
      }
    }
    return request;
  });

/** Builds, logs, and returns the exact request for this step, asking `asking` unless a handler names another. */
export const prepareRequest = (turn: Turn, stepId: string, asking: ModelInfo) =>
  Effect.gen(function* () {
    const { services, input, log, state } = turn;
    const { sessionId, turnId } = input;
    // As it stands now: the branch kept grows as the turn appends, and handlers see this one.
    const branch: readonly SessionEvent[] = (yield* log.branchNow).slice();
    // The model's view of it, derived once: the request's history comes from it too, when nothing is appended meanwhile.
    const view = modelEntries(branch);
    const { plan, handlers } = yield* askHandlers(turn, asking, branch, view);
    const model = plan.model === asking.ref ? asking : yield* services.llm.model(plan.model).pipe(Effect.mapError(failedAs(sessionId, "NoModel")));
    const { previous, restart, system, sent, contributions, history, unchanged, nested } = yield* declare(turn, plan, branch, view);
    const composition = yield* services.host.composition;
    const logged = yield* log.append({
      type: "request",
      turnId,
      stepId,
      model: plan.model,
      ...(plan.thinking === undefined ? {} : { thinking: plan.thinking }),
      composition: composition.id,
      ...(previous.system === system ? {} : { system }),
      ...(unchanged ? {} : { tools: [...sent] }),
      ...(isDeepStrictEqual(previous.nested, nested) ? {} : { nested }),
      ...(restart === undefined ? {} : { restart }),
      // Those of the request before it on the branch are not logged again: a reader has them from it (`requestState`).
      ...(isDeepStrictEqual(previous.contributions, contributions) ? {} : { contributions }),
      ...(handlers.length === 0 ? {} : { handlers }),
      ...(plan.providerOptions === undefined ? {} : { providerOptions: plan.providerOptions }),
    });
    state.loggedSpecs = sent;
    const request: LlmRequest = yield* sentRequest(turn, logged, history, contributions);
    // A tool the prompt declares that the request no longer offers is refused (`ToolInvocation.offered`), as the
    // `prompt-update` event told the model.
    const offer: Offer = { offered: plan.tools.map((tool) => tool.spec.name), declared: sent.map((spec) => spec.name) };
    return { request, model, offer };
  });
