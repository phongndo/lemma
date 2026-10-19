// glossary.ts
import { Schema } from "effect";
import { definePlugin } from "@lemma/core/plain";
import { latestDetails, Sessions } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";
import { ToolResult, Tools } from "@lemma/tools";

/** The glossary on a branch of the session: the terms the last `glossary` call left. */
export const termsOf = (branch: readonly SessionEvent[]): Readonly<Record<string, string>> =>
  (latestDetails(branch, "glossary") as { readonly terms?: Readonly<Record<string, string>> } | undefined)?.terms ?? {};

export default definePlugin({
  id: "glossary",
  uses: ["lemma/sessions@1", "lemma/tools@1"],
  requires: { sessions: Sessions },
  setup: ({ sessions }, { add }) => {
    add(Tools, {
      name: "glossary",
      description: "Records a term you introduced and what it means, so the user can look it up later.",
      input: Schema.Struct({ term: Schema.String, meaning: Schema.String }),
      // Its state is in its results, so each is logged as its own.
      direct: true,
      execute: async ({ term, meaning }, { sessionId, leafId }) => {
        const branch = await sessions.branch(sessionId, leafId === undefined ? undefined : { leaf: leafId });
        const terms = { ...termsOf(branch), [term]: meaning };
        return new ToolResult({ content: [{ type: "text", text: `Recorded "${term}"` }], details: { terms } });
      },
    });
  },
});
