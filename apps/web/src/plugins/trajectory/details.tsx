import { For, Match, Show, Switch, createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { RECORD_KIND_LABEL, contentText, formatDuration, formatTokens, promptDiff, rebuildRequest, recordRequest } from "@lemma/contracts";
import type { AssistantRecord, LedgerRecord, SystemRecord, Timing, TrajectoryRequest } from "@lemma/contracts";
import { inputTokens } from "../../model/timeline.ts";
import { clockTime } from "../../model/format.ts";
import { ToolViews, TrajectoryTabs } from "../../ui/contracts.ts";
import { Contained, CopyIcon, Markdown, XIcon } from "../../ui/parts.tsx";
import type { View, Kind } from "./state.ts";

/** The selected record's or request's details, in tabs. */
export function createDetails(view: View) {
  const { selection, tab, setTab, select, json, thinkingOf, callsOf, copy, deps } = view;

  function Section(props: { title: string; children: JSX.Element; aside?: JSX.Element }) {
    return (
      <section class="dt-section">
        <h4>
          <span>{props.title}</span>
          <Show when={props.aside}>
            <span class="dt-section-aside">{props.aside}</span>
          </Show>
        </h4>
        {props.children}
      </section>
    );
  }

  function Facts(props: { rows: readonly (readonly [string, JSX.Element | string | undefined])[] }) {
    return (
      <dl class="dt-facts">
        <For each={props.rows.filter(([, value]) => value !== undefined && value !== "")}>
          {([key, value]) => (
            <>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </>
          )}
        </For>
      </dl>
    );
  }

  function Pre(props: { text: string; error?: boolean }) {
    return (
      <div class="trj-pre-wrap">
        <button class="trj-copy" aria-label="Copy" data-tip="Copy" onClick={() => void copy(props.text)}>
          <CopyIcon />
        </button>
        <pre class="trj-pre" classList={{ "trj-error": props.error === true }}>
          {props.text}
        </pre>
      </div>
    );
  }

  function Meta(props: { source: string; chars: number; changed: boolean }) {
    return (
      <>
        <span class="trj-source">{props.source}</span>
        {props.chars.toLocaleString()} chars
        <Show when={props.changed}>
          <span class="trj-changed">changed</span>
        </Show>
      </>
    );
  }

  function SystemPrompt(props: { request: TrajectoryRequest }) {
    const unsplit = () => props.request.sections.length > 0 && props.request.sections.every((section) => section.text === undefined);
    return (
      <>
        <For each={props.request.sections}>
          {(section) => (
            <Section title={section.id} aside={<Meta source={section.source} chars={section.chars} changed={section.changed} />}>
              <Show when={section.text !== undefined}>
                <Pre text={section.text!} />
              </Show>
            </Section>
          )}
        </For>
        <Show when={unsplit() && props.request.system}>
          {(system) => (
            <Section title="Whole prompt">
              <Pre text={system()} />
            </Section>
          )}
        </Show>
      </>
    );
  }

  function ToolsList(props: { request: TrajectoryRequest }) {
    return (
      <For each={props.request.tools}>
        {(tool) => (
          <Section title={tool.name} aside={<Meta source={tool.source} chars={tool.chars} changed={tool.changed} />}>
            <Show when={tool.spec}>
              {(spec) => (
                <>
                  <p class="trj-desc">{spec().description}</p>
                  <Pre text={json(spec().parameters)} />
                </>
              )}
            </Show>
          </Section>
        )}
      </For>
    );
  }

  /** How a request's system prompt differs from the request before it (`lemma inspect --request N --diff`). */
  function Diff(props: { previous: TrajectoryRequest | undefined; request: TrajectoryRequest }) {
    const sections = createMemo(() => promptDiff(props.previous, props.request));
    return (
      <Switch>
        <Match when={props.previous === undefined}>
          <p class="trj-desc">This is the first request; everything in it is new (see System Prompt).</p>
        </Match>
        <Match when={sections().length === 0}>
          <p class="trj-desc">The system prompt is unchanged from the request before.</p>
        </Match>
        <Match when={true}>
          <For each={sections()}>
            {(section) => (
              <Section
                title={section.id}
                aside={
                  <>
                    <span class="trj-source">{section.source}</span>
                    {section.status}
                  </>
                }
              >
                <pre class="trj-pre trj-diff">
                  <For each={section.lines}>
                    {(line) => (
                      <span class={`trj-diff-${line.kind}`}>
                        {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
                        {line.text}
                        {"\n"}
                      </span>
                    )}
                  </For>
                </pre>
              </Section>
            )}
          </For>
        </Match>
      </Switch>
    );
  }

  /** Where a request's prompt came from, by contributing plugin. */
  function Sources(props: { request: TrajectoryRequest }) {
    const rows = createMemo(() => {
      const bySource = new Map<string, { chars: number; parts: string[] }>();
      const parts = [
        ...props.request.sections.map((section) => ({ source: section.source, chars: section.chars, label: section.id })),
        ...props.request.tools.map((tool) => ({ source: tool.source, chars: tool.chars, label: tool.name })),
      ];
      for (const part of parts) {
        const entry = bySource.get(part.source) ?? { chars: 0, parts: [] };
        entry.chars += part.chars;
        entry.parts.push(part.label);
        bySource.set(part.source, entry);
      }
      return [...bySource].sort((a, b) => b[1].chars - a[1].chars);
    });
    const max = () => Math.max(1, ...rows().map(([, entry]) => entry.chars));
    return (
      <div class="trj-sources">
        <For each={rows()}>
          {([source, entry]) => (
            <div class="trj-source-row">
              <span class="trj-source-name">{source}</span>
              <span class="trj-source-bar">
                <i style={{ width: `${(entry.chars / max()) * 100}%` }} />
              </span>
              <span class="trj-source-chars">{entry.chars.toLocaleString()}</span>
              <span class="trj-source-parts">{entry.parts.join(", ")}</span>
            </div>
          )}
        </For>
      </div>
    );
  }

  interface Tab {
    readonly id: string;
    readonly label: string;
    readonly render: () => JSX.Element;
  }

  function TimingFacts(props: { timing: Timing; output?: number | undefined }) {
    const t = () => props.timing;
    const decoding = () => (t().firstTokenAt === undefined ? undefined : t().endedAt - t().firstTokenAt!);
    return (
      <Facts
        rows={[
          ["Started", clockTime(t().startedAt)],
          [
            "First token",
            t().firstTokenAt === undefined ? undefined : `${clockTime(t().firstTokenAt!)} · TTFT ${formatDuration(t().firstTokenAt! - t().startedAt)}`,
          ],
          ["Ended", clockTime(t().endedAt)],
          ["Duration", formatDuration(t().endedAt - t().startedAt)],
          ["Decoding", decoding() === undefined ? undefined : formatDuration(decoding()!)],
          [
            "Throughput",
            decoding() !== undefined && decoding()! > 0 && props.output ? `${(props.output / (decoding()! / 1000)).toFixed(1)} tokens/s` : undefined,
          ],
        ]}
      />
    );
  }

  function requestTabs(request: TrajectoryRequest, assistant: AssistantRecord | undefined, previous: TrajectoryRequest | undefined): Tab[] {
    const usage = assistant?.message.usage;
    const timing = assistant?.timing;
    return [
      {
        id: "summary",
        label: "Summary",
        render: () => (
          <>
            <Facts
              rows={[
                ["Model", request.model],
                ["Thinking", request.thinking],
                ["History", `${request.messages} message${request.messages === 1 ? "" : "s"}`],
                [
                  "Composition",
                  <span class="trj-mono" data-tip={request.composition}>
                    {request.composition.slice(0, 16)}
                  </span>,
                ],
                ["Event", <span class="trj-mono">{request.eventId}</span>],
              ]}
            />
            <Section title="Prompt by source" aside={`${request.sections.length} sections · ${request.tools.length} tools`}>
              <Sources request={request} />
            </Section>
            <button
              class="icon-button"
              aria-label="Copy exact request"
              data-tip="Copy exact request"
              onClick={() => {
                const rebuilt = rebuildRequest(deps.threads.branch(), request.eventId);
                if (rebuilt !== undefined) void copy(json(rebuilt));
              }}
            >
              <CopyIcon />
            </button>
          </>
        ),
      },
      { id: "system", label: "System Prompt", render: () => <SystemPrompt request={request} /> },
      { id: "tools", label: "Tools", render: () => <ToolsList request={request} /> },
      { id: "diff", label: "Diff", render: () => <Diff previous={previous} request={request} /> },
      ...(usage === undefined
        ? []
        : [
            {
              id: "usage",
              label: "Usage",
              render: () => (
                <Facts
                  rows={[
                    ["Input", `${inputTokens(usage).toLocaleString()} tokens`],
                    ["Cache read", usage.cacheRead.toLocaleString()],
                    ["Cache write", usage.cacheWrite.toLocaleString()],
                    ["Uncached", usage.input.toLocaleString()],
                    ["Output", usage.output.toLocaleString()],
                    ["Reasoning", usage.reasoning?.toLocaleString()],
                    ["Cost", usage.cost.total > 0 ? `$${usage.cost.total.toFixed(4)}` : undefined],
                  ]}
                />
              ),
            },
          ]),
      ...(timing === undefined ? [] : [{ id: "timing", label: "Timing", render: () => <TimingFacts timing={timing} output={usage?.output} /> }]),
    ];
  }

  function recordTabs(record: LedgerRecord, previous: TrajectoryRequest | undefined): Tab[] {
    switch (record.kind) {
      case "system":
        return [
          { id: "system", label: "System Prompt", render: () => <SystemPrompt request={record.request} /> },
          { id: "diff", label: "Diff", render: () => <Diff previous={previous} request={record.request} /> },
          { id: "tools", label: "Tools", render: () => <ToolsList request={record.request} /> },
          { id: "sources", label: "Sources", render: () => <Sources request={record.request} /> },
        ];
      case "user":
        return [
          {
            id: "summary",
            label: "Summary",
            render: () => (
              <>
                <Facts
                  rows={[
                    ["Turn", String(record.turn.index)],
                    ["Sent", clockTime(record.at)],
                  ]}
                />
                <Pre text={contentText(record.message.content)} />
              </>
            ),
          },
          { id: "raw", label: "Raw", render: () => <Pre text={json(record.message)} /> },
        ];
      case "assistant": {
        const message = record.message;
        const thinking = thinkingOf(record);
        const text = contentText(message.content);
        return [
          {
            id: "summary",
            label: "Summary",
            render: () => (
              <>
                <Facts
                  rows={[
                    ["Request", `#${record.requestNumber}`],
                    ["Model", `${message.provider}/${message.model}`],
                    ["Stop", message.stopReason],
                    ["Error", message.errorMessage],
                    ["Tokens", `${formatTokens(inputTokens(message.usage))} in · ${formatTokens(message.usage.output)} out`],
                    ["Duration", record.timing === undefined ? undefined : formatDuration(record.timing.endedAt - record.timing.startedAt)],
                    ["TTFT", record.timing?.firstTokenAt === undefined ? undefined : formatDuration(record.timing.firstTokenAt - record.timing.startedAt)],
                    ["Tool calls", callsOf(record).join(", ")],
                  ]}
                />
                <Show when={record.step.request}>
                  {(request) => (
                    <button class="trj-link" onClick={() => select({ type: "request", eventId: request().eventId })}>
                      Open request #{record.requestNumber} →
                    </button>
                  )}
                </Show>
              </>
            ),
          },
          {
            id: "preview",
            label: "Preview",
            render: () => (
              <>
                <Show when={thinking}>
                  <details class="trj-thinking">
                    <summary>Thinking</summary>
                    <div class="trj-quote">{thinking}</div>
                  </details>
                </Show>
                <Show when={text} fallback={<p class="trj-desc">No text output.</p>}>
                  <div class="trj-md">
                    <Markdown text={text} />
                  </div>
                </Show>
              </>
            ),
          },
          { id: "raw", label: "Raw", render: () => <Pre text={json(message)} /> },
          ...(record.timing === undefined
            ? []
            : [{ id: "timing", label: "Timing", render: () => <TimingFacts timing={record.timing!} output={message.usage.output} /> }]),
        ];
      }
      case "tool": {
        const run = record.run;
        const result = run.result === undefined ? undefined : contentText(run.result.content);
        const timing = run.timing;
        return [
          {
            id: "summary",
            label: "Summary",
            render: () => (
              <>
                <Facts
                  rows={[
                    ["Tool", run.call.name],
                    ["Status", run.result === undefined ? "no result" : run.result.isError ? "error" : "ok"],
                    ["Duration", timing === undefined ? undefined : formatDuration(timing.endedAt - timing.startedAt)],
                    ["Call id", <span class="trj-mono">{run.call.id}</span>],
                  ]}
                />
                <Section title="Payload">
                  <Pre text={json(run.call.arguments)} />
                </Section>
                <Show when={result !== undefined}>
                  <Section title="Result">
                    <Pre text={result!} error={run.result?.isError === true} />
                  </Section>
                </Show>
              </>
            ),
          },
          { id: "payload", label: "Payload", render: () => <Pre text={json(run.call.arguments)} /> },
          ...(result === undefined ? [] : [{ id: "result", label: "Result", render: () => <Pre text={result} error={run.result?.isError === true} /> }]),
          ...(record.spec === undefined
            ? []
            : [
                {
                  id: "schema",
                  label: "Schema",
                  render: () => (
                    <>
                      <p class="trj-desc">{record.spec!.description}</p>
                      <Pre text={json(record.spec!.parameters)} />
                    </>
                  ),
                },
              ]),
          ...(timing === undefined
            ? []
            : [
                {
                  id: "timing",
                  label: "Timing",
                  render: () => (
                    <Facts
                      rows={[
                        ["Started", clockTime(timing.startedAt)],
                        ["Ended", clockTime(timing.endedAt)],
                        ["Duration", formatDuration(timing.endedAt - timing.startedAt)],
                      ]}
                    />
                  ),
                },
              ]),
        ];
      }
    }
  }

  /** A tool's own view (its `ToolViews` body), then the tabs plugins add for the record. */
  function addedTabs(record: LedgerRecord): Tab[] {
    const item = record.kind === "tool" ? deps.slots.get(ToolViews, record.run.call.name) : undefined;
    const view = item?.body;
    const tool: Tab[] =
      view === undefined || record.kind !== "tool"
        ? []
        : [
            {
              id: "view",
              label: "View",
              render: () => {
                const run = record.run;
                const result = run.result;
                return (
                  <Contained
                    slot={ToolViews}
                    item={item!}
                    component={view}
                    props={{
                      id: run.call.id,
                      name: run.call.name,
                      args: run.call.arguments,
                      result:
                        result === undefined
                          ? undefined
                          : { eventId: run.eventId ?? record.id, content: result.content, isError: result.isError, details: run.details },
                      state: result === undefined ? "interrupted" : result.isError ? "error" : "ok",
                    }}
                  />
                );
              },
            },
          ];
    return [
      ...tool,
      ...deps.slots
        .list(TrajectoryTabs)
        .filter((tab) => tab.when(record))
        .map((tab): Tab => ({
          id: `added:${tab.id}`,
          label: tab.label,
          render: () => <Contained slot={TrajectoryTabs} item={tab} component={tab.component} props={{ record }} />,
        })),
    ];
  }

  function Tabs(props: { tabs: readonly Tab[]; lead?: JSX.Element; title?: JSX.Element }) {
    const active = () => props.tabs.find((candidate) => candidate.id === tab()) ?? props.tabs[0];
    return (
      <>
        <div class="dt-tabs" role="tablist" aria-label="Event details">
          {props.lead}
          <For each={props.tabs}>
            {(candidate) => (
              <button role="tab" class="dt-tab" aria-selected={active()?.id === candidate.id} onClick={() => setTab(candidate.id)}>
                {candidate.label}
              </button>
            )}
          </For>
        </div>
        <Show when={props.title}>
          <div class="dt-details-title">{props.title}</div>
        </Show>
        <div class="trj-detail-body" role="tabpanel">
          {active()?.render()}
        </div>
      </>
    );
  }

  function Details(props: { records: readonly LedgerRecord[] }) {
    const systemFor = (eventId: string | undefined) =>
      eventId === undefined
        ? undefined
        : props.records.find((record): record is SystemRecord => record.kind === "system" && record.request.eventId === eventId);
    // Requests in log order, for each one's predecessor (the Diff tab).
    const requests = createMemo(() => {
      const seen = new Map<string, TrajectoryRequest>();
      for (const record of props.records) {
        const request = recordRequest(record);
        if (request !== undefined && !seen.has(request.eventId)) seen.set(request.eventId, request);
      }
      return [...seen.values()];
    });
    const previousOf = (eventId: string | undefined) => {
      const index = requests().findIndex((request) => request.eventId === eventId);
      return index > 0 ? requests()[index - 1] : undefined;
    };
    const view = createMemo(() => {
      const s = selection();
      if (s === undefined) return undefined;
      if (s.type === "record") {
        const record = props.records.find((candidate) => candidate.id === s.id);
        if (record === undefined) return undefined;
        const where =
          record.kind === "user"
            ? `Turn ${record.turn.index}`
            : record.kind === "system"
              ? `Request #${record.requestNumber}`
              : `Turn ${record.turn.index} · Step ${record.step.index}`;
        return {
          kind: record.kind as LedgerRecord["kind"] | "request",
          name: record.kind === "tool" ? record.run.call.name : "",
          where,
          tabs: [...recordTabs(record, previousOf(recordRequest(record)?.eventId)), ...addedTabs(record)],
        };
      }
      const assistant = props.records.find(
        (record): record is AssistantRecord => record.kind === "assistant" && !record.failed && record.step.request?.eventId === s.eventId,
      );
      const request = assistant?.step.request ?? systemFor(s.eventId)?.request;
      if (request === undefined) return undefined;
      return {
        kind: "request" as const,
        name: assistant === undefined ? "" : `#${assistant.requestNumber}`,
        where: assistant === undefined ? "" : `Turn ${assistant.turn.index} · Step ${assistant.step.index}`,
        tabs: requestTabs(request, assistant, previousOf(s.eventId)),
      };
    });
    return (
      <Show when={view()}>
        {(v) => (
          <aside class="trj-details dt-details" aria-label="Event details">
            <Tabs
              tabs={v().tabs}
              lead={
                <button class="dt-close" aria-label="Close details" data-tip="Close (Esc)" onClick={() => select(undefined)}>
                  <XIcon />
                </button>
              }
              title={
                <>
                  <span class="trj-dot" data-kind={v().kind} />
                  <span class="trj-details-kind">{v().kind === "request" ? "request" : RECORD_KIND_LABEL[v().kind as Kind]}</span>
                  <Show when={v().name}>
                    <span class="trj-mono">{v().name}</span>
                  </Show>
                  <span class="trj-details-where">{v().where}</span>
                </>
              }
            />
          </aside>
        )}
      </Show>
    );
  }

  return { Details };
}
