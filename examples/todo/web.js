// The todo plugin's web half: how its calls show, and a Todos view of the thread (see README.md).
// It needs no build step; package.json's `lemma` manifest names it beside the host half, todo.ts.
export default ({ defineWebPlugin, contracts: { Icon, Slots, Threads, ToolViews, Views }, solid: { createMemo, For, Show }, html }) => {
  /** The list on a branch, as the host half reads it: the `details` of the last successful `todo` call. */
  const todosOf = (branch) => {
    for (let index = branch.length - 1; index >= 0; index--) {
      const { data } = branch[index];
      if (data.type !== "message" || data.message.role !== "toolResult" || data.message.toolName !== "todo" || data.message.isError) continue;
      if (Array.isArray(data.details?.todos)) return data.details.todos;
    }
    return [];
  };

  const styles = `
    .todo-view { flex: 1; min-height: 0; overflow: auto; padding: 32px 24px; }
    .todo-view ul { max-width: var(--content); margin: 0 auto; list-style: none; padding: 0; }
    .todo-view li { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); }
    .todo-view .done { color: var(--text-3); text-decoration: line-through; }
  `;

  return defineWebPlugin({
    id: "todo",
    api: 3,
    styles,
    requires: { slots: Slots, threads: Threads },
    setup: ({ slots, threads }) => {
      // A call's line: what it did, by the item's text or id.
      slots.add(ToolViews, {
        id: "todo",
        icon: "check",
        // While a call's arguments stream in, a field may not be there yet.
        summary: (args) => ({
          primary: args?.action === "add" ? args.text : args?.action === "done" ? (args.id === undefined ? "done" : `#${args.id} done`) : "list",
        }),
        streaming: "text",
        action: ["updated", "todo list", "todo lists"],
      });
      const todos = createMemo(() => todosOf(threads.branch()));
      slots.add(Views, {
        id: "todo",
        order: 30,
        title: "Todos",
        icon: () => html`<${Icon} name="check" />`,
        component: () => html`
          <div class="todo-view">
            <${Show} when=${() => todos().length > 0} fallback=${html`<p class="muted">No todos in this thread.</p>`}>
              <ul>
                <${For} each=${todos}> ${(todo) => html`<li class=${todo.done ? "done" : ""}><span class="muted">#${todo.id}</span> ${todo.text}</li>`} <//>
              </ul>
            <//>
          </div>
        `,
      });
    },
  });
};
