import { Schema } from "effect";
import { definePlugin } from "@lemma/core/plain";
import { PromptSections } from "@lemma/agent";
import { Sessions } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";
import { ToolResult, Tools } from "@lemma/tools";

/**
 * A todo list the agent keeps for a session: the `todo` tool changes it, and a
 * section of the system prompt reminds the agent what is still open. The list
 * lives nowhere but the session's log: each call's result carries the whole
 * list in its `details`, and the list is the last one on the branch, so it
 * follows the branch when the session is checked out elsewhere, and survives
 * a restart with nothing stored. The web half (`web.js`) reads the same log.
 *
 * A folder plugin, written the way a user writes one: link or copy the folder
 * into `~/.lemma/plugins/`. It imports only packages the host supplies, and
 * is written with promises (`@lemma/core/plain`).
 */

export interface Todo {
  readonly id: number;
  readonly text: string;
  readonly done: boolean;
}

/** The list on `branch`: the `details` of its last successful `todo` call, or none. */
export const todosOf = (branch: readonly SessionEvent[]): readonly Todo[] => {
  for (let index = branch.length - 1; index >= 0; index--) {
    const data = branch[index]!.data;
    if (data.type !== "message" || data.message.role !== "toolResult" || data.message.toolName !== "todo" || data.message.isError) continue;
    const todos = (data.details as { readonly todos?: unknown } | undefined)?.todos;
    if (Array.isArray(todos)) return todos as Todo[];
  }
  return [];
};

export const TodoInput = Schema.Struct({
  action: Schema.Literals(["add", "done", "list"]).annotate({ description: "add an item, mark one done, or list them" }),
  text: Schema.optional(Schema.String).annotate({ description: "For add: what is to be done" }),
  id: Schema.optional(Schema.Number).annotate({ description: "For done: the item's id" }),
});
export type TodoInput = typeof TodoInput.Type;

/** The list after `input`, and what to tell the model; a call that cannot apply throws, which the model reads as an error. */
export const apply = (todos: readonly Todo[], input: TodoInput): { readonly todos: readonly Todo[]; readonly text: string } => {
  switch (input.action) {
    case "add": {
      if (input.text === undefined || input.text.trim() === "") throw new Error("add needs a text");
      const id = Math.max(0, ...todos.map((todo) => todo.id)) + 1;
      return { todos: [...todos, { id, text: input.text.trim(), done: false }], text: `Added #${id}` };
    }
    case "done": {
      const found = todos.find((todo) => todo.id === input.id);
      if (found === undefined) throw new Error(`No todo #${input.id}`);
      return { todos: todos.map((todo) => (todo === found ? { ...todo, done: true } : todo)), text: `Done #${found.id}` };
    }
    case "list":
      return { todos, text: todos.length === 0 ? "No todos" : todos.map((todo) => `#${todo.id} [${todo.done ? "x" : " "}] ${todo.text}`).join("\n") };
  }
};

/** What the agent is reminded of: the items still open, or nothing. */
export const reminder = (todos: readonly Todo[]): string | undefined => {
  const open = todos.filter((todo) => !todo.done);
  return open.length === 0 ? undefined : ["Open items on your todo list (the `todo` tool):", ...open.map((todo) => `- #${todo.id} ${todo.text}`)].join("\n");
};

export default definePlugin({
  id: "todo",
  version: "0.1.0",
  requires: { sessions: Sessions },
  setup: ({ sessions }, { add }) => {
    add(Tools, {
      name: "todo",
      description: "Keeps your todo list for this session: add an item, mark one done, or list them. Use it for work with several steps.",
      input: TodoInput,
      // Its list lives in its results, so each must be logged as its own: no tool that runs others calls it.
      direct: true,
      // The branch the call is on, which a checkout during the turn leaves where it was.
      execute: async (input, { sessionId, leafId }) => {
        const next = apply(todosOf(await sessions.branch(sessionId, leafId === undefined ? undefined : { leaf: leafId })), input);
        return new ToolResult({ content: [{ type: "text", text: next.text }], details: { todos: next.todos } });
      },
    });
    // After the agent's base prompt and the project's instructions, before the environment; from the turn's branch.
    add(PromptSections, { id: "todo", text: ({ branch }) => reminder(todosOf(branch)) }, { order: 600 });
  },
});
