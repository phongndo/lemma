import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Effect, Exit, Option, Stream } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { makeCore, Registries } from "@lemma/core";
import { Channels, elementsOf, resultOf } from "@lemma/contracts";
import type { Channel, ChannelCall, ChannelStream } from "@lemma/contracts";
import ticker, { opening, step } from "../ticker.ts";
import type { Quote } from "../ticker.ts";
import { startLemma } from "../../../scripts/e2e.ts";
import type { Lemma } from "../../../scripts/e2e.ts";

describe("the walk", () => {
  test("a symbol opens at the same price each start, from 20 to 200", () => {
    expect(opening("ACME", 5)).toEqual({ symbol: "ACME", price: 118, change: 0, at: 5 });
    for (const symbol of ["A", "ZZZZZZ", "GLOBEX"]) expect(opening(symbol, 0).price).toSatisfy((price: number) => price >= 20 && price < 200);
  });

  test("a tick moves each price by at most half a percent, to the cent, never below one", () => {
    const quotes = [
      { symbol: "ACME", price: 100, change: 0, at: 0 },
      { symbol: "PENNY", price: 0.01, change: 0, at: 0 },
    ];
    expect(step(quotes, () => 0.999999, 1)).toEqual([
      { symbol: "ACME", price: 100.5, change: 0.5, at: 1 },
      { symbol: "PENNY", price: 0.01, change: 0, at: 1 },
    ]);
    expect(step(quotes, () => 0, 2)).toEqual([
      { symbol: "ACME", price: 99.5, change: -0.5, at: 2 },
      { symbol: "PENNY", price: 0.01, change: 0, at: 2 },
    ]);
  });
});

/** Runs the plugin in a core and hands `body` its channels, as the transport reads them. */
const withTicker = <A>(body: (channels: ReadonlyMap<string, Channel>) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([ticker], { configs: { ticker: { symbols: ["ACME", "GLOBEX"], intervalMs: 50 } } });
        const items = yield* core.run(Effect.flatMap(Registries, (registries) => registries.items(Channels)));
        expect(items.map(({ item, pluginId }) => [item.id, item.kind, pluginId])).toEqual([
          ["ticker.prices", "stream", "ticker"],
          ["ticker.quote", "call", "ticker"],
        ]);
        return yield* body(new Map(items.map(({ item }) => [item.id, item])));
      }),
    ),
  );

describe("its channels", () => {
  test("the stream sends every symbol's quote now, then on each tick", () =>
    withTicker((channels) =>
      Effect.gen(function* () {
        const prices = channels.get("ticker.prices") as ChannelStream<void, readonly Quote[]>;
        const ticks = (yield* Stream.runCollect(Stream.take(elementsOf(prices, undefined), 3))) as (readonly Quote[])[];
        expect(ticks.map((quotes) => quotes.map((quote) => quote.symbol))).toEqual([
          ["ACME", "GLOBEX"],
          ["ACME", "GLOBEX"],
          ["ACME", "GLOBEX"],
        ]);
        expect(ticks[1]![0]!.at).toBeGreaterThanOrEqual(ticks[0]![0]!.at);
        expect(ticks[2]![0]!.at).toBeGreaterThan(ticks[0]![0]!.at);
      }),
    ));

  test("a quote is the stream's price now, for any case of its symbol; an unknown symbol fails NotFound", () =>
    withTicker((channels) =>
      Effect.gen(function* () {
        const quote = channels.get("ticker.quote") as ChannelCall<{ readonly symbol: string }, Quote>;
        expect(yield* resultOf(quote, { symbol: "acme" })).toMatchObject({ symbol: "ACME", price: expect.any(Number) });
        const unknown = yield* Effect.exit(resultOf(quote, { symbol: "NOPE" }));
        const error = Exit.isFailure(unknown) ? Option.getOrUndefined(Exit.findErrorOption(unknown)) : undefined;
        expect(error).toMatchObject({ _tag: "TickerError", reason: "NotFound", message: 'No symbol "NOPE": the ticker quotes ACME, GLOBEX' });
      }),
    ));
});

