import { describe, expect, it, vi } from "vitest";
import { bindingOf, formatKeys, listKey, matchesKeys, quickKey } from "../src/lib/keys.ts";

// Not a Mac here, so `mod` is Ctrl. Node has a `navigator` that reports the host, so pin it.
vi.hoisted(() => {
  Object.defineProperty(globalThis, "navigator", { value: { platform: "Linux x86_64", userAgent: "" }, configurable: true });
});

const press = (key: string, code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) =>
  ({ key, code, ctrlKey: mods.ctrl ?? false, shiftKey: mods.shift ?? false, altKey: mods.alt ?? false, metaKey: mods.meta ?? false }) as KeyboardEvent;

describe("bindingOf", () => {
  it("records modifiers in a fixed order and letters by their physical key", () => {
    expect(bindingOf(press("K", "KeyK", { ctrl: true, shift: true }))).toBe("mod+shift+k");
    // Option+K types ˚ on a Mac; the binding is still k.
    expect(bindingOf(press("˚", "KeyK", { alt: true }))).toBe("alt+k");
    expect(bindingOf(press("ArrowDown", "ArrowDown", { ctrl: true, alt: true }))).toBe("mod+alt+arrowdown");
    expect(bindingOf(press(" ", "Space"))).toBe("space");
  });

  it("leaves shift out of symbols it types, and ignores modifiers alone", () => {
    expect(bindingOf(press("?", "Slash", { shift: true }))).toBe("?");
    expect(bindingOf(press("Shift", "ShiftLeft", { shift: true }))).toBeUndefined();
    expect(bindingOf(press("Control", "ControlLeft", { ctrl: true }))).toBeUndefined();
  });
});

describe("matchesKeys", () => {
  it("matches what bindingOf records", () => {
    for (const event of [
      press("K", "KeyK", { ctrl: true, shift: true }),
      press("˚", "KeyK", { alt: true }),
      press("?", "Slash", { shift: true }),
      press("ArrowUp", "ArrowUp", { ctrl: true, alt: true }),
      press("1", "Digit1", { ctrl: true }),
    ]) {
      expect(matchesKeys(bindingOf(event)!, event)).toBe(true);
    }
  });

  it("needs the exact modifiers", () => {
    expect(matchesKeys("mod+k", press("k", "KeyK", { ctrl: true, shift: true }))).toBe(false);
    expect(matchesKeys("mod+k", press("k", "KeyK"))).toBe(false);
    expect(matchesKeys("escape", press("Escape", "Escape"))).toBe(true);
  });
});

describe("formatKeys", () => {
  it("writes bindings the platform's way", () => {
    expect(formatKeys("mod+shift+o")).toBe("Ctrl+Shift+O");
    expect(formatKeys("mod+alt+arrowdown")).toBe("Ctrl+Alt+↓");
    expect(formatKeys("space")).toBe("Space");
  });
});

describe("listKey", () => {
  it("moves with arrows, Ctrl+N/P, and Ctrl+J/K, and picks with mod and a digit", () => {
    expect(listKey(press("ArrowDown", "ArrowDown"))).toEqual({ move: 1 });
    expect(listKey(press("ArrowUp", "ArrowUp"))).toEqual({ move: -1 });
    expect(listKey(press("j", "KeyJ", { ctrl: true }))).toEqual({ move: 1 });
    expect(listKey(press("k", "KeyK", { ctrl: true }))).toEqual({ move: -1 });
    expect(listKey(press("n", "KeyN", { ctrl: true }))).toEqual({ move: 1 });
    expect(listKey(press("p", "KeyP", { ctrl: true }))).toEqual({ move: -1 });
    // mod is Ctrl here.
    expect(listKey(press("3", "Digit3", { ctrl: true }))).toEqual({ pick: 2 });
  });

  it("leaves other keys to the field", () => {
    expect(listKey(press("j", "KeyJ"))).toBeUndefined();
    expect(listKey(press("0", "Digit0", { ctrl: true }))).toBeUndefined();
    expect(listKey(press("k", "KeyK", { ctrl: true, shift: true }))).toBeUndefined();
    expect(listKey(press("ArrowDown", "ArrowDown", { alt: true }))).toBeUndefined();
    expect(quickKey(0)).toBe("Ctrl+1");
    expect(quickKey(9)).toBeUndefined();
  });
});
