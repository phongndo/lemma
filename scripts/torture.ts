// The harness from the outside, under process faults, as TigerBeetle's Vörtex tests theirs: a real host, the scripted
// provider over HTTP (so the provider plugin's real code runs), and the CLI over the transport, driven by a seeded
// workload while the host is killed (`kill -9`) and restarted, or stopped (`SIGSTOP`) and continued. Then the faults
// stop, every prompt is asked for again by its request id, and what clients can see is checked:
//
// - safety, from each session's whole log read through the `sessions.events` channel: seqs in order, each event's
//   parent an earlier one, and nothing off the session's branch but titles; on the branch, turns opening and closing
//   in pairs, one at a time; across the log, each tool call answered once, a request id placed at most once (and once
//   when asking for it again finds a turn), and a tool call unsafe to repeat run at most once (`tally.log`);
// - liveness: asked for again, every prompt reaches the end of a turn, and then nothing runs and nothing is queued;
// - and the host exits only when the torture kills it.
//
// The workload replays from its seed; the processes' timing does not, so unlike the simulator (packages/sim) a failing
// run is not replayed bit for bit. It runs nightly.
//
//   node --conditions=lemma-source scripts/torture.ts [--seed <n>] [--seconds <n>]
//
// `LEMMA_TORTURE_SEED` and `LEMMA_TORTURE_SECONDS` do the same; the default is a random seed and 30 seconds.
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { run as cli } from "../apps/cli/src/cli.ts";
import { Prng } from "../packages/sim/src/random.ts";
import { startLemma } from "./e2e.ts";
import { failureArtifact } from "../packages/testing/src/artifacts.ts";

const { values } = parseArgs({ options: { seed: { type: "string" }, seconds: { type: "string" } } });
const seed = Number(values.seed ?? process.env.LEMMA_TORTURE_SEED ?? Math.floor(Math.random() * 2 ** 31));
const seconds = Number(values.seconds ?? process.env.LEMMA_TORTURE_SECONDS ?? 30);
console.log(`torture: seed ${seed}, ${seconds} s (the same workload again: pnpm torture --seed ${seed})`);

/** Sessions the workload spreads over. */
const SESSIONS = 3;
/** How long, once the faults stop, every prompt has to reach the end of a turn. */
const LIVENESS_MS = 120_000;
/** The provider's pause between streamed words: long enough that a fault lands mid-answer. */
const PACE_MS = 15;

const prng = new Prng(seed);
const lemma = await startLemma("lemma-torture-", { paceMs: PACE_MS, plugins: { "agent.loop": { config: { defaultModel: "mock/scripted" } } } });
const violations: string[] = [];
const counts = new Map<string, number>();
/** The run's latest actions and CLI calls, for a failure's evidence: the last 500, so a long run's stay small. */
const recent: object[] = [];
const remember = (entry: object) => {
  recent.push({ atMs: Date.now(), ...entry });
  if (recent.length > 500) recent.shift();
};
const count = (what: string) => counts.set(what, (counts.get(what) ?? 0) + 1);

/** Runs the CLI in this process against the host's home; a call the host could not answer (it was killed) fails. */
const lemmaCli = async (...argv: string[]) => {
  let out = "";
  const err: string[] = [];
  const code = await cli([...argv], {
    env: { LEMMA_HOME: lemma.home },
    cwd: lemma.home,
    out: (text) => void (out += `${text}\n`),
    write: (text) => void (out += text),
    err: (text) => void err.push(text),
  }).catch((error: unknown) => {
    err.push(String(error));
    return 1;
  });
  const result = { code, out: out.trim(), err: err.join("\n") };
  remember({ argv, code, out: result.out.slice(-2_000), err: result.err });
  return result;
};
const json = async <A>(...argv: string[]): Promise<A> => {
  const result = await lemmaCli(...argv, "--json");
  if (result.code !== 0) throw new Error(`lemma ${argv.join(" ")} failed: ${result.err}`);
  return JSON.parse(result.out) as A;
};

interface Sent {
  readonly session: string;
  readonly text: string;
  readonly mode: "follow-up" | "steer";
}
const sent = new Map<string, Sent>();
const inFlight = new Set<Promise<unknown>>();
const track = (work: Promise<unknown>) => {
  inFlight.add(work);
  void work.finally(() => inFlight.delete(work));
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Hosts the torture stopped itself: any other's exit is a violation (an error no plugin owned, a failed start). */
const killed = new WeakSet<ChildProcess>();
const watchHost = (host: ChildProcess) =>
  host.once("exit", (code, signal) => {
    if (!killed.has(host)) violations.push(`the host (pid ${host.pid}) exited by itself: ${signal ?? `code ${code}`}`);
  });
const exited = (host: ChildProcess) => host.exitCode !== null || host.signalCode !== null;
watchHost(lemma.host);
// Interrupted (Ctrl-C), it continues a host it stopped, so the host can stop, and removes the home.
/** Set once interrupted: the workload stops, and no host starts again, as everything is being stopped. */
let stopping = false;
const interrupted = (signal: NodeJS.Signals) => {
  stopping = true;
  killed.add(lemma.host);
  lemma.host.kill("SIGCONT");
  void lemma.stop().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
};
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);

