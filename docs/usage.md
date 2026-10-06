# Using Lemma

```sh
nix develop -c pnpm start          # build the web app, start the host, print its URL
nix develop -c pnpm desktop        # the same app in a desktop window
nix develop -c pnpm lemma status   # query the running host; `pnpm lemma --help` lists commands
```

The host runs the plugins and serves the web app, the
[desktop app](../apps/desktop/README.md), and the [CLI](../apps/cli/README.md),
which all attach to it. To use a host on another machine, see
[remote access](remote.md).

Log in to a provider from the key icon in the web app or with `lemma login`, or
set the provider's API key environment variable. The
[llm plugin](../plugins/llm-pi-ai/README.md) lists the providers and how to add
your own.
