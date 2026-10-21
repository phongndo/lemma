import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTool } from "../src/index.ts";
import type { ReadDetails } from "../src/index.ts";
import { readLines } from "../src/lines.ts";
import { truncateHead } from "@lemma/tools";
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

  it("pages a file larger than what it reads at a time", async () => {
    await put("big.txt", Array.from({ length: 300_000 }, (_, i) => `line ${i + 1}\n`).join(""));
    expect(textOf(await call(readTool, { path: "big.txt", offset: 150_000, limit: 2 }, context(dir)))).toBe(
      "line 150000\nline 150001\n\n[150000 more lines in file. Use offset=150002 to continue.]",
    );
    const rest = textOf(await call(readTool, { path: "big.txt", offset: 299_000 }, context(dir)));
    expect([rest.split("\n").length, rest.startsWith("line 299000\n"), rest.endsWith("line 300000\n")]).toEqual([1002, true, true]);
  });

  it("reads lines a chunk at a time as splitting the whole file would", async () => {
    // Characters split between chunks, invalid UTF-8 (each sequence a 3-byte U+FFFD), and an empty last line.
    const bytes = Buffer.concat([Buffer.from("é€😀\nab\n"), Buffer.from([0xff, 0xe2, 0x82, 0x0a, 0xc3]), Buffer.from("\n\nlong line here\n")]);
    await put("mixed.txt", bytes);
    const lines = bytes.toString("utf8").split("\n");
    const limits = { maxLines: 2, maxBytes: 8 };
    for (const chunk of [1, 2, 3, 5, 1024])
      for (const [start, end] of [[0], [1, 3], [3], [4, 6], [6, 9], [7], [9]] as const) {
        const handle = await fs.open(path.join(dir, "mixed.txt"), "r");
        const { fileLines, selection } = await readLines(handle, start, end, limits, new AbortController().signal, chunk).finally(() => handle.close());
        expect(fileLines).toBe(lines.length);
        if (start >= lines.length) {
          expect(selection).toBeUndefined();
          continue;
        }
        const whole = truncateHead(lines.slice(start, end).join("\n"), limits);
        const kept = truncateHead(selection!.head, limits);
        expect(kept.truncated ? { ...kept, totalLines: selection!.lines, totalBytes: selection!.bytes } : kept).toEqual(whole);
        expect(selection!.firstLineBytes).toBe(Buffer.byteLength(lines[start]!));
      }
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