const sessions: string[] = [];
for (let n = 0; n < SESSIONS; n++) sessions.push((await lemmaCli("session", "new", "--cwd", lemma.home)).out);

const actions = {
  prompt: async () => {
    const id = `t${sent.size + 1}`;
    const prompt: Sent = {
      session: prng.pick(sessions),
      text: prng.pick(["say hello", "ramble a while", "tally it"]),
      mode: prng.pick(["follow-up", "steer"]),
    };
    sent.set(id, prompt);
    track(lemmaCli("run", prompt.session, prompt.text, "--request-id", id, "--when-busy", prompt.mode));
  },
  // The same request again, as a client that lost its answer sends it: it must not be placed twice.
  retry: async () => {
    if (sent.size === 0) return;
    const [id, prompt] = prng.pick([...sent]);
    track(lemmaCli("run", prompt.session, prompt.text, "--request-id", id, "--when-busy", prompt.mode));
  },
  cancel: async () => void track(lemmaCli("cancel", prng.pick(sessions))),
  withdraw: async () => {
    const session = prng.pick(sessions);
    // Drawn whatever the queue holds, which timing decides: so every later draw is the seed's, as the workload is.
    const draw = prng.next();
    const queue = await json<readonly { readonly requestId: string }[]>("queue", session).catch(() => []);
    if (queue.length > 0) track(lemmaCli("withdraw", session, queue[Math.floor(draw * queue.length)]!.requestId));
  },
  kill: async () => {
    const host = lemma.host;
    const gap = prng.between(0, 500);
    killed.add(host);
    if (!exited(host)) {
      const gone = new Promise((resolve) => host.once("exit", resolve));
      host.kill("SIGKILL");
      await gone;
    }
    await delay(gap);
    if (!stopping) watchHost(await lemma.restart());
  },
  pause: async () => {
    const pause = prng.between(100, 2_000);
    if (exited(lemma.host)) return;
    lemma.host.kill("SIGSTOP");
    await delay(pause);
    lemma.host.kill("SIGCONT");
  },
  wait: async () => void (await delay(prng.between(20, 400))),
};
const weights: Readonly<Record<keyof typeof actions, number>> = { prompt: 30, retry: 8, cancel: 4, withdraw: 5, kill: 3, pause: 3, wait: 30 };

