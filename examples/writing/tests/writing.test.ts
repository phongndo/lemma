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
import profiles from "@lemma/agent-profiles";
import { callTools, reply, scriptedLlm, SCRIPTED_MODEL, toolCall } from "@lemma/llm/testing";
import type { Script } from "@lemma/llm/testing";
import { Sessions } from "@lemma/sessions";
import sessions from "@lemma/sessions-files";
import tools from "@lemma/tools-registry";
import writing, { measure, report } from "../writing.ts";

let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lemma-writing-")));
  await fs.mkdir(path.join(dir, "project"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("measuring a draft", () => {
  it("counts the prose's words, sentences, and paragraphs, past headings, code, and link targets", () => {
    const stats = measure(
      "# Title\n\nShort one. Then a [longer](https://example.com/a.b) sentence follows here!\n\n```\ncode. not. prose.\n```\n\nWhy?\nA line without a stop",
    );
    expect(stats).toEqual({
      words: 14,
      sentences: 4,
      paragraphs: 2,
      averageSentence: 3.5,
      longest: ["Then a [longer] sentence follows here!", "A line without a stop", "Short one."],
      minutes: 1,
    });
    expect(report(measure(""))).toBe("0 words in 0 sentences and 0 paragraphs; 0 words a sentence on average; about 1 min to read.");
  });
});

describe("in a turn", () => {
  const known: PluginInfo[] = [
    {
      id: "writing",
      source: "user",
      enabled: true,
      state: "active",
      provides: [],
      requires: [],
      resources: { profiles: [fileURLToPath(new URL("../profiles", import.meta.url))] },
    },
  ];
  const run = (scripts: readonly Script[], profile?: string) => {
    const llm = scriptedLlm(scripts);
    const project = path.join(dir, "project");
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore(
            [pathsPlugin(path.join(dir, "home"), { cwd: project }), hostControlPlugin(known), sessions, tools, agent, profiles, llm.plugin, writing],
            {
              configs: { "agent.loop": { defaultModel: SCRIPTED_MODEL.ref } },
            },
          );
          return yield* core.run(
            Effect.gen(function* () {
              const { id } = yield* (yield* Sessions).create({ cwd: project });
              yield* (yield* Agent).prompt(id, [{ type: "text", text: "draft it" }], profile === undefined ? {} : { plugins: { "agent.profiles": profile } });
              return llm.requests;
            }),
          );
        }),
      ),
    );
  };

  it("puts the style guide in the system prompt and measures a draft for the model", async () => {
    await fs.writeFile(path.join(dir, "project", "STYLE.md"), "Sentences under 20 words.\n");
    await fs.writeFile(path.join(dir, "project", "draft.md"), "One. Two words.\n");
    const requests = await run([callTools(toolCall("draft_stats", { path: "draft.md" })), reply("Within the limit.")]);
    expect(requests[0]!.system).toContain("The project's style guide (STYLE.md); follow it in what you write:\n\nSentences under 20 words.");
    expect(JSON.stringify(requests[1]!.messages)).toContain("3 words in 2 sentences and 1 paragraphs");
  });

  it("brings the writing profile, and leaves the guide out when there is none", async () => {
    const [request] = await run([reply("ok")], "writing");
    expect((request!.tools ?? []).map((tool) => tool.name)).toEqual(["draft_stats"]);
    expect(request!.system).toContain("# Writing");
    expect(request!.system).not.toContain("style guide (");
  });
});