const execFileAsync = promisify(execFile);
const cliMain = fileURLToPath(new URL("../../../apps/cli/src/main.ts", import.meta.url));
const file = fileURLToPath(new URL("../ticker.ts", import.meta.url));

// The user's path: the file dropped into `<home>/plugins`, loaded by a real host, its channels used from the CLI.
describe("as a plugin file in a real host", () => {
  let started: Lemma;
  let home: string;
  const env = () => ({ ...process.env, LEMMA_HOME: home });
  const lemma = async (...argv: string[]) => (await execFileAsync(process.execPath, ["--conditions=lemma-source", cliMain, ...argv], { env: env() })).stdout;
  /** Starts `lemma` and reads its output a line at a time. */
  const follow = (...argv: string[]) => {
    const child = spawn(process.execPath, ["--conditions=lemma-source", cliMain, ...argv], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    let err = "";
    child.stderr!.on("data", (chunk: Buffer) => (err += chunk.toString()));
    const exited = new Promise<number | null>((done) => child.once("exit", done));
    return { child, next: async () => (await lines.next()).value as string, exited, err: () => err };
  };

  beforeAll(async () => {
    started = await startLemma("lemma-ticker-", {
      plugins: { ticker: { config: { intervalMs: 100 } } },
      prepare: async (home) => {
        await mkdir(join(home, "plugins"));
        await copyFile(file, join(home, "plugins", "ticker.ts"));
      },
    });
    home = started.home;
  }, 30_000);
  afterAll(() => started?.stop());
  // What went wrong in the host shows only in what it printed.
  beforeEach(({ onTestFailed }) => {
    onTestFailed(() => console.error(started?.output()));
  });

  test("lists its channels, quotes a symbol, and streams prices", async () => {
    expect(JSON.parse(await lemma("channels", "--json"))).toEqual([
      { id: "ticker.prices", kind: "stream", title: "Prices", description: "Every symbol's quote now, then on each tick", source: "ticker" },
      { id: "ticker.quote", kind: "call", title: "Quote", description: "One symbol's quote now", source: "ticker" },
    ]);
    expect(JSON.parse(await lemma("channels", "call", "ticker.quote", '{"symbol":"GLOBEX"}', "--json"))).toMatchObject({ symbol: "GLOBEX" });
    const refused = await lemma("channels", "call", "ticker.quote", '{"symbol":"NOPE"}', "--json").catch((error: { code: number; stderr: string }) => error);
    expect(typeof refused === "object" && refused.code).toBe(1);
    expect(JSON.parse((refused as { stderr: string }).stderr).error).toMatchObject({ code: "NotFound", subject: "ticker.quote" });

    const prices = follow("channels", "open", "ticker.prices");
    const ticks = [JSON.parse(await prices.next()), JSON.parse(await prices.next())] as Quote[][];
    expect(ticks.map((quotes) => quotes.map((quote) => quote.symbol))).toEqual([
      ["ACME", "GLOBEX", "INITECH"],
      ["ACME", "GLOBEX", "INITECH"],
    ]);
    prices.child.kill("SIGINT");
    await prices.exited;
  }, 60_000);

  test("a stream open while the plugin reloads ends Withdrawn, and opens again on the new instance", async () => {
    const before = follow("channels", "open", "ticker.prices", "--json");
    await before.next();
    await lemma("plugins", "config", "ticker", "intervalMs", "150");
    expect(await before.exited).toBe(1);
    expect(JSON.parse(before.err()).error).toMatchObject({ code: "Withdrawn", subject: "ticker.prices" });
    const after = follow("channels", "open", "ticker.prices");
    expect(JSON.parse(await after.next())).toHaveLength(3);
    after.child.kill("SIGINT");
    await after.exited;
  }, 60_000);
});
