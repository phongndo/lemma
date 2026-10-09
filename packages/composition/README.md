# @lemma/composition

Decides what runs from the plugins an app knows and the rows its config files
set, and describes the result for clients. The host
([`packages/host`](../host/README.md)) and the web app plan with the same
functions, so both decide alike. Browser-safe: it imports no Node API, nor,
being part of the runtime, any domain contract; `scripts/check-boundaries.ts`
fails on either.

## Use

```ts
import { catalog, faultHistory, planComposition } from "@lemma/composition";

const plan = planComposition({ bundled, local, rows, pinned: ["transport"], provided: provide.provides });
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

An app that provides capabilities itself (`provide` on `makeCore` or
`makeLoader`, in the [core README](../core/README.md#capabilities-the-application-provides))
passes the same list as `provided` to `planComposition`, `resolveComposition`
and `restartedBy`. Like the core's own capabilities, what it provides needs no
plugin. A plugin offering it too is refused by the core, so it is left out like
any plugin that cannot run, and it neither keeps on nor halts the plugins that
require it.

## Bundles stay outside the kernel

`expandBundles({ manifests, rows, plugins, ui })` expands authoring manifests
and desired selections into ordinary host and UI plugin rows. Apply neither
result when its diagnostics contain an error. Then feed the host result to
`planComposition`, and let each web app plan the UI result. `bundleEnabled`
reports selection, not runtime health.

Shared membership is unioned, inactive members receive effective off rows,
and explicit per-plugin rows win. Selected members do not receive generated
on rows, so third-party capability replacement keeps working. Config defaults
merge at the top level; incompatible defaults fail deterministically unless
an explicit member config replaces them. Bundle ids never enter the kernel
composition, capabilities, or plugin dependency graph. See
[feature bundle configuration](../../docs/configuration.md#feature-bundles)
for the manifest, precedence, and host/UI reconciliation contract.
