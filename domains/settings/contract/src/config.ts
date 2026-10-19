import { createSignal } from "solid-js";
import type { NotifyService, PluginsService } from "@lemma/web";

export interface ConfigSetting<T> {
  /** The value its plugin runs with (the field's default while unset), or the one just set until the plugin has it; undefined while no plugin has the id. */
  readonly value: () => T | undefined;
  /** Writes it to the file that sets the plugin's config; the field's default is written as unset. Failures are reported. */
  readonly set: (value: T) => void;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A field of a plugin's config as one setting, for a row in a settings section to edit, as the Plugins page's form
 * would: `plugins` is `WebPlugins` for a web half's config, or `HostPlugins` for a host half's. Writing restarts the
 * plugin. Writing the field's default unsets it, so the config file keeps only what was changed. Call it in a plugin's
 * setup, which owns what it shows while a write is under way.
 */
export const configSetting = <T>(plugins: PluginsService, notify: NotifyService, id: string, key: string): ConfigSetting<T> => {
  const row = () => plugins.list().find((plugin) => plugin.id === id);
  const field = () => row()?.configFields?.find((candidate) => candidate.key === key);
  const [pending, setPending] = createSignal<{ readonly value: T }>();
  const running = (): T | undefined => {
    const found = row();
    if (found === undefined) return undefined;
    const value = found.config?.values[key];
    return (value === undefined ? field()?.default : value) as T | undefined;
  };
  const shown = (): T | undefined => {
    const wanted = pending();
    return wanted === undefined || same(wanted.value, running()) ? running() : wanted.value;
  };
  return {
    value: shown,
    set: (value) => {
      const found = row();
      // Against what shows: the running value written back while another write settles is a write of its own.
      if (found === undefined || same(value, shown())) return;
      const fallback = field()?.default;
      const mine = { value };
      setPending(mine);
      // A later write keeps showing its own value.
      const settle = () => setPending((now) => (now === mine ? undefined : now));
      plugins.setConfig(found, { [key]: fallback !== undefined && same(value, fallback) ? null : value }).then(settle, (error: unknown) => {
        settle();
        notify.report(error, `Could not change ${field()?.title ?? key}`);
      });
    },
  };
};
