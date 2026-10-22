import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, KeyOverrides } from "@lemma/actions";
import { HOLD_DELAY, createKeymap } from "../src/keymap.ts";
import type { Item, Place } from "../src/keymap.ts";

// Not a Mac here, so `mod` is Ctrl. Node has a `navigator` that reports the host, so pin it.
vi.hoisted(() => {
  Object.defineProperty(globalThis, "navigator", { value: { platform: "Linux x86_64", userAgent: "" }, configurable: true });
});

interface Mods {
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

/** A key event as the page sends it: `repeat` for a key held down, `handled` for one something before the keymap took. */
const press = (key: string, code: string, mods: Mods = {}, options: { readonly repeat?: boolean; readonly handled?: boolean } = {}) => {
  let prevented = options.handled ?? false;
  return {
    key,
    code,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: false,
    repeat: options.repeat ?? false,
    isComposing: false,
    target: null,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as KeyboardEvent;
};
const ctrl = (options?: { readonly repeat?: boolean; readonly handled?: boolean }) => press("Control", "ControlLeft", { ctrl: true }, options);
/** Ctrl let go: its keyup no longer has it held. */
const ctrlUp = () => press("Control", "ControlLeft");

/** An action that records what it hears of a hold. */
const listener = (id: string, keys: string, extra: Partial<Action> = {}) => {
  const heard: (string | undefined)[] = [];
  const item: Item = { id, title: id, keys, run: vi.fn(), onHold: (binding) => void heard.push(binding), ...extra };
  return { item, heard };
};

const setup = (actions: readonly Item[], options: { readonly place?: Partial<Place>; readonly overrides?: KeyOverrides } = {}) => {
  const failed = vi.fn();
  const keymap = createKeymap({
    actions: () => actions,
    overrides: options.overrides ?? {},
    placeOf: () => ({ modal: false, inField: false, ...options.place }),
    after: (ms, run) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    failed,
  });
  return { keymap, failed };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("holding modifiers", () => {
  it("tells an action its keys once the modifier has been held alone a moment", () => {
    const one = listener("one", "mod+1");
    const { keymap } = setup([one.item]);
    keymap.keydown(ctrl());
    vi.advanceTimersByTime(HOLD_DELAY - 1);
    expect(one.heard).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(one.heard).toEqual(["mod+1"]);
  });

  it("lets a shortcut pressed at once pass first", () => {
    const one = listener("one", "mod+1");
    const { keymap } = setup([one.item]);
    keymap.keydown(ctrl());
    vi.advanceTimersByTime(50);
    keymap.keydown(press("c", "KeyC", { ctrl: true }));
    vi.advanceTimersByTime(HOLD_DELAY * 2);
    expect(one.heard).toEqual([]);
  });

  it("tells it again once the modifier is let go, the window loses focus, or a key with it runs nothing", () => {
    const one = listener("one", "mod+1");
    const { keymap } = setup([one.item]);
    const hold = () => {
      keymap.keydown(ctrl());
      vi.advanceTimersByTime(HOLD_DELAY);
    };
    hold();
    keymap.keyup(ctrlUp());
    hold();
    keymap.letGo();
    hold();
    keymap.keydown(press("c", "KeyC", { ctrl: true }));
    expect(one.heard).toEqual(["mod+1", undefined, "mod+1", undefined, "mod+1", undefined]);
  });

  it("keeps the hold through a key that runs an action, so mod+1 then mod+2 show throughout", () => {
    const one = listener("one", "mod+1");
    const { keymap } = setup([one.item]);
    keymap.keydown(ctrl());
    vi.advanceTimersByTime(HOLD_DELAY);
    keymap.keydown(press("1", "Digit1", { ctrl: true }));
    expect(one.item.run).toHaveBeenCalledOnce();
    expect(one.heard).toEqual(["mod+1"]);
  });

  it("does not start over for a modifier's repeated keydowns", () => {
    const one = listener("one", "mod+1");
    const { keymap } = setup([one.item]);
    keymap.keydown(ctrl());
    vi.advanceTimersByTime(HOLD_DELAY - 50);
    keymap.keydown(ctrl({ repeat: true }));
    vi.advanceTimersByTime(50);
    expect(one.heard).toEqual(["mod+1"]);
    keymap.keydown(ctrl({ repeat: true }));
    vi.advanceTimersByTime(HOLD_DELAY);
    expect(one.heard).toEqual(["mod+1"]);
  });

  it("starts over when the modifiers change, telling only the bindings they hold", () => {
    const one = listener("one", "mod+1");
    const next = listener("next", "mod+shift+]");
    const { keymap } = setup([one.item, next.item]);
    keymap.keydown(ctrl());
    vi.advanceTimersByTime(HOLD_DELAY);
    keymap.keydown(press("Shift", "ShiftLeft", { ctrl: true, shift: true }));
    expect(one.heard).toEqual(["mod+1", undefined]);
    vi.advanceTimersByTime(HOLD_DELAY);
    expect(next.heard).toEqual(["mod+shift+]"]);
    expect(one.heard).toEqual(["mod+1", undefined]);
  });

  it("holds nothing for a modifier something else handled first, as a quick-pick list does for its own ⌘1", () => {
    const one = listener("one", "mod+1");
    const { keymap } = setup([one.item]);
    keymap.keydown(ctrl({ handled: true }));
    vi.advanceTimersByTime(HOLD_DELAY * 2);
    expect(one.heard).toEqual([]);
  });
});

describe("which action a held key belongs to", () => {
  const holdCtrl = (actions: readonly Item[], options?: Parameters<typeof setup>[1]) => {
    const { keymap, failed } = setup(actions, options);
    keymap.keydown(ctrl());
    vi.advanceTimersByTime(HOLD_DELAY);
    return failed;
  };

  it("is the first in order whose `when` holds, as pressing it would choose", () => {
    const off = listener("off", "mod+1", { when: () => false });
    const first = listener("first", "mod+1");
    const second = listener("second", "mod+1");
    holdCtrl([off.item, first.item, second.item]);
    expect(off.heard).toEqual([]);
    expect(first.heard).toEqual(["mod+1"]);
    expect(second.heard).toEqual([]);
  });

  it("is an earlier action's that does not listen, so a later one shows no keys pressing would not run it", () => {
    const taker: Item = { id: "taker", title: "taker", keys: "mod+2", run: vi.fn() };
    const two = listener("two", "mod+2");
    const one = listener("one", "mod+1");
    holdCtrl([taker, two.item, one.item]);
    expect(two.heard).toEqual([]);
    expect(one.heard).toEqual(["mod+1"]);
  });

  it("follows the user's bindings over the action's own", () => {
    const one = listener("one", "mod+1");
    holdCtrl([one.item], { overrides: { one: ["mod+3"] } });
    expect(one.heard).toEqual(["mod+3"]);
  });

  it("is only a global action's under a dialog", () => {
    const plain = listener("plain", "mod+1");
    const global = listener("global", "mod+2", { global: true });
    holdCtrl([plain.item, global.item], { place: { modal: true } });
    expect(plain.heard).toEqual([]);
    expect(global.heard).toEqual(["mod+2"]);
  });

  it("is none in a text field for keys that type, unless the action works while typing", () => {
    const typed = listener("typed", "alt+1");
    const whileTyping = listener("while-typing", "alt+2", { whileTyping: true });
    const { keymap } = setup([typed.item, whileTyping.item], { place: { inField: true } });
    keymap.keydown(press("Alt", "AltLeft", { alt: true }));
    vi.advanceTimersByTime(HOLD_DELAY);
    expect(typed.heard).toEqual([]);
    expect(whileTyping.heard).toEqual(["alt+2"]);
  });

  it("is told apart from one that throws, which fails alone", () => {
    const broken = listener("broken", "mod+1", {
      onHold: () => {
        throw new Error("no");
      },
    });
    const two = listener("two", "mod+2");
    const failed = holdCtrl([broken.item, two.item]);
    expect(failed).toHaveBeenCalledWith(broken.item, expect.any(Error));
    expect(two.heard).toEqual(["mod+2"]);
  });
});

describe("pressing keys", () => {
  it("runs the first action whose keys match and whose `when` holds, and takes the key from the page", () => {
    const off: Item = { id: "off", title: "off", keys: "mod+k", when: () => false, run: vi.fn() };
    const on: Item = { id: "on", title: "on", keys: "mod+k", run: vi.fn() };
    const { keymap } = setup([off, on]);
    const event = press("k", "KeyK", { ctrl: true });
    keymap.keydown(event);
    expect(off.run).not.toHaveBeenCalled();
    expect(on.run).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves a key something else handled alone", () => {
    const on: Item = { id: "on", title: "on", keys: "mod+k", run: vi.fn() };
    const { keymap } = setup([on]);
    keymap.keydown(press("k", "KeyK", { ctrl: true }, { handled: true }));
    expect(on.run).not.toHaveBeenCalled();
  });

  it("asks the palette for an action's value first", () => {
    const palette: Item = { id: "palette.open", title: "palette", run: vi.fn() };
    const rename: Item = { id: "rename", title: "rename", keys: "mod+alt+r", input: () => ({ title: "Rename" }), run: vi.fn() };
    const { keymap } = setup([palette, rename]);
    keymap.keydown(press("r", "KeyR", { ctrl: true, alt: true }));
    expect(palette.run).toHaveBeenCalledWith("rename");
    expect(rename.run).not.toHaveBeenCalled();
  });
});

describe("a key typed with AltGr", () => {
  /** AltGr+A on a Polish layout: ą, which Windows reports as Ctrl+Alt+A. */
  const altGrA = () => {
    const event = press("ą", "KeyA", { ctrl: true, alt: true });
    Object.defineProperty(event, "getModifierState", { value: (key: string) => key === "AltGraph" });
    return event;
  };

  it("types in a text field, running no binding", () => {
    const archive: Item = { id: "archive", title: "Archive", keys: "mod+alt+a", whileTyping: true, run: vi.fn() };
    const { keymap } = setup([archive], { place: { inField: true } });
    const event = altGrA();
    keymap.keydown(event);
    expect(archive.run).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("runs mod+alt outside one, as a real Ctrl+Alt Windows reports as AltGr does", () => {
    const archive: Item = { id: "archive", title: "Archive", keys: "mod+alt+a", run: vi.fn() };
    const { keymap } = setup([archive]);
    keymap.keydown(altGrA());
    expect(archive.run).toHaveBeenCalledOnce();
  });
});
