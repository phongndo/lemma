import type { SpanRecord } from "@lemma/contracts";

/*
 * The Trace panel's filter: words, each narrowing what shows.
 *
 *   plugin:tools          a plugin, or a domain's plugins (`tools.bash`, `tools.registry`)
 *   session:4f2a  turn:2  step:3  tool:bash  hook:agent.request
 *   name:core.hook  status:error  slow:>5ms
 *   -plugin:transport     any of them negated
 *   anything else         in the span's name or any attribute's value
 *
 * `turn:N` is the Nth turn the trace kept (by when it started), `step:N` a step's index in its turn; an id, or the
 * start of one, works for both, as for a session or a tool call.
 */

type Term =
  | { readonly kind: "key"; readonly key: string; readonly value: string }
  | { readonly kind: "slow"; readonly ms: number }
  | { readonly kind: "text"; readonly value: string };

export interface Query {
  readonly terms: readonly { readonly term: Term; readonly negated: boolean }[];
}

const KEYS = new Set(["plugin", "session", "turn", "step", "tool", "hook", "name", "status"]);

export const parseQuery = (text: string): Query => ({
  terms: text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const negated = word.startsWith("-") && word.length > 1;
      const bare = negated ? word.slice(1) : word;
      const colon = bare.indexOf(":");
      const key = colon > 0 ? bare.slice(0, colon).toLowerCase() : "";
      const value = colon > 0 ? bare.slice(colon + 1) : bare;
      if (key === "slow" || key === "ms") {
        const ms = Number.parseFloat(value.replace(/^>=?/, "").replace(/ms$/, ""));
        if (Number.isFinite(ms)) return { term: { kind: "slow", ms } as const, negated };
      }
      if (KEYS.has(key) && value !== "") return { term: { kind: "key", key, value } as const, negated };
      return { term: { kind: "text", value: bare.toLowerCase() } as const, negated };
    }),
});

/** What numbers turns: each kept turn's id, by when it started. */
export const turnOrder = (spans: readonly SpanRecord[]): ReadonlyMap<string, number> => {
  const turns = spans.filter((span) => span.name === "agent.turn" && typeof span.attributes["turn.id"] === "string").sort((a, b) => a.start - b.start);
  return new Map(turns.map((span, index) => [span.attributes["turn.id"] as string, index + 1]));
};

const text = (value: unknown) => (value === undefined ? undefined : String(value));
const startsWith = (value: unknown, prefix: string) => text(value)?.startsWith(prefix) === true;

const matchesKey = (span: SpanRecord, key: string, value: string, turns: ReadonlyMap<string, number>): boolean => {
  const attributes = span.attributes;
  switch (key) {
    case "plugin": {
      const plugin = text(attributes["plugin.id"]);
      return plugin !== undefined && (plugin === value || plugin.startsWith(`${value}.`));
    }
    case "session":
      return startsWith(attributes["session.id"], value);
    case "turn": {
      const id = text(attributes["turn.id"]);
      if (id === undefined) return false;
      return /^\d+$/.test(value) ? turns.get(id) === Number(value) : id.startsWith(value);
    }
    case "step":
      return /^\d+$/.test(value) ? attributes["step.index"] === Number(value) : startsWith(attributes["step.id"], value);
    case "tool":
      return attributes["tool.name"] === value || startsWith(attributes["tool.call.id"], value);
    case "hook":
      return text(attributes["hook.name"])?.includes(value) === true;
    case "name":
      return span.name.includes(value);
    case "status":
      return span.status === value;
    default:
      return false;
  }
};

/** Whether `span` matches every term of `query`; `turns` numbers the kept turns (`turnOrder`). */
export const matcher =
  (query: Query, turns: ReadonlyMap<string, number>) =>
  (span: SpanRecord): boolean =>
    query.terms.every(({ term, negated }) => {
      const found =
        term.kind === "slow"
          ? span.ms >= term.ms
          : term.kind === "key"
            ? matchesKey(span, term.key, term.value, turns)
            : span.name.toLowerCase().includes(term.value) || Object.values(span.attributes).some((value) => String(value).toLowerCase().includes(term.value));
      return found !== negated;
    });
