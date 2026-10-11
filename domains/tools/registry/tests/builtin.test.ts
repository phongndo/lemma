import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { definePlugin, makeCore, PluginContext } from "@lemma/core";
import { ToolInvocation, ToolResult, ToolRunner, Tools } from "@lemma/tools";
import { tempDir, textOf } from "@lemma/tools/testing";
import bash from "@lemma/tools-bash";
import edit from "@lemma/tools-edit";
import read from "@lemma/tools-read";
import write from "@lemma/tools-write";
import tools from "../src/index.ts";

/** The bundled tools but `codemode`, whose own tests run it through a registry. */
const builtin = [read, write, edit, bash];

describe("the bundled tools", () => {
  it("adds one tool per plugin under the tool's name, with clean schemas", async () => {
    expect(builtin.map((plugin) => plugin.id)).toEqual(["tools.read", "tools.write", "tools.edit", "tools.bash"]);
    const listed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([tools, ...builtin]);
          return yield* core.run(Effect.flatMap(ToolRunner, (registry) => registry.list));
        }),
      ),
    );
    expect(listed.map((tool) => [tool.spec.name, tool.source])).toEqual([
      ["bash", "tools.bash"],
      ["edit", "tools.edit"],
      ["read", "tools.read"],
      ["write", "tools.write"],
    ]);
    const editSpec = listed.find((tool) => tool.spec.name === "edit")!.spec.parameters;
    expect(editSpec).toMatchObject({ type: "object", required: ["path", "edits"], additionalProperties: false });
    expect(Object.keys(editSpec["properties"] as object)).toEqual(["path", "edits"]);
    expect(JSON.stringify(listed)).not.toContain("$schema");
  });

  it("lets a composition replace bash alone and routes the legacy edit shape through the registry", async () => {
    const dir = await tempDir();
    const myBash = definePlugin({
      id: "my-bash",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.add(Tools, {
            name: "bash",
            description: "sandboxed",
            input: Schema.Struct({ command: Schema.String }),
            execute: async () => new ToolResult({ content: [{ type: "text", text: "sandboxed" }] }),
          }),
        ),
      ),
    });
    await fs.writeFile(path.join(dir, "f.txt"), "hello");
    const [bashOut, editOut] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([tools, read, write, edit, myBash]);
          return yield* core.run(
            Effect.gen(function* () {
              const registry = yield* ToolRunner;
              const invoke = (name: string, input: unknown) =>
                registry.execute(new ToolInvocation({ sessionId: "s", toolCallId: "c", name, input, cwd: dir }), new AbortController().signal);
              return [yield* invoke("bash", { command: "rm -rf /" }), yield* invoke("edit", { path: "f.txt", oldText: "hello", newText: "bye" })];
            }),
          );
        }),
      ),
    );
    expect(textOf(bashOut!)).toBe("sandboxed");
    expect(textOf(editOut!)).toBe("Successfully replaced 1 block(s) in f.txt.");
    expect(await fs.readFile(path.join(dir, "f.txt"), "utf8")).toBe("bye");
    expect(bash.id).toBe("tools.bash");
    await fs.rm(dir, { recursive: true, force: true });
  });
});
