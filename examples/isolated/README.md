# Isolated (an example of running a plugin's code apart from the host)

Tools whose code runs in a worker thread rather than in the host. The
[host half](isolated.ts) starts a worker ([`isolate.ts`](isolate.ts),
[`worker.mjs`](worker.mjs)) that loads [`tools.mjs`](tools.mjs), asks it for
its tools, and adds a stand-in for each to `Tools`, offered to the model with
the module's JSON Schema, as MCP's tools are. A call is a message to the
worker and its answer a message back.

The worker has its own event loop, heap, and module cache, so:

- **a tool stuck in an endless loop does not stall the host.** A call that
  does not answer within `timeoutMs` stops the worker, and the next call
  starts another; a cancelled turn stops it too;
- **a tool that uses too much memory stops the worker, not the host**, past
  `memoryMb`;
- **a reload frees the tools' code.** Turning the plugin off, or a reload,
  closes the worker, and the module goes with it: in the host, Node.js keeps
  every version of a module it imported.

Measured on a laptop (Node.js 24): a call costs about 9 µs more than calling
the function in the host, which a model call's seconds dwarf; a worker
answers its first call 16 ms after it starts; and 40 reloads of a module
holding 2 MB grew the host's resident memory by 32 MB in a worker against
176 MB imported into the host.

A worker thread is not a security boundary: it runs with the host's
permissions. It contains a crash, a hang, and memory, not a hostile tool.

| Shape | What it uses                                                |
| ----- | ----------------------------------------------------------- |
| Add   | `Tools`: a stand-in for each tool the worker's module lists |

Its row's `config` sets `timeoutMs` (30 seconds) and `memoryMb` (256).

To use it, put your tools in `tools.mjs` and:

```sh
ln -s "$PWD/examples/isolated" ~/.lemma-dev/plugins/isolated   # or copy the folder, into ~/.lemma/plugins for an installed Lemma
```

`nix develop -c pnpm --filter @lemma/example-isolated test` runs its tools
through the tools registry, and stops a worker stuck in a loop, one
cancelled, and one past its memory.
