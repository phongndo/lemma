import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hooks, makeCore } from "@lemma/core";
import { AgentRequestHook } from "@lemma/contracts";
import type { RequestDraft, RequestPlan } from "@lemma/contracts";
import { pathsPlugin } from "@lemma/contracts/testing";
import projectContext, { makeLoader } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lemma-context-")));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const put = async (file: string, content: string) => {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await fs.writeFile(path.join(dir, file), content);
};

/** Only files inside the test directory; anything above it on this machine is not ours to assert on. */
const ours = (files: readonly { path: string; content: string }[]) =>
  files.filter((file) => file.path.startsWith(dir)).map((file) => [path.relative(dir, file.path), file.content]);

describe("project context", () => {
  it("collects the home file, then root-to-cwd files, preferring AGENTS.md over CLAUDE.md", async () => {
    await put("home/AGENTS.md", "global");
    await put("repo/AGENTS.md", "repo");
    await put("repo/pkg/AGENTS.md", "pkg agents");
    await put("repo/pkg/CLAUDE.md", "pkg claude");
    await put("repo/pkg/app/CLAUDE.md", "app claude");
    await fs.mkdir(path.join(dir, "repo/pkg/app/src"));
    const load = makeLoader(path.join(dir, "home"));
    expect(ours(await load(path.join(dir, "repo/pkg/app/src")))).toEqual([
      ["home/AGENTS.md", "global"],
      ["repo/AGENTS.md", "repo"],
      ["repo/pkg/AGENTS.md", "pkg agents"],
      ["repo/pkg/app/CLAUDE.md", "app claude"],
    ]);
  });

  it("rereads a file only when it changes and forgets deleted files", async () => {
    await put("repo/AGENTS.md", "v1");
    const load = makeLoader(path.join(dir, "home"));
    const file = path.join(dir, "repo/AGENTS.md");
    expect(ours(await load(path.join(dir, "repo")))).toEqual([["repo/AGENTS.md", "v1"]]);
    await fs.writeFile(file, "v2");
    await fs.utimes(file, new Date(), new Date(Date.now() + 5000));
    expect(ours(await load(path.join(dir, "repo")))).toEqual([["repo/AGENTS.md", "v2"]]);
    await fs.rm(file);
    expect(ours(await load(path.join(dir, "repo")))).toEqual([]);
  });

  it("adds a section attributed to its plugin id, before the environment section", async () => {
    await put("repo/AGENTS.md", "Use tabs.");
    const paths = pathsPlugin(path.join(dir, "home"), { cwd: dir });
    const draft: RequestDraft = {
      sessionId: "s",
      turnId: "t",
      cwd: path.join(dir, "repo"),
      model: "p/m",
      tools: [],
      branch: [],
      history: [],
      append: () => Effect.die("not used"),
      sections: [
        { id: "base", source: "agent", text: "Base." },
        { id: "environment", source: "agent", text: "Env." },
      ],
    };
    const plan = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([paths, projectContext]);
          return yield* core.run(
            Effect.flatMap(Hooks, (hooks) =>
              hooks.invoke(AgentRequestHook, draft, (final) =>
                Effect.succeed<RequestPlan>({ model: final.model, sections: final.sections, tools: final.tools }),
              ),
            ),
          );
        }),
      ),
    );
    expect(plan.sections.map((section) => [section.id, section.source])).toEqual([
      ["base", "agent"],
      ["project-context", "project-context"],
      ["environment", "agent"],
    ]);
    expect(plan.sections[1]!.text).toContain(`<project_instructions path="${path.join(dir, "repo/AGENTS.md")}">\nUse tabs.\n</project_instructions>`);
  });
});
