import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { settled, startLemma } from "../../../scripts/e2e.ts";
import type { Lemma } from "../../../scripts/e2e.ts";
import { ExitCode, run } from "../src/cli.ts";
import { invoke, printOnFailure } from "./invoke.ts";

describe("turns against a running host", () => {
  let lemma: Lemma;
  let home: string;
  beforeAll(async () => {
    lemma = await startLemma("lemma-cli-turns-");
    home = lemma.home;
  }, 30_000);
  afterAll(() => lemma?.stop());
  printOnFailure(() => lemma?.output());

  test("run sends a prompt and prints the reply; --follow --json streams events and ends with the result", async () => {
    const session = (await invoke(["session", "new", "--cwd", home], home)).out;
    expect(await invoke(["session", "title", session, "CLI", "test"], home)).toMatchObject({ code: ExitCode.ok, out: `${session}  CLI test` });
    expect(await invoke(["session", "pin", session], home)).toMatchObject({ code: ExitCode.ok, out: `${session}  pinned` });
    expect(await invoke(["session", "archive", session], home)).toMatchObject({ code: ExitCode.ok, out: `${session}  archived` });
    expect((await invoke(["session", "list", "--all"], home)).out).toContain("CLI test [pinned] [archived]");
    expect(await invoke(["session", "unarchive", session], home)).toMatchObject({ code: ExitCode.ok, out: `${session}  unarchived` });
    const doomed = (await invoke(["session", "new", "--cwd", home], home)).out;
    expect(await invoke(["session", "delete", doomed], home)).toMatchObject({ code: ExitCode.ok, out: `${doomed}  deleted` });
    expect((await invoke(["session", "list", "--all"], home)).out).not.toContain(doomed);

    const plain = await invoke(["run", session, "check", "the", "shell", "--model", "mock/scripted"], home);
    expect(plain.code).toBe(ExitCode.ok);
    expect(plain.out).toContain("Everything works end to end.");
    expect(plain.out).toMatch(/── turn done · 2 steps · 1 tool call/);

    const followed = await invoke(["run", session, "again", "--model", "mock/scripted", "--follow", "--json"], home);
    const lines = followed.out.split("\n").map((line) => JSON.parse(line));
    expect(lines.some((event) => event.type === "turn-started")).toBe(true);
    expect(lines.some((event) => event.type === "delta" && event.event.type === "toolcall-end")).toBe(true);
    // The command's output also streams live (order across event kinds is not guaranteed, so only its arrival is checked).
    expect(lines.some((event) => event.type === "tool-output" && event.chunk.includes("hello from lemma"))).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: "result", session, reason: "done", steps: 2, toolCalls: 1 });

    const tools = JSON.parse((await invoke(["inspect", session, "--filter", "kind:tool", "--json"], home)).out);
    expect(tools.map((record: { tool: string; status: string }) => [record.tool, record.status])).toEqual([
      ["bash", "ok"],
      ["bash", "ok"],
    ]);
    // The host consumes the INIT_CWD it was started with, so a CLI the agent runs uses the agent's directory.
    expect(JSON.stringify(tools)).toContain("INIT_CWD=unset");
    // Longest first; the records without a duration (the prompt, the system prompt) last.
    const durations = JSON.parse((await invoke(["inspect", session, "--records", "--sort", "duration", "--desc", "--json"], home)).out).map(
      (record: { duration?: number }) => record.duration ?? -1,
    );
    expect(durations).toEqual([...durations].sort((a, b) => b - a));
    expect(durations[0]).toBeGreaterThanOrEqual(0);
    expect((await invoke(["cancel", session], home)).code).toBe(ExitCode.ok);
  }, 30_000);

  test("a prompt sent while a turn runs is queued or steers it; a queued one can be withdrawn; a request id sends it once", async () => {
    const session = (await invoke(["session", "new", "--cwd", home], home)).out;
    // Its answer stops halfway until the steer below is in.
    const first = invoke(["run", session, "ramble on gate:steer", "--model", "mock/scripted", "--json"], home);
    await settled(
      async () => JSON.parse((await invoke(["status", "--json"], home)).out).running as string[],
      (running) => running.includes(session),
    );
    const queued = invoke(["run", session, "afterwards", "--request-id", "q1", "--json"], home);
    const listed = await settled(
      async () => JSON.parse((await invoke(["queue", session, "--json"], home)).out) as { requestId: string; mode: string }[],
      (queue) => queue.some((item) => item.requestId === "q1"),
    );
    expect(listed).toEqual([expect.objectContaining({ requestId: "q1", mode: "follow-up" })]);
    expect((await invoke(["queue", session], home)).out).toMatch(/follow-up\s+q1\s+\S+\s+afterwards/);
    expect((await invoke(["withdraw", session, "q1"], home)).code).toBe(ExitCode.ok);
    const withdrawn = await queued;
    expect(withdrawn.code).toBe(ExitCode.failed);
    expect(JSON.parse(withdrawn.err).error.code).toBe("Retracted");
    expect((await invoke(["withdraw", session, "q1", "--json"], home)).code).toBe(ExitCode.failed);

    // A steer joins the running turn: both runs report that one turn.
    const steered = invoke(["run", session, "also check the shell", "--steer", "--request-id", "s1", "--json"], home);
    await settled(
      async () => JSON.parse((await invoke(["queue", session, "--json"], home)).out) as { requestId: string }[],
      (queue) => queue.some((item) => item.requestId === "s1"),
    );
    lemma.mock.open("steer");
    const [ramble, steer] = await Promise.all([first, steered]);
    expect(ramble.code).toBe(ExitCode.ok);
    expect(steer.code).toBe(ExitCode.ok);
    const turn = JSON.parse(ramble.out).turn as string;
    expect(JSON.parse(steer.out)).toMatchObject({ turn, reason: "done", toolCalls: 1 });
    // The same request id again reports that turn instead of placing the prompt twice.
    expect(JSON.parse((await invoke(["run", session, "also check the shell", "--request-id", "s1", "--json"], home)).out).turn).toBe(turn);
    const { branch } = JSON.parse((await invoke(["session", "show", session, "--json"], home)).out) as { branch: { data: { type: string } }[] };
    expect(branch.filter((event) => event.data.type === "turn-start")).toHaveLength(1);
    expect((await invoke(["run", session, "x", "--steer", "--when-busy", "reject"], home)).code).toBe(ExitCode.usage);
  }, 30_000);

  test("events follows the host's own events and its subsystems' streams; --session keeps one session's, with its log", async () => {
    const session = (await invoke(["session", "new", "--cwd", home], home)).out;
    const other = (await invoke(["session", "new", "--cwd", home], home)).out;
    const lines: { from: string; element: any }[] = [];
    const interrupt = new AbortController();
    const following = run(["events", "--session", session, "--json"], {
      env: { LEMMA_HOME: home },
      cwd: "/",
      out: (text) => void lines.push(JSON.parse(text)),
      err: () => {},
      interrupt: interrupt.signal,
    });
    const of = (from: string) => lines.filter((line) => line.from === from).map((line) => line.element);
    // Each stream says first that it is live: commands.changes with the list of commands.
    const live = ["agent.activity", "sessions.changes", "llm.changes", "sessions.log"].map(
      (from) => () => of(from).some((element) => element.type === "subscribed"),
    );
    expect(await settled(async () => [...live, () => of("commands.changes").length > 0].every((done) => done()) || undefined)).toBe(true);

    expect((await invoke(["session", "title", other, "elsewhere"], home)).code).toBe(ExitCode.ok);
    expect((await invoke(["run", session, "check the shell", "--model", "mock/scripted"], home)).code).toBe(ExitCode.ok);
    expect(
      await settled(async () => of("sessions.log").some((element) => element.type === "appended" && element.event.data.type === "turn-end") || undefined),
    ).toBe(true);
    interrupt.abort();
    expect(await following).toBe(ExitCode.interrupted);

    const activity = of("agent.activity").filter((element) => element.type !== "subscribed");
    expect(activity.map((element) => element.type)).toEqual(expect.arrayContaining(["turn-started", "delta", "tool-output", "turn-ended"]));
    expect(activity.every((element) => element.sessionId === session)).toBe(true);
    const changed = of("sessions.changes").filter((element) => element.type !== "subscribed");
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((element) => element.info.id === session)).toBe(true);
    // Its log from when it began following, in order without gaps.
    const seqs = of("sessions.log").flatMap((element) =>
      element.type === "appended" ? [element.event.seq] : element.events.map((event: { seq: number }) => event.seq),
    );
    expect(seqs[0]).toBe(1);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    // The host's own events: what the subsystems report comes on their streams.
    const runtime = ["notice", "interaction", "interaction-closed", "plugins-changed", "channels-changed", "ui-changed"];
    expect(of("host").every((element) => runtime.includes(element.type))).toBe(true);
  }, 30_000);

  test("a retried run reports the turn that placed its prompt, even after a checkout left it off the branch", async () => {
    const session = (await invoke(["session", "new", "--cwd", home], home)).out;
    const first = JSON.parse((await invoke(["run", session, "first", "--request-id", "b1", "--json"], home)).out);
    const second = JSON.parse((await invoke(["run", session, "second", "--request-id", "b2", "--json"], home)).out);
    expect(second.turn).not.toBe(first.turn);
    const { branch } = JSON.parse((await invoke(["session", "show", session, "--json"], home)).out) as {
      branch: { id: string; data: Record<string, unknown> }[];
    };
    const firstEnd = branch.find((event) => event.data.type === "turn-end" && event.data.turnId === first.turn)!;
    expect((await invoke(["session", "checkout", session, firstEnd.id], home)).code).toBe(ExitCode.ok);
    const retried = JSON.parse((await invoke(["run", session, "second", "--request-id", "b2", "--json"], home)).out);
    expect(retried).toMatchObject({ turn: second.turn, reason: "done", text: second.text });
  }, 30_000);

  test("a retried run --follow shows the turn that placed its prompt: its answer when done, all of it when running", async () => {
    const session = (await invoke(["session", "new", "--cwd", home], home)).out;
    const done = await invoke(["run", session, "check the shell", "--request-id", "d1", "--follow"], home);
    expect(done.out).toContain("Everything works end to end.");
    const again = await invoke(["run", session, "check the shell", "--request-id", "d1", "--follow"], home);
    expect(again.code).toBe(ExitCode.ok);
    expect(again.out).toContain("Everything works end to end.");

    // Retried while it runs: what it said before the retry, then the rest as it comes, once each, in order. The answer
    // stops halfway until the retry has shown that half.
    const running = invoke(["run", session, "ramble on gate:retry", "--request-id", "r1"], home);
    await lemma.mock.reached("retry");
    let shown = "";
    const joined = run(["run", session, "ramble on gate:retry", "--request-id", "r1", "--follow"], {
      env: { LEMMA_HOME: home },
      cwd: "/",
      out: (text) => {
        shown += `${text}\n`;
      },
      write: (text) => {
        shown += text;
      },
      err: () => {},
    });
    expect(
      await settled(
        async () => shown,
        (text) => text.includes("word30 "),
      ),
    ).toBeDefined();
    lemma.mock.open("retry");
    expect(await joined).toBe(ExitCode.ok);
    const words = [...shown.matchAll(/word(\d+)/g)].map((match) => Number(match[1]));
    expect(words).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect((await running).code).toBe(ExitCode.ok);
  }, 30_000);
});
