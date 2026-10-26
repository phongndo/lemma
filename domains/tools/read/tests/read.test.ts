import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTool } from "../src/index.ts";
import type { ReadDetails } from "../src/index.ts";
import { readLines } from "../src/lines.ts";
import { sniffBinary } from "../src/read.ts";
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
      "two\nthree\n\n[… 1 line left out: showing lines 2-3 of 4. Use offset=4 to continue.]",
    );
    expect(await attempt(readTool, { path: "a.txt", offset: 10 }, context(dir))).toBe("error: Offset 10 is beyond end of file (4 lines total)");
    expect(await attempt(readTool, { path: "a.txt", offset: 5 }, context(dir))).toBe("error: Offset 5 is beyond end of file (4 lines total)");
  });

  it("pages 2000 lines at a time, fewer past the result's budget, saying where to continue", async () => {
    await put("long.txt", Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n"));
    const long = await call(readTool, { path: "long.txt" }, context(dir));
    expect(textOf(long).split("\n").slice(-1)[0]).toBe("[… 500 lines left out: showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
    expect((long.details as ReadDetails).truncation).toBeUndefined();

    await put("wide.txt", Array.from({ length: 100 }, () => "x".repeat(1000)).join("\n"));
    const wide = await call(readTool, { path: "wide.txt", offset: 3 }, { ...context(dir), maxResultChars: 21_000 });
    const [, left, last, next] = /\[… (\d+) lines left out: showing lines 3-(\d+) of 100\. Use offset=(\d+) to continue\.\]$/.exec(textOf(wide))!.map(Number);
    expect([left, next]).toEqual([100 - last!, last! + 1]);
    expect(textOf(wide).length).toBeLessThanOrEqual(20_000);
    expect((wide.details as ReadDetails).truncation).toMatchObject({ lines: 100 });

    await put("huge-line.txt", "y".repeat(60 * 1024));
    expect(textOf(await call(readTool, { path: "huge-line.txt" }, context(dir)))).toMatch(
      /^y+\n\n\[… the rest of line 1 left out: showing the first (\d+) characters of line 1 of 1\. Read on in it with bash: sed -n '1p' huge-line\.txt \| cut -c \d+-\d+\]$/,
    );
  });

  it("pages a file larger than what it reads at a time", async () => {
    await put("big.txt", Array.from({ length: 300_000 }, (_, i) => `line ${i + 1}\n`).join(""));
    expect(textOf(await call(readTool, { path: "big.txt", offset: 150_000, limit: 2 }, context(dir)))).toBe(
      "line 150000\nline 150001\n\n[… 149999 lines left out: showing lines 150000-150001 of 300000. Use offset=150002 to continue.]",
    );
    const rest = textOf(await call(readTool, { path: "big.txt", offset: 299_000 }, context(dir)));
    expect([rest.split("\n").length, rest.startsWith("line 299000\n"), rest.endsWith("line 300000\n")]).toEqual([1002, true, true]);
  });

  it("reads lines a chunk at a time as splitting the whole file would", async () => {
    // Characters split between chunks, invalid UTF-8 (each sequence a 3-byte U+FFFD), and an empty last line.
    const bytes = Buffer.concat([Buffer.from("é€😀\nab\n"), Buffer.from([0xff, 0xe2, 0x82, 0x0a, 0xc3]), Buffer.from("\n\nlong line here\n")]);
    await put("mixed.txt", bytes);
    const split = bytes.toString("utf8").split("\n");
    // Where each line starts in the file's bytes: a window's bytes, cut short, decode as the window's head does.
    const starts = [0, ...[...bytes.entries()].filter(([, byte]) => byte === 0x0a).map(([at]) => at + 1)];
    const windowOf = (start: number, end: number) => bytes.subarray(starts[start], end < starts.length ? starts[end]! - 1 : bytes.length);
    for (const chunk of [1, 2, 3, 5, 1024])
      for (const [start, end] of [
        [0, 9],
        [1, 3],
        [3, 9],
        [4, 6],
        [6, 9],
        [7, 9],
        [9, 12],
      ] as const) {
        const handle = await fs.open(path.join(dir, "mixed.txt"), "r");
        const window = await readLines(handle, start, end, { headBytes: 1024, countBytes: 1024 }, new AbortController().signal, chunk).finally(() =>
          handle.close(),
        );
        expect(window.lines).toBe(split.length - 1);
        if (start >= split.length) {
          expect(window.text).toBeUndefined();
          continue;
        }
        expect(window.text).toBe(split.slice(start, end).join("\n"));
        const handle2 = await fs.open(path.join(dir, "mixed.txt"), "r");
        const cut = await readLines(handle2, start, end, { headBytes: 4, countBytes: 1024 }, new AbortController().signal, chunk).finally(() =>
          handle2.close(),
        );
        expect(cut.text).toBe(new TextDecoder().decode(windowOf(start, end).subarray(0, 4)));
      }
  });

  it("stops reading at the page's end in a file past what it counts, leaving its lines uncounted", async () => {
    await put("many.txt", Array.from({ length: 10_000 }, (_, i) => `line ${i + 1}\n`).join(""));
    const handle = await fs.open(path.join(dir, "many.txt"), "r");
    let furthest = 0;
    const counting = {
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const read = await handle.read(buffer, offset, length, position);
        furthest = Math.max(furthest, position + read.bytesRead);
        return read;
      },
    } as unknown as fs.FileHandle;
    const window = await readLines(counting, 10, 20, { headBytes: 1024, countBytes: 1024 }, new AbortController().signal, 256).finally(() => handle.close());
    expect(window).toEqual({ text: Array.from({ length: 10 }, (_, i) => `line ${i + 11}`).join("\n") });
    expect(furthest).toBeLessThanOrEqual(1024 + 256);
  });

  it("tells binary files from text, saying what kind each is instead of showing it", async () => {
    await put("doc.pdf", Buffer.concat([Buffer.from("%PDF-1.7\n%"), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.from("\n1 0 obj\n")]));
    await put("lib.so", Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(64)]));
    await put("blob.bin", Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37 + 128) % 256).filter((byte) => byte !== 0)));
    expect(textOf(await call(readTool, { path: "doc.pdf" }, context(dir)))).toBe(
      "doc.pdf is a PDF (23B), not text, so it is not shown. Look into it with bash (file, strings, xxd) or a tool made for it.",
    );
    expect(textOf(await call(readTool, { path: "lib.so" }, context(dir)))).toMatch(/^lib\.so is an ELF executable or library \(72B\)/);
    expect(textOf(await call(readTool, { path: "blob.bin" }, context(dir)))).toMatch(/^blob\.bin is a binary file /);
    expect(sniffBinary(Buffer.from("plain text, ünïcödé, emoji 😀, tabs\tand\r\nlines\n\x1b[31mcolor\x1b[0m"))).toBeUndefined();
    expect(sniffBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe("a binary file");
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
