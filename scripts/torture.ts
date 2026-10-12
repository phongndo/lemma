// The harness from the outside, under process faults, as TigerBeetle's Vörtex tests theirs: a real host, the scripted
// provider over HTTP (so the provider plugin's real code runs), and the CLI over the transport, driven by a seeded
// workload while the host is killed (`kill -9`) and restarted, or stopped (`SIGSTOP`) and continued. Then the faults
// stop, every prompt is asked for again by its request id, and what clients can see is checked:
//
// - safety, from each session's log read through `session show`: every event's parent is the one before it; turns
//   open and close in pairs, one at a time; each tool call is answered once; a request id is placed at most once, and
//   once when asking for it again finds a turn; a tool call that is unsafe to repeat ran at most once (`tally.log`);
// - liveness: asked for again, every prompt reaches the end of a turn, and then nothing runs and nothing is queued.
//
// The workload replays from its seed; the processes' timing does not, so unlike the simulator (packages/sim) a failing
// run is not replayed bit for bit. It runs nightly.
//
//   node --conditions=lemma-source scripts/torture.ts [--seed <n>] [--seconds <n>]
//
// `LEMMA_TORTURE_SEED` and `LEMMA_TORTURE_SECONDS` do the same; the default is a random seed and 30 seconds.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { run as cli } from "../apps/cli/src/cli.ts";
import { Prng } from "../packages/sim/src/random.ts";
import { startLemma } from "./e2e.ts";

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
  return { code, out: out.trim(), err: err.join("\n") };
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

/** The host stopped (`SIGSTOP`) and not yet continued, or killed and not yet started again. */
let stopped = false;
let dead = false;

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
    const queue = await json<readonly { readonly requestId: string }[]>("queue", session).catch(() => []);
    if (queue.length > 0) track(lemmaCli("withdraw", session, prng.pick(queue).requestId));
  },
  kill: async () => {
    if (stopped) return;
    const host = lemma.host;
    const exited = new Promise((resolve) => host.once("exit", resolve));
    host.kill("SIGKILL");
    await exited;
    dead = true;
    await delay(prng.between(0, 500));
    await lemma.restart();
    dead = false;
  },
  pause: async () => {
    if (dead) return;
    lemma.host.kill("SIGSTOP");
    stopped = true;
    await delay(prng.between(100, 2_000));
    lemma.host.kill("SIGCONT");
    stopped = false;
  },
  wait: async () => void (await delay(prng.between(20, 400))),
};
const weights: Readonly<Record<keyof typeof actions, number>> = { prompt: 30, retry: 8, cancel: 4, withdraw: 5, kill: 3, pause: 3, wait: 30 };

const output = () => `${lemma.output()}\ntorture: seed ${seed}`;
try {
  const deadline = Date.now() + seconds * 1_000;
  while (Date.now() < deadline) {
    const action = prng.weighted(weights)!;
    count(action);
    await actions[action]();
  }

  // Liveness: no more faults, and every prompt asked for again by its id reaches the end of a turn.
  if (stopped) lemma.host.kill("SIGCONT");
  if (lemma.host.exitCode !== null || lemma.host.signalCode !== null) await lemma.restart();
  const outcomes = new Map<string, "placed" | "retracted">();
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
      if (turn?.reason !== undefined) {
        outcomes.set(id, "placed");
        count(`turn ${turn.reason}`);
        if (turn.reason === "error") violations.push(`liveness: ${id} (${prompt.text}, in ${prompt.session}) ended in error: ${turn.error ?? result.out}`);
      } else if (/retract|withdrawn/i.test(result.err)) outcomes.set(id, "retracted");
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

  // Safety, from the logs as clients read them.
  const placed = new Map<string, number>();
  for (const session of sessions) {
    const { branch } = await json<{
      readonly branch: readonly { readonly seq: number; readonly id: string; readonly parent: string | null; readonly data: any }[];
    }>("session", "show", session);
    let open: string | undefined;
    let calls: Map<string, number> | undefined;
    const answered = () => {
      for (const [call, results] of calls ?? []) if (results !== 1) violations.push(`${session}: tool call ${call} has ${results} result(s)`);
    };
    branch.forEach((event, index) => {
      const before = branch[index - 1];
      if (event.parent !== (before?.id ?? null)) violations.push(`${session}: event ${event.seq} follows ${event.parent}, not ${before?.id ?? "nothing"}`);
      if (before !== undefined && event.seq <= before.seq) violations.push(`${session}: seq ${event.seq} after ${before.seq}`);
      const data = event.data;
      if (data.type === "turn-start") {
        if (open !== undefined) violations.push(`${session}: turn ${data.turnId} starts inside ${open}`);
        open = data.turnId;
      } else if (data.type === "turn-end") {
        if (open !== data.turnId) violations.push(`${session}: turn ${data.turnId} ends, but ${open ?? "none"} is open`);
        open = undefined;
      } else if (data.type === "message" && data.message.role === "assistant") {
        answered();
        calls = new Map(data.message.content.filter((part: any) => part.type === "toolCall").map((part: any) => [part.id, 0]));
      } else if (data.type === "message" && data.message.role === "toolResult") {
        const id = data.message.toolCallId;
        if (calls?.has(id) !== true) violations.push(`${session}: a result for ${id}, which the last answer did not call`);
        else calls.set(id, calls.get(id)! + 1);
      } else if (data.type === "message" && data.message.role === "user" && data.requestId !== undefined) {
        placed.set(data.requestId, (placed.get(data.requestId) ?? 0) + 1);
      }
    });
    answered();
    if (open !== undefined) violations.push(`${session}: turn ${open} never ended`);
  }
  for (const [id, times] of placed) if (times > 1) violations.push(`request ${id} was placed ${times} times`);
  for (const [id, outcome] of outcomes) {
    const times = placed.get(id) ?? 0;
    if (outcome === "placed" && times !== 1) violations.push(`request ${id} answered from a turn, but is placed ${times} times`);
    if (outcome === "retracted" && times !== 0) violations.push(`request ${id} was refused as withdrawn, but is placed`);
  }
  // A command unsafe to repeat is never run again after a crash: each call's id is tallied once at most.
  const tallied = (await readFile(join(lemma.home, "tally.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  for (const id of new Set(tallied)) if (tallied.filter((line) => line === id).length > 1) violations.push(`tool call ${id} ran more than once`);
  for (const outcome of outcomes.values()) count(outcome);
} catch (error) {
  violations.push(`the run failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  await Promise.race([Promise.allSettled(inFlight), delay(5_000)]);
  if (violations.length > 0) console.error(output());
  await lemma.stop();
}
console.log(`torture: ${[...counts].map(([what, times]) => `${what} ${times}`).join(", ")}`);
if (violations.length > 0) {
  console.error(`torture: ${violations.length} violation(s), seed ${seed}:\n${violations.map((violation) => `  ${violation}`).join("\n")}`);
  process.exit(1);
}
console.log("torture: no violations");
process.exit(0);
