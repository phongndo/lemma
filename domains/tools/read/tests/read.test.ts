import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTool } from "../src/index.ts";
import type { ReadDetails } from "../src/index.ts";
import { attempt, call, context, tempDir, textOf } from "@lemma/tools/testing";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const put = (name: string, content: string | Buffer) => fs.writeFile(path.join(dir, name), content);

describe("read", () => {
  it("returns text relative to cwd and pages with offset and limit", async () => {
    await put("a.txt", "one\ntwo\nthree\nfour\n");
    expect(textOf(await call(readTool, { path: "a.txt" }, context(dir)))).toBe("one\ntwo\nthree\nfour\n");
    expect(textOf(await call(readTool, { path: "@a.txt", offset: 2, limit: 2 }, context(dir)))).toBe(
      "two\nthree\n\n[2 more lines in file. Use offset=4 to continue.]",
    );
    expect(await attempt(readTool, { path: "a.txt", offset: 10 }, context(dir))).toBe("error: Offset 10 is beyond end of file (5 lines total)");
  });

  it("truncates to 2000 lines and 50KB with a continuation notice", async () => {
    await put("long.txt", Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n"));
    const long = await call(readTool, { path: "long.txt" }, context(dir));
    expect(textOf(long).split("\n").slice(-1)[0]).toBe("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
    expect((long.details as ReadDetails).truncation?.truncatedBy).toBe("lines");

    await put("wide.txt", Array.from({ length: 100 }, () => "x".repeat(1000)).join("\n"));
    expect(textOf(await call(readTool, { path: "wide.txt", offset: 3 }, context(dir)))).toMatch(
      /\[Showing lines 3-53 of 100 \(50\.0KB limit\)\. Use offset=54 to continue\.\]$/,
    );

    await put("huge-line.txt", "y".repeat(60 * 1024));
    expect(textOf(await call(readTool, { path: "huge-line.txt" }, context(dir)))).toBe(
      "[Line 1 is 60.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' huge-line.txt | head -c 51200]",
    );
  });

  it("returns images by content, not extension, and reports missing files and directories", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
    await put("pic.dat", png);
    const image = await call(readTool, { path: "pic.dat" }, context(dir));
    expect(image.content).toEqual([
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", mimeType: "image/png", data: png.toString("base64") },
    ]);
    expect(await attempt(readTool, { path: "missing.txt" }, context(dir))).toBe("error: File not found: missing.txt");
    await fs.mkdir(path.join(dir, "sub"));
    expect(await attempt(readTool, { path: "sub" }, context(dir))).toContain("is a directory");
  });
});
