import { Result, Schema, SchemaAST } from "effect";
import { buildPath, parsePattern } from "./path.ts";
import type { Pattern, RawParams } from "./path.ts";
import { stringifySearch } from "./search.ts";
import type { RawSearch } from "./search.ts";

/** What a params or search Schema decodes from: the URL's strings by name. */
export type Encoded = { readonly [key: string]: string | undefined };

type Simplify<T> = { readonly [K in keyof T]: T[K] } & {};
type SegmentParams<S extends string> = S extends `:${infer Name}?`
  ? { readonly [K in Name]?: string }
  : S extends `:${infer Name}`
    ? { readonly [K in Name]: string }
    : S extends `*${infer Name}`
      ? { readonly [K in Name]: string }
      : {};
type WalkPath<P extends string> = P extends `${infer Head}/${infer Tail}` ? SegmentParams<Head> & WalkPath<Tail> : SegmentParams<P>;

/**
 * The params a path names, as strings: `"/users/:id/:tab?"` is
 * `{ id: string; tab?: string }`. A path only known as `string` names any.
 */
export type PathParams<P extends string> = string extends P ? Readonly<Record<string, string>> : Simplify<WalkPath<P>>;

/**
 * A params Schema checked against the path at compile time: its URL side must
 * have exactly the path's names (so a renamed segment or field is an error
 * here, not a route that silently never matches).
 */
type CheckParams<P extends string, I> = string extends P
  ? unknown
  : [Exclude<keyof I, keyof PathParams<P>>] extends [never]
    ? [Exclude<keyof PathParams<P>, keyof I>] extends [never]
      ? unknown
      : { readonly "path params missing from the params Schema": Exclude<keyof PathParams<P>, keyof I> }
    : { readonly "params Schema fields the path does not name": Exclude<keyof I, keyof PathParams<P>> };

/**
 * An address: a path pattern and the Schemas its params and search decode
 * through, both ways, so a URL reads as typed values and typed values write
 * back as a URL. It names no component: what shows at the address is whatever
 * is registered for it, so a link to a route works while nothing renders it.
 */
export interface Route<Params = unknown, Search = unknown> {
  readonly id: string;
  readonly path: string;
  readonly pattern: Pattern;
  readonly params: Schema.Codec<Params, any>;
  readonly search: Schema.Codec<Search, any>;
  /** The search a URL without one decodes to, when every key has a default or is optional. */
  readonly defaults: Search | undefined;
  /** Typed params from the URL's; a failure with the reason when they do not decode. */
  readonly decodeParams: (raw: RawParams) => Result.Result<Params, string>;
  /** Typed search from the URL's; a failure with the reason when it does not decode. */
  readonly decodeSearch: (raw: RawSearch) => Result.Result<Search, string>;
  /** `/path?search` for these values. Search keys equal to their defaults are left out. Throws a `RouteError` when a value does not encode. */
  readonly href: (params: Params, search?: Partial<Search>) => string;
}

export type AnyRoute = Route<any, any>;
export type ParamsOf<R> = R extends Route<infer P, any> ? P : never;
export type SearchOf<R> = R extends Route<any, infer S> ? S : never;

export interface RouteOptions<P extends string, Params, ParamsEncoded extends Encoded, Search, SearchEncoded extends Encoded> {
  /** `/users/:id/:tab?`; see `parsePattern`. */
  readonly path: P;
  /** Decodes the path's params from their strings; its fields are the path's names. Without one they are the strings. */
  readonly params?: Schema.Codec<Params, ParamsEncoded> & CheckParams<P, ParamsEncoded>;
  /** Decodes the query string from its strings; without one the route takes none. Unknown keys are ignored. */
  readonly search?: Schema.Codec<Search, SearchEncoded>;
}

