import { describe, expect, it } from "vitest";
import { Effect, Result, Schema, Struct } from "effect";
import { configValues, describeConfig, migrateConfig, parseConfigValue, secret } from "../src/config.ts";

const Config = Schema.Struct({
  defaultModel: Schema.optional(Schema.String).annotate({ description: "Model for turns that name none" }),
  maxSteps: Schema.Int.check(Schema.isGreaterThan(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 200)))
    .annotate({ description: "Model calls per turn" }),
  port: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 65535 })).pipe(Schema.withDecodingDefaultType(Effect.sync(() => 7433))),
  ratio: Schema.optional(Schema.Number),
  theme: Schema.Literals(["system", "light", "dark"]).pipe(Schema.withDecodingDefaultType(Effect.sync(() => "system" as const))),
  token: Schema.optional(Schema.NonEmptyString).annotate({ ...secret, description: "Clients must present it" }),
  verbose: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => false))),
  include: Schema.optional(Schema.Array(Schema.String)),
  providers: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, apiKey: Schema.optional(Schema.String) }))),
  baseUrl: Schema.String,
});

describe("describeConfig", () => {
  const fields = describeConfig(Config);
  const field = (key: string) => fields.find((candidate) => candidate.key === key)!;

  it("classifies scalar fields and leaves nested ones to the file", () => {
    expect(fields.map((candidate) => [candidate.key, candidate.type])).toEqual([
      ["defaultModel", "string"],
      ["maxSteps", "integer"],
      ["port", "integer"],
      ["ratio", "number"],
      ["theme", "enum"],
      ["token", "string"],
      ["verbose", "boolean"],
      ["include", "strings"],
      ["providers", "other"],
      ["baseUrl", "string"],
    ]);
    expect(field("theme").options).toEqual(["system", "light", "dark"]);
  });

  it("keeps descriptions from property annotations, including on fields with defaults", () => {
    expect(field("defaultModel").description).toBe("Model for turns that name none");
    expect(field("maxSteps").description).toBe("Model calls per turn");
    expect(field("port").description).toBeUndefined();
  });

  it("titles fields from their keys", () => {
    expect(field("maxSteps").title).toBe("Max steps");
    expect(field("baseUrl").title).toBe("Base url");
  });

  it("reports optionality as the file sees it: a field with a default may be left out", () => {
    expect(field("maxSteps").optional).toBe(true);
    expect(field("defaultModel").optional).toBe(true);
    expect(field("baseUrl").optional).toBe(false);
  });

  it("marks secrets and never reports their defaults", () => {
    expect(field("token").secret).toBe(true);
    expect(field("maxSteps").secret).toBeUndefined();
  });

  it("finds defaults only when an empty config is valid", () => {
    expect(field("maxSteps").default).toBeUndefined();
    const optionalOnly = describeConfig(Config.mapFields(Struct.omit(["baseUrl"])));
    expect(optionalOnly.find((candidate) => candidate.key === "maxSteps")?.default).toBe(200);
    expect(optionalOnly.find((candidate) => candidate.key === "theme")?.default).toBe("system");
  });

  it("describes a config that is not a struct as having no fields", () => {
    expect(describeConfig(Schema.String)).toEqual([]);
  });
});

describe("configValues", () => {
  it("applies defaults and drops secrets and nested values", () => {
    const config = { baseUrl: "http://x", token: "hunter2", providers: [{ id: "a", apiKey: "sk" }], include: ["openai"] };
    expect(configValues(Config, config)).toEqual({
      values: { baseUrl: "http://x", maxSteps: 200, port: 7433, theme: "system", verbose: false, include: ["openai"] },
      secretsSet: ["token"],
    });
  });

  it("shows an invalid config as written", () => {
    expect(configValues(Config, { baseUrl: "http://x", maxSteps: -1 }).values).toEqual({ baseUrl: "http://x", maxSteps: -1 });
  });
});

describe("migrateConfig", () => {
  const Current = Schema.Struct({
    maxSteps: Schema.Int.check(Schema.isGreaterThan(0))
      .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 200)))
      .annotate({ description: "Model calls per turn" }),
    model: Schema.optional(Schema.String),
  });
  // An earlier version called it `steps`.
  const Migrated = migrateConfig(Current, ({ steps, ...rest }) => (steps === undefined ? rest : { maxSteps: steps, ...rest }));
  const decode = Schema.decodeUnknownResult(Migrated, { onExcessProperty: "error" });

  it("reads rows an earlier version wrote, and current ones as they are", () => {
    expect(decode({ steps: 50, model: "m" })).toEqual(Result.succeed({ maxSteps: 50, model: "m" }));
    expect(decode({ maxSteps: 70 })).toEqual(Result.succeed({ maxSteps: 70 }));
    expect(decode({})).toEqual(Result.succeed({ maxSteps: 200 }));
    // The current key wins when a row has both.
    expect(decode({ steps: 50, maxSteps: 70 })).toEqual(Result.succeed({ maxSteps: 70 }));
    expect(Result.isFailure(decode({ steps: -1 }))).toBe(true);
  });

  it("keeps the current Schema's form and values", () => {
    expect(describeConfig(Migrated)).toEqual(describeConfig(Current));
    expect(configValues(Migrated, { steps: 50 }).values).toEqual({ maxSteps: 50 });
  });
});

describe("parseConfigValue", () => {
  const fields = describeConfig(Config);
  const parse = (key: string, text: string) =>
    parseConfigValue(
      fields.find((field) => field.key === key),
      text,
    );

  it("reads text as the field's type", () => {
    expect(parse("maxSteps", " 80 ")).toEqual({ value: 80 });
    expect(parse("ratio", "0.5")).toEqual({ value: 0.5 });
    expect(parse("verbose", "on")).toEqual({ value: true });
    expect(parse("theme", "dark")).toEqual({ value: "dark" });
    expect(parse("include", "openai, anthropic,")).toEqual({ value: ["openai", "anthropic"] });
    expect(parse("defaultModel", "42")).toEqual({ value: "42" });
    expect(parse("providers", `[{"id":"a"}]`)).toEqual({ value: [{ id: "a" }] });
  });

  it("explains a value of the wrong type", () => {
    expect(parse("maxSteps", "1.5")).toEqual({ error: "maxSteps must be a whole number" });
    expect(parse("port", "x")).toEqual({ error: "port must be a number" });
    expect(parse("verbose", "maybe")).toEqual({ error: "verbose must be true or false" });
    expect(parse("theme", "blue")).toEqual({ error: "theme must be one of system, light, dark" });
    expect(parse("providers", "{")).toEqual({ error: "providers takes JSON" });
  });

  it("without a field, reads JSON when it parses and text otherwise", () => {
    expect(parseConfigValue(undefined, "12")).toEqual({ value: 12 });
    expect(parseConfigValue(undefined, "red")).toEqual({ value: "red" });
  });
});
