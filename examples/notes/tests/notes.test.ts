import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCore } from "@lemma/core";
import type { PluginInfo } from "@lemma/contracts";
import { hostControlPlugin, pathsPlugin } from "@lemma/contracts/testing";
import { Agent } from "@lemma/agent";
import agent from "@lemma/agent-loop";
import modes from "@lemma/agent-modes";
import { callTools, reply, scriptedLlm, SCRIPTED_MODEL, toolCall } from "@lemma/llm/testing";
import type { Script } from "@lemma/llm/testing";
import { Sessions } from "@lemma/sessions";
import sessions from "@lemma/sessions-files";
import skills from "@lemma/skills-files";
import tools from "@lemma/tools-registry";
import notes, { search, section, slug } from "../notes.ts";

let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lemma-notes-")));
  await fs.mkdir(path.join(dir, "project"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("notes", () => {
  it("are named from their titles", () => {
    expect(slug("  Cache misses: why? ")).toBe("cache-misses-why");
    expect(() => slug("??")).toThrow("no letters or digits");
  });

  it("are searched by line, any case, and listed to the model", () => {
    const found = [
      { name: "a", title: "Alpha", text: "# Alpha\n\nThe Cache is cold.\nNothing here." },
      { name: "b", title: "Beta", text: "# Beta\n\ncache: warm" },
    ];
    expect(search(found, "CACHE")).toEqual(["a:3: The Cache is cold.", "b:3: cache: warm"]);
    expect(search(found, "cache", 1)).toEqual(["a:3: The Cache is cold."]);
    expect(section(found)).toBe("Your research notes (read one with note_read, search them with note_search):\n- a: Alpha\n- b: Beta");
    expect(section([])).toBeUndefined();
  });
});

describe("in a turn", () => {
  const known: PluginInfo[] = [
    {
      id: "notes",
      source: "user",
      enabled: true,
      state: "active",
      provides: [],
      requires: [],
      resources: { modes: [fileURLToPath(new URL("../modes", import.meta.url))], skills: [fileURLToPath(new URL("../skills", import.meta.url))] },
    },
  ];
  const run = (turns: readonly (readonly Script[])[], mode?: string) => {
    const llm = scriptedLlm(turns.flat());
    const project = path.join(dir, "project");
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore(
            [pathsPlugin(path.join(dir, "home"), { cwd: project }), hostControlPlugin(known), sessions, tools, agent, modes, skills, llm.plugin, notes],
            { configs: { "agent.loop": { defaultModel: SCRIPTED_MODEL.ref } } },
          );
          return yield* core.run(
            Effect.gen(function* () {
              const { id } = yield* (yield* Sessions).create({ cwd: project });
              for (const _ of turns) {
                yield* (yield* Agent).prompt(id, [{ type: "text", text: "look into it" }], mode === undefined ? {} : { plugins: { "agent.modes": mode } });
              }
              return llm.requests;
            }),
          );
        }),
      ),
    );
  };

  it("keeps findings in notes the next request lists, and finds them again", async () => {
    const requests = await run([
      [
        callTools(toolCall("note_write", { title: "Cache misses", text: "- The date in the prompt changes daily (agent.ts)" }, "a")),
        callTools(toolCall("note_write", { title: "Cache misses", text: "- Tools added mid-session" }, "b")),
        reply("Noted."),
      ],
      [callTools(toolCall("note_search", { query: "DAILY" })), reply("Found it.")],
    ]);
    expect(await fs.readFile(path.join(dir, "project", "notes", "cache-misses.md"), "utf8")).toBe(
      "# Cache misses\n\n- The date in the prompt changes daily (agent.ts)\n\n- Tools added mid-session\n",
    );
    expect(requests[0]!.system).not.toContain("Your research notes");
    // The notes section is told as an update where it changed, as the prompt the model was given stays.
    expect(requests[3]!.system).toBe(requests[0]!.system);
    expect(JSON.stringify(requests[3]!.messages)).toContain("- cache-misses: Cache misses");
    expect(JSON.stringify(requests[4]!.messages)).toContain("cache-misses:3: - The date in the prompt changes daily (agent.ts)");
  });

  it("brings the research mode and the cite skill", async () => {
    const [request] = await run([[reply("ok")]], "research");
    expect((request!.tools ?? []).map((tool) => tool.name).sort()).toEqual(["note_read", "note_search", "note_write"]);
    expect(request!.system).toContain("# Research");
    expect(request!.system).toContain("- cite: Record a source in a note");
  });
});
