import { createContext, useContext } from "solid-js";
import type { WebPluginContext } from "./define.ts";

/*
 * Which plugin a component belongs to. A slot item is drawn (`Contained`) inside its plugin's context, so a component
 * finds the plugin that added it with `usePlugin`, wherever it is drawn: an event handler made with its `action` is that
 * plugin's, and a timer started with its `after` ends with it.
 */

/** Each running web plugin's context, by id, while it runs: set as its setup starts, removed as it stops. */
export const owners = new Map<string, WebPluginContext<unknown>>();

/**
 * The context of the plugin whose slot item is being drawn; `Contained` provides it. A plugin written against the kernel
 * directly (`slots.as`) has none, only its id, for `usePlugin` to name it.
 */
export const PluginOwner = createContext<WebPluginContext<unknown> | { readonly unowned: string }>();

/** What `Contained` provides for an item added by the plugin `id`. */
export const ownerOf = (id: string | undefined) => (id === undefined ? undefined : (owners.get(id) ?? { unowned: id }));

/**
 * The plugin whose slot item this component is drawn for: its helpers (`action`, `after`, `listen`, `task`), so what
 * the component starts is its plugin's, ends with it, and fails as its fault. Throws outside a plugin's slot item, and in
 * one of a plugin written against the kernel directly, which has no such helpers.
 *
 *   const plugin = usePlugin();
 *   <button onClick={plugin.action("save", () => save(draft()))}>Save</button>
 */
export function usePlugin(): WebPluginContext<unknown> {
  const plugin = useContext(PluginOwner);
  if (plugin === undefined) throw new Error("usePlugin() is called outside any plugin's slot item: draw the component through a slot, or pass the plugin down");
  if ("unowned" in plugin)
    throw new Error(`usePlugin() is called in an item of "${plugin.unowned}", written against the kernel directly: write it with defineWebPlugin to have one`);
  return plugin;
}
