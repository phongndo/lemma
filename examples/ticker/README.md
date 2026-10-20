# Ticker (an example plugin with two halves)

Made-up prices for a few symbols, moving by a random walk, and a page in the
web app that shows them live. It is the smallest example of a plugin with a
host half and a web half: [`ticker.ts`](ticker.ts) adds two
[channels](../../packages/contracts/src/channels.ts), and [`web.js`](web.js)
reads them through the `Client` capability. Both define the id `ticker`, so
one row in `config.jsonc` turns both on or off, and the web app runs its half
only while the host's runs. [`package.json`](package.json)'s `lemma` manifest
says where each half is. Neither needs a change to Lemma's contracts, its
transport, or the web app. `ticker.ts` declares its channels (`prices`,
`quote`) apart from serving them, so a client with a build step imports the
declarations and calls them typed.

| Channel         | Kind   | Payload             | Result                                            |
| --------------- | ------ | ------------------- | ------------------------------------------------- |
| `ticker.prices` | stream | none                | Every symbol's quote now, then on each tick       |
| `ticker.quote`  | call   | `{ "symbol": "…" }` | One quote; fails `NotFound` for a symbol it lacks |

A quote is `{ symbol, price, change, at }`: `change` since the tick before,
`at` in epoch ms.

Both halves import only what the host or the page supplies, so the folder
needs no install step. To use it:

```sh
ln -s "$PWD/examples/ticker" ~/.lemma/plugins/ticker   # or copy the folder: the host loads it, and open web apps follow
```

The page is at `/ticker`, and the palette's **Ticker: Show prices** opens it.
From a shell:

```sh
lemma channels                                        # what host plugins serve
lemma channels call ticker.quote '{"symbol":"ACME"}'
lemma channels open ticker.prices                     # one line of JSON per tick, until Ctrl+C
```

| Setting      | Default                         | What it does          |
| ------------ | ------------------------------- | --------------------- |
| `symbols`    | `["ACME", "GLOBEX", "INITECH"]` | The symbols it quotes |
| `intervalMs` | `1000`                          | How often prices move |

Prices live in the plugin, so a reload (a settings change) starts them over.
An open stream then fails `Withdrawn`, and the page, which follows it with
`client.follow`, opens it again on the new instance; it does the same after the
page reconnects to the host, because a stream ends with its connection, and
when a `channels-changed` event lists `ticker.prices` again after the plugin
was off. A client that falls behind
gets the latest prices rather than a backlog. `ticker.quote` only reads, so
it is declared `repeatable`: one asked across a reload the host asks of the
new instance itself. Both declare `access: "read"`, so an agent's scripts call
them as `lemma_ticker_quote` and `lemma_ticker_prices` with nothing configured
([tools.lemma](../../domains/tools/lemma/README.md)).

`nix develop -c pnpm --filter @lemma/example-ticker test` checks the walk and
the channels, and runs the plugin as a folder in a real host, using it from
the CLI.
