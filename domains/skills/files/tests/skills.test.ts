import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { definePlugin, Hooks, makeCore, Registries } from "@lemma/core";
import { AgentInputHook, PromptSections } from "@lemma/agent";
import type { PromptDecision, PromptInput, SectionRequest } from "@lemma/agent";
import { pathsPlugin } from "@lemma/contracts/testing";
import { Sessions } from "@lemma/sessions";
import skillsFiles, { makeSkillFinder, mentionedSkills, parseSkill, skillBlock } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lemma-skills-")));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const put = async (file: string, content: string) => {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await fs.writeFile(path.join(dir, file), content);
};
const skill = (name: string, description: string, body = `Do ${name}.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

describe("parseSkill", () => {
  it("reads flat frontmatter: plain, quoted, continued, and block values", () => {
    const { fields, body } = parseSkill(
      [
        "---",
        "name: review",
        'description: "Review a diff: find bugs"',
        "summary: one",
        "  two",
        "folded: >-",
        "  a",
        "  b",
        "literal: |",
        "  x",
        "  y",
        "---",
        "",
        "The body.",
      ].join("\n"),
    );
    expect(fields).toEqual({ name: "review", description: "Review a diff: find bugs", summary: "one two", folded: "a b", literal: "x\ny" });
    expect(body).toBe("The body.");
  });

  it("takes a file with no frontmatter as all body", () => {
    expect(parseSkill("Just text.\n")).toEqual({ fields: {}, body: "Just text." });
  });
});

describe("makeSkillFinder", () => {
  it("finds the user's skills, then the project's from the root down, the nearest winning a name", async () => {
    await put("user/review/SKILL.md", skill("review", "the user's"));
    await put("user/notes/SKILL.md", "No frontmatter: named for its folder.");
    await put("repo/.agents/skills/review/SKILL.md", skill("review", "the repo's"));
    await put("repo/pkg/.lemma/skills/deploy/SKILL.md", skill("deploy", "ship it"));
    await put("repo/pkg/.lemma/skills/not-a-skill.md", "ignored");
    const find = makeSkillFinder({ user: [path.join(dir, "user")], project: [".agents/skills", ".lemma/skills"] });
    const found = (await find(path.join(dir, "repo/pkg"))).filter((found) => found.path.startsWith(dir));
    expect(found.map((found) => [found.name, found.description, found.scope, path.relative(dir, found.path)])).toEqual([
      ["deploy", "ship it", "project", "repo/pkg/.lemma/skills/deploy/SKILL.md"],
      ["notes", "", "user", "user/notes/SKILL.md"],
      ["review", "the repo's", "project", "repo/.agents/skills/review/SKILL.md"],
    ]);
  });

  it("counts a directory both the user's and a project's as the user's", async () => {
    await put("home/.agents/skills/review/SKILL.md", skill("review", "mine"));
    const find = makeSkillFinder({ user: [path.join(dir, "home/.agents/skills")], project: [".agents/skills"] });
    expect((await find(path.join(dir, "home/repo"))).filter((found) => found.path.startsWith(dir)).map((found) => found.scope)).toEqual(["user"]);
  });
});

describe("the cache", () => {
  it("reads a file again only when it changes, one that is no skill too", async () => {
    await put("user/review/SKILL.md", skill("review", "ok"));
    await put("user/bad name/SKILL.md", "---\nname: bad name\n---\n");
    const find = makeSkillFinder({ user: [path.join(dir, "user")], project: [] });
    const reads = vi.spyOn(fs, "readFile");
    try {
      await find(dir);
      await find(dir);
      const ours = reads.mock.calls.map(([file]) => path.relative(dir, String(file))).filter((file) => !file.startsWith(".."));
      expect(ours.sort()).toEqual(["user/bad name/SKILL.md", "user/review/SKILL.md"]);
    } finally {
      reads.mockRestore();
    }
  });
});

describe("mentionedSkills", () => {
  const skills = [
    { name: "review", description: "", path: "/s/review/SKILL.md", scope: "user", body: "Review." },
    { name: "deploy", description: "", path: "/s/deploy/SKILL.md", scope: "user", body: "Deploy." },
  ] as const;

  it("finds each known name after the trigger at a word's start, once, in order, past a sentence's full stop", () => {
    expect(mentionedSkills("$deploy then $review. and $review again, cost $5, a$review", skills, "$").map((found) => found.name)).toEqual(["deploy", "review"]);
  });

  it("skips one the prompt carries already, as a prompt sent again does", () => {
    expect(mentionedSkills(`$review\n\n${skillBlock(skills[0])}`, skills, "$")).toEqual([]);
  });
});

describe("skills.files", () => {
  const run = async <A>(
    use: (core: { section: (cwd: string) => Promise<string | undefined>; input: (text: string) => Promise<PromptDecision> }) => Promise<A>,
  ) => {
    const repo = path.join(dir, "repo");
    const sessions = definePlugin({
      id: "test.sessions",
      provides: { sessions: Sessions },
      setup: () => Effect.succeed({ sessions: { get: () => Effect.succeed({ id: "s", cwd: repo }) } as never }),
    });
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([pathsPlugin(path.join(dir, "home"), { cwd: repo }), sessions, skillsFiles]);
          return yield* core.run(
            Effect.gen(function* () {
              const [section] = yield* Effect.flatMap(Registries, (registries) => registries.items(PromptSections));
              const hooks = yield* Hooks;
              const request: SectionRequest = { sessionId: "s", turnId: "t", cwd: repo, model: "p/m", tools: [], branch: [] };
              const placed = (input: PromptInput) => Effect.succeed<PromptDecision>({ kind: "place", content: input.content, options: input.options });
              return yield* Effect.promise(() =>
                use({
                  section: (cwd) => Effect.runPromise(section!.item.text({ ...request, cwd }) as Effect.Effect<string | undefined>),
                  input: (text) => Effect.runPromise(hooks.invoke(AgentInputHook, { sessionId: "s", content: [{ type: "text", text }], options: {} }, placed)),
                }),
              );
            }),
          );
        }),
      ),
    );
  };

  it("lists the skills to the model, and adds a named one's instructions to the prompt", async () => {
    await put("repo/.agents/skills/review/SKILL.md", skill("review", "Review a diff", "Look for bugs."));
    const { section, decision, plain } = await run(async (core) => ({
      section: await core.section(path.join(dir, "repo")),
      decision: await core.input("$review this branch"),
      plain: await core.input("no skill here, $unknown"),
    }));
    expect(section).toContain(`- review: Review a diff (${path.join(dir, "repo/.agents/skills/review/SKILL.md")})`);
    expect(decision).toMatchObject({
      kind: "place",
      content: [
        { type: "text", text: "$review this branch" },
        { type: "text", text: `<skill name="review" path="${path.join(dir, "repo/.agents/skills/review/SKILL.md")}">\nLook for bugs.\n</skill>` },
      ],
    });
    expect(plain).toMatchObject({ kind: "place", content: [{ type: "text", text: "no skill here, $unknown" }] });
  });
});
