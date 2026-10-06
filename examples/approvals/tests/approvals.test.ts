import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, test } from "vitest";
import { definePlugin, makeCore } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { Interaction, InteractionError, ToolInvocation, ToolResult, Tools } from "@lemma/contracts";
import type { Tool } from "@lemma/contracts";
import tools from "@lemma/plugin-tools";
import approvals, { question } from "../approvals.ts";

const defaults = { ask: ["bash"], outsideProject: ["write", "edit"] };
const call = (name: string, input: unknown, sessionId = "s1") => new ToolInvocation({ sessionId, toolCallId: "c1", name, input, cwd: "/work/project" });

describe("which calls ask", () => {
  test("every command, and writes outside the session's directory", () => {
    expect(question(call("bash", { command: "rm -rf build" }), defaults)).toEqual({ title: "Run this command?", detail: "rm -rf build" });
    expect(question(call("write", { path: "src/a.ts" }), defaults)).toBeUndefined();
    expect(question(call("edit", { path: "/work/project/../other/a.ts" }), defaults)).toEqual({
      title: "Allow edit outside the project?",
      detail: "/work/other/a.ts",
    });
    expect(question(call("write", { path: "/work/projects-evil/a.ts" }), defaults)?.detail).toBe("/work/projects-evil/a.ts");
    expect(question(call("read", { path: "/etc/passwd" }), defaults)).toBeUndefined();
    expect(question(call("read", { path: "/etc/passwd" }), { ...defaults, outsideProject: ["read"] })?.detail).toBe("/etc/passwd");
  });

  test("resolves a path as the file tools do: `~` is home and a leading `@` is dropped; `..name` is a name", () => {
    expect(question(call("write", { path: "~/.bashrc" }), defaults)?.detail).toBe(join(homedir(), ".bashrc"));
    expect(question(call("write", { path: "@/etc/hosts" }), defaults)?.detail).toBe("/etc/hosts");
    expect(question(call("write", { path: "..prettierrc" }), defaults)).toBeUndefined();
  });

  test("follows a link out of the project, even to a file not yet written", async () => {
    const root = await mkdtemp(join(tmpdir(), "lemma-approvals-links-"));
    try {
      await mkdir(join(root, "project"));
      await mkdir(join(root, "elsewhere"));
      await symlink(join(root, "elsewhere"), join(root, "project", "link"));
      const inProject = (path: string) => new ToolInvocation({ sessionId: "s1", toolCallId: "c1", name: "write", input: { path }, cwd: join(root, "project") });
      expect(question(inProject("link/new.txt"), defaults)?.title).toBe("Allow write outside the project?");
      expect(question(inProject("plain/new.txt"), defaults)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** Answers each question with the next answer, recording what was asked; `undefined` means nobody is there. */
const answering = (answers: readonly (string | undefined)[]) => {
  const asked: { readonly title: string; readonly detail?: string }[] = [];
  const queue = [...answers];
  const plugin = definePlugin({
    id: "answers",
    provides: [Interaction],
    layer: Layer.succeed(Interaction, {
      confirm: () => Effect.die("not asked"),
      ask: () => Effect.die("not asked"),
      select: <V extends string>(title: string, _options: readonly { readonly value: V }[], detail?: string) =>
        Effect.suspend(() => {
          asked.push({ title, ...(detail === undefined ? {} : { detail }) });
          const answer = queue.shift();
          return answer === undefined
            ? Effect.fail(new InteractionError({ reason: "Unavailable", message: "No client is attached" }))
            : Effect.succeed(answer as V);
        }),
    }),
  });
  return { plugin, asked };
};

const shell: Tool<{ readonly command: string }> = {
  name: "bash",
  description: "Runs a command.",
  input: Schema.Struct({ command: Schema.String }),
  execute: async ({ command }) => new ToolResult({ content: [{ type: "text", text: `ran ${command}` }] }),
};
const shellPlugin = definePlugin({ id: "shell", requires: [Tools], layer: Layer.effectDiscard(Effect.flatMap(Tools, (registry) => registry.register(shell))) });

const run = (plugins: readonly Plugin[], calls: readonly ToolInvocation[]) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([tools, shellPlugin, approvals, ...plugins]);
        return yield* core.run(
          Effect.flatMap(Tools, (registry) =>
            Effect.forEach(calls, (invocation) =>
              Effect.map(registry.execute(invocation, new AbortController().signal), (result) =>
                result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
              ),
            ),
          ),
        );
      }),
    ),
  );

describe("the guard", () => {
  test("runs a command allowed once, and asks again next time", async () => {
    const human = answering(["once", "deny"]);
    expect(await run([human.plugin], [call("bash", { command: "ls" }), call("bash", { command: "ls" })])).toEqual([
      "ran ls",
      "Tool call denied: the user declined",
    ]);
    expect(human.asked).toEqual([
      { title: "Run this command?", detail: "ls" },
      { title: "Run this command?", detail: "ls" },
    ]);
  });

  test("stops asking for a tool allowed for the session, in that session only", async () => {
    const human = answering(["session", "once"]);
    const results = await run([human.plugin], [call("bash", { command: "a" }), call("bash", { command: "b" }), call("bash", { command: "c" }, "s2")]);
    expect(results).toEqual(["ran a", "ran b", "ran c"]);
    expect(human.asked.map((asked) => asked.detail)).toEqual(["a", "c"]);
  });

  test("denies when nobody can answer", async () => {
    const human = answering([undefined]);
    const [result] = await run([human.plugin], [call("bash", { command: "ls" })]);
    expect(result).toBe("Tool call denied: nobody could approve it (No client is attached)");
  });
});
