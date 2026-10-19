import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { formatTokens } from "@lemma/client/format";
import { latestRequest, pluginShares, trajectory } from "@lemma/sessions";
import type { PluginShare, SessionEvent, TrajectoryRequest } from "@lemma/sessions";
import { PluginTabs, PluginsFacts } from "@lemma/settings";
import type { ThreadsService } from "@lemma/threads";
import type { SlotsService } from "@lemma/web";

/** Characters as tokens, roughly: four to a token. */
const tokens = (chars: number) => `≈${formatTokens(Math.ceil(chars / 4))}`;

const CACHE_NOTE =
  "Tokens are estimated at four characters each. A provider caches a prompt up to its first change, so a part that changed since the request before costs the cache of everything after it.";

interface Latest {
  readonly request: TrajectoryRequest;
  /** The branch's first request, where everything is new. */
  readonly first: boolean;
  readonly shares: readonly PluginShare[];
}

const latestOf = (branch: readonly SessionEvent[]): Latest | undefined => {
  const turns = trajectory(branch);
  const request = latestRequest(turns);
  if (request === undefined) return undefined;
  const requests = turns.reduce((count, turn) => count + turn.steps.filter((step) => step.request !== undefined).length, 0);
  return { request, first: requests === 1, shares: pluginShares(request) };
};

/**
 * What each plugin costs in the open thread's latest request, on the Plugins page: a line of its summary (the
 * request's size, and how many of its parts changed since the request before), and a Cost tab for each plugin that
 * put something in it (its sections and tools, their size, and which changed). Worked out when the page asks, once a
 * branch, rather than as the thread streams.
 */
export function addCosts(threads: ThreadsService, slots: SlotsService): void {
  let cached: { readonly branch: readonly SessionEvent[]; readonly latest: Latest | undefined } | undefined;
  const latest = (): Latest | undefined => {
    const branch = threads.branch();
    if (cached?.branch !== branch) cached = { branch, latest: latestOf(branch) };
    return cached.latest;
  };
  const shareOf = (id: string) => latest()?.shares.find((share) => share.source === id);

  slots.add(PluginsFacts, {
    id: "trajectory.latest-request",
    label: "Latest request",
    tip: `The open thread's latest request: its system prompt and tools. Each plugin's share is in its Cost tab. ${CACHE_NOTE}`,
    value: () => {
      const found = latest();
      if (found === undefined) return undefined;
      const size = found.shares.reduce((sum, share) => sum + share.systemChars + share.toolChars, 0);
      const changed = found.shares.reduce((sum, share) => sum + share.changed.length, 0);
      return `${tokens(size)} tokens of prompt and tools; ${found.first ? "the first" : changed === 0 ? "nothing changed" : `${changed} part${changed === 1 ? "" : "s"} changed`}`;
    },
  });

  slots.add(PluginTabs, {
    id: "trajectory.cost",
    order: 25,
    label: (plugin, kind) => (kind === "host" && shareOf(plugin.id) !== undefined ? "Cost" : undefined),
    component: (props) => (
      <Show when={latest()}>
        {(found) => <Show when={found().shares.find((share) => share.source === props.plugin.id)}>{(share) => <Cost latest={found()} share={share()} />}</Show>}
      </Show>
    ),
  });
}

function Cost(props: { readonly latest: Latest; readonly share: PluginShare }): JSX.Element {
  const parts = () => [
    ...props.latest.request.sections
      .filter((section) => section.source === props.share.source)
      .map((section) => ({ name: section.id, kind: "section", chars: section.chars, changed: section.changed })),
    ...props.latest.request.tools
      .filter((tool) => tool.source === props.share.source)
      .map((tool) => ({ name: tool.name, kind: "tool", chars: tool.chars, changed: tool.changed })),
  ];
  return (
    <div class="trj-cost">
      <p>
        In the open thread's latest request: {tokens(props.share.systemChars)} tokens of system prompt and {tokens(props.share.toolChars)} of tools
        {props.latest.first ? ", all of it new in the thread's first request." : "."}
      </p>
      <table>
        <thead>
          <tr>
            <th>Part</th>
            <th>Kind</th>
            <th class="trj-num">Tokens</th>
            <th>Since the request before</th>
          </tr>
        </thead>
        <tbody>
          <For each={parts()}>
            {(part) => (
              <tr>
                <td>{part.name}</td>
                <td class="trj-muted">{part.kind}</td>
                <td class="trj-num">{tokens(part.chars)}</td>
                <td classList={{ "trj-muted": !part.changed || props.latest.first }}>{props.latest.first ? "new" : part.changed ? "changed" : "unchanged"}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <p class="trj-muted">{CACHE_NOTE}</p>
    </div>
  );
}
