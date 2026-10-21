# Building on Lemma

This guide builds one plugin in three steps: a tool the model calls, a view
of what the tool keeps, and a mode that gives a thread an agent built
around it. Each step is a few lines, and each links to the reference that
says more. The plugin is a glossary: when the agent introduces a term, it
records it, and you can look the terms up beside the chat. With the mode,
it becomes a tutor. The finished plugin is
[`examples/glossary`](../examples/glossary/README.md), and its files are the
ones shown here.

## 1. A tool

Save this as `~/.lemma/plugins/glossary.ts`:

```ts
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
```

The host loads it as soon as it is saved: ask for an explanation of something
and to keep a glossary, and the model has the tool from its next request.

What the file does:

- **It adds a tool** to the tools domain's `Tools` registry. Adding is one of
  the [five ways plugins meet](plugins.md#the-five-shapes); the
  [tools README](../domains/tools/README.md) says what a tool can be.
- **It calls `Sessions`**, the session log, which it `requires`. It keeps no
  state of its own: each call's result carries the whole glossary in its
  `details`, and the glossary is the last one on the branch (`latestDetails`).
  So it follows a thread that is forked or checked out at an earlier point,
  and survives a restart with nothing stored
  ([Two halves, and state](plugins.md#two-halves-and-state)).
- **`uses`** names the contracts it is written against. If one changes
  incompatibly, the plugin is left out, saying which, rather than failing at
  a call ([Contract versions](plugins.md#contract-versions)).
- **It is written with promises** (`@lemma/core/plain`). The same plugin can
  be written with Effect ([Promises or Effects](plugins.md#promises-or-effects)).

It imports only packages the host supplies, which the host links into
`~/.lemma/node_modules`, so it needs no install and your editor finds their
types. `lemma plugins check ~/.lemma/plugins/glossary.ts` runs it as a host
would and reports what it adds, or why it fails.

## 2. A view of what it keeps

Save this beside it as `~/.lemma/plugins/glossary.web.js`:

```js
// glossary.web.js
export default ({ defineWebPlugin, contracts: { Icon, Slots, Threads, ToolViews, Views, latestDetails }, solid: { createMemo, For, Show }, html }) =>
  defineWebPlugin({
    id: "glossary",
    api: 4,
    uses: ["lemma/threads@1"],
    styles: `
      .glossary-view { flex: 1; min-height: 0; overflow: auto; padding: 32px 24px; }
      .glossary-view dl { max-width: var(--content); margin: 0 auto; }
      .glossary-view dt { font-weight: 600; margin-top: 12px; }
      .glossary-view dd { margin: 2px 0 0; color: var(--text-2); }
    `,
    requires: { slots: Slots, threads: Threads },
    setup: ({ slots, threads }) => {
      // A call's line in the chat: the term it recorded.
      slots.add(ToolViews, { id: "glossary", icon: "brain", summary: (args) => ({ primary: args?.term }) });
      // The open thread's terms, as the host half reads them: the last call's.
      const terms = createMemo(() => Object.entries(latestDetails(threads.branch(), "glossary")?.terms ?? {}));
      slots.add(Views, {
        id: "glossary",
        order: 40,
        title: "Glossary",
        icon: () => html`<${Icon} name="brain" />`,
        component: () => html`
          <div class="glossary-view">
            <${Show} when=${() => terms().length > 0} fallback=${html`<p class="muted">No terms in this thread yet.</p>`}>
              <dl>
                <${For} each=${terms}
                  >${([term, meaning]) =>
                    html`<dt>${term}</dt>
                      <dd>${meaning}</dd>`}<//
                >
              </dl>
            <//>
          </div>
        `,
      });
    },
  });
```

Open web apps load it when it is saved. The chat shows each call by the term
it recorded, and **Glossary** (in the thread's menu and the palette) opens
the terms beside the chat.

What the file does:

- **It is the same plugin.** Both halves define the id `glossary`, so one row
  in `config.jsonc` turns both on or off, and the web app runs this half only
  while the host half runs.
- **It adds to two slots** of the threads domain: `ToolViews`, how a tool's
  calls show, and `Views`, a view of the open thread
  ([threads README](../domains/threads/README.md)).
- **It reads the same log.** `threads.branch()` is the open thread's branch,
  reactive, and `latestDetails` finds the glossary on it as the host half
  does, so the view is right on any branch, and updates as a call lands.
- **It needs no build step.** A web half that is a function receives the
  page's own modules: the contracts, Solid, and `html`, Solid's tagged
  template, which is JSX without a compiler
  ([Writing a plugin](../apps/web/README.md#writing-a-plugin)).

## 3. A mode that uses it

A mode says what a thread's agent is for: a prompt, and which tools and
prompt sections it keeps. A plugin can bring modes, so move the two files
into a folder, `~/.lemma/plugins/glossary/`, with a `package.json` that says
where its halves and its modes are:

```json
{
  "lemma": {
    "host": "./glossary.ts",
    "web": "./glossary.web.js",
    "resources": { "modes": "./modes" }
  }
}
```

and the mode, `modes/tutor.md`:

```md
---
description: Teaches a topic step by step, and keeps a glossary of the terms it introduces
tools: glossary, read, ask_user
---

# Tutor

Teach the topic the user names, a step at a time:

- Find out what they know first (`ask_user`), and start from there.
- Introduce one idea at a time, with a concrete example, and check it landed before the next.
- Record each new term in the glossary (`glossary`) when you first use it, in a sentence the user would understand.
- When they get something wrong, say what is right and why, without making them feel slow.
```

Start a new thread and pick **Tutor** in its Mode menu, under the prompt. That
thread's agent now teaches, offered only the glossary, `read`, and
`ask_user`, whatever else is installed; another thread keeps its own mode. The
mode is logged with the thread's first turn and kept from then on, so a turn
resumed after a restart keeps it too.

What changed:

- **A folder plugin** is a package: its manifest names its halves, and its
  files can import each other ([Your plugins](configuration.md#your-plugins)).
- **`resources`** names folders of things other plugins read, by kind. The
  modes plugin reads `modes` while the glossary plugin is on, below
  your own modes of the same name
  ([agent.modes](../domains/agent/modes/README.md)); the skills plugin
  reads `skills` the same way.

## Testing it

`lemma plugins check <path>` runs a plugin file or folder as a host would,
before you rely on it. In this repository, a folder plugin is a workspace
package with tests of its own. The glossary's run it in real turns: the agent,
the session log, and the tools, with a scripted model that plays the tool
calls and answers it is given (`scriptedLlm` from `@lemma/llm/testing`), and
the mode found as the host finds it
([its tests](../examples/glossary/tests/glossary.test.ts),
[Testing](plugins.md#testing)).

## Where next

- [What to plug into](plugins.md#what-to-plug-into) lists what a plugin can
  change, with the example that shows each: a guard on tool calls, a section
  of the system prompt, a model provider, a page.
- To tell the model something once, where it happened (a message arriving,
  a reading), append a `context` event rather than a prompt section, as
  [inbox](../examples/inbox/README.md) does.
- A plugin can replace any bundled one by id, the agent loop included
  ([Replacing a bundled plugin](plugins.md#replacing-a-bundled-plugin), and
  [fresh-loop](../examples/fresh-loop/README.md), a loop of another kind).
- When a plugin misbehaves, [Debugging plugins](debugging.md) says where to
  look, and what each plugin costs in the model's requests.
