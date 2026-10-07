import { Context } from "effect";
import { servicesOf } from "./settings.ts";

/**
 * A plugin's own services, which its handlers and observers run with,
 * whenever they were registered.
 *
 * While the plugin activates, the context it registers in is its own (what
 * it requires, and what its layers provide inside), so a registration keeps
 * what it finds there, and adds it here. Once it is active, a registration is
 * made in some piece of work's context instead (a handler's operation, a
 * caller of one of its services), which holds that work's references: who
 * asked, which trace, which plugin called. It keeps the plugin's own
 * services, collected here, and none of those.
 */
export interface OwnServices {
  /** Activation begins with `base`: what the plugin requires, its `PluginContext`, and its `Scope`. */
  readonly begin: (base: Context.Context<never>) => void;
  /** Activation is over: registrations from now on keep what was collected. */
  readonly end: () => void;
  /** What a registration made in `context` keeps. */
  readonly capture: <R>(context: Context.Context<R>) => Context.Context<R>;
}

export const makeOwnServices = (): OwnServices => {
  let activating = false;
  const own = new Map<string, unknown>();
  /** `own` as a context, made once it no longer changes. */
  let settled: Context.Context<never> | undefined;
  return {
    begin: (base) => {
      activating = true;
      for (const [key, value] of base.mapUnsafe) own.set(key, value);
    },
    end: () => {
      activating = false;
    },
    capture: <R>(context: Context.Context<R>): Context.Context<R> => {
      if (!activating) return (settled ??= Context.makeUnsafe<never>(new Map(own))) as Context.Context<R>;
      const services = servicesOf(context);
      for (const [key, value] of services.mapUnsafe) own.set(key, value);
      settled = undefined;
      return services;
    },
  };
};
