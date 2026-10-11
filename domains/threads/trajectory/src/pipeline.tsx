import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { formatDuration, formatTokens } from "@lemma/client/format";
import type { CheckCredit, HandlerCredit } from "@lemma/contracts";
import type { TrajectoryStep, TrajectoryToolRun } from "@lemma/sessions";
import { clockTime } from "@lemma/web/format";
import { inputTokens } from "./scale.ts";

/** How the details panel draws a titled section and a list of facts, shared with it. */
export interface PipelineParts {
  readonly Section: (props: { title: string; children: JSX.Element; aside?: JSX.Element }) => JSX.Element;
  readonly Facts: (props: { rows: readonly (readonly [string, JSX.Element | string | undefined])[] }) => JSX.Element;
}

const ms = (value: number) => (value < 10 ? value.toFixed(2) : value.toFixed(0));

/** A hook's handlers in the order they ran: each one's own time, and what it changed. */
function Handlers(props: { handlers: readonly HandlerCredit[] | undefined; none: string }) {
  return (
    <Show when={props.handlers?.length} fallback={<p class="trj-desc">{props.none}</p>}>
      <table class="dt-table trj-pipeline" aria-label="Handlers">
        <thead>
          <tr>
            <th>Plugin</th>
            <th class="dt-num">Own ms</th>
            <th>What it did</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.handlers}>
            {(handler) => (
              <tr>
                <td class="trj-source">{handler.source}</td>
                <td class="dt-num">{ms(handler.ms)}</td>
                <td>
                  <Show when={(handler.changed?.length ?? 0) > 0 || handler.answered || handler.failed} fallback={<span class="dt-muted">passed it on</span>}>
                    <For each={handler.changed}>{(change) => <span class="trj-change">{change}</span>}</For>
                    <Show when={handler.answered}>
                      <span class="trj-change">answered itself</span>
                    </Show>
                    <Show when={handler.failed}>
                      <span class="trj-change trj-error">failed</span>
                    </Show>
                  </Show>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Show>
  );
}

/** Checks a result passed or was stopped by (a tool call's guards), in order. */
function Checks(props: { checks: readonly CheckCredit[] | undefined; none: string }) {
  return (
    <Show when={props.checks?.length} fallback={<p class="trj-desc">{props.none}</p>}>
      <table class="dt-table trj-pipeline" aria-label="Guards">
        <thead>
          <tr>
            <th>Plugin</th>
            <th class="dt-num">ms</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.checks}>
            {(check) => (
              <tr>
                <td class="trj-source">{check.source}</td>
                <td class="dt-num">{ms(check.ms)}</td>
                <td classList={{ "trj-error": !check.allowed }}>{check.allowed ? "allowed" : `denied: ${check.reason ?? "no reason given"}`}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Show>
  );
}

/**
 * What shaped a model call and what came of it, from the log: the compactions its request made, the request's handlers
 * (`AgentRequestHook`), the attempts that failed and when each was asked again, the answer, and why the turn went on or
 * stopped after it (`AgentContinueHook`).
 */
export function createPipeline({ Section, Facts }: PipelineParts) {
  function StepPipeline(props: { step: TrajectoryStep }) {
    const step = () => props.step;
    return (
      <div class="trj-pipeline-steps">
        <Show when={step().compactions.length > 0}>
          <Section title="Compaction" aside="before the request">
            <For each={step().compactions}>
              {(compaction) => (
                <Facts
                  rows={[
                    ["By", <span class="trj-source">{compaction.source}</span>],
                    ["Replaced", `${formatTokens(compaction.tokensBefore)} tokens of history`],
                    ["Summary", `${compaction.summary.length.toLocaleString()} chars`],
                    [
                      "Cost",
                      compaction.usage === undefined
                        ? undefined
                        : `${formatTokens(inputTokens(compaction.usage))} in · ${formatTokens(compaction.usage.output)} out`,
                    ],
                    ["At", clockTime(compaction.at)],
                  ]}
                />
              )}
            </For>
          </Section>
        </Show>
        <Section title="Request" aside="AgentRequestHook">
          <Handlers handlers={step().request?.handlers} none="No plugin changed the request." />
        </Section>
        <Section title="Model" aside={step().attempts.length === 0 ? undefined : `${step().attempts.length} failed first`}>
          <For each={step().attempts}>
            {(attempt) => (
              <Facts
                rows={[
                  ["Failed", attempt.message.errorMessage ?? attempt.message.stopReason],
                  ["Kind", attempt.failure?.kind],
                  ["Took", formatDuration(attempt.timing.endedAt - attempt.timing.startedAt)],
                  [
                    "Asked again",
                    attempt.retry === undefined
                      ? undefined
                      : `${attempt.retry.reason === "restart" ? "after a restart" : `attempt ${attempt.retry.attempt}`} at ${clockTime(attempt.retry.at)}`,
                  ],
                ]}
              />
            )}
          </For>
          <Show when={step().response} fallback={<p class="trj-desc">No answer was logged.</p>}>
            {(response) => (
              <Facts
                rows={[
                  ["Answered", `${response().message.provider}/${response().message.model}`],
                  ["Stop", response().message.stopReason],
                  ["Tokens", `${formatTokens(inputTokens(response().message.usage))} in · ${formatTokens(response().message.usage.output)} out`],
                  [
                    "TTFT",
                    response().timing?.firstTokenAt === undefined ? undefined : formatDuration(response().timing!.firstTokenAt! - response().timing!.startedAt),
                  ],
                  ["Took", response().timing === undefined ? undefined : formatDuration(response().timing!.endedAt - response().timing!.startedAt)],
                ]}
              />
            )}
          </Show>
        </Section>
        <Show when={step().decision}>
          {(decision) => (
            <Section title={decision().result === "continue" ? "Then it went on" : "Then it stopped"} aside="AgentContinueHook">
              <p class="trj-desc">By default: {decision().why}.</p>
              <Handlers handlers={decision().handlers} none="No plugin weighed in." />
            </Section>
          )}
        </Show>
      </div>
    );
  }

  /** What shaped a tool call's result: `ToolExecuteHook`'s handlers, the guards, the tool, and a cut. */
  function ToolPipeline(props: { run: TrajectoryToolRun }) {
    const credit = () => props.run.credit;
    return (
      <div class="trj-pipeline-steps">
        <Section title="Handlers" aside="ToolExecuteHook">
          <Handlers handlers={credit()?.handlers} none="No plugin changed the call or its result." />
        </Section>
        <Section title="Guards">
          <Checks checks={credit()?.checks} none="No guard checked it." />
        </Section>
        <Section title="Tool">
          <Facts
            rows={[
              ["Status", props.run.result === undefined ? "no result" : props.run.result.isError ? "error" : "ok"],
              ["Took", props.run.timing === undefined ? undefined : formatDuration(props.run.timing.endedAt - props.run.timing.startedAt)],
            ]}
          />
        </Section>
        <Show when={credit()?.cut}>
          {(cut) => (
            <Section title="Cut">
              <p class="trj-desc">
                The registry cut its text from {cut().from.toLocaleString()} to {cut().to.toLocaleString()} characters before the model read it.
              </p>
            </Section>
          )}
        </Show>
      </div>
    );
  }

  return { StepPipeline, ToolPipeline };
}
