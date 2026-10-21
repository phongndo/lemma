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
import tools from "@lemma/tools-registry";
import glossary, { termsOf } from "../glossary.ts";

const here = (file: string) => fileURLToPath(new URL(`../${file}`, import.meta.url));

let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lemma-glossary-")));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("the guide", () => {
  it("shows the plugin's files as they are", async () => {
    const guide = await fs.readFile(here("../../docs/building.md"), "utf8");
    const blocks = [...guide.matchAll(/```(?:ts|js)\n(\/\/ (glossary\.\S+)\n[\s\S]*?)```/g)].map(([, code, file]) => ({ file: file!, code: code! }));
    expect(blocks.map((block) => block.file)).toEqual(["glossary.ts", "glossary.web.js"]);
    for (const block of blocks) expect(block.code).toBe(await fs.readFile(here(block.file), "utf8"));
    const mode = /```md\n([\s\S]*?)```/.exec(guide)?.[1];
    expect(mode).toBe(await fs.readFile(here("modes/tutor.md"), "utf8"));
  });
});

describe("in a turn", () => {
  const known: PluginInfo[] = [
    { id: "glossary", source: "user", enabled: true, state: "active", provides: [], requires: [], resources: { modes: [here("modes")] } },
  ];
  const run = (scripts: readonly Script[], mode?: string) => {
    const llm = scriptedLlm(scripts);
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([pathsPlugin(dir), hostControlPlugin(known), sessions, tools, agent, modes, llm.plugin, glossary], {
            configs: { "agent.loop": { defaultModel: SCRIPTED_MODEL.ref } },
          });
          return yield* core.run(
            Effect.gen(function* () {
              const { id } = yield* (yield* Sessions).create();
              yield* (yield* Agent).prompt(id, [{ type: "text", text: "teach me" }], mode === undefined ? {} : { plugins: { "agent.modes": mode } });
              return { requests: llm.requests, branch: yield* (yield* Sessions).branch(id) };
            }),
          );
        }),
      ),
    );
  };

  it("keeps each term the model records in the log, the last call holding them all", async () => {
    const { branch } = await run([
      callTools(toolCall("glossary", { term: "recursion", meaning: "A function that calls itself" }, "a")),
      callTools(toolCall("glossary", { term: "base case", meaning: "Where the calls stop" }, "b")),
      reply("Done."),
    ]);
    expect(termsOf(branch)).toEqual({ recursion: "A function that calls itself", "base case": "Where the calls stop" });
    expect(termsOf([])).toEqual({});
  });

  it("brings the tutor mode, which offers the glossary", async () => {
    const { requests } = await run([reply("What do you know already?")], "tutor");
    expect((requests[0]!.tools ?? []).map((tool) => tool.name)).toEqual(["glossary"]);
    expect(requests[0]!.system).toContain("# Tutor");
  });
});
