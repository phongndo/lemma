import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeTool } from "../src/index.ts";
import { call, context, tempDir, textOf } from "@lemma/tools/testing";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const get = (name: string) => fs.readFile(path.join(dir, name), "utf8");

describe("write", () => {
  it("creates parent directories and overwrites", async () => {
    const result = await call(writeTool, { path: "deep/er/file.txt", content: "héllo" }, context(dir));
    expect(textOf(result)).toBe("Successfully wrote 6 bytes to deep/er/file.txt");
    await call(writeTool, { path: "deep/er/file.txt", content: "bye" }, context(dir));
    expect(await get("deep/er/file.txt")).toBe("bye");
  });
});
