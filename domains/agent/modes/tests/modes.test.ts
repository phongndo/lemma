import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Events, makeCore } from "@lemma/core";
import { Notice } from "@lemma/contracts";
import type { PluginInfo } from "@lemma/contracts";
import { hostControlPlugin } from "@lemma/contracts/testing";
import { Agent } from "@lemma/agent";
import { Sessions } from "@lemma/sessions";
import agent from "@lemma/agent-loop";
import sessions from "@lemma/sessions-files";
import tools from "@lemma/tools-registry";
import { fakeLlm, host, paths, reply, tempDir, testTools } from "../../loop/tests/fakes.ts";
import type { SessionEvent } from "@lemma/sessions";
import modes, { byName, Config, firstMode, keeps, parseMode } from "../src/index.ts";

describe("a mode file", () => {
  it("reads its fields and its body", () => {
    const mode = parseMode(
      "writing",
      [
        "---",
        "description: Drafts prose",
        "model: p/m",
        "thinking: low",
        "tools: read, write",
        'sections: ["*", "!project-context"]',
        "---",
        "",
        "You help the user write.",
        "",
      ].join("\n"),
      "user",
    );
    expect(mode).toEqual({
      name: "writing",
      description: "Drafts prose",
      model: "p/m",
      thinking: "low",
      tools: ["read", "write"],
      sections: ["*", "!project-context"],
      prompt: "You help the user write.",
      source: "user",
    });
    expect(parseMode("plain", "Just a prompt.", "project")).toEqual({ name: "plain", prompt: "Just a prompt.", source: "project" });
  });

  it("keeps what its patterns allow, the last match deciding", () => {
    expect(keeps(undefined, "bash")).toBe(true);
    expect(keeps(["read", "write"], "bash")).toBe(false);
    expect(keeps(["*", "!bash"], "bash")).toBe(false);
    expect(keeps(["*", "!bash"], "read")).toBe(true);
    expect(keeps(["mcp__*"], "mcp__github__issue")).toBe(true);
    expect(keeps(["!bash", "bash"], "bash")).toBe(true);
  });

  it("is a thread's as its first turn logged it, under the id it had before modes were named so too", () => {
    const turnStart = (plugins: Readonly<Record<string, unknown>>) => ({ data: { type: "turn-start", plugins } }) as unknown as SessionEvent;
    expect(firstMode([turnStart({ "agent.modes": "reader" })])).toEqual({ name: "reader" });
    expect(firstMode([turnStart({ "agent.profiles": "writing" }), turnStart({ "agent.modes": "work" })])).toEqual({ name: "writing" });
    expect(firstMode([turnStart({})])).toEqual({});
    expect(firstMode([])).toBeUndefined();
  });

  it("is the project's over the user's over the bundled one of a name", () => {
    const named = byName([parseMode("a", "project", "project"), parseMode("a", "bundled", "bundled"), parseMode("a", "user", "user")]);
    expect(named.get("a")?.prompt).toBe("project");
  });
});

describe("the bundled modes", () => {
  it("are work, the default, and creator, each described", async () => {
    const dir = fileURLToPath(new URL("../modes", import.meta.url));
    const files = (await fs.readdir(dir)).sort();
    expect(files).toEqual(["creator.md", "work.md"]);
    for (const file of files) expect(parseMode(file, await fs.readFile(path.join(dir, file), "utf8"), "bundled").description).toBeDefined();
    expect(Schema.decodeUnknownSync(Config)({}).default).toBe("work");
  });
});

