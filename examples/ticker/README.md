# Ticker (an example host plugin and UI file)

Made-up prices for a few symbols, moving by a random walk, and a page in the
web app that shows them live. It is the smallest example of a host plugin
serving its own UI: [`ticker.ts`](ticker.ts) adds two
[channels](../../packages/contracts/src/channels.ts), and
[`ticker-ui.js`](ticker-ui.js) reads them through the `Client` capability.
Neither needs a change to Lemma's contracts, its transport, or the web app.
`ticker.ts` declares its channels (`prices`, `quote`) apart from serving them,
so a client with a build step imports the declarations and calls them typed.

| Channel         | Kind   | Payload             | Result                                            |
| --------------- | ------ | ------------------- | ------------------------------------------------- |
| `ticker.prices` | stream | none                | Every symbol's quote now, then on each tick       |
| `ticker.quote`  | call   | `{ "symbol": "…" }` | One quote; fails `NotFound` for a symbol it lacks |

A quote is `{ symbol, price, change, at }`: `change` since the tick before,
`at` in epoch ms.

Both files import only what the host or the page supplies, so they need no
install step. To use them:

```sh
ln -s "$PWD/examples/ticker/ticker.ts" ~/.lemma/plugins/ticker.ts       # or copy them
ln -s "$PWD/examples/ticker/ticker-ui.js" ~/.lemma/ui/ticker-ui.js
lemma reload                                                          # plugin files load on reload
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
new instance itself.

`nix develop -c pnpm --filter @lemma/example-ticker test` checks the walk and
the channels, and runs the plugin as a file in a real host, using it from the
CLI.
