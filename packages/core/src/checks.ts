import { Result, Schema } from "effect";

/**
 * A `check` for `Hook.make` or `Registry.make` from a Schema: `undefined` when the value decodes as `schema`, else the
 * first line of why not. For values TypeScript never saw, from a plugin written in JavaScript.
 */
export const schemaCheck = (schema: Schema.Top): ((value: unknown) => string | undefined) => {
  const decode = Schema.decodeUnknownResult(schema as Schema.Codec<unknown, unknown>);
  return (value) => {
    const decoded = decode(value);
    return Result.isSuccess(decoded) ? undefined : (decoded.failure.message.split("\n")[0] ?? decoded.failure.message);
  };
};
