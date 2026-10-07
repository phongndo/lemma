import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/model/candidates.ts";

describe("extractCandidates", () => {
  it("finds the classes in a UI file's html templates and strings", () => {
    const source = [
      'html`<span class="muted tw:text-xs">${count}</span>`',
      "html`<div class=${open() ? 'tw:bg-accent-soft' : 'tw:bg-bg-raised'}>`",
      'const wide = "tw:w-[calc(100%-2rem)] tw:max-w-(--content) tw:hover:bg-bg-hover";',
    ].join("\n");
    const found = extractCandidates(source);
    for (const candidate of [
      "muted",
      "tw:text-xs",
      "tw:bg-accent-soft",
      "tw:bg-bg-raised",
      "tw:w-[calc(100%-2rem)]",
      "tw:max-w-(--content)",
      "tw:hover:bg-bg-hover",
    ]) {
      expect(found).toContain(candidate);
    }
  });

  it("keeps a class whose bracketed value has quotes whole", () => {
    const found = extractCandidates(
      `html\`<p class="tw:before:content-['hello'] tw:font-['Inter',_serif] tw:[&>p]:font-['Inter'] tw:[&[data-state='open']]:bg-accent tw:p-2">\``,
    );
    for (const candidate of [
      "tw:before:content-['hello']",
      "tw:font-['Inter',_serif]",
      "tw:[&>p]:font-['Inter']",
      "tw:[&[data-state='open']]:bg-accent",
      "tw:p-2",
    ])
      expect(found).toContain(candidate);
  });

  it("trims the markup around a class and keeps each once", () => {
    expect(extractCandidates("{flex}; (grid, 123 --")).toEqual(["flex", "grid"]);
  });
});
