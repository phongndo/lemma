import { describe, expect, it } from "vitest";
import { Option, Result, Schema } from "effect";
import { describeConfig } from "@lemma/contracts";
import { UiSchema as S } from "../src/ui/schema.ts";

const decodes = (schema: Schema.Codec<any, any>, input: unknown) => Result.isSuccess(Schema.decodeUnknownResult(schema)(input));
const decode = (schema: Schema.Codec<any, any>, input: unknown) => Schema.decodeUnknownSync(schema)(input);

describe("api.Schema keeps the forms Effect 3 gave its members", () => {
  it("a config declared as for Effect 3, with .annotations and propertySignature, still makes its form", () => {
    // How a UI file (plain JavaScript) written for Effect 3 calls it: the method is not in Effect 4's types.
    const v3 = <T extends Schema.Top>(schema: T) => schema as T & { annotations(annotations: Schema.Annotations.Annotations): T };
    const config = S.Struct({
      greeting: v3(S.optional(S.String)).annotations({ title: "Greeting", description: "What to say" }),
      name: v3(S.propertySignature(S.String)).annotations({ description: "Who to greet" }),
      size: v3(S.Int.pipe(S.between(1, 10))).annotations({ title: "Size" }),
    });
    expect(describeConfig(config).map(({ key, title, description }) => ({ key, title, description }))).toEqual([
      { key: "greeting", title: "Greeting", description: "What to say" },
      { key: "name", title: "Name", description: "Who to greet" },
      { key: "size", title: "Size", description: undefined },
    ]);
  });

  it("Literal takes one literal or a union of several", () => {
    expect(decodes(S.Literal("x"), "x")).toBe(true);
    expect(decodes(S.Literal("enter", "mod+enter"), "mod+enter")).toBe(true);
    expect(decodes(S.Literal("enter", "mod+enter"), "space")).toBe(false);
  });

  it("Record takes its key and value as two arguments or as { key, value }", () => {
    for (const record of [S.Record(S.String, S.Number), S.Record({ key: S.String, value: S.Number })]) {
      expect(decode(record, { a: 1 })).toEqual({ a: 1 });
      expect(decodes(record, { a: "1" })).toBe(false);
    }
  });

  it("between, positive, and nonNegative refine a number", () => {
    const size = S.Int.pipe(S.between(1, 10));
    expect([1, 10].map((value) => decodes(size, value))).toEqual([true, true]);
    expect([0, 11, 1.5].map((value) => decodes(size, value))).toEqual([false, false, false]);
    expect([1, 0].map((value) => decodes(S.Number.pipe(S.positive()), value))).toEqual([true, false]);
    expect([0, -1].map((value) => decodes(S.Number.pipe(S.nonNegative()), value))).toEqual([true, false]);
  });

  it("NumberFromString fails on text that is not a number", () => {
    expect(decode(S.NumberFromString, "4")).toBe(4);
    expect(decodes(S.NumberFromString, "four")).toBe(false);
  });

  it("optionalWith gives a default to a field left out, and exact refuses undefined", () => {
    const Config = S.Struct({
      size: S.optionalWith(S.Number, { default: () => 3 }),
      name: S.optionalWith(S.String, { exact: true }),
      mode: S.optionalWith(S.Literal("a", "b"), { exact: true, default: () => "a" as const }),
    });
    expect(decode(Config, {})).toEqual({ size: 3, mode: "a" });
    expect(decode(Config, { size: undefined, name: "n", mode: "b" })).toEqual({ size: 3, name: "n", mode: "b" });
    expect(decodes(Config, { name: undefined })).toBe(false);
    expect(decodes(Config, { mode: undefined })).toBe(false);
  });

  it("optionalWith's nullable and Option fields read and write as Effect 3's did", () => {
    const fails = Symbol("fails");
    const N = S.NumberFromString;
    // Each field `a`: what a config decodes to (or `fails`), then what a decoded value encodes to.
    const cases: [string, Schema.Codec<any, any>, [unknown, unknown][], [unknown, unknown][]][] = [
      [
        "nullable",
        S.optionalWith(N, { nullable: true }),
        [
          [{}, {}],
          [{ a: undefined }, { a: undefined }],
          [{ a: null }, {}],
          [{ a: "1" }, { a: 1 }],
        ],
        [
          [{}, {}],
          [{ a: undefined }, { a: undefined }],
          [{ a: 1 }, { a: "1" }],
        ],
      ],
      [
        "exact, nullable",
        S.optionalWith(N, { exact: true, nullable: true }),
        [
          [{}, {}],
          [{ a: undefined }, fails],
          [{ a: null }, {}],
          [{ a: "1" }, { a: 1 }],
        ],
        [
          [{}, {}],
          [{ a: 1 }, { a: "1" }],
        ],
      ],
      [
        "nullable, default",
        S.optionalWith(N, { nullable: true, default: () => 0 }),
        [
          [{}, { a: 0 }],
          [{ a: undefined }, { a: 0 }],
          [{ a: null }, { a: 0 }],
          [{ a: "1" }, { a: 1 }],
        ],
        [[{ a: 1 }, { a: "1" }]],
      ],
      [
        "exact, nullable, default",
        S.optionalWith(N, { exact: true, nullable: true, default: () => 0 }),
        [
          [{}, { a: 0 }],
          [{ a: undefined }, fails],
          [{ a: null }, { a: 0 }],
          [{ a: "1" }, { a: 1 }],
        ],
        [[{ a: 1 }, { a: "1" }]],
      ],
      [
        "Option",
        S.optionalWith(N, { as: "Option" }),
        [
          [{}, { a: Option.none() }],
          [{ a: undefined }, { a: Option.none() }],
          [{ a: null }, fails],
          [{ a: "1" }, { a: Option.some(1) }],
        ],
        [
          [{ a: Option.none() }, {}],
          [{ a: Option.some(1) }, { a: "1" }],
        ],
      ],
      [
        "exact, Option",
        S.optionalWith(N, { exact: true, as: "Option" }),
        [
          [{}, { a: Option.none() }],
          [{ a: undefined }, fails],
          [{ a: "1" }, { a: Option.some(1) }],
        ],
        [
          [{ a: Option.none() }, {}],
          [{ a: Option.some(1) }, { a: "1" }],
        ],
      ],
      [
        "nullable, Option",
        S.optionalWith(N, { nullable: true, as: "Option" }),
        [
          [{}, { a: Option.none() }],
          [{ a: undefined }, { a: Option.none() }],
          [{ a: null }, { a: Option.none() }],
          [{ a: "1" }, { a: Option.some(1) }],
        ],
        [
          [{ a: Option.none() }, {}],
          [{ a: Option.some(1) }, { a: "1" }],
        ],
      ],
      [
        "exact, nullable, Option",
        S.optionalWith(N, { exact: true, nullable: true, as: "Option" }),
        [
          [{}, { a: Option.none() }],
          [{ a: undefined }, fails],
          [{ a: null }, { a: Option.none() }],
        ],
        [[{ a: Option.none() }, {}]],
      ],
      [
        "nullable, Option, None as null",
        S.optionalWith(N, { nullable: true, as: "Option", onNoneEncoding: () => Option.some(null) }),
        [[{ a: null }, { a: Option.none() }]],
        [[{ a: Option.none() }, { a: null }]],
      ],
    ];
    for (const [name, field, decoded, encoded] of cases) {
      const Config = S.Struct({ a: field });
      for (const [input, output] of decoded) {
        if (output === fails) expect(decodes(Config, input), `${name}: ${JSON.stringify(input)}`).toBe(false);
        else expect(decode(Config, input), `${name}: ${JSON.stringify(input)}`).toStrictEqual(output);
      }
      for (const [input, output] of encoded) expect(Schema.encodeSync(Config)(input as never), `${name}: encode`).toStrictEqual(output);
    }
  });

  it("a config made of them becomes a settings form", () => {
    const Config = S.Struct({
      send: S.optionalWith(S.Literal("enter", "mod+enter"), { default: () => "enter" as const }).annotate({
        title: "Send with",
        description: "Which key sends.",
      }),
      limit: S.optionalWith(S.Int.pipe(S.between(1, 100)), { default: () => 50 }),
    });
    expect(describeConfig(Config)).toEqual([
      { key: "send", title: "Send with", description: "Which key sends.", type: "enum", options: ["enter", "mod+enter"], optional: true, default: "enter" },
      { key: "limit", title: "Limit", type: "integer", optional: true, default: 50 },
    ]);
  });
});
