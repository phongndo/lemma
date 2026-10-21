import { For, Index, Show, createMemo } from "solid-js";
import type { ToolBodyProps, ToolView } from "@lemma/threads";
import { ToolViews } from "@lemma/threads";
import { Contained } from "@lemma/web";
import type { SlotsService } from "@lemma/web";
import { detailsOf, firstLine, liveCalls, scriptOutput } from "./calls.ts";
import type { CodemodeCallRecord, CodemodeDisplay } from "./details.ts";

const duration = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

function Calls(props: { calls: readonly CodemodeCallRecord[]; omitted?: number | undefined }) {
  return (
    <Show when={props.calls.length > 0}>
      <ol class="codemode-calls">
        <Index each={props.calls}>
          {(call) => (
            <li class={`codemode-call codemode-${call().status}`}>
              <span class="codemode-mark" aria-label={call().status}>
                {call().status === "ok" ? "✓" : call().status === "error" ? "✗" : "–"}
              </span>
              <span class="codemode-name">{call().name}</span>
              <Show when={call().args}>
                <span class="codemode-args">{call().args}</span>
              </Show>
              <span class="codemode-time">{call().replayed ? "from before the restart" : duration(call().durationMs)}</span>
            </li>
          )}
        </Index>
      </ol>
      <Show when={props.omitted}>{(more) => <p class="muted small">…and {more()} more calls</p>}</Show>
    </Show>
  );
}

/** A call opened: the script, the calls it made (live while it runs), and what it printed. */
function CodemodeBody(props: ToolBodyProps) {
  const details = createMemo(() => detailsOf(props.result?.details));
  const calls = createMemo(() => (props.result === undefined ? liveCalls(props.output) : (details().calls ?? [])));
  const text = () => scriptOutput(props.result?.content ?? []);
  const images = () => (props.result?.content ?? []).filter((part) => part.type === "image");
  return (
    <div class="tool-body codemode-body">
      <Show when={typeof props.args?.code === "string"}>
        <pre class="codemode-code">{props.args!.code as string}</pre>
      </Show>
      <Calls calls={calls()} omitted={details().callsOmitted} />
      <Show when={text().trim() !== ""}>
        <div class="output" classList={{ error: props.result?.isError === true }}>
          <pre>{text()}</pre>
        </div>
      </Show>
      <Show when={images().length > 0}>
        <div class="images">
          <For each={images()}>{(image) => (image.type === "image" ? <img src={`data:${image.mimeType};base64,${image.data}`} alt="" /> : null)}</For>
        </div>
      </Show>
      <Show when={details().usage}>{(usage) => <p class="muted small">Models used: ${usage().cost.total.toFixed(4)}</p>}</Show>
    </div>
  );
}

/**
 * How the chat shows a `codemode` call: the script's first line on its line; opened, the script, its calls, and its
 * output; and outside the fold, what the `display` tools it called show (a page drawn), each as that tool's own view
 * draws it.
 */
export const codemodeView = (slots: SlotsService): ToolView => {
  function CodemodeDisplays(props: ToolBodyProps) {
    /** Each display as the call its tool's view draws, and runs of one tool's its view draws together (`displays`). */
    const runs = createMemo((): readonly (readonly ToolBodyProps[])[] => {
      const shown = (detailsOf(props.result?.details).displays ?? []).map((display: CodemodeDisplay, index): ToolBodyProps => ({
        id: `${props.id}/${index}`,
        name: display.name,
        args: display.title === undefined ? undefined : { title: display.title },
        result: {
          eventId: props.result!.eventId,
          content: display.content,
          isError: false,
          ...(display.details === undefined ? {} : { details: display.details }),
        },
        state: "ok",
      }));
      const out: ToolBodyProps[][] = [];
      for (const call of shown) {
        const last = out.at(-1);
        if (last !== undefined && last[0]!.name === call.name && slots.get(ToolViews, call.name)?.displays !== undefined) last.push(call);
        else out.push([call]);
      }
      return out;
    });
    return (
      <Index each={runs()}>
        {(run) => {
          const view = () => slots.get(ToolViews, run()[0]!.name);
          return (
            <Show
              when={run().length > 1 && view()?.displays !== undefined ? view() : undefined}
              keyed
              fallback={
                <Show when={view()?.display !== undefined ? view() : undefined} keyed>
                  {(item) => <Contained slot={ToolViews} item={item} component={item.display} props={run()[0]!} />}
                </Show>
              }
            >
              {(item) => <Contained slot={ToolViews} item={item} component={item.displays} props={{ calls: run() }} />}
            </Show>
          );
        }}
      </Index>
    );
  }
  return {
    icon: "code",
    summary: (args) => {
      const line = firstLine(args?.code);
      return line === undefined ? {} : { primary: line };
    },
    streaming: "code",
    action: ["ran", "script", "scripts"],
    body: CodemodeBody,
    display: CodemodeDisplays,
  };
};