/** A route defined wrongly, or values its Schemas do not encode: a mistake in the code, named by the route's id. */
export class RouteError extends Error {
  readonly routeId: string;
  constructor(routeId: string, message: string) {
    super(`Route "${routeId}": ${message}`);
    this.name = "RouteError";
    this.routeId = routeId;
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const strings = Schema.Record(Schema.String, Schema.String);

/** The URL side's fields of a Struct-like Schema, or undefined for any other (a record takes any names). */
const fieldsOf = (schema: Schema.Codec<any, any>): readonly { readonly name: string; readonly optional: boolean }[] | undefined => {
  const ast = Schema.toEncoded(schema).ast;
  if (!SchemaAST.isObjects(ast) || ast.indexSignatures.length > 0) return undefined;
  return ast.propertySignatures.map((field) => ({ name: String(field.name), optional: SchemaAST.isOptional(field.type) }));
};

/** The checks the types make, again at runtime, for routes whose path is only known as a `string`. */
const checkParams = (id: string, pattern: Pattern, schema: Schema.Codec<any, any>) => {
  const fields = fieldsOf(schema);
  if (fields === undefined) return;
  const named = new Map(pattern.segments.flatMap((segment) => (segment.kind === "static" ? [] : [[segment.name, segment.kind] as const])));
  for (const field of fields) {
    const kind = named.get(field.name);
    if (kind === undefined) throw new RouteError(id, `the params Schema has "${field.name}", which the path "${pattern.source}" does not name`);
    if (kind === "optional" && !field.optional)
      throw new RouteError(id, `"${field.name}" is optional in the path but required by the params Schema, so an address without it never matches`);
  }
  for (const name of named.keys()) {
    if (!fields.some((field) => field.name === name)) throw new RouteError(id, `the path names "${name}", which the params Schema does not have`);
  }
};

/**
 * Defines a route. `id` names it for registration and overrides. Params are
 * the path's names as strings, or what `params` decodes them to; a Schema
 * whose fields differ from the path's names is an error, at compile time for a
 * literal path and here otherwise.
 */
export function defineRoute<
  const P extends string,
  Params = PathParams<P>,
  ParamsEncoded extends Encoded = Encoded,
  Search = {},
  SearchEncoded extends Encoded = Encoded,
>(id: string, options: RouteOptions<P, Params, ParamsEncoded, Search, SearchEncoded>): Route<Params, Search> {
  let pattern: Pattern;
  try {
    pattern = parsePattern(options.path);
  } catch (error) {
    throw new RouteError(id, message(error));
  }
  const params = (options.params ?? strings) as Schema.Codec<Params, any>;
  const search = (options.search ?? Schema.Struct({})) as Schema.Codec<Search, any>;
  checkParams(id, pattern, params);
  const decodeParams = Schema.decodeUnknownResult(params);
  const encodeParams = Schema.encodeResult(params);
  const decodeSearch = Schema.decodeUnknownResult(search);
  const encodeSearch = Schema.encodeResult(search);
  const defaults = Result.getOrUndefined(decodeSearch({}));
  const encodedDefaults: Encoded = defaults === undefined ? {} : Result.getOrElse(encodeSearch(defaults), () => ({}));

  const href = (values: Params, partial?: Partial<Search>): string => {
    const rawParams = encodeParams(values).pipe(Result.getOrThrowWith((error) => new RouteError(id, `params do not encode: ${error.message}`)));
    const full = { ...defaults, ...partial } as Search;
    const rawSearch = encodeSearch(full).pipe(Result.getOrThrowWith((error) => new RouteError(id, `search does not encode: ${error.message}`))) as Encoded;
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawSearch)) {
      if (value !== undefined && value !== encodedDefaults[key]) kept[key] = value;
    }
    let path: string;
    try {
      path = buildPath(pattern, rawParams as Encoded);
    } catch (error) {
      throw new RouteError(id, message(error));
    }
    return `${path}${stringifySearch(kept)}`;
  };

  return {
    id,
    path: options.path,
    pattern,
    params,
    search,
    defaults,
    decodeParams: (raw) => Result.mapError(decodeParams(raw), message),
    decodeSearch: (raw) => Result.mapError(decodeSearch(raw), message),
    href,
  };
}
