import { Connection } from "./connection.ts";
import type { Launch } from "./connection.ts";

interface Entry {
  readonly connection: Connection;
  holders: number;
}

/**
 * Connections by what they connect to, shared by the plugin instances that
 * hold them. A reload starts the new instance before it stops the old, so a
 * server whose config did not change keeps its connection (and its process,
 * and whatever state it holds) across the reload; the last holder to let go
 * closes it.
 */
const pool = new Map<string, Entry>();

/** Two servers are the same connection when their id, launch, and connect timeout are. */
export const connectionKey = (id: string, launch: Launch, startupTimeoutMs: number): string => JSON.stringify([id, launch, startupTimeoutMs]);

export interface Held {
  readonly connection: Connection;
  /** Lets go; the last holder's release closes the connection. Idempotent. */
  readonly release: () => Promise<void>;
}

/** The open connection for `key`, or a new one from `create`, started. */
export function acquire(key: string, create: () => Connection): Held {
  let entry = pool.get(key);
  if (entry === undefined) {
    entry = { connection: create(), holders: 0 };
    pool.set(key, entry);
    void entry.connection.start();
  }
  const held = entry;
  held.holders++;
  let released = false;
  return {
    connection: held.connection,
    release: async () => {
      if (released) return;
      released = true;
      held.holders--;
      if (held.holders > 0) return;
      if (pool.get(key) === held) pool.delete(key);
      await held.connection.close();
    },
  };
}

/** How many connections are open, for tests. */
export const openConnections = (): number => pool.size;
