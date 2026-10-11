// The ticker plugin's web half: its prices, live, at /ticker in the web app (see README.md). The host compiles it
// (TypeScript, Solid's JSX, and its stylesheet as text); its imports of solid-js and @lemma/* are the page's own.
import { createSignal, For, onCleanup, Show } from "solid-js";
import { Actions } from "@lemma/actions";
import { defineRoute } from "@lemma/router";
import { Client, defineWebPlugin, Pages, Router, Slots } from "@lemma/web";
import type { Quote } from "./ticker.ts";
import styles from "./ticker.css";

const TickerRoute = defineRoute("ticker", { path: "/ticker" });

const signed = (change: number) => (change > 0 ? `+${change.toFixed(2)}` : change.toFixed(2));
const trend = (change: number) => (change > 0 ? "up" : change < 0 ? "down" : "");

export default defineWebPlugin({
  id: "ticker",
  api: 4,
  routes: [TickerRoute],
  styles,
  requires: { slots: Slots, client: Client, router: Router },
  setup: ({ slots, client, router }, plugin) => {
    /**
     * Streams the prices while it shows. `follow` keeps the stream open: again on every reconnect, at once when its
     * plugin restarts, and when the channel comes back after its plugin was off.
     */
    const TickerPage = () => {
      const [quotes, setQuotes] = createSignal<readonly Quote[]>([]);
      const [problem, setProblem] = createSignal<string>();
      const close = client.follow(
        "ticker.prices",
        undefined,
        (next) => {
          setQuotes(next as readonly Quote[]);
          setProblem(undefined);
        },
        (error) => {
          // Withdrawn: its plugin reloaded, and `follow` opens it again on the new one.
          if (error === undefined) setProblem("The prices stopped.");
          else if (!("code" in error && error.code === "Withdrawn")) setProblem(error.message);
        },
      );
      onCleanup(close);

      const asOf = () => {
        const first = quotes()[0];
        return first === undefined ? "Waiting for prices…" : `As of ${new Date(first.at).toLocaleTimeString()}`;
      };
      return (
        <main class="ticker">
          <div class="ticker-body">
            <h1>Ticker</h1>
            <p class="muted small">{asOf()}</p>
            <Show when={problem()}>
              <p class="muted">{problem()}</p>
            </Show>
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Price</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                <For each={quotes()}>
                  {(quote) => (
                    <tr>
                      <td>{quote.symbol}</td>
                      <td>{quote.price.toFixed(2)}</td>
                      <td class={trend(quote.change)}>{signed(quote.change)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </main>
      );
    };

    plugin.onCleanup(slots.add(Pages, { id: "ticker", route: TickerRoute, component: TickerPage }));
    plugin.onCleanup(slots.add(Actions, { id: "ticker.show", title: "Show prices", category: "Ticker", run: () => router.navigate(TickerRoute, {}) }));
  },
});
