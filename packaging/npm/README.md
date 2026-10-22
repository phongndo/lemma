# lemma-harness

[Lemma](https://github.com/phongndo/lemma), an agent harness in which every
part is a plugin, as an npm package. It installs the `lemma` command:

```sh
npm install --global lemma-harness
cd your-project
lemma serve
```

The package is a launcher. The first time it runs, it fetches the Lemma release
of its own version from GitHub, checked against its SHA-256, into
`~/.local/share/lemma/npm` (`LEMMA_NPM_DIR`), outside `node_modules`: Lemma runs
its TypeScript sources, and Node.js strips their types only outside
`node_modules`. The release runs on the Node.js it carries; the one npm uses
runs the launcher alone (18 or later). It runs on macOS on Apple silicon and on
Linux (glibc) on arm64 and x64; on NixOS, the release's Node.js needs nix-ld,
or install [Nix's package](https://github.com/phongndo/lemma/blob/main/docs/installation.md#nix).

`lemma update` and Lemma's Settings › About update it with npm (or pnpm or bun,
whichever installed it), on the stable channel. [Installation](https://github.com/phongndo/lemma/blob/main/docs/installation.md)
says more, and how to remove it.
