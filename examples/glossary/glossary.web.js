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
