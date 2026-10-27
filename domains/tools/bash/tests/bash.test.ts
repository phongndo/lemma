import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bashTool, makeBashTool, makeJobs } from "../src/index.ts";
import type { JobExit } from "../src/index.ts";
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

  it("keeps both ends of long output and saves all of it to a file", async () => {
    const result = await call(bashTool, { command: "seq 1 30000" }, context(dir));
    const text = textOf(result);
    const details = result.details as BashDetails;
    expect(text.length).toBeLessThanOrEqual(50_000);
    expect(text.startsWith("1\n2\n")).toBe(true);
    const [, left, headTo, tailFrom] = /\n\n\[… (\d+) lines left out: showing lines 1-(\d+) and (\d+)-30000 of 30000\. Full output: [^\]]+\]\n\n/
      .exec(text)!
      .map(Number);
    expect(left).toBe(tailFrom! - headTo! - 1);
    expect(text).toContain(
      `\n${headTo}\n\n[… ${left} lines left out: showing lines 1-${headTo} and ${tailFrom}-30000 of 30000. Full output: ${details.fullOutputPath}]\n\n${tailFrom}\n`,
    );
    expect(text.endsWith("\n30000\n")).toBe(true);
    expect(details.truncation).toMatchObject({ chars: 168_894, lines: 30_000 });
    const full = await fs.readFile(details.fullOutputPath!, "utf8");
    expect(full.split("\n").length).toBe(30_001);
    await fs.rm(details.fullOutputPath!);
  });

  it("saves the full output where only this user can read it", async () => {
    const result = await call(bashTool, { command: "seq 1 30000" }, context(dir));
    const file = (result.details as BashDetails).fullOutputPath!;
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(path.basename(file)).toMatch(/^lemma-bash-[0-9a-f]{16}\.log$/);
  });

  it("keeps its result within the call's budget, whole lines of each end, and one long line to its start and end", async () => {
    const budget = { ...context(dir), maxResultChars: 11_000 };
    const lines = await call(bashTool, { command: "for i in $(seq 1 1000); do printf '%099d\\n' $i; done" }, budget);
    const linesDetails = lines.details as BashDetails;
    expect(linesDetails.truncation).toMatchObject({ chars: 100_000, lines: 1000 });
    expect(textOf(lines).length).toBeLessThanOrEqual(10_000);
    const shown = textOf(lines).split("\n");
    expect(shown[0]).toBe("1".padStart(99, "0"));
    expect(shown.at(-2)).toBe("1000".padStart(99, "0"));
    expect(textOf(lines)).toMatch(/\[… \d+ lines left out: showing lines 1-\d+ and \d+-1000 of 1000\. Full output: /);
    expect((await fs.readFile(linesDetails.fullOutputPath!, "utf8")).length).toBe(100_000);

    const line = await call(bashTool, { command: "head -c 60000 /dev/zero | tr '\\0' a; echo b" }, budget);
    expect((line.details as BashDetails).truncation).toMatchObject({ chars: 60_002, lines: 1 });
    expect(textOf(line)).toMatch(/^a+\n\n\[… \d+ characters left out: showing the start and the end of its one line\. Full output: [^\]]+\]\n\na+b\n$/);

    // Two long lines: no line left out whole, but the end of one, the line break, and the start of the next.
    const two = await call(bashTool, { command: "head -c 30000 /dev/zero | tr '\\0' a; echo; head -c 30000 /dev/zero | tr '\\0' b" }, budget);
    expect(textOf(two)).toMatch(/^a+\n\n\[… \d+ characters left out: showing the start of line 1 and the end of line 2 of 2\. Full output: [^\]]+\]\n\nb+$/);
  });

  it("gives a script up to a megabyte of output, then its first and last half megabyte, with the exit code", async () => {
    const small = await call(bashTool, { command: "printf 'one\\ntwo'; exit 4" }, context(dir));
    expect(small.structured).toMatchObject({ output: "one\ntwo", exitCode: 4, truncated: false });
    const command = "head -c 700000 /dev/zero | tr '\\0' a; head -c 700000 /dev/zero | tr '\\0' b";
    const large = await call(bashTool, { command }, context(dir));
    const { output, truncated, fullOutputPath, exitCode } = large.structured as {
      output: string;
      truncated: boolean;
      fullOutputPath?: string;
      exitCode: number;
    };
    expect([truncated, exitCode]).toEqual([true, 0]);
    expect(output.startsWith("a".repeat(512 * 1024))).toBe(true);
    expect(output.endsWith("b".repeat(512 * 1024))).toBe(true);
    expect(output).toContain(`…[${1_400_000 - 1024 * 1024} bytes left out; the whole output is in fullOutputPath]…`);
    expect((await fs.stat(fullOutputPath!)).size).toBe(1_400_000);
  });

  it("reports a failed command's exit code after truncated output", async () => {
    const result = await call(bashTool, { command: "seq 1 30000; exit 7" }, context(dir));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Full output: [^\]]+\]\n\n\d+\n[\s\S]*\n30000\n\n\nCommand exited with code 7$/);
    expect(result.details).toMatchObject({ exitCode: 7, truncation: { lines: 30_000 } });
  });

  it("rejects an invalid timeout and a missing cwd", async () => {
    await expect(call(bashTool, { command: "true", timeout: -1 }, context(dir))).rejects.toThrow("Invalid timeout");
    await expect(call(bashTool, { command: "true" }, context(path.join(dir, "gone")))).rejects.toThrow("Working directory does not exist");
  });
});

