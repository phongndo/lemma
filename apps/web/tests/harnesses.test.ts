import { describe, expect, it } from "vitest";
import { NATIVE_HARNESS } from "@lemma/contracts";
import type { HarnessInfo } from "@lemma/contracts";
import { activePick, nextHarness, resolveHarness, withHarness } from "../src/model/harnesses.ts";

const harness = (id: string, models: boolean, ready = true): HarnessInfo => ({
  id,
  title: id,
  source: models ? "agent" : "acp",
  capabilities: { steer: models, models, resume: models, requests: models },
  status: ready ? { state: "ready" } : { state: "unavailable", detail: `${id} was not found on PATH` },
});
const native = harness(NATIVE_HARNESS, true);
const opencode = harness("opencode", false);
const gemini = harness("gemini", false, false);
const list = [native, gemini, opencode];

describe("resolveHarness", () => {
  it("keeps the stored harness while it is listed and ready", () => {
    expect(resolveHarness(list, "opencode")).toBe("opencode");
  });
  it("falls back to the native harness for none, an unavailable one, or one no longer listed", () => {
    expect(resolveHarness(list, undefined)).toBe(NATIVE_HARNESS);
    expect(resolveHarness(list, "gemini")).toBe(NATIVE_HARNESS);
    expect(resolveHarness(list, "codex")).toBe(NATIVE_HARNESS);
  });
  it("keeps the stored harness until the list loads", () => {
    expect(resolveHarness([], "opencode")).toBe("opencode");
  });
});

describe("activePick", () => {
  it("holds while the thread is on the harness it was picked over, and lapses once it moves", () => {
    const pick = { harness: "opencode", over: NATIVE_HARNESS };
    expect(activePick(pick, NATIVE_HARNESS)).toBe("opencode");
    expect(activePick(pick, "opencode")).toBeUndefined();
    expect(activePick(pick, "gemini")).toBeUndefined();
    expect(activePick(undefined, NATIVE_HARNESS)).toBeUndefined();
  });
});

describe("nextHarness", () => {
  const base = { current: undefined, picked: undefined, preferred: NATIVE_HARNESS, loading: false };
  it("names the preferred harness for a new thread, or one without turns, native included", () => {
    expect(nextHarness(base)).toEqual({ id: NATIVE_HARNESS, name: NATIVE_HARNESS });
    expect(nextHarness({ ...base, preferred: "opencode" })).toEqual({ id: "opencode", name: "opencode" });
    expect(nextHarness({ ...base, picked: "opencode" })).toEqual({ id: "opencode", name: "opencode" });
  });
  it("leaves a thread on its own harness to the host, whatever new threads prefer", () => {
    expect(nextHarness({ ...base, current: "opencode", preferred: NATIVE_HARNESS })).toEqual({ id: "opencode", name: undefined });
    expect(nextHarness({ ...base, current: NATIVE_HARNESS, preferred: "opencode" })).toEqual({ id: NATIVE_HARNESS, name: undefined });
  });
  it("names a harness picked over the thread's", () => {
    expect(nextHarness({ ...base, current: NATIVE_HARNESS, picked: "opencode" })).toEqual({ id: "opencode", name: "opencode" });
    expect(nextHarness({ ...base, current: "opencode", picked: "opencode" })).toEqual({ id: "opencode", name: undefined });
  });
  it("names only a pick while the thread's log loads", () => {
    expect(nextHarness({ ...base, preferred: "opencode", loading: true })).toEqual({ id: "opencode", name: undefined });
    expect(nextHarness({ ...base, picked: "opencode", loading: true })).toEqual({ id: "opencode", name: "opencode" });
  });
});

describe("withHarness", () => {
  const model = { model: "anthropic/claude-sonnet-4-5", thinking: "high" as const };
  it("keeps the model for a harness that runs on it", () => {
    expect(withHarness(model, NATIVE_HARNESS, native)).toEqual({ ...model, harness: NATIVE_HARNESS });
    expect(withHarness(model, undefined, native)).toEqual(model);
  });
  it("drops the model and reasoning for a harness on a model of its own, named or not", () => {
    expect(withHarness(model, "opencode", opencode)).toEqual({ harness: "opencode" });
    expect(withHarness(model, undefined, opencode)).toBeUndefined();
  });
  it("keeps the model while the harness is not listed", () => {
    expect(withHarness(model, "codex", undefined)).toEqual({ ...model, harness: "codex" });
    expect(withHarness(undefined, undefined, undefined)).toBeUndefined();
  });
});
