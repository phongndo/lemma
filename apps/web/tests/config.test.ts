import { describe, expect, it } from "vitest";
import type { ConfigField } from "@lemma/contracts";
import { configEdit, configText } from "../src/model/config.ts";

const field = (key: string, type: ConfigField["type"], extra: Partial<ConfigField> = {}): ConfigField => ({ key, title: key, type, optional: true, ...extra });

describe("configText", () => {
  it("shows a list as comma-separated text and no value as none", () => {
    expect(configText(["src", "docs"])).toBe("src, docs");
    expect(configText(200)).toBe("200");
    expect(configText(false)).toBe("false");
    expect(configText(undefined)).toBe("");
  });
});

describe("configEdit", () => {
  it("reads text as the field's type, and saves it only when it changes the value", () => {
    expect(configEdit(field("maxSteps", "integer"), 200, "150")).toEqual({ value: 150 });
    expect(configEdit(field("maxSteps", "integer"), 200, " 200 ")).toBeUndefined();
    expect(configEdit(field("verbose", "boolean"), false, "on")).toEqual({ value: true });
    expect(configEdit(field("folders", "strings"), ["src"], "src, docs")).toEqual({ value: ["src", "docs"] });
    expect(configEdit(field("send", "enum", { options: ["enter", "mod+enter"] }), "enter", "mod+enter")).toEqual({ value: "mod+enter" });
  });

  it("refuses text that is not of the field's type, saying why", () => {
    expect(configEdit(field("maxSteps", "integer"), 200, "2.5")).toEqual({ error: "maxSteps must be a whole number" });
    expect(configEdit(field("send", "enum", { options: ["enter", "mod+enter"] }), "enter", "tab")).toEqual({
      error: "send must be one of enter, mod+enter",
    });
  });

  it("unsets a cleared field set away from its default, and leaves one that is not", () => {
    expect(configEdit(field("defaultModel", "string"), "anthropic/claude", "  ")).toEqual({ value: null });
    expect(configEdit(field("maxSteps", "integer", { default: 200 }), 200, "")).toBeUndefined();
    expect(configEdit(field("defaultModel", "string"), undefined, "")).toBeUndefined();
  });

  it("keeps a secret that is set when its field is left blank, and saves whatever is typed over it", () => {
    expect(configEdit(field("token", "string", { secret: true }), undefined, "")).toBeUndefined();
    expect(configEdit(field("token", "string", { secret: true }), undefined, "  ")).toEqual({ value: "  " });
  });
});
