import { defineSlot } from "@lemma/web";
import type { Accessor, Component } from "solid-js";

/*
 * Settings › Integrations lists what Lemma works with besides its own models, such as the MCP servers that give
 * it tools. Each kind of thing is an item of `IntegrationKinds`,
 * added by the plugin that runs it, which draws its own details and its own way to add one; the page only lays them
 * out, one list beside the open item.
 */

/**
 * How an item is doing: a few words for its row (`Connected · 12 tools`, `Not on PATH`), and a tone. Only trouble
 * (`warn`, `error`) gets a dot: the rest read fine from their words.
 */
export interface IntegrationStatus {
  readonly tone: "ok" | "off" | "busy" | "warn" | "error";
  readonly text: string;
}

/** One item in the list. */
export interface IntegrationItem {
  /** Unique within its kind; the address names it (`?kind=<kind>&item=<id>`). */
  readonly id: string;
  readonly title: string;
  /** Muted after the title: a version. */
  readonly version?: string;
  /** An image's address for its icon; the kind's icon when absent. */
  readonly icon?: string;
  /** Its icon on a dark theme, when it differs from `icon`. */
  readonly iconDark?: string;
  /** Draws its mark instead of `icon` (a brand's logo, in its color). */
  readonly logo?: Component;
  readonly status: IntegrationStatus;
  /** Whether it is on, with a switch on its row (`setEnabled`); neither: no switch. */
  readonly enabled?: boolean;
  readonly setEnabled?: (enabled: boolean) => void;
  /** What a search matches besides its title: its command, its tools. */
  readonly keywords?: string;
}

export interface IntegrationDetailProps {
  readonly id: string;
  /** Closes the details (once the item is removed, say). */
  readonly close: () => void;
}

export interface IntegrationAddProps {
  /** It was added: the page opens it. */
  readonly added: (id: string) => void;
  readonly cancel: () => void;
}

/** Something a kind offers to add in one pick: a server Lemma knows, one from a registry. */
export interface IntegrationOffer {
  /** Unique among the kind's offers. */
  readonly id: string;
  readonly title: string;
  /** A few words under its title. */
  readonly description?: string;
  /** An image's address for its icon; the kind's icon when absent. */
  readonly icon?: string;
  /** Draws its mark instead of `icon`. */
  readonly logo?: Component;
  /** What a search matches besides its title and description. */
  readonly keywords?: string;
  /** The item it is, once added: picking it opens that item. */
  readonly added?: string;
  /** Why it cannot be added from here (`Needs uvx`): it is listed, but cannot be picked. */
  readonly unavailable?: string;
  /** Adds it, answering the new item's id, which the page opens. */
  readonly add: () => Promise<string>;
}

/** What a kind offers to add while the Add dialog is open. */
export interface IntegrationCatalog {
  readonly offers: Accessor<readonly IntegrationOffer[]>;
  /** More are being read (a registry): the list says so after the offers it has. */
  readonly loading?: Accessor<boolean>;
  /** Why some could not be read, after the offers. */
  readonly problem?: Accessor<string | undefined>;
}

/** A kind of integration: its heading in the list, its items, an item's details, and adding one. */
export interface IntegrationKind {
  /** The list's heading: `Agents`, `MCP servers`. */
  readonly title: string;
  readonly icon: Component;
  readonly items: Accessor<readonly IntegrationItem[]>;
  /** Its items have arrived; until then the list says it is loading them. */
  readonly loaded: Accessor<boolean>;
  /** What is wrong with the kind as a whole (its file cannot be read), shown above its items. */
  readonly problem?: Accessor<string | undefined>;
  /** One item's details, beside the list: its state, settings, and actions. */
  readonly detail: Component<IntegrationDetailProps>;
  /**
   * What it offers to add in one pick, in the Add dialog. Called as the dialog opens, inside it: what it reads (a
   * registry) is read then, and dropped as it closes.
   */
  readonly catalog?: () => IntegrationCatalog;
  /**
   * Adding one it does not offer, after its offers in the Add dialog: the row's label (`Custom MCP server`), a few words
   * under it, and the form it opens.
   */
  readonly add?: { readonly label: string; readonly description?: string; readonly component: Component<IntegrationAddProps> };
}

/**
 * The classes the page styles, which a kind's details and forms are drawn with so every kind reads alike:
 * `integration-head` (its icon in `integration-icon`, its title and status in `integration-head-text`, with an `h2`),
 * `integration-actions` (a row of buttons), `integration-section` (a part of the details, its `h3` heading),
 * `integration-field` (a label above a `.field`), `integration-hint`, `integration-kv` (name and value rows, with a
 * remove button each), `integration-code` (a command line, a file's text), `integration-error`, and
 * `integration-buttons` (a form's Cancel and Save).
 */
export const DetailClasses = [
  "integration-head",
  "integration-icon",
  "integration-head-text",
  "integration-actions",
  "integration-section",
  "integration-field",
  "integration-hint",
  "integration-kv",
  "integration-code",
  "integration-error",
  "integration-buttons",
] as const;

/** The kinds Settings › Integrations lists, in order: the MCP servers' (order 20) among them. The item's id is the kind's. */
export const IntegrationKinds = defineSlot<IntegrationKind>("integrations.kinds");

/**
 * Settings › Integrations' section id, for `Settings.open`. Its params: `kind` and `item` open an item, `add` opens the
 * Add dialog: `all` on every kind's offers, a kind's id on that kind's.
 */
export const IntegrationsSection = "integrations";
export { INTEGRATIONS_CONTRACT } from "./version.ts";
