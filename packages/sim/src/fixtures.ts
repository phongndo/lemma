import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { makeCore } from "@lemma/core";
import { pathsPlugin } from "@lemma/contracts/testing";
import { Sessions } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";
import sessionsPlugin from "@lemma/sessions-files";
import { projectionOf } from "@lemma/testing";
import type { Projection } from "@lemma/testing";
import { HOME } from "./host.ts";
import { World } from "./world.ts";

/**
 * Session files for the format's fixture corpus (`domains/sessions/files/tests/fixtures`): what the store writes,
 * frozen, so a later change to the format or its readers that would read an old session differently fails a test
 * rather than a user's session. Written once per format version by `pnpm sim --fixtures <dir>`; never regenerated for
 * a version already committed.
 */

/** The whole lines of a file's text: a torn last line (no newline) is a write the store does not serve. */
const wholeLines = (text: string): string => {
  const end = text.lastIndexOf("\n");
  return end === -1 ? "" : text.slice(0, end + 1);
};

/** Loads each file with the real store, in a home of its own; returns the events of those that load, by file name. */
async function loadable(files: ReadonlyMap<string, string>): Promise<Map<string, readonly SessionEvent[]>> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-fixtures-"));
  try {
    for (const [relative, text] of files) {
      const target = path.join(home, "sessions", relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text);
    }
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([pathsPlugin(home, { cwd: "/fixtures" }), sessionsPlugin]);
          return yield* core.run(
            Effect.gen(function* () {
              const store = yield* Sessions;
              const out = new Map<string, readonly SessionEvent[]>();
              for (const relative of files.keys()) {
                const id = /_([A-Za-z0-9_-]+)\.jsonl$/.exec(relative)?.[1];
                if (id === undefined) continue;
                const events = yield* Effect.option(store.events(id));
                if (events._tag === "Some" && events.value.length > 0) out.set(relative, events.value);
              }
              return out;
            }),
          );
        }),
      ),
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

/** A session the workload does not make: marks, a relocation while empty, a checkout record, and a second branch. */
async function handMade(): Promise<Map<string, string>> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-fixtures-"));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([pathsPlugin(home, { cwd: "/fixtures/app" }), sessionsPlugin]);
          yield* core.run(
            Effect.gen(function* () {
              const store = yield* Sessions;
              const { id } = yield* store.create({ cwd: "/fixtures/first" });
              yield* store.relocate(id, "/fixtures/app");
              const user = yield* store.append(id, {
                type: "message",
                message: { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 },
                requestId: "fixture-1",
              });
              yield* store.append(id, { type: "title", title: "Hello" });
              yield* store.append(id, {
                type: "message",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "Hi." }],
                  api: "openai-completions",
                  provider: "fixture",
                  model: "fixture-model",
                  usage: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 2,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                  stopReason: "stop",
                  timestamp: 2,
                },
              });
              yield* store.mark(id, { pinned: true });
              const second = yield* store.append(id, {
                type: "message",
                message: { role: "user", content: [{ type: "text", text: "Again" }], timestamp: 3 },
                requestId: "fixture-2",
              });
              // A compaction keeping the second prompt, then a request after it: the summary replaces what came before.
              yield* store.append(id, { type: "compaction", summary: "The user said hello.", firstKeptId: second.id, tokensBefore: 10, source: "fixture" });
              yield* store.append(id, { type: "turn-start", turnId: "t1", model: "fixture/fixture-model" });
              yield* store.append(id, { type: "step-start", turnId: "t1", stepId: "s1" });
              yield* store.append(id, {
                type: "request",
                turnId: "t1",
                stepId: "s1",
                model: "fixture/fixture-model",
                composition: "fixture",
                system: "You are a fixture.",
                tools: [],
                contributions: [{ source: "agent.loop", kind: "system", label: "agent.base", chars: 18 }],
              });
              yield* store.append(id, { type: "step-end", turnId: "t1", stepId: "s1" });
              yield* store.append(id, { type: "turn-end", turnId: "t1", reason: "done" });
              yield* store.checkout(id, user.id);
              yield* store.append(id, { type: "custom", kind: "fixture.note", data: { branch: 2 } });
              yield* store.mark(id, { archived: true, pinned: false });
            }),
          );
        }),
      ),
    );
    return await readTree(path.join(home, "sessions"));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

/** Every `.jsonl` under `root`, by its path relative to it. */
async function readTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const project of await fs.readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const name of await fs.readdir(path.join(root, project.name))) {
      if (name.endsWith(".jsonl")) out.set(`${project.name}/${name}`, await fs.readFile(path.join(root, project.name, name), "utf8"));
    }
  }
  return out;
}

/**
 * Runs the workload for `seeds` and writes the session files it leaves that the store serves, at most `perSeed` a
 * seed, plus one made by hand, into `dir`, with `projections.json` beside them.
 */
export async function writeSessionFixtures(dir: string, seeds: readonly number[], ticks: number, perSeed = 2): Promise<readonly string[]> {
  const files = new Map<string, string>(await handMade());
  for (const seed of seeds) {
    const world = new World({ seed, ticks });
    await world.run();
    const left = new Map<string, string>();
    for (const file of world.disk.list()) {
      if (!file.startsWith(`${HOME}/sessions/`) || !file.endsWith(".jsonl")) continue;
      left.set(file.slice(`${HOME}/sessions/`.length), wholeLines(world.disk.read(file) ?? ""));
    }
    const served = await loadable(left);
    // The longest sessions say the most.
    const chosen = [...served].sort(([, a], [, b]) => b.length - a.length).slice(0, perSeed);
    for (const [relative] of chosen) files.set(relative, left.get(relative)!);
  }
  const served = await loadable(files);
  const projections: Record<string, Projection> = {};
  await fs.mkdir(dir, { recursive: true });
  for (const [relative, events] of served) {
    const target = path.join(dir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, files.get(relative)!);
    projections[relative] = projectionOf(events);
  }
  await fs.writeFile(path.join(dir, "projections.json"), `${JSON.stringify(projections, null, 2)}\n`);
  return [...served.keys()];
}
