import type { WebPluginContext } from "@lemma/web";
import { load, save } from "@lemma/web/storage";

/** What of the plugin's handle its parts run on: what they listen to and wait for ends with the plugin. */
export type Handle = Pick<WebPluginContext<unknown>, "listen" | "after" | "onCleanup">;

/** The record `text` holds, as far as `is` reads it: empty when there is none, it is not JSON, or it has another shape. */
const recordIn = <A>(text: string | null | undefined, is: (value: unknown) => value is Record<string, A>): Record<string, A> => {
  try {
    const value: unknown = JSON.parse(text ?? "{}");
    return is(value) ? { ...value } : {};
  } catch {
    return {};
  }
};

/** A record the browser's tabs share in its storage (`sharedRecord`). */
export interface SharedRecord<A> {
  /** What storage holds now. */
  readonly read: () => Record<string, A>;
  /** Writes what `change` makes of what storage holds now, so what another tab wrote since stays; empty, it is removed. */
  readonly write: (change: (record: Record<string, A>) => Record<string, A>) => void;
}

/**
 * A record kept under `key` in the browser's storage, which its tabs share, its entries as far as `is` reads them.
 * Another tab's write arrives as `changed`, with what storage held before it.
 */
export const sharedRecord = <A>(
  plugin: Handle,
  key: string,
  is: (value: unknown) => value is Record<string, A>,
  changed: (after: Record<string, A>, before: Record<string, A>) => void,
): SharedRecord<A> => {
  plugin.listen(window, "storage", (event: StorageEvent) => {
    if (event.key === key) changed(recordIn(event.newValue, is), recordIn(event.oldValue, is));
  });
  return {
    read: () => recordIn(load(key), is),
    write: (change) => {
      const next = change(recordIn(load(key), is));
      save(key, Object.keys(next).length === 0 ? undefined : JSON.stringify(next));
    },
  };
};
