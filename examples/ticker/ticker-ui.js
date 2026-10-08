// The ticker plugin's prices, live, at /ticker in the web app (see README.md).
// A UI file: link or copy it into ~/.lemma/ui/; it needs no build step.
export default ({ defineUiPlugin, defineRoute, contracts: { Actions, Client, Pages, Router, Slots }, solid: { createSignal, For, onCleanup, Show }, html }) => {
  const TickerRoute = defineRoute("ticker", { path: "/ticker" });

  const styles = `
    .ticker { flex: 1; min-height: 0; overflow: auto; padding: 32px 24px; }
    .ticker-body { max-width: var(--content); margin: 0 auto; }
    .ticker h1 { font-size: calc(20px * var(--text-scale)); font-weight: 600; letter-spacing: -0.015em; margin-bottom: 4px; }
    .ticker table { width: 100%; margin-top: 16px; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    .ticker th, .ticker td { padding: 8px 12px; border-bottom: 1px solid var(--border); text-align: right; }
    .ticker th { font-weight: 500; color: var(--text-2); }
    .ticker th:first-child, .ticker td:first-child { text-align: left; }
    .ticker .up { color: var(--ok); }
    .ticker .down { color: var(--err); }
  `;

  return defineUiPlugin({
    id: "ticker",
    api: 2,
    routes: [TickerRoute],
    styles,
    requires: { slots: Slots, client: Client, router: Router },
    setup: ({ slots, client, router }, plugin) => {
      /** Streams the prices while it shows: opened on every (re)connect, and again whenever the channel serving them comes back. */
      const TickerPage = () => {
        const [quotes, setQuotes] = createSignal([]);
        const [problem, setProblem] = createSignal();
        let close;
        const open = () => {
          close?.();
          close = client.host.channel.open(
            "ticker.prices",
            undefined,
            (next) => {
              setQuotes(next);
              setProblem(undefined);
            },
            (error) => {
              close = undefined;
              // Its plugin stopped or was replaced: a replacement usually serves it already, else `channels-changed` says when.
              if (error?.code === "Withdrawn") open();
              else setProblem(error === undefined ? "The prices stopped." : error.message);
            },
          );
        };
        const stopSync = client.onConnect(open);
        // The channel came back (its plugin on again, or restarted after a gap): open it again.
        const stopEvents = client.onEvent((event) => {
          if (event.type === "channels-changed" && close === undefined && event.channels.some((channel) => channel.id === "ticker.prices")) open();
        });
        onCleanup(() => {
          stopSync();
          stopEvents();
          close?.();
        });

        const asOf = () => (quotes().length === 0 ? "Waiting for prices…" : `As of ${new Date(quotes()[0].at).toLocaleTimeString()}`);
        const signed = (change) => (change > 0 ? `+${change.toFixed(2)}` : change.toFixed(2));
        const trend = (change) => (change > 0 ? "up" : change < 0 ? "down" : "");
        return html`
          <main class="ticker">
            <div class="ticker-body">
              <h1>Ticker</h1>
              <p class="muted small">${asOf}</p>
              <${Show} when=${problem}><p class="muted">${problem}</p><//>
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Price</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  <${For} each=${quotes}>
                    ${(quote) =>
                      html`<tr>
                        <td>${quote.symbol}</td>
                        <td>${quote.price.toFixed(2)}</td>
                        <td class=${trend(quote.change)}>${signed(quote.change)}</td>
                      </tr>`}
                  <//>
                </tbody>
              </table>
            </div>
          </main>
        `;
      };

      plugin.onCleanup(slots.add(Pages, { id: "ticker", route: TickerRoute, component: TickerPage }));
      plugin.onCleanup(slots.add(Actions, { id: "ticker.show", title: "Show prices", category: "Ticker", run: () => router.navigate(TickerRoute, {}) }));
    },
  });
};
