import { afterEach, describe, expect, it, vi } from "vitest";
import { bindingOf, formatKeys, holdsKeys, listKey, matchesKeys, quickKey, radioGroupKey, radioStep, typedWithAltGr } from "../src/keys.ts";

// Not a Mac here, so `mod` is Ctrl. Node has a `navigator` that reports the host, so pin it.
vi.hoisted(() => {
  Object.defineProperty(globalThis, "navigator", { value: { platform: "Linux x86_64", userAgent: "" }, configurable: true });
});

const press = (key: string, code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) =>
  ({ key, code, ctrlKey: mods.ctrl ?? false, shiftKey: mods.shift ?? false, altKey: mods.alt ?? false, metaKey: mods.meta ?? false }) as KeyboardEvent;
/** `event` with AltGr held, which Windows reports as Ctrl+Alt too. */
const withAltGr = (event: KeyboardEvent) => ({ ...event, getModifierState: (key: string) => key === "AltGraph" }) as KeyboardEvent;

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
    expect(bindingOf(withAltGr(press("AltGraph", "AltRight", { ctrl: true, alt: true })))).toBeUndefined();
    // Nor a key with it: it would record a binding that types, or one the plain key presses.
    expect(bindingOf(withAltGr(press("ą", "KeyA", { ctrl: true, alt: true })))).toBeUndefined();
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

  it("knows a symbol Shift types another one on by the key's place", () => {
    // Ctrl+Shift+] types } on a US layout: the binding names ] and Shift.
    expect(matchesKeys("mod+shift+]", press("}", "BracketRight", { ctrl: true, shift: true }))).toBe(true);
    expect(matchesKeys("mod+]", press("}", "BracketRight", { ctrl: true, shift: true }))).toBe(false);
    expect(matchesKeys("mod+]", press("]", "BracketRight", { ctrl: true }))).toBe(true);
  });

  it("tells a key typed with AltGr, which still presses mod+alt: Windows reports a real Ctrl+Alt as AltGr too", () => {
    // AltGr+A types ą on a Polish layout; Windows reports it as Ctrl+Alt+A. Whether it types is the keymap's to say.
    const altGr = withAltGr(press("ą", "KeyA", { ctrl: true, alt: true }));
    expect(typedWithAltGr(altGr, false)).toBe(true);
    expect(matchesKeys("mod+alt+a", altGr, false)).toBe(true);
    expect(typedWithAltGr(press("a", "KeyA", { ctrl: true, alt: true }), false)).toBe(false);
    // On macOS ⌥ is Alt, whatever the event says of AltGr.
    expect(typedWithAltGr(withAltGr(press("å", "KeyA", { meta: true, alt: true })), true)).toBe(false);
  });

  it("needs the exact modifiers", () => {
    expect(matchesKeys("mod+k", press("k", "KeyK", { ctrl: true, shift: true }))).toBe(false);
    expect(matchesKeys("mod+k", press("k", "KeyK"))).toBe(false);
    expect(matchesKeys("escape", press("Escape", "Escape"))).toBe(true);
  });
});

describe("holdsKeys", () => {
  it("holds a binding while exactly its modifiers are down", () => {
    expect(holdsKeys("mod+1", press("Control", "ControlLeft", { ctrl: true }))).toBe(true);
    expect(holdsKeys("mod+1", press("Shift", "ShiftLeft", { ctrl: true, shift: true }))).toBe(false);
    expect(holdsKeys("mod+shift+]", press("Shift", "ShiftLeft", { ctrl: true, shift: true }))).toBe(true);
    expect(holdsKeys("alt+1", press("Alt", "AltLeft", { alt: true, ctrl: true }))).toBe(false);
    expect(holdsKeys("mod+1", press("Control", "ControlLeft"))).toBe(false);
    expect(holdsKeys("mod+alt+a", withAltGr(press("AltGraph", "AltRight", { ctrl: true, alt: true })))).toBe(false);
  });

  it("never holds a binding without a modifier", () => {
    expect(holdsKeys("escape", press("Escape", "Escape"))).toBe(false);
    expect(holdsKeys("?", press("Shift", "ShiftLeft", { shift: true }))).toBe(false);
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

describe("radioStep", () => {
  it("moves along either axis and wraps at the ends", () => {
    expect(radioStep("ArrowRight", 0, 3)).toBe(1);
    expect(radioStep("ArrowDown", 2, 3)).toBe(0);
    expect(radioStep("ArrowLeft", 0, 3)).toBe(2);
    expect(radioStep("ArrowUp", 1, 3)).toBe(0);
  });

  it("jumps to the ends with Home and End, and leaves other keys alone", () => {
    expect(radioStep("Home", 2, 3)).toBe(0);
    expect(radioStep("End", 0, 3)).toBe(2);
    expect(radioStep("Enter", 1, 3)).toBeUndefined();
  });
});

describe("radioGroupKey", () => {
  afterEach(() => vi.unstubAllGlobals());
  /** A group of `role` options, as the DOM would hand them over, with the option at `focused` holding the focus. */
  const group = (focused: number | undefined, role = "radio") => {
    const options = [0, 1, 2].map(() => ({ focus: vi.fn() }));
    vi.stubGlobal("document", { activeElement: focused === undefined ? null : options[focused] });
    const queried: string[] = [];
    const currentTarget = { querySelectorAll: (selector: string) => (queried.push(selector), selector === `[role=${role}]` ? options : []) };
    const press = (key: string, mods: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => {
      const event = {
        key,
        altKey: mods.alt ?? false,
        ctrlKey: mods.ctrl ?? false,
        metaKey: mods.meta ?? false,
        shiftKey: mods.shift ?? false,
        preventDefault: vi.fn(),
        currentTarget,
      };
      return { event, next: radioGroupKey(event as unknown as KeyboardEvent & { currentTarget: Element }, undefined, role) };
    };
    return { options, press };
  };

  it("steps from the option focused, focusing the one moved to", () => {
    const { options, press } = group(1);
    const { event, next } = press("ArrowRight");
    expect(next).toBe(2);
    expect(options[2]!.focus).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("answers a tab list's options too", () => {
    expect(group(0, "tab").press("End").next).toBe(2);
  });

  it("leaves a modified key, and focus on no option, alone", () => {
    expect(group(1).press("ArrowLeft", { alt: true }).next).toBeUndefined();
    expect(group(1).press("ArrowRight", { shift: true }).next).toBeUndefined();
    expect(group(undefined).press("ArrowRight").next).toBeUndefined();
  });
});
