import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashTool, makeBashTool } from "../src/index.ts";
import type { BashDetails } from "../src/index.ts";
import { call, context, tempDir, textOf } from "@lemma/tools/testing";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("bash", () => {
  it("reports output as it arrives, whole characters only", async () => {
    const chunks: string[] = [];
    // A multi-byte character written in two halves, a pause, then more.
    const command = "printf 'caf\\303'; sleep 0.2; printf '\\251\\n'; sleep 0.2; echo later";
    const result = await call(bashTool, { command }, { ...context(dir), update: (chunk) => chunks.push(chunk) });
    expect(textOf(result)).toBe("café\nlater\n");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe("café\nlater\n");
    expect(chunks.every((chunk) => !chunk.includes("\uFFFD"))).toBe(true);
  });

  it("runs in cwd and combines stdout and stderr", async () => {
    const result = await call(bashTool, { command: "pwd; echo out; echo err >&2" }, context(dir));
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(`${await fs.realpath(dir)}\nout\nerr\n`);
    expect((result.details as BashDetails).exitCode).toBe(0);
    expect(textOf(await call(bashTool, { command: "true" }, context(dir)))).toBe("(no output)");
  });

  it("reports a non-zero exit as an error result with the code in details", async () => {
    const result = await call(bashTool, { command: "echo nope; exit 3" }, context(dir));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("nope\n\n\nCommand exited with code 3");
    expect((result.details as BashDetails).exitCode).toBe(3);
  });

  it("times out, killing the whole process group", async () => {
    const pidFile = path.join(dir, "pid");
    const started = Date.now();
    const result = await call(bashTool, { command: `sleep 30 & echo $! > ${pidFile}; wait`, timeout: 0.3 }, context(dir));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(textOf(result)).toBe("Command timed out after 0.3 seconds");
    expect(result.details).toMatchObject({ exitCode: null, timedOut: true });
    const pid = Number(await fs.readFile(pidFile, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alive(pid)).toBe(false);
  });

  it("stops a command that names no timeout after the default, which its description states", async () => {
    const tool = makeBashTool(0.3);
    expect(tool.description).toContain("stopped after 0.3 seconds");
    const result = await call(tool, { command: "sleep 30" }, context(dir));
    expect(textOf(result)).toBe("Command timed out after 0.3 seconds");
    expect(result.details).toMatchObject({ exitCode: null, timedOut: true });
  });

  it("aborts through the signal", async () => {
    const controller = new AbortController();
    const pending = call(bashTool, { command: "echo started; sleep 30" }, context(dir, controller.signal));
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    expect(textOf(result)).toBe("started\n\n\nCommand aborted");
    expect(result.details).toMatchObject({ aborted: true });
  });

  it("does not start the command when aborted while the working directory is checked", async () => {
    const marker = path.join(dir, "ran");
    const controller = new AbortController();
    // Direct execute so the abort lands while the cwd lookup is pending, after the initial signal check.
    const pending = Promise.resolve(bashTool.execute({ command: `touch ${marker}` }, context(dir, controller.signal)));
    controller.abort();
    await expect(pending).rejects.toThrow("Command aborted");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it("does not wait for a background process that inherited the pipes", async () => {
    const started = Date.now();
    const result = await call(bashTool, { command: "sleep 5 & echo done" }, context(dir));
    expect(textOf(result)).toBe("done\n");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("keeps the tail of long output and saves the rest to a file", async () => {
    const result = await call(bashTool, { command: "seq 1 3000" }, context(dir));
    const text = textOf(result);
    const details = result.details as BashDetails;
    expect(text.startsWith("1001\n")).toBe(true);
    expect(text).toContain(`[Showing lines 1001-3000 of 3000. Full output: ${details.fullOutputPath}]`);
    const full = await fs.readFile(details.fullOutputPath!, "utf8");
    expect(full.split("\n").length).toBe(3001);
    await fs.rm(details.fullOutputPath!);
  });

  it("saves the full output where only this user can read it", async () => {
    const result = await call(bashTool, { command: "seq 1 3000" }, context(dir));
    const file = (result.details as BashDetails).fullOutputPath!;
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(path.basename(file)).toMatch(/^lemma-bash-[0-9a-f]{16}\.log$/);
  });

  it("cuts output past 50KB by bytes, and one long line to its end", async () => {
    // 1000 lines of 100 bytes: under the line limit, over the byte limit.
    const lines = await call(bashTool, { command: "for i in $(seq 1 1000); do printf '%099d\\n' $i; done" }, context(dir));
    const linesDetails = lines.details as BashDetails;
    expect(linesDetails.truncation).toMatchObject({ truncated: true, truncatedBy: "bytes", totalLines: 1000 });
    expect(textOf(lines)).toContain(`(50.0KB limit). Full output: ${linesDetails.fullOutputPath}]`);
    expect(textOf(lines).split("\n")[0]).toBe(String(1000 - linesDetails.truncation!.outputLines + 1).padStart(99, "0"));
    expect((await fs.readFile(linesDetails.fullOutputPath!, "utf8")).length).toBe(100_000);

    const line = await call(bashTool, { command: "head -c 60000 /dev/zero | tr '\\0' a; echo b" }, context(dir));
    const lineDetails = line.details as BashDetails;
    expect(lineDetails.truncation).toMatchObject({ truncated: true, lastLinePartial: true, totalLines: 1 });
    expect(textOf(line)).toMatch(/^a+b\n\n\[Showing last 50\.0KB of line 1 \(line is 58\.6KB\)\. Full output: /);
  });

  it("reports a failed command's exit code after truncated output", async () => {
    const result = await call(bashTool, { command: "seq 1 3000; exit 7" }, context(dir));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Full output: [^\]]+\]\n\nCommand exited with code 7$/);
    expect(result.details).toMatchObject({ exitCode: 7, truncation: { truncated: true } });
  });

  it("rejects an invalid timeout and a missing cwd", async () => {
    await expect(call(bashTool, { command: "true", timeout: -1 }, context(dir))).rejects.toThrow("Invalid timeout");
    await expect(call(bashTool, { command: "true" }, context(path.join(dir, "gone")))).rejects.toThrow("Working directory does not exist");
  });
});