describe("bash in the background", () => {
  /** A bash running background commands, and the exits it tells. */
  const withJobs = () => {
    const jobs = makeJobs();
    const exits: JobExit[] = [];
    let heard = () => {};
    jobs.attach((exit) => {
      exits.push(exit);
      heard();
    });
    const next = () => new Promise<void>((resolve) => (heard = resolve));
    return { jobs, exits, next, tool: makeBashTool(600, jobs) };
  };

  it("answers at once with its pid and output file, lists it while it runs, and tells its exit with both ends of its output", async () => {
    const { jobs, exits, next, tool } = withJobs();
    const exited = next();
    const started = Date.now();
    const result = await call(tool, { command: "echo one; sleep 0.3; echo two; exit 2", background: true }, context(dir));
    expect(Date.now() - started).toBeLessThan(250);
    const details = result.details as BashDetails;
    const id = details.background!.id;
    expect(details).toMatchObject({
      exitCode: null,
      background: { id: expect.stringMatching(/^job-[0-9a-f]{12}$/), pid: expect.any(Number) },
      fullOutputPath: expect.any(String),
    });
    expect(textOf(result)).toContain(`Started in the background as job ${id}, pid ${details.background!.pid}`);
    expect(jobs.running("s").map((job) => [job.id, job.toolCallId])).toEqual([[id, "c"]]);
    await exited;
    expect(jobs.running("s")).toEqual([]);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({
      exitCode: 2,
      timedOut: false,
      job: { id, toolCallId: "c", sessionId: "s", command: expect.stringContaining("echo one") },
    });
    expect(exits[0]!.text).toContain(`<background-job id="${id}"`);
    expect(exits[0]!.text).toContain("exited with code 2");
    expect(exits[0]!.text).toContain("one\ntwo");
    expect(await fs.readFile(details.fullOutputPath!, "utf8")).toBe("one\ntwo\n");
  });

  it("is stopped by a timeout it was given, and says so; the default timeout does not apply to it", async () => {
    const { exits, jobs } = withJobs();
    const tool = makeBashTool(0.1, jobs);
    await call(tool, { command: "sleep 0.3; echo done", background: true }, { ...context(dir), toolCallId: "free" });
    await call(tool, { command: "sleep 30", background: true, timeout: 0.2 }, { ...context(dir), toolCallId: "timed" });
    await vi.waitFor(() => expect(exits).toHaveLength(2), { timeout: 5_000 });
    const by = new Map(exits.map((exit) => [exit.job.toolCallId, exit]));
    expect(by.get("free")).toMatchObject({ exitCode: 0, timedOut: false });
    expect(by.get("timed")).toMatchObject({ exitCode: null, timedOut: true });
    expect(by.get("timed")!.text).toContain("timed out after 0.2 seconds");
  });

  it("kills a session's commands when stopped, telling nothing", async () => {
    const { jobs, exits, tool } = withJobs();
    const pidFile = path.join(dir, "pid");
    const result = await call(tool, { command: `sleep 30 & echo $! > ${pidFile}; wait`, background: true }, context(dir));
    await vi.waitFor(async () => expect((await fs.readFile(pidFile, "utf8").catch(() => "")).trim()).not.toBe(""), { timeout: 5_000 });
    jobs.stop("s");
    // Its exit is handled, and not told, before it leaves the running ones.
    await vi.waitFor(() => expect(jobs.running("s")).toEqual([]), { timeout: 5_000 });
    expect(exits).toEqual([]);
    const pid = Number(await fs.readFile(pidFile, "utf8"));
    await vi.waitFor(() => expect([alive(pid), alive((result.details as BashDetails).background!.pid)]).toEqual([false, false]), { timeout: 5_000 });
  });

  it("gives each job its own id, so two calls a provider gave one id are two jobs, each stopped and told", async () => {
    const { jobs, exits, tool } = withJobs();
    const first = (await call(tool, { command: "sleep 30", background: true }, { ...context(dir), toolCallId: "call_0" })).details as BashDetails;
    const second = (await call(tool, { command: "sleep 0.2", background: true }, { ...context(dir), toolCallId: "call_0" })).details as BashDetails;
    expect(first.background!.id).not.toBe(second.background!.id);
    expect(jobs.running("s").map((job) => job.id)).toEqual([first.background!.id, second.background!.id]);
    await vi.waitFor(() => expect(exits.map((exit) => exit.job.id)).toEqual([second.background!.id]), { timeout: 5_000 });
    // The first still runs, and is listed and stopped as its own.
    expect(jobs.running("s").map((job) => job.id)).toEqual([first.background!.id]);
    jobs.stop("s");
    await vi.waitFor(() => expect([jobs.running("s"), alive(first.background!.pid)]).toEqual([[], false]), { timeout: 5_000 });
  });

  it("says why a command could not be started, rather than report a job with no process", async () => {
    const { jobs, exits } = withJobs();
    await expect(jobs.start({ sessionId: "s", toolCallId: "c", command: "true", cwd: path.join(dir, "gone") })).rejects.toThrow(
      /^The command could not be started: .*ENOENT/,
    );
    expect(jobs.running("s")).toEqual([]);
    expect(exits).toEqual([]);
  });

  it("offers no background without the plugin's jobs, and says how to put a long-lived process there itself", () => {
    const properties = (tool: typeof bashTool) => Object.keys((Schema.toJsonSchemaDocument(tool.input).schema as { properties: object }).properties);
    expect(properties(bashTool)).toEqual(["command", "timeout"]);
    expect(bashTool.description).toContain("Run long-lived processes such as servers in the background (with nohup and &");
    const withJobs = makeBashTool(600, makeJobs());
    expect(properties(withJobs)).toEqual(["command", "timeout", "background"]);
    expect(withJobs.description).not.toContain("nohup");
  });
});
