import { Show, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import type { ConnectionStatus } from "@lemma/client";
import { Client, ComposerNotices, SidebarFooter, Slots } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { AlertIcon, CheckIcon, CopyIcon } from "../ui/parts.tsx";
import { copyText } from "../lib/clipboard.ts";
import styles from "./connection.css?inline";

function ConnectionBadge(props: { status: ConnectionStatus; now: Accessor<number>; compact?: boolean }) {
  const now = props.now;
  const label = () => {
    const status = props.status;
    switch (status.state) {
      case "connected":
        return "Connected";
      case "closed":
        return "Disconnected";
      case "connecting":
      case "reconnecting": {
        const verb = status.state === "connecting" ? "Connecting" : "Reconnecting";
        const wait = status.retryAt === undefined ? 0 : Math.ceil((status.retryAt - now()) / 1_000);
        return wait > 1 ? `${verb} in ${wait}s` : `${verb}…`;
      }
    }
  };
  return (
    <span
      class={`connection connection-${props.status.state}${props.compact ? " connection-compact" : ""}`}
      role="status"
      data-tip={props.compact ? (props.status.error === undefined ? label() : `${label()}: ${props.status.error}`) : props.status.error}
    >
      <span class="connection-dot" aria-hidden="true" />
      {/* Compact, the label is hidden rather than left out: a live region announces its text, not an aria-label. */}
      <span classList={{ "connection-hidden": props.compact }}>{label()}</span>
    </span>
  );
}

/** Sits above the composer while the host is unreachable, since nothing can be sent until it's back. */
function ConnectionNotice(props: { status: Accessor<ConnectionStatus>; now: Accessor<number> }) {
  const status = props.status;
  const unreachable = () => status().state === "connecting" && status().attempts >= 2;
  const [copied, setCopied] = createSignal(false);
  const copy = (error: string) =>
    void copyText(`Can't reach the host: ${error}`).then((ok) => {
      setCopied(ok);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <Show when={status().state === "reconnecting" || unreachable()}>
      <div class="callout callout-warn composer-callout" role={unreachable() ? "alert" : "status"}>
        <AlertIcon />
        <div class="callout-text">
          <span>{unreachable() ? "Can't reach the host." : "Connection to the host lost."}</span>
          <Show when={unreachable()}>
            <span class="muted">
              Is it running? Open the link it printed — the page needs its <code>?token=</code>.
            </span>
          </Show>
          <Show when={status().error}>{(error) => <code class="callout-detail">{error()}</code>}</Show>
        </div>
        <ConnectionBadge status={status()} now={props.now} />
        <Show when={status().error}>
          {(error) => (
            <button class="icon-button" aria-label="Copy error" data-tip={copied() ? "Copied" : "Copy error"} onClick={() => copy(error())}>
              {copied() ? <CheckIcon /> : <CopyIcon />}
            </button>
          )}
        </Show>
      </div>
    </Show>
  );
}

/** How the connection to the host is doing: a dot in the sidebar (its label is the tooltip), a notice above the composer while it is down. */
export default defineUiPlugin({
  id: "connection",
  styles,
  requires: { client: Client, slots: Slots },
  setup: ({ client, slots }, plugin) => {
    const [now, setNow] = createSignal(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    plugin.onCleanup(() => window.clearInterval(timer));
    plugin.onCleanup(
      slots.add(SidebarFooter, {
        id: "connection",
        order: 100,
        component: () => (
          <>
            <span class="spacer" />
            <ConnectionBadge status={client.status()} now={now} compact />
          </>
        ),
      }),
    );
    plugin.onCleanup(slots.add(ComposerNotices, { id: "connection", component: () => <ConnectionNotice status={client.status} now={now} /> }));
  },
});
