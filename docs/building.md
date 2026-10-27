# Building on Lemma

This guide builds one plugin in three steps:

1. a tool the model calls;
2. a view of what the tool keeps;
3. a mode that gives a thread an agent built around the tool.

Each step is a few lines. Each links to the reference that says more.

The plugin is a glossary. When the agent introduces a term, it records it. You
can look the terms up beside the chat. With the mode, the plugin becomes a
tutor.

The finished plugin is [`examples/glossary`](../examples/glossary/README.md).
Its files are the ones shown here.

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
  uses: ["lemma/sessions@2", "lemma/tools@2"],
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

The host loads the file as soon as it is saved. Ask for an explanation of
something, and ask the agent to keep a glossary. The model has the tool from
its next request.

What the file does:

- **It adds a tool** to the tools domain's `Tools` registry. Adding is one of
  the [five ways plugins meet](plugins.md#the-five-shapes). The
  [tools README](../domains/tools/README.md) says what a tool can be.
- **It calls `Sessions`**, the session log, which it `requires`. It keeps no
  state of its own.
  - Each call's result carries the whole glossary in its `details`.
  - The glossary is the last one on the branch (`latestDetails`).
  - So it follows a thread that is forked or checked out at an earlier point.
  - It survives a restart with nothing stored
    ([Two halves, and state](plugins.md#two-halves-and-state)).
- **`uses`** names the contracts it is written against. If one changes
  incompatibly, the plugin is left out and says which. It does not fail at a
  call instead ([Contract versions](plugins.md#contract-versions)).
- **It is written with promises** (`@lemma/core/plain`). The same plugin can
  be written with Effect ([Promises or Effects](plugins.md#promises-or-effects)).

It imports only packages the host supplies. The host links them into
`~/.lemma/node_modules`. So the plugin needs no install, and your editor finds
their types.

`lemma plugins check ~/.lemma/plugins/glossary.ts` runs the plugin as a host
would. It reports what the plugin adds, or why it fails.

## 2. A view of what it keeps

Save this beside it as `~/.lemma/plugins/glossary.web.js`:

```js
// glossary.web.js
export default ({ defineWebPlugin, contracts: { Icon, Slots, Threads, ToolViews, Views, latestDetails }, solid: { createMemo, For, Show }, html }) =>
  defineWebPlugin({
    id: "glossary",
    api: 5,
    uses: ["lemma/threads@2"],
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

Open web apps load the file when it is saved. The chat shows each call by the
term it recorded. **Glossary** opens the terms beside the chat. It is in the
thread's menu and in the palette.

What the file does:

- **It is the same plugin.** Both halves define the id `glossary`.
  - So one row in `config.jsonc` turns both on or off.
  - The web app runs this half only while the host half runs.
- **It adds to two slots** of the threads domain
  ([threads README](../domains/threads/README.md)):
  - `ToolViews`: how a tool's calls show;
  - `Views`: a view of the open thread.
- **It reads the same log.** `threads.branch()` is the open thread's branch,
  and it is reactive. `latestDetails` finds the glossary on it, as the host
  half does. So the view is right on any branch, and it updates as a call
  lands.
- **It needs no build step.** A web half that is a function receives the
  page's own modules: the contracts, Solid, and `html`. `html` is Solid's
  tagged template, which is JSX without a compiler
  ([Writing a plugin](../apps/web/README.md#writing-a-plugin)).

## 3. A mode that uses it

A mode says what a thread's agent is for. It is a prompt, and it says which
tools and prompt sections the agent keeps.

A plugin can bring modes. Move the two files into a folder,
`~/.lemma/plugins/glossary/`. Add a `package.json` that says where the halves
and the modes are:

```json
{
  "lemma": {
    "host": "./glossary.ts",
    "web": "./glossary.web.js",
    "resources": { "modes": "./modes" }
  }
}
```

Then add the mode, `modes/tutor.md`:

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

Start a new thread. Pick **Tutor** in its Mode menu, under the prompt.

- That thread's agent now teaches.
- It is offered only the glossary, `read`, and `ask_user`, whatever else is
  installed.
- Another thread keeps its own mode.
- The mode is logged with the thread's first turn, and kept from then on. So a
  turn resumed after a restart keeps it too.

What changed:

- **A folder plugin** is a package. Its manifest names its halves, and its
  files can import each other ([Your plugins](configuration.md#your-plugins)).
- **`resources`** names folders of things other plugins read, by kind.
  - The modes plugin reads `modes` while the glossary plugin is on. It ranks
    them below your own modes of the same name
    ([agent.modes](../domains/agent/modes/README.md)).
  - The skills plugin reads `skills` the same way.

## Testing it

`lemma plugins check <path>` runs a plugin file or folder as a host would.
Run it before you rely on the plugin.

In this repository, a folder plugin is a workspace package with tests of its
own. The glossary's tests run it in real turns
([its tests](../examples/glossary/tests/glossary.test.ts),
[Testing](plugins.md#testing)):

- with the agent, the session log, and the tools;
- with a scripted model that plays the tool calls and answers it is given
  (`scriptedLlm` from `@lemma/llm/testing`);
- with the mode found as the host finds it.

## Where next

- [What to plug into](plugins.md#what-to-plug-into) lists what a plugin can
  change, with the example that shows each. It covers a guard on tool calls,
  a section of the system prompt, a model provider, and a page.
- To tell the model something once, where it happened, append a `context`
  event rather than a prompt section. A message arriving and a reading are
  such things. [inbox](../examples/inbox/README.md) does this.
- A plugin can replace any bundled one by id, the agent loop included
  ([Replacing a bundled plugin](plugins.md#replacing-a-bundled-plugin)).
  [fresh-loop](../examples/fresh-loop/README.md) is a loop of another kind.
- When a plugin misbehaves, [Debugging plugins](debugging.md) says where to
  look. It also says what each plugin costs in the model's requests.
