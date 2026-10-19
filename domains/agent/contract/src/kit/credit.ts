import { isDeepStrictEqual } from "node:util";
import type { HandlerStep } from "@lemma/core";
import type { RequestDraft, RequestPlan } from "../agent.ts";

/** What a request is, for telling two apart. */
type Shape = Pick<RequestPlan, "model" | "thinking" | "sections" | "tools" | "providerOptions">;

/** What changed from `before` to `after`: the model, the thinking level, and sections and tools, by name. */
export const requestChanges = (before: Shape, after: Shape): string[] => {
  const changed: string[] = [];
  if (after.model !== before.model) changed.push(`model ${before.model} → ${after.model}`);
  if (after.thinking !== before.thinking) changed.push(`thinking ${before.thinking ?? "default"} → ${after.thinking ?? "default"}`);
  const sections = new Map(before.sections.map((section) => [section.id, section]));
  for (const section of after.sections) {
    const was = sections.get(section.id);
    if (was === undefined) changed.push(`+section ${section.id}`);
    else if (was.text !== section.text) changed.push(`~section ${section.id}`);
    sections.delete(section.id);
  }
  for (const id of sections.keys()) changed.push(`-section ${id}`);
  const tools = new Map(before.tools.map((tool) => [tool.spec.name, tool]));
  for (const tool of after.tools) {
    const was = tools.get(tool.spec.name);
    if (was === undefined) changed.push(`+tool ${tool.spec.name}`);
    else if (!isDeepStrictEqual(was.spec, tool.spec)) changed.push(`~tool ${tool.spec.name}`);
    tools.delete(tool.spec.name);
  }
  for (const name of tools.keys()) changed.push(`-tool ${name}`);
  if (!isDeepStrictEqual(before.providerOptions ?? {}, after.providerOptions ?? {})) changed.push("providerOptions");
  return changed;
};

/**
 * What a handler of `AgentRequestHook` changed: the draft it passed on, the plan it made of what it got back (or of its
 * own draft, when it answered itself), and the events it appended (`+compaction`).
 */
export const handlerChanges = (step: HandlerStep<RequestDraft, RequestPlan>, appended: readonly string[]): string[] => {
  const { next, output } = step;
  return [
    ...(next !== undefined && next.input !== step.input ? requestChanges(step.input, next.input) : []),
    ...(output === undefined
      ? []
      : next === undefined
        ? requestChanges(step.input, output)
        : next.output !== undefined && next.output !== output
          ? requestChanges(next.output, output)
          : []),
    ...appended.map((type) => `+${type}`),
  ];
};
