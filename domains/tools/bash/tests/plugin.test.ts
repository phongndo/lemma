import * as fs from "node:fs/promises";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { definePlugin, makeCore, PluginContext, Registries } from "@lemma/core";
import { ModelNotice, PromptSections } from "@lemma/agent";
import type { SectionRequest } from "@lemma/agent";
import { Tools } from "@lemma/tools";
import type { Tool, ToolResult } from "@lemma/tools";
import { call, context, tempDir, textOf } from "@lemma/tools/testing";
import bash from "../src/index.ts";
import type { BashDetails } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

interface Notice {
  readonly sessionId: string;
  readonly id: string;
  readonly source: string;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}

/** Hears every `ModelNotice`, as the agent would. */
const listener = () => {
  const heard: Notice[] = [];
  const plugin = definePlugin({
    id: "listener",
    setup: function* () {
      const owner = yield* PluginContext;
      yield* owner.observe(ModelNotice, (notice) => Effect.sync(() => void heard.push(notice)));
    },
  });
  return { heard, plugin };
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Runs `command` in the background with the `bash` the plugin added to `Tools`, as the registry would call it. */
const background = (sessionId: string, toolCallId: string, command: string) =>
  Effect.flatMap(
    Effect.map(
      Effect.flatMap(Registries, (registries) => registries.items(Tools)),
      (items) => items.find(({ item }) => item.name === "bash")!.item as Tool,
    ),
    (tool) => Effect.promise((): Promise<ToolResult> => call(tool, { command, background: true }, { ...context(dir), sessionId, toolCallId })),
  );

describe("tools.bash", () => {
  it("lists a session's background commands to the model while they run, and tells it each exit as a notice from the plugin", async () => {
    const { heard, plugin } = listener();
    const request = (sessionId: string): SectionRequest => ({ sessionId, turnId: "t", cwd: dir, model: "p/m", tools: [], branch: [] });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([bash, plugin]);
          yield* core.run(
            Effect.gen(function* () {
              const section = (yield* Effect.flatMap(Registries, (registries) => registries.items(PromptSections))).find(
                ({ item }) => item.id === "tools.bash.jobs",
              )!;
              const listed = (sessionId: string) => Effect.promise(async () => section.item.text(request(sessionId)) as Promise<string | undefined>);
              const result = yield* background("s1", "call-1", "sleep 0.3; echo built");
              const id = (result.details as BashDetails).background!.id;
              expect(textOf(result)).toContain(`Started in the background as job ${id}`);
              expect(yield* listed("s1")).toContain(`- ${id}: \`sleep 0.3; echo built\``);
              expect(yield* listed("s2")).toBeUndefined();
              yield* Effect.promise(() => vi.waitFor(() => expect(heard).toHaveLength(1), { timeout: 5_000 }));
              expect(heard[0]).toMatchObject({ sessionId: "s1", id, source: "tools.bash" });
              expect(heard[0]!.content.map((part) => part.text).join("")).toContain("exited with code 0");
              expect(yield* listed("s1")).toBeUndefined();
            }),
          );
        }),
      ),
    );
  });

  it("keeps its background commands running through a reload, the replacement telling their exits, and stops them when it stops", async () => {
    const { heard, plugin } = listener();
    let lasting = 0;
    let shortId = "";
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([bash, plugin]);
          const start = (toolCallId: string, command: string) => core.run(background("s", toolCallId, command));
          const short = ((yield* start("short", "sleep 0.5; echo after")).details as BashDetails).background!;
          shortId = short.id;
          lasting = ((yield* start("long", "sleep 30")).details as BashDetails).background!.pid;
          yield* core.restart("tools.bash", { force: true });
          expect(alive(short.pid)).toBe(true);
          yield* Effect.promise(() => vi.waitFor(() => expect(heard.map((notice) => notice.id)).toEqual([short.id]), { timeout: 4_000 }));
          expect(alive(lasting)).toBe(true);
        }),
      ),
    );
    // The core closed, and the plugin with it: what still ran is stopped, and nothing is told of it.
    await vi.waitFor(() => expect(alive(lasting)).toBe(false), { timeout: 5_000 });
    expect(heard.map((notice) => notice.id)).toEqual([shortId]);
  });

  it("keeps each host's background commands apart in one process: its own exits told to it, and its own stopped with it", async () => {
    const first = listener();
    const second = listener();
    let lasting = 0;
    let other = 0;
    let shortId = "";
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const a = yield* makeCore([bash, first.plugin]);
          const short = ((yield* a.run(background("s", "short", "sleep 0.3; echo after"))).details as BashDetails).background!;
          shortId = short.id;
          lasting = ((yield* a.run(background("s", "long", "sleep 30"))).details as BashDetails).background!.pid;
          // A second host starts after the first's commands, and outlives the first.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const b = yield* makeCore([bash, second.plugin]);
              other = ((yield* b.run(background("s", "other", "sleep 30"))).details as BashDetails).background!.pid;
              yield* Effect.promise(() => vi.waitFor(() => expect(first.heard.map((notice) => notice.id)).toEqual([short.id]), { timeout: 4_000 }));
              expect(second.heard).toEqual([]);
              expect(alive(short.pid)).toBe(false);
            }),
          );
          // The second host stopped: its command with it, the first's running on.
          yield* Effect.promise(() => vi.waitFor(() => expect(alive(other)).toBe(false), { timeout: 5_000 }));
          expect(alive(lasting)).toBe(true);
        }),
      ),
    );
    await vi.waitFor(() => expect(alive(lasting)).toBe(false), { timeout: 5_000 });
    expect(first.heard.map((notice) => notice.id)).toEqual([shortId]);
    expect(second.heard).toEqual([]);
  });
});
