import { Order } from "effect";
import { createHash } from "node:crypto";
import type { CompositionInfo } from "@lemma/contracts";
import type { Composition, PluginIdentity } from "@lemma/core";

/**
 * Identifies a running plugin set. `id` is a sha256 over the sorted plugin ids,
 * their versions, and their configs as canonical JSON (object keys sorted), so
 * it is stable across processes and key order in config files. Configs come
 * from `composition`; `plugins` (usually `core.inspect` snapshots) says which
 * members actually run and with which version.
 */
export function compositionInfo(composition: Composition, plugins: readonly PluginIdentity[]): CompositionInfo {
  const members = [...plugins]
    .sort((a, b) => Order.String(a.id, b.id))
    .map((plugin) => ({ id: plugin.id, ...(plugin.version === undefined ? {} : { version: plugin.version }) }));
  const hash = createHash("sha256");
  for (const member of members) {
    hash.update(canonicalJson([member.id, member.version ?? null, composition.plugins[member.id]?.config ?? null]));
    hash.update("\n");
  }
  return { id: hash.digest("hex"), plugins: members };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => Order.String(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
