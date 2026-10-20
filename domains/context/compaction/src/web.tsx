import { Show, createMemo } from "solid-js";
import { formatTokens } from "@lemma/client/format";
import { Models } from "@lemma/llm/web";
import type { ModelsService } from "@lemma/llm/web";
import { PromptCommands, ThreadCard, Threads } from "@lemma/threads";
import { ArchiveIcon } from "@lemma/look";
import type { ThreadsService } from "@lemma/threads";
import { Notify, Slots, WebPlugins, defineWebPlugin } from "@lemma/web";
import { measuredTokens } from "./compact.ts";
import { Config } from "./config.ts";
import { lastCacheHit, percent } from "./meter.ts";
import { addSettings } from "./settings.tsx";
import styles from "./meter.css?inline";

/** How far below `at` the ring starts to warn that a summary is near. */
const WARN_BEFORE = 0.1;
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The thread card's context row: a ring of how full the context is, and how much of the last reply's input the cache served. */
function ContextRow(props: { threads: ThreadsService; models: ModelsService; at: number }) {
  const model = () => props.models.selected();
  const tokens = createMemo(() => measuredTokens(props.threads.branch()));
  const cacheHit = createMemo(() => lastCacheHit(props.threads.branch()));
  const share = () => {
    const used = tokens();
    const limit = model()?.contextWindow;
    return used === undefined || limit === undefined ? undefined : used / limit;
  };
  const context = () => {
    const window = `${model()!.name}'s ${formatTokens(model()!.contextWindow)} window`;
    return share() === undefined
      ? `Context: not measured since the last summary or before the first reply; ${window}`
      : `Context: ${formatTokens(tokens()!)} of ${window} (${percent(share()!)}), summarized at ${percent(props.at)}`;
  };
  const cache = () => (cacheHit() === undefined ? undefined : `Cache hit: ${percent(cacheHit()!)} of the last reply's input`);
  return (
    <Show when={model()}>
      {/* Focusable, so its tooltip reaches a keyboard too. */}
      <div
        class="menu-item context-row"
        classList={{
          "context-meter-warn": (share() ?? 0) >= props.at - WARN_BEFORE && (share() ?? 0) < 1,
          "context-meter-over": (share() ?? 0) >= 1,
        }}
        tabIndex={0}
        data-tip={cache() === undefined ? context() : `${context()} · ${cache()}`}
      >
        <span class="menu-check">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle class="context-meter-track" cx="8" cy="8" r={RADIUS} />
            <circle
              class="context-meter-fill"
              cx="8"
              cy="8"
              r={RADIUS}
              stroke-dasharray={`${Math.min(1, share() ?? 0) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
              transform="rotate(-90 8 8)"
            />
          </svg>
        </span>
        <span class="menu-label">Context</span>
        <span class="menu-hint">
          <Show when={share() !== undefined} fallback={<span aria-label={context()}>not measured yet</span>}>
            <span
              role="meter"
              aria-label="Context used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(share()! * 100)}
              aria-valuetext={context()}
            >
              {percent(share()!)}
            </span>
          </Show>
          <Show when={cacheHit() !== undefined}>
            <span aria-label={cache()}> · {percent(cacheHit()!)} cached</span>
          </Show>
        </span>
      </div>
    </Show>
  );
}

/**
 * `context.compaction`'s web half: how full the open thread's context is, as the host half measures it, against the
 * window of the selected model (where the next prompt goes) and its `at`, and how much of the last call the
 * provider's cache served, beside it. A row of the thread card (`ThreadCard`), after where the thread works. Its `at`
 * is a setting in General › Agent.
 */
export default defineWebPlugin({
  id: "context.compaction",
  config: Config,
  styles,
  requires: { threads: Threads, models: Models, slots: Slots, webPlugins: WebPlugins, notify: Notify },
  setup: ({ threads, models, slots, webPlugins, notify }, plugin) => {
    plugin.onCleanup(
      slots.add(ThreadCard, {
        id: "context",
        order: 30,
        group: "usage",
        component: () => <ContextRow threads={threads} models={models} at={plugin.config.at} />,
      }),
    );
    addSettings(slots, webPlugins, notify, plugin.id, () => plugin.config.at);
    // Sent as typed: the host half answers it (`compactAsked`).
    plugin.onCleanup(
      slots.add(PromptCommands, {
        id: "compact",
        order: 20,
        description: "Summarize the conversation so far, to free its context",
        icon: ArchiveIcon,
        args: [{ name: "focus", optional: true, rest: true }],
      }),
    );
  },
});
