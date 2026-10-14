import { describe, expect, test } from "vitest";
import { MAX_IMAGE_BYTES } from "@lemma/llm";
import { leftOutWarnings, sortFiles, unreadWarning } from "../src/images.ts";

const file = (type: string, size = 10) => ({ type, size });

describe("sortFiles", () => {
  test("accepts the image types providers take, up to the size limit", () => {
    const png = file("image/png");
    const big = file("image/jpeg", MAX_IMAGE_BYTES + 1);
    const sorted = sortFiles([png, big, file("image/tiff"), file("text/plain"), file("")]);
    expect(sorted.accepted).toEqual([png]);
    expect(sorted).toMatchObject({ others: 1, unsupported: 2, tooLarge: 1 });
  });

  test("a file of no type the browser knows counts as an image of a format not taken", () => {
    expect(sortFiles([file("")])).toMatchObject({ others: 0, unsupported: 1 });
  });
});

describe("leftOutWarnings", () => {
  test("one warning per reason, counted", () => {
    expect(leftOutWarnings({ others: 0, unsupported: 0, tooLarge: 0 })).toEqual([]);
    expect(leftOutWarnings({ others: 1, unsupported: 2, tooLarge: 1 })).toEqual([
      "A file was not attached: only images can be.",
      "2 images were not attached: use PNG, JPEG, GIF, or WebP.",
      "An image was not attached: over the 3.75 MB limit providers accept.",
    ]);
  });

  test("says how many could not be read", () => {
    expect(unreadWarning(1)).toBe("An image could not be read, and was not attached.");
    expect(unreadWarning(3)).toBe("3 images could not be read, and were not attached.");
  });
});
