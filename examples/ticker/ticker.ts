import { Clock, Data, Duration, Effect, Schedule, Schema, Stream, SubscriptionRef } from "effect";
import { definePlugin } from "@lemma/core";
import { Channels, defineChannel, serveChannel } from "@lemma/contracts";

/**
 * Made-up prices for a few symbols, moving by a random walk, served to
 * clients through two channels: `ticker.prices`, a stream of every symbol's
 * quote on each tick, and `ticker.quote`, one symbol's quote now. Its UI file
 * (`ticker-ui.js`) shows them at `/ticker` in the web app.
 *
 * A plugin file, written the way a user writes one: copy or link it into
 * `~/.lemma/plugins/` and run `lemma reload`. It imports only packages the
 * host supplies, and needs no change to Lemma's contracts or transport. Its
 * channels' declarations are exported, so a typed client can import them.
 */

const Config = Schema.Struct({
  symbols: Schema.Array(Schema.String)
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => ["ACME", "GLOBEX", "INITECH"])))
    .annotate({ title: "Symbols", description: "The made-up symbols it quotes." }),
  intervalMs: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 50, maximum: 60_000 }))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 1000)))
    .annotate({ title: "Tick interval (ms)", description: "How often prices move." }),
});

export const Quote = Schema.Struct({
  symbol: Schema.String,
  price: Schema.Number,
  /** Since the tick before. */
  change: Schema.Number,
  /** Epoch ms of the tick. */
  at: Schema.Number,
});
export type Quote = typeof Quote.Type;

/** Every symbol's quote now, then on each tick. */
export const prices = defineChannel({
  kind: "stream",
  id: "ticker.prices",
  title: "Prices",
  description: "Every symbol's quote now, then on each tick",
  payload: Schema.Void,
  success: Schema.Array(Quote),
});

/** One symbol's quote now; fails `NotFound` for a symbol it does not quote. */
export const quote = defineChannel({
  kind: "call",
  id: "ticker.quote",
  title: "Quote",
  description: "One symbol's quote now",
  payload: Schema.Struct({ symbol: Schema.String }),
  success: Quote,
  repeatable: true,
});

/** `NotFound`: the ticker does not quote the symbol; clients see it as the error's code. */
export class TickerError extends Data.TaggedError("TickerError")<{ readonly reason: "NotFound"; readonly message: string }> {}

const cents = (value: number) => Math.round(value * 100) / 100;

/** A symbol's first price: somewhere from 20 to 200, the same each start. */
export const opening = (symbol: string, at: number): Quote => ({
  symbol,
  price: 20 + ([...symbol].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 180),
  change: 0,
  at,
});

/** One tick: each price moves by up to half a percent either way (`random` is uniform in [0, 1)), never below a cent. */
export const step = (quotes: readonly Quote[], random: () => number, at: number): Quote[] =>
  quotes.map((quote) => {
    const price = Math.max(0.01, cents(quote.price * (1 + (random() - 0.5) / 100)));
    return { symbol: quote.symbol, price, change: cents(price - quote.price), at };
  });

export default definePlugin({
  id: "ticker",
  version: "0.1.0",
  config: Config,
  setup: function* (_, owner) {
    const config = owner.config;
    const now = yield* Clock.currentTimeMillis;
    // One market for every client, so the stream and a quote agree.
    const market = yield* SubscriptionRef.make<readonly Quote[]>(config.symbols.map((symbol) => opening(symbol, now)));
    const tick = Effect.flatMap(Clock.currentTimeMillis, (at) => SubscriptionRef.update(market, (quotes) => step(quotes, Math.random, at)));
    yield* owner.background("walk", Effect.repeat(tick, Schedule.spaced(Duration.millis(config.intervalMs))), { required: true });

    // A client that falls behind gets the latest quotes, not a backlog of old ones.
    yield* owner.add(
      Channels,
      serveChannel(prices, () => SubscriptionRef.changes(market).pipe(Stream.buffer({ capacity: 1, strategy: "sliding" }))),
    );
    yield* owner.add(
      Channels,
      serveChannel(quote, ({ symbol }) =>
        Effect.flatMap(SubscriptionRef.get(market), (quotes) => {
          const found = quotes.find((candidate) => candidate.symbol.toUpperCase() === symbol.toUpperCase());
          return found === undefined
            ? Effect.fail(new TickerError({ reason: "NotFound", message: `No symbol "${symbol}": the ticker quotes ${config.symbols.join(", ")}` }))
            : Effect.succeed(found);
        }),
      ),
    );
  },
});
