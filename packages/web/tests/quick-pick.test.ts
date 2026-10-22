import { describe, expect, it, vi } from "vitest";
import { createQuickHold } from "../src/quick-pick.ts";

// Not a Mac here, so the modifier is Ctrl; and Node has no KeyboardEvent, so give it one.
vi.hoisted(() => {
  Object.defineProperty(globalThis, "navigator", { value: { platform: "Linux x86_64", userAgent: "" }, configurable: true });
  class KeyboardEvent extends Event {
    constructor(type: string, init: Record<string, unknown>) {
      super(type, { cancelable: true });
      Object.assign(this, { metaKey: false, altKey: false, shiftKey: false, ctrlKey: false, ...init });
    }
  }
  Object.defineProperty(globalThis, "KeyboardEvent", { value: KeyboardEvent, configurable: true });
});

const ctrl = () => new KeyboardEvent("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true });

describe("createQuickHold", () => {
  it("holds while the modifier is down alone, and takes it from the keymap while the list shows", () => {
    let showing = true;
    const hold = createQuickHold(() => showing);
    const shown = ctrl();
    hold.track(shown);
    expect(hold.held()).toBe(true);
    expect(shown.defaultPrevented).toBe(true);
    // A list that is not there leaves it to the keymap's actions (the sidebar's ⌘1).
    showing = false;
    const hidden = ctrl();
    hold.track(hidden);
    expect(hidden.defaultPrevented).toBe(false);
  });

  it("leaves a shortcut pressed with the modifier alone (⌘C copies)", () => {
    const hold = createQuickHold();
    const copy = new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true });
    hold.track(copy);
    expect(hold.held()).toBe(true);
    expect(copy.defaultPrevented).toBe(false);
  });

  it("lets go once the modifier is up or another is held with it", () => {
    const hold = createQuickHold();
    hold.track(ctrl());
    hold.track(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", ctrlKey: true, shiftKey: true }));
    expect(hold.held()).toBe(false);
    hold.track(ctrl());
    hold.track(new KeyboardEvent("keyup", { key: "Control", code: "ControlLeft" }));
    expect(hold.held()).toBe(false);
  });
});
