/**
 * Path patterns: `/users/:id/:tab?/*rest`. A segment is literal text, a
 * required `:param`, an optional `:param?` (only at the end, before a rest),
 * or a `*rest` that takes every remaining segment (only last).
 */
export type Segment =
  | { readonly kind: "static"; readonly value: string }
  | { readonly kind: "param"; readonly name: string }
  | { readonly kind: "optional"; readonly name: string }
  | { readonly kind: "rest"; readonly name: string };

export interface Pattern {
  readonly source: string;
  readonly segments: readonly Segment[];
}

/** Raw values for a pattern's names: one segment each, a rest's segments joined by `/`. */
export type RawParams = Readonly<Record<string, string>>;

/** How specific each matched segment was, in order: literal 3, param 2, filled optional 1, rest 0. */
export type Score = readonly number[];

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const parsePattern = (source: string): Pattern => {
  if (!source.startsWith("/")) throw new Error(`Route path "${source}" must start with "/"`);
  const names = new Set<string>();
  const named = (name: string) => {
    if (!NAME.test(name)) throw new Error(`Route path "${source}": "${name}" is not a valid parameter name`);
    if (names.has(name)) throw new Error(`Route path "${source}": "${name}" appears twice`);
    names.add(name);
    return name;
  };
  const parts = source.split("/").filter((part) => part !== "");
  const segments = parts.map((part, index): Segment => {
    if (part.startsWith("*")) {
      if (index !== parts.length - 1) throw new Error(`Route path "${source}": a rest segment must be last`);
      return { kind: "rest", name: named(part.slice(1)) };
    }
    if (part.startsWith(":")) {
      return part.endsWith("?") ? { kind: "optional", name: named(part.slice(1, -1)) } : { kind: "param", name: named(part.slice(1)) };
    }
    return { kind: "static", value: part };
  });
  // Optional segments are trailing: one in the middle would make `/a/b` ambiguous.
  const firstOptional = segments.findIndex((segment) => segment.kind === "optional");
  if (firstOptional !== -1 && segments.slice(firstOptional).some((segment) => segment.kind === "static" || segment.kind === "param")) {
    throw new Error(`Route path "${source}": optional segments may only be followed by optional or rest segments`);
  }
  return { source, segments };
};

/** A pathname's segments, decoded; undefined when one is malformed. Empty segments (`//`, a trailing `/`) are ignored. */
export const splitPath = (pathname: string): string[] | undefined => {
  try {
    return pathname
      .split("/")
      .filter((part) => part !== "")
      .map((part) => decodeURIComponent(part));
  } catch {
    return undefined;
  }
};

/** The pattern's raw params for these segments, and how specific the match was; undefined when it does not match. */
export const matchPattern = (pattern: Pattern, segments: readonly string[]): { readonly params: RawParams; readonly score: Score } | undefined => {
  const params: Record<string, string> = Object.create(null);
  const score: number[] = [];
  let at = 0;
  for (const segment of pattern.segments) {
    switch (segment.kind) {
      case "static":
        if (segments[at] !== segment.value) return undefined;
        score.push(3);
        at++;
        break;
      case "param":
        if (at >= segments.length) return undefined;
        params[segment.name] = segments[at]!;
        score.push(2);
        at++;
        break;
      case "optional":
        if (at < segments.length) {
          params[segment.name] = segments[at]!;
          score.push(1);
          at++;
        }
        break;
      case "rest":
        params[segment.name] = segments.slice(at).join("/");
        score.push(0);
        at = segments.length;
        break;
    }
  }
  return at === segments.length ? { params, score } : undefined;
};

/**
 * Orders two matches of one path, most specific first: segment by segment, a
 * literal beats a param beats an optional beats a rest, earlier segments
 * counting most; when one score is a prefix of the other, the shorter (the
 * one not leaning on a rest) wins. Returns a negative number when `a` wins.
 */
export const compareScores = (a: Score, b: Score): number => {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return b[index]! - a[index]!;
  }
  return a.length - b.length;
};

/** The pathname for raw params. Throws when a required one is missing, or an optional is set after an unset one. */
export const buildPath = (pattern: Pattern, params: Readonly<Record<string, string | undefined>>): string => {
  const parts: string[] = [];
  let skipped: string | undefined;
  for (const segment of pattern.segments) {
    if (segment.kind === "static") {
      parts.push(encodeURIComponent(segment.value));
      continue;
    }
    const value = Object.hasOwn(params, segment.name) ? params[segment.name] : undefined;
    if (segment.kind === "param") {
      if (value === undefined || value === "") throw new Error(`Route path "${pattern.source}": "${segment.name}" is required`);
      parts.push(encodeURIComponent(value));
    } else if (value === undefined || value === "") {
      skipped ??= segment.name;
    } else if (skipped !== undefined) {
      throw new Error(`Route path "${pattern.source}": "${segment.name}" is set but "${skipped}" before it is not`);
    } else {
      parts.push(...(segment.kind === "rest" ? value.split("/").filter((part) => part !== "") : [value]).map(encodeURIComponent));
    }
  }
  return `/${parts.join("/")}`;
};