const output = () => `${lemma.output()}\ntorture: seed ${seed}`;
try {
  const deadline = Date.now() + seconds * 1_000;
  while (Date.now() < deadline && !stopping) {
    const action = prng.weighted(weights)!;
    remember({ action });
    count(action);
    await actions[action]();
  }

  // Liveness: no more faults, and every prompt asked for again by its id reaches the end of a turn. (A host that
  // exited by itself is a violation already; one starts again, to check the rest.)
  if (stopping) await new Promise(() => {});
  if (exited(lemma.host)) watchHost(await lemma.restart());
  const outcomes = new Map<string, "placed" | "retracted">();
  const reasons = new Map<string, string>();
  const asked = Promise.all(
    [...sent].map(async ([id, prompt]) => {
      const result = await lemmaCli("run", prompt.session, prompt.text, "--request-id", id, "--when-busy", "follow-up", "--json");
      const turn = (() => {
        try {
          return JSON.parse(result.out) as { readonly reason?: string; readonly error?: string };
        } catch {
          return undefined;
        }
      })();
      // A turn it was placed in answers however it ended; one withdrawn, or cancelled before its turn started, is
      // refused for good.
      const refused = (() => {
        try {
          // The JSON error is the last line: a notice (reconnecting, say) may come before it.
          return (JSON.parse(result.err.trim().split("\n").at(-1) ?? "") as { readonly error?: { readonly code?: string } }).error?.code;
        } catch {
          return undefined;
        }
      })();
      if (turn?.reason !== undefined) {
        outcomes.set(id, "placed");
        reasons.set(id, turn.reason);
        count(`turn ${turn.reason}`);
        if (turn.reason === "error") violations.push(`liveness: ${id} (${prompt.text}, in ${prompt.session}) ended in error: ${turn.error ?? result.out}`);
      } else if (refused === "Retracted") outcomes.set(id, "retracted");
      else violations.push(`liveness: asked again, ${id} (${prompt.text}, in ${prompt.session}) failed with ${result.code}: ${result.err}${result.out}`);
    }),
  );
  const timedOut = await Promise.race([asked.then(() => false), delay(LIVENESS_MS).then(() => true)]);
  if (timedOut) violations.push(`liveness: not every prompt reached the end of a turn within ${LIVENESS_MS} ms`);
  else {
    const status = await json<{ readonly running?: readonly unknown[] }>("status");
    if ((status.running ?? []).length > 0) violations.push(`liveness: turns still running: ${JSON.stringify(status.running)}`);
    for (const session of sessions) {
      const queue = await json<readonly unknown[]>("queue", session);
      if (queue.length > 0) violations.push(`liveness: ${session} still queues ${queue.length} prompt(s)`);
    }
  }

  // Safety, from the logs as clients read them: each session's whole log, in the order of its file, and its branch.
  interface Logged {
    readonly seq: number;
    readonly id: string;
    readonly parent: string | null;
    readonly data: any;
  }
  const placed = new Map<string, number>();
  const calls = new Map<string, number>();
  for (const session of sessions) {
    const log = await json<readonly Logged[]>("channels", "call", "sessions.events", JSON.stringify({ sessionId: session }));
    const { branch } = await json<{ readonly branch: readonly Logged[] }>("session", "show", session);
    const seen = new Set<string>();
    const onBranch = new Set(branch.map((event) => event.id));
    log.forEach((event, index) => {
      if (event.seq !== index + 1) violations.push(`${session}: event ${index + 1} of the log has seq ${event.seq}`);
      if (event.parent !== null && !seen.has(event.parent)) violations.push(`${session}: event ${event.seq} follows ${event.parent}, which is not before it`);
      seen.add(event.id);
      // Off the branch, only what may hang off it: a title, renamed at the leaf as a turn ran.
      if (!onBranch.has(event.id) && event.data.type !== "title")
        violations.push(`${session}: event ${event.seq} (${event.data.type}) is off the session's branch`);
      const data = event.data;
      if (data.type !== "message") return;
      if (data.message.role === "assistant") for (const part of data.message.content) if (part.type === "toolCall") calls.set(part.id, calls.get(part.id) ?? 0);
      if (data.message.role === "toolResult") {
        const id = data.message.toolCallId;
        if (!calls.has(id)) violations.push(`${session}: a result for ${id}, which no answer before it called`);
        calls.set(id, (calls.get(id) ?? 0) + 1);
      }
      if (data.message.role === "user" && data.requestId !== undefined) placed.set(data.requestId, (placed.get(data.requestId) ?? 0) + 1);
    });
    let open: string | undefined;
    for (const { data } of branch) {
      if (data.type === "turn-start") {
        if (open !== undefined) violations.push(`${session}: turn ${data.turnId} starts inside ${open}`);
        open = data.turnId;
      } else if (data.type === "turn-end") {
        if (open !== data.turnId) violations.push(`${session}: turn ${data.turnId} ends, but ${open ?? "none"} is open`);
        open = undefined;
      }
    }
    if (open !== undefined) violations.push(`${session}: turn ${open} never ended`);
  }
  for (const [call, results] of calls) if (results !== 1) violations.push(`tool call ${call} has ${results} result(s)`);
  for (const [id, times] of placed) if (times > 1) violations.push(`request ${id} was placed ${times} times`);
  for (const [id, outcome] of outcomes) {
    const times = placed.get(id) ?? 0;
    if (outcome === "placed" && times !== 1) violations.push(`request ${id} answered from a turn, but is placed ${times} times`);
    if (outcome === "retracted" && times !== 0) violations.push(`request ${id} was refused as withdrawn, but is placed`);
  }
  // A command unsafe to repeat is never run again after a crash: each call's id is tallied once at most.
  const tallied = (await readFile(join(lemma.home, "tally.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  for (const id of new Set(tallied)) if (tallied.filter((line) => line === id).length > 1) violations.push(`tool call ${id} ran more than once`);
  // And it runs at all: a tally turn that ended done ran its command, so the check above saw something.
  const tallies = [...sent].filter(([id, prompt]) => prompt.text === "tally it" && reasons.get(id) === "done");
  if (tallies.length > 0 && tallied.length === 0) violations.push(`${tallies.length} tally turn(s) ended done, but tally.log is empty`);
  for (const outcome of outcomes.values()) count(outcome);
} catch (error) {
  violations.push(`the run failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  await Promise.race([Promise.allSettled(inFlight), delay(5_000)]);
  if (violations.length > 0) {
    console.error(output());
    failureArtifact(
      "torture",
      {
        seed,
        seconds,
        // The same actions in the same order; the processes' timing is not replayed.
        replay: `nix develop -c pnpm torture --seed ${seed} --seconds ${seconds}`,
        violations,
        counts: Object.fromEntries(counts),
        sent: [...sent],
        recent,
      },
      { "processes.log": output() },
      // The host's durable state and the mock's record of side effects; never its token or config.
      Object.fromEntries(["sessions", "agent", "tally.log"].map((name) => [name, join(lemma.home, name)])),
    );
  }
  killed.add(lemma.host);
  // A host stopped as the run failed (a pause cut short) must go on to stop.
  lemma.host.kill("SIGCONT");
  await lemma.stop();
}
console.log(`torture: ${[...counts].map(([what, times]) => `${what} ${times}`).join(", ")}`);
if (violations.length > 0) {
  console.error(`torture: ${violations.length} violation(s), seed ${seed}:\n${violations.map((violation) => `  ${violation}`).join("\n")}`);
  process.exit(1);
}
console.log("torture: no violations");
process.exit(0);