describe("in a turn", () => {
  let home: string;
  beforeEach(async () => {
    home = await tempDir();
    await fs.mkdir(path.join(home, "modes"), { recursive: true });
    await fs.writeFile(path.join(home, "modes", "reader.md"), '---\ntools: echo\nsections: "*", "!agent.environment"\n---\nYou only read.\n');
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const turn = (
    plugins: Readonly<Record<string, unknown>> | undefined,
    config: Readonly<Record<string, unknown>> = {},
    known: readonly PluginInfo[] | undefined = undefined,
    /** Run between a first and a second prompt in the same host. */
    between?: () => Promise<void>,
  ) => {
    const llm = fakeLlm([reply("ok"), reply("ok")]);
    const toolset = testTools();
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore(
            [paths(home, home), known === undefined ? host() : hostControlPlugin(known), sessions, tools, toolset.plugin, llm.plugin, agent, modes],
            {
              configs: { "agent.modes": config },
            },
          );
          return yield* core.run(
            Effect.gen(function* () {
              const notices: string[] = [];
              yield* Effect.forkScoped(Stream.runForEach((yield* Events).stream(Notice), (notice) => Effect.sync(() => notices.push(notice.message))));
              yield* Effect.yieldNow;
              const { id } = yield* (yield* Sessions).create();
              const prompt = (yield* Agent).prompt(id, [{ type: "text", text: "go" }], plugins === undefined ? {} : { plugins });
              yield* prompt;
              if (between !== undefined) yield* Effect.andThen(Effect.promise(between), prompt);
              return { request: llm.requests[0]!, later: llm.requests[1], notices };
            }),
          );
        }),
      ),
    );
  };

  it("adds the chosen mode's prompt and keeps only the tools and sections it allows", async () => {
    const { request } = await turn({ "agent.modes": "reader" });
    expect((request.tools ?? []).map((tool) => tool.name)).toEqual(["echo"]);
    expect(request.system).toContain("You only read.");
    expect(request.system).not.toContain("<environment>");
  });

  it("takes a mode from a running plugin's package, a user's own of the name replacing it", async () => {
    await fs.mkdir(path.join(home, "pack", "modes"), { recursive: true });
    await fs.writeFile(path.join(home, "pack", "modes", "triage.md"), "---\ntools: echo\n---\nSort the inbox.\n");
    await fs.writeFile(path.join(home, "pack", "modes", "reader.md"), "The pack's reader.\n");
    const pack: PluginInfo = {
      id: "pack",
      source: "user",
      enabled: true,
      state: "active",
      provides: [],
      requires: [],
      resources: { modes: [path.join(home, "pack", "modes")] },
    };
    const triage = await turn({ "agent.modes": "triage" }, {}, [pack]);
    expect(triage.request.system).toContain("Sort the inbox.");
    const reader = await turn({ "agent.modes": "reader" }, {}, [pack]);
    expect(reader.request.system).toContain("You only read.");
    expect(reader.request.system).not.toContain("The pack's reader.");
    // Turned off, failed, or left out (not loaded): it brings none.
    const { state: _, ...unloaded } = pack;
    for (const stopped of [{ ...pack, enabled: false }, { ...pack, state: "failed" as const }, unloaded]) {
      const off = await turn({ "agent.modes": "triage" }, {}, [stopped]);
      expect(off.request.system).not.toContain("Sort the inbox.");
    }
  });

  it("reads modes from the folder they were kept in before they were named so, beneath the new one, and says where to move them", async () => {
    await fs.mkdir(path.join(home, "profiles"), { recursive: true });
    await fs.writeFile(path.join(home, "profiles", "old.md"), "---\ntools: echo\n---\nThe old one.\n");
    await fs.writeFile(path.join(home, "profiles", "reader.md"), "The old reader.\n");
    const old = await turn({ "agent.modes": "old" });
    expect(old.request.system).toContain("The old one.");
    expect(old.notices).toEqual([
      `Modes are read from ${path.join(home, "profiles")}, their folder before they were named so: move them to ${path.join(home, "modes")}`,
    ]);
    const reader = await turn({ "agent.modes": "reader" });
    expect(reader.request.system).toContain("You only read.");
    expect(reader.request.system).not.toContain("The old reader.");
  });

  it("reads a mode edited while the host runs", async () => {
    const { request, later } = await turn({ "agent.modes": "reader" }, {}, undefined, () =>
      fs.writeFile(path.join(home, "modes", "reader.md"), "You only read, and carefully.\n"),
    );
    expect(request.system).toContain("You only read.");
    // The prompt the model was given stays, so the next request extends it: the edit reaches the model as an update
    // after the new prompt, which the next request that declares the prompt afresh carries.
    expect(later?.system).toBe(request.system);
    expect(JSON.stringify(later?.messages.at(-1))).toContain("You only read, and carefully.");
  });

  /** A thread given `prompts` in turn, each with its turn options' plugins: the requests, notices, and each turn's logged mode. */
  const thread = (prompts: readonly (Readonly<Record<string, unknown>> | undefined)[], config: Readonly<Record<string, unknown>> = {}) => {
    const llm = fakeLlm(prompts.map(() => reply("ok")));
    const toolset = testTools();
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([paths(home, home), host(), sessions, tools, toolset.plugin, llm.plugin, agent, modes], {
            configs: { "agent.modes": config },
          });
          return yield* core.run(
            Effect.gen(function* () {
              const notices: string[] = [];
              yield* Effect.forkScoped(Stream.runForEach((yield* Events).stream(Notice), (notice) => Effect.sync(() => notices.push(notice.message))));
              yield* Effect.yieldNow;
              const store = yield* Sessions;
              const { id } = yield* store.create();
              for (const plugins of prompts) yield* (yield* Agent).prompt(id, [{ type: "text", text: "go" }], plugins === undefined ? {} : { plugins });
              const logged = (yield* store.branch(id)).flatMap((event) => (event.data.type === "turn-start" ? [event.data.plugins?.["agent.modes"]] : []));
              return { requests: llm.requests, notices, logged };
            }),
          );
        }),
      ),
    );
  };

  it("keeps the mode a thread's first prompt chose: a later prompt naming another goes with it, and its turn logs so", async () => {
    const { requests, notices, logged } = await thread([{ "agent.modes": "reader" }, { "agent.modes": "nonesuch" }]);
    expect(logged).toEqual(["reader", "reader"]);
    // Nothing of the request changed: no update brings back the sections the reader leaves out.
    expect(JSON.stringify(requests[1]?.messages.at(-1))).not.toContain("<environment>");
    expect((requests[1]?.tools ?? []).map((tool) => tool.name)).toEqual(["echo"]);
    expect(notices.some((message) => message.includes("nonesuch"))).toBe(false);
  });

  it("keeps a thread's mode for a later prompt that names none", async () => {
    const { requests, logged } = await thread([{ "agent.modes": "reader" }, undefined]);
    expect(logged).toEqual(["reader", undefined]);
    expect(JSON.stringify(requests[1]?.messages.at(-1))).not.toContain("<environment>");
  });

  it("logs the default with a thread's first turn when none is chosen, and goes on with it", async () => {
    const { requests, logged } = await thread([undefined, { "agent.modes": "work" }], { default: "reader" });
    expect(logged).toEqual(["reader", "reader"]);
    expect((requests[0]?.tools ?? []).map((tool) => tool.name)).toEqual(["echo"]);
  });

  it("goes on in work for a thread taken with a bundled mode since renamed", async () => {
    const { requests, notices } = await thread([{ "agent.modes": "coding" }]);
    expect(requests[0]?.system).toContain("Carry a task through");
    expect(notices).toEqual([]);
  });

  it("gives a thread with none chosen the default, and says so when a mode named is not there", async () => {
    const defaulted = await turn(undefined, { default: "reader" });
    expect((defaulted.request.tools ?? []).map((tool) => tool.name)).toEqual(["echo"]);
    const missing = await turn({ "agent.modes": "nonesuch" });
    // Nothing of the reader mode applies: its sections stay.
    expect(missing.request.system).toContain("<environment>");
    expect(missing.notices.some((message) => message.includes('No mode named "nonesuch"'))).toBe(true);
  });
});
