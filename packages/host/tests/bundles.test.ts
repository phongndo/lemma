import { describe, expect, test } from "vitest";
import { bundleStatuses } from "../src/bundles.ts";

describe("bundleStatuses", () => {
  const definition = {
    id: "feature",
    title: "Feature",
    description: "Description",
    host: ["agent"],
    ui: ["chat"],
    defaults: { plugins: { agent: { config: { token: "secret" } } } },
  };
  const input = { bundleDefinitions: [definition], bundles: {}, bundleEnabledIn: {}, rows: {}, ui: { plugins: {}, enabledIn: {}, configIn: {} } };

  test("sanitizes definitions without exposing config defaults", () => {
    expect(bundleStatuses(input)).toEqual([
      { id: "feature", title: "Feature", description: "Description", host: ["agent"], ui: ["chat"], enabled: true, customized: false },
    ]);
    expect(JSON.stringify(bundleStatuses(input))).not.toContain("secret");
  });

  test("reports desired selection, scope, and explicit host or UI overrides", () => {
    expect(
      bundleStatuses({ ...input, bundles: { feature: { enabled: false } }, bundleEnabledIn: { feature: "project" }, rows: { agent: { enabled: true } } })[0],
    ).toMatchObject({ enabled: false, customized: true, scope: "project" });
    expect(bundleStatuses({ ...input, ui: { ...input.ui, plugins: { chat: { required: true } } } })[0]?.customized).toBe(true);
    expect(bundleStatuses({ ...input, rows: { agent: {} } })[0]?.customized).toBe(false);
    expect(bundleStatuses({ ...input, rows: { unrelated: { config: {} } } })[0]?.customized).toBe(false);
  });
});
