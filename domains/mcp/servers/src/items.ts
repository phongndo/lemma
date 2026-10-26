import { matchesQuery } from "@lemma/web/match";
import type { McpServerStatus } from "@lemma/mcp";

/**
 * How a server is doing: a few words for its row (`Connected · 12 tools`, `Needs sign-in`), and a tone. Only trouble
 * (`warn`, `error`) gets a dot: the rest read fine from their words.
 */
export interface ServerStatus {
  readonly tone: "ok" | "off" | "busy" | "warn" | "error";
  readonly text: string;
}

/** A server as Settings › Integrations lists it. */
export interface ServerItem {
  /** Its name, which the address names (`?item=<name>`). */
  readonly id: string;
  readonly title: string;
  /** Muted after the title: the version the server reports. */
  readonly version?: string;
  /** An image's address for its icon; a hammer when absent. */
  readonly icon?: string;
  /** Its icon on a dark theme, when it differs from `icon`. */
  readonly iconDark?: string;
  readonly status: ServerStatus;
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
  /** What a filter matches besides its title: its command or address, its tools. */
  readonly keywords: string;
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export const statusOf = (server: McpServerStatus): ServerStatus => {
  const reached = server.tools.filter((tool) => tool.exposure !== "hidden").length;
  if (server.auth?.state === "signing-in") return { tone: "busy", text: "Signing in…" };
  switch (server.state) {
    case "connected":
      return { tone: "ok", text: `Connected · ${count(reached, "tool")}` };
    case "connecting":
      return { tone: "busy", text: "Connecting…" };
    case "failed":
      return { tone: "error", text: server.retryIn === undefined ? "Failed" : "Failed · retrying" };
    // Its tools wait on the person: as much trouble as a failure, and counted with them.
    case "needs-sign-in":
      return { tone: "error", text: "Needs sign-in" };
    case "off":
      return { tone: "off", text: server.error === undefined ? "Off" : "Off · needs attention" };
  }
};

/** The items a filter keeps: those whose title, version, status, or keywords match every word of it. */
export const filterItems = (items: readonly ServerItem[], query: string): readonly ServerItem[] =>
  query.trim() === "" ? items : items.filter((item) => matchesQuery(query, `${item.title} ${item.version ?? ""} ${item.status.text} ${item.keywords}`));

/** How many items are in trouble: the section's badge. */
export const troubled = (items: readonly ServerItem[]): number => items.filter((item) => item.status.tone === "error").length;

/** Whether the tone gets a dot on its row: only trouble does. */
export const dotted = (tone: ServerStatus["tone"]): boolean => tone === "warn" || tone === "error";
