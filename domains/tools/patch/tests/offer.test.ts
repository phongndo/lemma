import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { definePlugin, Hooks, makeCore } from "@lemma/core";
import { AgentRequestHook } from "@lemma/agent";
import type { RequestDraft } from "@lemma/agent";
import type { ToolContribution } from "@lemma/tools";
import patch, { trainedOnPatches } from "../src/index.ts";

const tool = (name: string): ToolContribution => ({ spec: { name, description: name, parameters: { type: "object", properties: {} } }, source: name });

/** The tools a request on `model` offering `names` is sent, with `tools.patch` configured as `config` and `others` handling it too. */
const offered = (model: string, names: readonly string[], config: Record<string, unknown> = {}, others: readonly ReturnType<typeof definePlugin>[] = []) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([patch, ...others], { configs: { "tools.patch": config } });
        return yield* core.run(
          Effect.gen(function* () {
            const hooks = yield* Hooks;
            const draft: RequestDraft = {
              sessionId: "s",
              turnId: "t",
              cwd: "/work",
              model,
              sections: [],
              tools: names.map(tool),
              branch: [],
              history: [],
              append: () => Effect.die("not appended"),
            };
            const plan = yield* hooks.invoke(AgentRequestHook, draft, ({ model, sections, tools }) => Effect.succeed({ model, sections, tools }));
            return plan.tools.map((each) => each.spec.name);
          }),
        );
      }),
    ),
  );

describe("which of apply_patch and edit a request offers", () => {
  it("knows the model families trained on apply_patch by their ids", () => {
    expect(
      ["openai/gpt-5.5", "openrouter/openai/gpt-oss-120b", "openai/codex-mini-latest", "github-copilot/gpt-5.1-codex", "openai/chatgpt-4o-latest"].map(
        trainedOnPatches,
      ),
    ).toEqual([true, true, true, true, true]);
    expect(["anthropic/claude-sonnet-5-5", "google/gemini-3-pro", "openrouter/anthropic/claude-opus-5-5", "gpt/claude"].map(trainedOnPatches)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("offers apply_patch to GPT and Codex models and edit to the rest, each keeping the other tools", async () => {
    expect(await offered("openai/gpt-5.5", ["apply_patch", "edit", "read"])).toEqual(["apply_patch", "read"]);
    expect(await offered("anthropic/claude-sonnet-5-5", ["apply_patch", "edit", "read"])).toEqual(["edit", "read"]);
  });

  it("leaves whichever of the two is on offer alone, and offers both to every model when asked to", async () => {
    expect(await offered("anthropic/claude-sonnet-5-5", ["apply_patch", "read"])).toEqual(["apply_patch", "read"]);
    expect(await offered("openai/gpt-5.5", ["edit", "read"])).toEqual(["edit", "read"]);
    expect(await offered("anthropic/claude-sonnet-5-5", ["apply_patch", "edit"], { everyModel: true })).toEqual(["apply_patch", "edit"]);
  });

  it("chooses after a handler that changes the request's model", async () => {
    const switcher = definePlugin({
      id: "switcher",
      setup: function* (_, owner) {
        yield* owner.on(AgentRequestHook, (draft, next) => next({ ...draft, model: "openai/gpt-5.5" }), { phase: "select", order: 10 });
      },
    });
    expect(await offered("anthropic/claude-sonnet-5-5", ["apply_patch", "edit"], {}, [switcher])).toEqual(["apply_patch"]);
  });
});
