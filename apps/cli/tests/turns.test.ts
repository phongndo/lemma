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
    const session = (await invoke(["sessions", "new", "--cwd", home], home)).out;
    expect(await invoke(["sessions", "title", session, "CLI", "test"], home)).toMatchObject({ code: ExitCode.ok, out: `${session}  CLI test` });
    expect(await invoke(["sessions", "pin", session], home)).toMatchObject({ code: ExitCode.ok, out: `${session}  pinned` });
    expect(await invoke(["sessions", "archive", session], home)).toMatchObject({ code: ExitCode.ok, out: `${session}  archived` });
    expect((await invoke(["sessions", "list", "--all"], home)).out).toContain("CLI test [pinned] [archived]");
    expect(await invoke(["sessions", "unarchive", session], home)).toMatchObject({ code: ExitCode.ok, out: `${session}  unarchived` });
    const doomed = (await invoke(["sessions", "new", "--cwd", home], home)).out;
    expect(await invoke(["sessions", "delete", doomed], home)).toMatchObject({ code: ExitCode.ok, out: `${doomed}  deleted` });
    expect((await invoke(["sessions", "list", "--all"], home)).out).not.toContain(doomed);

    const plain = await invoke(["run", session, "check", "the", "shell", "--model", "mock/scripted"], home);
    expect(plain.code).toBe(ExitCode.ok);
    expect(plain.out).toContain("Everything works end to end.");
    expect(plain.out).toMatch(/── turn done · 2 steps · 1 tool call/);

    const followed = await invoke(["run", session, "again", "--model", "mock/scripted", "--follow", "--json"], home);
    const lines = followed.out.split("\n").map((line) => JSON.parse(line));
    expect(lines.some((event) => event.type === "turn-started")).toBe(true);
    // The turn as the log has it: the answer that calls the tool. Its deltas print too unless that answer overtook them
    // (the activity and the log each come in their own order), so they are not counted on here.
    const calls = (event: { type: string; event?: { data: { type: string; message?: { role: string; content: { type: string }[] } } } }) =>
      event.type === "appended" &&
      event.event?.data.message?.role === "assistant" &&
      event.event.data.message.content.some((block) => block.type === "toolCall");
    expect(lines.some(calls)).toBe(true);
    // The command's output also streams live (order across event kinds is not guaranteed, so only its arrival is checked).
    expect(lines.some((event) => event.type === "tool-output" && event.chunk.includes("hello from lemma"))).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: "result", session, reason: "done", steps: 2, toolCalls: 1 });

    const tools = JSON.parse((await invoke(["sessions", "inspect", session, "--filter", "kind:tool", "--json"], home)).out);
    expect(tools.map((record: { tool: string; status: string }) => [record.tool, record.status])).toEqual([
      ["bash", "ok"],
      ["bash", "ok"],
    ]);
    // The host consumes the INIT_CWD it was started with, so a CLI the agent runs uses the agent's directory.
    expect(JSON.stringify(tools)).toContain("INIT_CWD=unset");
    // Longest first; the records without a duration (the prompt, the system prompt) last.
    const durations = JSON.parse((await invoke(["sessions", "inspect", session, "--records", "--sort", "duration", "--desc", "--json"], home)).out).map(
      (record: { duration?: number }) => record.duration ?? -1,
    );
    expect(durations).toEqual([...durations].sort((a, b) => b - a));
    expect(durations[0]).toBeGreaterThanOrEqual(0);
    // Each plugin's share of the latest request: the agent's base prompt, and the bash tool its plugin offered.
    const shares = JSON.parse((await invoke(["sessions", "inspect", session, "--request", "last", "--plugins", "--json"], home)).out) as {
      readonly source: string;
      readonly tools: readonly string[];
    }[];
    expect(shares.find((share) => share.tools.includes("bash"))?.source).toBe("tools.bash");
    expect(shares.some((share) => share.source === "agent.loop")).toBe(true);
    // How the session kept the provider's cache: its requests, none of them changing the prompt or tools mid-session.
    const [cache] = JSON.parse((await invoke(["sessions", "cache", session, "--json"], home)).out) as { readonly requests: number; readonly changed: number }[];
    expect(cache).toMatchObject({ session, changed: 0 });
    expect(cache!.requests).toBeGreaterThanOrEqual(2);
    expect((await invoke(["agent", "cancel", session], home)).code).toBe(ExitCode.ok);
  }, 30_000);

  test("a prompt sent while a turn runs is queued or steers it; a queued one can be withdrawn; a request id sends it once", async () => {
    const session = (await invoke(["sessions", "new", "--cwd", home], home)).out;
    // Its answer stops halfway until the steer below is in.
    const first = invoke(["run", session, "ramble on gate:steer", "--model", "mock/scripted", "--json"], home);
    await settled(
      async () => JSON.parse((await invoke(["agent", "running", "--json"], home)).out) as string[],
      (running) => running.includes(session),
    );
    const queued = invoke(["run", session, "afterwards", "--request-id", "q1", "--json"], home);
    const listed = await settled(
      async () => JSON.parse((await invoke(["agent", "queue", session, "--json"], home)).out) as { requestId: string; mode: string }[],
      (queue) => queue.some((item) => item.requestId === "q1"),
    );
    expect(listed).toEqual([expect.objectContaining({ requestId: "q1", mode: "follow-up" })]);
    expect((await invoke(["agent", "queue", session], home)).out).toMatch(/follow-up\s+q1\s+\S+\s+afterwards/);
    expect((await invoke(["agent", "withdraw", session, "q1"], home)).code).toBe(ExitCode.ok);
    const withdrawn = await queued;
    expect(withdrawn.code).toBe(ExitCode.failed);
    expect(JSON.parse(withdrawn.err).error.code).toBe("Retracted");
    expect((await invoke(["agent", "withdraw", session, "q1", "--json"], home)).code).toBe(ExitCode.failed);

    // A steer joins the running turn: both runs report that one turn.
    const steered = invoke(["run", session, "also check the shell", "--steer", "--request-id", "s1", "--json"], home);
    await settled(
      async () => JSON.parse((await invoke(["agent", "queue", session, "--json"], home)).out) as { requestId: string }[],
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
    const { branch } = JSON.parse((await invoke(["sessions", "show", session, "--json"], home)).out) as { branch: { data: { type: string } }[] };
    expect(branch.filter((event) => event.data.type === "turn-start")).toHaveLength(1);
    expect((await invoke(["run", session, "x", "--steer", "--when-busy", "reject"], home)).code).toBe(ExitCode.usage);
  }, 30_000);

  test("events follows the host's own events and every stream its plugins serve that takes no payload; --channel only those", async () => {
    const session = (await invoke(["sessions", "new", "--cwd", home], home)).out;
    const other = (await invoke(["sessions", "new", "--cwd", home], home)).out;
    /** Runs `events` with `argv` until the returned stop is called, collecting its NDJSON lines. */
    const watch = (argv: readonly string[]) => {
      const lines: { from: string; element: any }[] = [];
      const interrupt = new AbortController();
      const done = run(["events", ...argv, "--json"], {
        env: { LEMMA_HOME: home },
        cwd: "/",
        out: (text) => void lines.push(JSON.parse(text)),
        err: () => {},
        interrupt: interrupt.signal,
      });
      const of = (from: string) => lines.filter((line) => line.from === from).map((line) => line.element);
      return { lines, of, stop: () => (interrupt.abort(), done) };
    };
    const all = watch([]);
    // Each stream says first that it is live: commands.changes with the list of commands.
    const live = ["agent.activity", "sessions.changes", "llm.changes"].map((from) => () => all.of(from).some((element) => element.type === "subscribed"));
    expect(await settled(async () => [...live, () => all.of("commands.changes").length > 0].every((done) => done()) || undefined)).toBe(true);

    expect((await invoke(["sessions", "title", other, "elsewhere"], home)).code).toBe(ExitCode.ok);
    expect((await invoke(["run", session, "check the shell", "--model", "mock/scripted"], home)).code).toBe(ExitCode.ok);
    expect(
      await settled(
        async () =>
          (all.of("agent.activity").some((element) => element.type === "turn-ended" && element.sessionId === session) &&
            all.of("sessions.changes").some((element) => element.info?.id === other)) ||
          undefined,
      ),
    ).toBe(true);
    expect(await all.stop()).toBe(ExitCode.interrupted);

    const activity = all.of("agent.activity").filter((element) => element.sessionId === session);
    expect(activity.map((element) => element.type)).toEqual(expect.arrayContaining(["turn-started", "delta", "tool-output", "turn-ended"]));
    // A stream that takes a payload (a session's log) is left out unless --channel names it.
    expect(all.of("sessions.log")).toEqual([]);
    // The host's own events: what the domains report comes on their streams.
    const runtime = ["notice", "interaction", "interaction-closed", "plugins-changed", "channels-changed", "web-changed"];
    expect(all.of("host").every((element) => runtime.includes(element.type))).toBe(true);

    const one = watch(["--channel", "agent.activity"]);
    expect(await settled(async () => one.of("agent.activity").some((element) => element.type === "subscribed") || undefined)).toBe(true);
    expect(await one.stop()).toBe(ExitCode.interrupted);
    expect(one.lines.every((line) => line.from === "agent.activity" || line.from === "host")).toBe(true);
  }, 30_000);

  test("a retried run reports the turn that placed its prompt, even after a checkout left it off the branch", async () => {
    const session = (await invoke(["sessions", "new", "--cwd", home], home)).out;
    const first = JSON.parse((await invoke(["run", session, "first", "--request-id", "b1", "--json"], home)).out);
    const second = JSON.parse((await invoke(["run", session, "second", "--request-id", "b2", "--json"], home)).out);
    expect(second.turn).not.toBe(first.turn);
    const { branch } = JSON.parse((await invoke(["sessions", "show", session, "--json"], home)).out) as {
      branch: { id: string; data: Record<string, unknown> }[];
    };
    const firstEnd = branch.find((event) => event.data.type === "turn-end" && event.data.turnId === first.turn)!;
    expect((await invoke(["sessions", "checkout", session, firstEnd.id], home)).code).toBe(ExitCode.ok);
    const retried = JSON.parse((await invoke(["run", session, "second", "--request-id", "b2", "--json"], home)).out);
    expect(retried).toMatchObject({ turn: second.turn, reason: "done", text: second.text });
  }, 30_000);

  test("a retried run --follow shows the turn that placed its prompt: its answer when done, all of it when running", async () => {
    const session = (await invoke(["sessions", "new", "--cwd", home], home)).out;
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
