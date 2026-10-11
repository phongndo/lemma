import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCore, Registries } from "@lemma/core";
import { PromptSections, SectionOrder } from "@lemma/agent";
import type { SectionRequest } from "@lemma/agent";
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

  it("adds a section between the agent's base prompt and its environment, written for the request's directory", async () => {
    await put("repo/AGENTS.md", "Use tabs.");
    const paths = pathsPlugin(path.join(dir, "home"), { cwd: dir });
    const request: SectionRequest = { sessionId: "s", turnId: "t", cwd: path.join(dir, "repo"), model: "p/m", tools: [], branch: [] };
    const [added, text, empty] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([paths, projectContext]);
          return yield* core.run(
            Effect.gen(function* () {
              const [section] = yield* Effect.flatMap(Registries, (registries) => registries.items(PromptSections));
              const write = (cwd: string) => Effect.promise(async () => section!.item.text({ ...request, cwd }) as Promise<string | undefined>);
              return [section!, yield* write(request.cwd), yield* write(path.join(dir, "elsewhere"))] as const;
            }),
          );
        }),
      ),
    );
    expect([added.item.id, added.pluginId, added.order]).toEqual(["project-context", "context.project", 500]);
    expect(SectionOrder.base < added.order && added.order < SectionOrder.environment).toBe(true);
    expect(text).toContain(`<project_instructions path="${path.join(dir, "repo/AGENTS.md")}">\nUse tabs.\n</project_instructions>`);
    // No instructions where it is asked: no section.
    expect(empty).toBeUndefined();
  });
});
