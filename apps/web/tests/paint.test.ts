import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentTheme, paint, preloadPaint, settlePaint, unpaint } from "../src/lib/paint.ts";

/** Just enough of the page for lib/paint: `<html>`'s dataset and style, storage, and the colour scheme. */
const page = (prefersDark: boolean) => {
  const properties = new Map<string, string>();
  const root = {
    dataset: {} as Record<string, string | undefined>,
    style: {
      setProperty: (name: string, value: string) => void properties.set(name, value),
      removeProperty: (name: string) => void properties.delete(name),
    },
  };
  const stored = new Map<string, string>();
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: prefersDark }) });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  return { root, properties, stored };
};

describe("paint", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("paints the remembered look before plugins start, else the system theme", () => {
    const { root, properties, stored } = page(true);
    preloadPaint();
    expect(root.dataset.theme).toBe("dark");
    stored.set("lemma.paint", JSON.stringify({ theme: "light", tokens: { "--content": "1040px" } }));
    preloadPaint();
    expect([currentTheme(), properties.get("--content")]).toEqual(["light", "1040px"]);
    stored.set("lemma.paint", "not json");
    preloadPaint();
    expect(root.dataset.theme).toBe("dark");
  });

  it("removes the tokens a look set when the next does not set them", () => {
    const { properties } = page(false);
    paint({ theme: "light", tokens: { "--accent": "red", "--content": "none" } }, "first");
    paint({ theme: "light", tokens: { "--accent": "blue" } }, "first");
    expect(Object.fromEntries(properties)).toEqual({ "--accent": "blue" });
    unpaint("first");
    expect(properties.size).toBe(0);
  });

  it("starts from the system theme alone when the remembered look is not wanted (?safe)", () => {
    const { root, properties, stored } = page(true);
    stored.set("lemma.paint", JSON.stringify({ theme: "light", tokens: { "--bg": "#101020" } }));
    preloadPaint(false);
    expect([root.dataset.theme, properties.has("--bg")]).toEqual(["dark", false]);
  });

  it("forgets a remembered look no plugin painted again once the plugins start", () => {
    const { root, properties, stored } = page(false);
    stored.set("lemma.paint", JSON.stringify({ theme: "dark", tokens: { "--bg": "#101020" } }));
    preloadPaint();
    expect([root.dataset.theme, properties.get("--bg")]).toEqual(["dark", "#101020"]);
    settlePaint();
    expect([root.dataset.theme, properties.has("--bg"), stored.has("lemma.paint")]).toEqual(["light", false, false]);
    // A painter that painted keeps its look.
    preloadPaint();
    paint({ theme: "dark", tokens: { "--bg": "#101020" } }, "appearance");
    settlePaint();
    expect([root.dataset.theme, properties.get("--bg")]).toEqual(["dark", "#101020"]);
  });

  it("returns to the system theme when its painter stops, unless a replacement has painted since", () => {
    const { root, stored } = page(false);
    paint({ theme: "dark" }, "first");
    expect(JSON.parse(stored.get("lemma.paint")!)).toEqual({ theme: "dark" });
    // A replacement starts before the old instance stops.
    paint({ theme: "dark", tokens: { "--content": "none" } }, "second");
    unpaint("first");
    expect([root.dataset.theme, root.dataset.paintedBy]).toEqual(["dark", "second"]);
    unpaint("second");
    expect([root.dataset.theme, root.dataset.paintedBy, stored.has("lemma.paint")]).toEqual(["light", undefined, false]);
  });
});
