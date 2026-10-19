import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect, Stream } from "effect";
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
import profiles, { byName, keeps, parseProfile } from "../src/index.ts";

describe("a profile file", () => {
  it("reads its fields and its body", () => {
    const profile = parseProfile(
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
    expect(profile).toEqual({
      name: "writing",
      description: "Drafts prose",
      model: "p/m",
      thinking: "low",
      tools: ["read", "write"],
      sections: ["*", "!project-context"],
      prompt: "You help the user write.",
      source: "user",
    });
    expect(parseProfile("plain", "Just a prompt.", "project")).toEqual({ name: "plain", prompt: "Just a prompt.", source: "project" });
  });

  it("keeps what its patterns allow, the last match deciding", () => {
    expect(keeps(undefined, "bash")).toBe(true);
    expect(keeps(["read", "write"], "bash")).toBe(false);
    expect(keeps(["*", "!bash"], "bash")).toBe(false);
    expect(keeps(["*", "!bash"], "read")).toBe(true);
    expect(keeps(["mcp__*"], "mcp__github__issue")).toBe(true);
    expect(keeps(["!bash", "bash"], "bash")).toBe(true);
  });

  it("is the project's over the user's over the bundled one of a name", () => {
    const named = byName([parseProfile("a", "project", "project"), parseProfile("a", "bundled", "bundled"), parseProfile("a", "user", "user")]);
    expect(named.get("a")?.prompt).toBe("project");
  });
});

describe("in a turn", () => {
  let home: string;
  beforeEach(async () => {
    home = await tempDir();
    await fs.mkdir(path.join(home, "profiles"), { recursive: true });
    await fs.writeFile(path.join(home, "profiles", "reader.md"), '---\ntools: echo\nsections: "*", "!agent.environment"\n---\nYou only read.\n');
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
            [paths(home, home), known === undefined ? host() : hostControlPlugin(known), sessions, tools, toolset.plugin, llm.plugin, agent, profiles],
            {
              configs: { "agent.profiles": config },
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

  it("adds the chosen profile's prompt and keeps only the tools and sections it allows", async () => {
    const { request } = await turn({ "agent.profiles": "reader" });
    expect((request.tools ?? []).map((tool) => tool.name)).toEqual(["echo"]);
    expect(request.system).toContain("You only read.");
    expect(request.system).not.toContain("<environment>");
  });

  it("takes a profile from a running plugin's package, a user's own of the name replacing it", async () => {
    await fs.mkdir(path.join(home, "pack", "profiles"), { recursive: true });
    await fs.writeFile(path.join(home, "pack", "profiles", "triage.md"), "---\ntools: echo\n---\nSort the inbox.\n");
    await fs.writeFile(path.join(home, "pack", "profiles", "reader.md"), "The pack's reader.\n");
    const pack: PluginInfo = {
      id: "pack",
      source: "user",
      enabled: true,
      state: "active",
      provides: [],
      requires: [],
      resources: { profiles: [path.join(home, "pack", "profiles")] },
    };
    const triage = await turn({ "agent.profiles": "triage" }, {}, [pack]);
    expect(triage.request.system).toContain("Sort the inbox.");
    const reader = await turn({ "agent.profiles": "reader" }, {}, [pack]);
    expect(reader.request.system).toContain("You only read.");
    expect(reader.request.system).not.toContain("The pack's reader.");
    // Turned off, failed, or left out (not loaded): it brings none.
    const { state: _, ...unloaded } = pack;
    for (const stopped of [{ ...pack, enabled: false }, { ...pack, state: "failed" as const }, unloaded]) {
      const off = await turn({ "agent.profiles": "triage" }, {}, [stopped]);
      expect(off.request.system).not.toContain("Sort the inbox.");
    }
  });

  it("reads a profile edited while the host runs", async () => {
    const { request, later } = await turn({ "agent.profiles": "reader" }, {}, undefined, () =>
      fs.writeFile(path.join(home, "profiles", "reader.md"), "You only read, and carefully.\n"),
    );
    expect(request.system).toContain("You only read.");
    // The prompt the model was given stays, so the next request extends it: the edit reaches the model as an update
    // after the new prompt, which the next request that declares the prompt afresh carries.
    expect(later?.system).toBe(request.system);
    expect(JSON.stringify(later?.messages.at(-1))).toContain("You only read, and carefully.");
  });

  it("gives a thread with none chosen the default, and says so when a profile named is not there", async () => {
    const defaulted = await turn(undefined, { default: "reader" });
    expect((defaulted.request.tools ?? []).map((tool) => tool.name)).toEqual(["echo"]);
    const missing = await turn({ "agent.profiles": "nonesuch" });
    // Nothing of the reader profile applies: its sections stay.
    expect(missing.request.system).toContain("<environment>");
    expect(missing.notices.some((message) => message.includes('No profile named "nonesuch"'))).toBe(true);
  });
});
