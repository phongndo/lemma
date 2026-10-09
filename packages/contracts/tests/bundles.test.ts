import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { BundleManifest, BundleStatus, ConfigFile, UiComposition } from "../src/runtime.ts";

describe("bundle contracts", () => {
  const manifest = {
    id: "writing",
    title: "Writing",
    host: ["writer"],
    ui: ["editor"],
    enabledByDefault: true,
    defaults: { plugins: { writer: { config: { token: "private" } } } },
  };

  test("decodes bundle definitions and overrides alongside existing plugin rows", () => {
    expect(Schema.decodeUnknownSync(BundleManifest)(manifest)).toEqual(manifest);
    const config = { bundles: { writing: { enabled: false } }, bundleDefinitions: [manifest], plugins: { writer: { enabled: true } } };
    expect(Schema.decodeUnknownSync(ConfigFile)(config)).toEqual(config);
    expect(() => Schema.decodeUnknownSync(ConfigFile)({ bundles: { writing: { enabled: "no" } } })).toThrow();
  });

  test("excludes raw defaults from public status and accepts legacy UI compositions", () => {
    const status = { id: "writing", title: "Writing", host: ["writer"], ui: ["editor"], enabled: true, customized: false, scope: "user" };
    expect(Schema.decodeUnknownSync(BundleStatus)({ ...manifest, ...status })).toEqual(status);
    const legacy = { plugins: {}, enabledIn: {}, configIn: {}, files: [] };
    expect(Schema.decodeUnknownSync(UiComposition)(legacy)).toEqual(legacy);
    expect(Schema.decodeUnknownSync(UiComposition)({ ...legacy, bundles: [status] })).toEqual({ ...legacy, bundles: [status] });
  });
});
