import type { PluginStatus } from "@lemma/contracts";
import { defineRoute } from "@lemma/router";
import { defineSlot } from "@lemma/web";
import { Context, Schema } from "effect";
import type { Accessor, Component, JSX } from "solid-js";

export interface SettingsService {
  /** The open section's id; undefined while settings are not the page shown. */
  readonly section: Accessor<string | undefined>;
  /**
   * Goes to a section, with `params` for it (the Plugins page's `plugin`, say);
   * without them, a section opens as it was last left. Undefined closes
   * settings, returning to where they were opened from.
   */
  readonly open: (section: string | undefined, params?: Readonly<Record<string, string>>) => void;
  /** The open section's own state in the address (`?plugin=agent&tab=faults`): strings by name. */
  readonly params: Accessor<Readonly<Record<string, string>>>;
  /** Changes some of them in place (no new history entry); undefined removes one. */
  readonly setParams: (patch: Readonly<Record<string, string | undefined>>) => void;
}

export class Settings extends Context.Service<Settings, SettingsService>()("lemma-web/Settings") {}

/** A settings section (General when absent); its search is the section's own state, as strings. */
export const SettingsRoute = defineRoute("settings", {
  path: "/settings/:section?",
  search: Schema.Record(Schema.String, Schema.String),
});

export interface SettingsSection {
  readonly title: string;
  readonly icon: Component;
  /** Shown above the section's groups while browsing it, not in search results. */
  readonly intro?: Component;
  /** Buttons beside the title. */
  readonly actions?: Component;
  /** Shown while browsing a section with no entries. */
  readonly empty?: Component;
  /** Something needing attention, shown in the nav and on the sidebar's settings button. */
  readonly badge?: Accessor<string | undefined>;
  /** Shown instead of the section's groups while browsing it, full width; its groups then only answer searches. */
  readonly body?: Component;
}

export const SettingsSections = defineSlot<SettingsSection>("settings.sections");

export interface SettingsEntry {
  /** Everything a search should match. */
  readonly text: string;
  readonly view: () => JSX.Element;
}

/** Entries in a section; groups with the same title merge, in order. */
export interface SettingsGroup {
  readonly section: string;
  readonly title?: string;
  readonly entries: Accessor<readonly SettingsEntry[]>;
}

export const SettingsGroups = defineSlot<SettingsGroup>("settings.groups");

/** A tab in the Plugins page's inspector, for the plugin selected there: Overview, Wiring, Settings, and Faults are its defaults. */
export interface PluginTab {
  /** Its label for this plugin, with a count, say; undefined leaves the tab out. */
  readonly label: (plugin: PluginStatus, kind: "host" | "web") => string | undefined;
  readonly component: Component<{ readonly plugin: PluginStatus; readonly kind: "host" | "web" }>;
}

export const PluginTabs = defineSlot<PluginTab>("plugins.tabs");

/**
 * A line of the Plugins page's summary, beside the host's facts: something
 * worth knowing before a switch or a reload restarts plugins, such as the
 * turns running. It leaves with the plugin that adds it.
 */
export interface PluginsFact {
  readonly label: string;
  /** What it says now; undefined leaves the line out. Reactive. */
  readonly value: () => string | undefined;
  /** Its tooltip. */
  readonly tip?: string;
}

export const PluginsFacts = defineSlot<PluginsFact>("plugins.facts");

/**
 * Settings sections other plugins add groups to or link to: `general` comes
 * with Settings (a replacement provides it), `keyboard` with the shortcuts page,
 * and `plugins` with the Plugins page.
 */
export const SectionIds = { general: "general", appearance: "appearance", keyboard: "keyboard", plugins: "plugins" } as const;
export * from "./config.ts";
export { SETTINGS_CONTRACT } from "./version.ts";
