# sessions.cli

The sessions' commands for the `lemma` command (`CliCommands` in [`@lemma/cli`](../../cli/README.md)): `sessions list|show|new|title|pin|unpin|archive|unarchive|delete|checkout|open|inspect|cache|watch`. Requires nothing: it reaches the sessions through their channels (`callHere`, `followHere`). No config.

- **Directories are the host's.** `list` and `new` default to the client's
  directory, which is the host's only when they are one machine: with a host
  elsewhere, give its path (`--cwd`).
- **`inspect`** is the web app's Trajectory view, from the same contract
  (`trajectory`, the ledger and its filter language in `@lemma/sessions`), so
  both show the same records and take the same queries: turns and steps,
  `--records` (with `--filter`, `--sort`, `--range`), or one request in full
  (`--request`, with `--system`, `--tools`, `--diff`, `--rebuilt`, or
  `--plugins`: each plugin's share of it, `pluginShares`).
- **`cache`** reports how sessions kept the provider's prompt cache
  (`cacheReport`): for a directory's sessions (`--all`, `--cwd`) or one, the
  requests after the first that changed the system prompt or the tools, which
  a provider caches ahead of the history, the plugins whose parts changed,
  and the share of input read from the cache. Whether in-history system
  messages are worth building turns on what it finds.
- **`open`** asks the client to open the session's address in the web app
  (`ThreadRoute`); with `--json` it only answers the path.
- **`watch`** prints what is appended to the log from now on, until stopped,
  opening the log again from the last event shown when its plugin reloads.
