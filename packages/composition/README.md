# @lemma/composition

Decides what runs from the plugins an app knows and the rows its config files
set, and describes the result for clients. The host
([`packages/host`](../host/README.md)) and the web app plan with the same
functions, so both decide alike. Browser-safe: it imports no Node API.

## Use

```ts
import { catalog, faultHistory, planComposition } from "@lemma/composition";

const plan = planComposition({ bundled, local, rows, pinned: ["transport"] });
const { composition, diagnostics, required } = plan;
```

[Configuration](../../docs/configuration.md) describes the rows, how they
merge, and what happens to a plugin that cannot run. Each export's doc comment
gives its contract: `planComposition` turns plugins and rows into what runs,
leaving out what cannot and saying why, with `required` naming what must start;
`resolveComposition` and `withReplacements` decide what turning a plugin on or
off does to the plugins around it; `restartedBy` is what a change restarts;
`catalog` joins each known plugin with its row and core snapshot for the
Plugins page and the CLI, with the recent faults `faultHistory` keeps.
