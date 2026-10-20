import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import type { Context } from "effect";
import type { Llm } from "@lemma/llm";
import { llmCommands } from "../src/index.ts";
import { find, run, scripted } from "@lemma/commands/testing";

describe("llm commands", () => {
  test("log out offers only configured providers, and fails when there are none", async () => {
    const loggedOut: string[] = [];
    const llm = (configured: boolean) =>
      ({
        providers: Effect.succeed([
          { id: "a", name: "Alpha", auth: [], configured, source: "auth.json" },
          { id: "b", name: "Beta", auth: [], configured: false },
        ]),
        logout: (id: string) => Effect.sync(() => void loggedOut.push(id)),
      }) as unknown as Context.Service.Shape<typeof Llm>;

    const { ask, asked } = scripted("a");
    expect(await run(find(llmCommands(llm(true), ask), "llm.logout"))).toMatchObject({
      success: { message: "Logged out of Alpha. To end its access there too, revoke it with Alpha." },
    });
    expect(asked[0]?.options).toEqual(["a"]);
    expect(loggedOut).toEqual(["a"]);

    expect(await run(find(llmCommands(llm(false), ask), "llm.logout"))).toMatchObject({ failure: { reason: "Failed", message: "No provider is logged in" } });
  });
});
