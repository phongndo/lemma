import type { SpanRecord } from "@lemma/contracts";

/** A span with the spans under it, in the order they started. */
export interface SpanNode {
  readonly span: SpanRecord;
  readonly children: SpanNode[];
  /** Its own time: what no span under it accounts for. */
  self: number;
}

/**
 * The spans as trees, the roots in the order they started: a span whose parent the trace did not keep (it ended too
 * long ago, or is still running) is a root.
 */
export function forest(spans: readonly SpanRecord[]): SpanNode[] {
  const nodes = new Map(spans.map((span) => [span.id, { span, children: [] as SpanNode[], self: span.ms }]));
  const roots: SpanNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.span.parentId === undefined ? undefined : nodes.get(node.span.parentId);
    if (parent === undefined) roots.push(node);
    else {
      parent.children.push(node);
      parent.self -= node.span.ms;
    }
  }
  const byStart = (a: SpanNode, b: SpanNode) => a.span.start - b.span.start;
  for (const node of nodes.values()) {
    node.self = Math.max(0, node.self);
    node.children.sort(byStart);
  }
  return roots.sort(byStart);
}

/** `node` and the spans under it, depth first, each with its depth below `node`. */
export function flatten(node: SpanNode): { readonly node: SpanNode; readonly depth: number }[] {
  const rows: { node: SpanNode; depth: number }[] = [];
  const visit = (at: SpanNode, depth: number) => {
    rows.push({ node: at, depth });
    for (const child of at.children) visit(child, depth + 1);
  };
  visit(node, 0);
  return rows;
}

/** Whether `node` or a span under it is one `matches` picks. */
export const contains = (node: SpanNode, matches: (span: SpanRecord) => boolean): boolean =>
  matches(node.span) || node.children.some((child) => contains(child, matches));

/** What one plugin's spans cost: how many, their time in all and their own, the slowest, and how many failed. */
export interface PluginProfile {
  readonly plugin: string;
  readonly spans: number;
  readonly total: number;
  readonly self: number;
  readonly p95: number;
  readonly max: number;
  readonly slowest: string;
  readonly errors: number;
}

const percentile = (sorted: readonly number[], p: number) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!);

/** Each plugin's profile over `nodes` (every node, not only roots), the costliest by own time first. */
export function profile(nodes: readonly SpanNode[]): PluginProfile[] {
  const byPlugin = new Map<string, SpanNode[]>();
  const visit = (node: SpanNode) => {
    const plugin = node.span.attributes["plugin.id"];
    if (typeof plugin === "string") {
      const own = byPlugin.get(plugin);
      if (own === undefined) byPlugin.set(plugin, [node]);
      else own.push(node);
    }
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return [...byPlugin]
    .map(([plugin, own]): PluginProfile => {
      const times = own.map((node) => node.span.ms).sort((a, b) => a - b);
      const slowest = own.reduce((worst, node) => (node.span.ms > worst.span.ms ? node : worst), own[0]!);
      return {
        plugin,
        spans: own.length,
        total: times.reduce((sum, ms) => sum + ms, 0),
        self: own.reduce((sum, node) => sum + node.self, 0),
        p95: percentile(times, 0.95),
        max: times.at(-1) ?? 0,
        slowest: slowest.span.name,
        errors: own.filter((node) => node.span.status === "error").length,
      };
    })
    .sort((a, b) => b.self - a.self);
}
