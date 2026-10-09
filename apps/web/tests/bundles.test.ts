import { describe, expect, it } from "vitest";
import type { BundleStatus, PluginStatus } from "@lemma/contracts/runtime";
import { bundleState } from "../src/model/bundles.ts";

const plugin = (id: string, extra: Partial<PluginStatus> = {}): PluginStatus => ({
  id,
  source: "bundled",
  enabled: true,
  state: "active",
  provides: [],
  requires: [],
  ...extra,
});
const bundle: BundleStatus = { id: "tools", title: "Tools", host: ["tools"], ui: ["tools"], enabled: true, customized: false };

describe("bundleState", () => {
  it("requires members from both runtimes, distinguishing identical ids", () => {
    expect(bundleState(bundle, [plugin("tools")], []).missing).toEqual(["web:tools"]);
    expect(bundleState(bundle, [], [plugin("tools")]).label).toBe("Incomplete");
    expect(bundleState(bundle, [plugin("tools")], [plugin("tools")])).toEqual({ label: "On", missing: [] });
  });
  it("keeps desired selection separate from disabled, failed, halted and unknown members", () => {
    for (const extra of [{ enabled: false }, { state: "disabled" }, { state: "failed" }, { problem: "Unknown plugin" }] as Partial<PluginStatus>[]) {
      expect(bundleState(bundle, [plugin("tools", extra)], [plugin("tools")]).label).toBe("Incomplete");
    }
    expect(bundleState(bundle, [], []).missing).toEqual(["host:tools", "web:tools"]);
  });
  it("does not infer selection or customization from shared active members", () => {
    expect(bundleState({ ...bundle, enabled: false, customized: true }, [plugin("tools")], [plugin("tools")]).label).toBe("Off");
    expect(bundleState({ ...bundle, customized: true }, [plugin("tools")], [plugin("tools")]).label).toBe("On");
  });
  it("reports rejected UI reconciliation for either desired selection, independently of active shared members", () => {
    for (const enabled of [true, false]) {
      expect(bundleState({ ...bundle, enabled }, [plugin("tools")], [plugin("tools")], false).label).toBe("UI not applied");
    }
    expect(bundleState({ ...bundle, enabled: false }, [plugin("tools")], [plugin("tools")], true).label).toBe("Off");
  });
  it("allows host-only and UI-only bundles", () => {
    expect(bundleState({ ...bundle, ui: [] }, [plugin("tools")], []).label).toBe("On");
    expect(bundleState({ ...bundle, host: [] }, [], [plugin("tools")]).label).toBe("On");
  });
});
