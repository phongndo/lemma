// Runs `busy.ts`'s plugin with the stall watchdog on, blocks the loop through its handler for the milliseconds given as
// the first argument, and prints the stall `onStall` hears as JSON: what `stall.test.ts` reads. The second argument is
// how: `busy` (the default) in JavaScript; `native` in a synchronous child process; `linked`, in JavaScript, the
// plugin's code known by a path through a symlink, as a plugin linked into a plugins directory is. It never stops the
// watchdog: the process ends once its own work does, as the watchdog keeps nothing alive.
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { Hooks, makeCore } from "@lemma/core";
import { watchStalls } from "../../../src/stall.ts";
import type { Stall } from "../../../src/stall.ts";
import busy, { Busy, Waiting } from "./busy.ts";

const ms = Number(process.argv[2] ?? 1500);
const how = process.argv[3] ?? "busy";
const file = fileURLToPath(new URL("./busy.ts", import.meta.url));
const links = how === "linked" ? mkdtempSync(join(tmpdir(), "lemma-stall-")) : undefined;
if (links !== undefined) symlinkSync(dirname(file), join(links, "plugin"), "dir");
let stalled!: (stall: Stall) => void;
const heard = new Promise<Stall>((resolve) => (stalled = resolve));
const owners = [{ path: links === undefined ? file : join(links, "plugin", "busy.ts"), id: busy.id }];
const watch = watchStalls({
  owners: () => owners,
  onStall: (stall) => stalled(stall),
});
// The worker is watching, and has heard where the plugin's code is (sent before it started), before the loop blocks.
await watch?.ready;
await Effect.runPromise(
  Effect.scoped(
    Effect.flatMap(makeCore([busy]), (core) => core.run(Effect.flatMap(Hooks, (hooks) => hooks.invoke(how === "native" ? Waiting : Busy, ms, Effect.succeed)))),
  ),
);
if (links !== undefined) rmSync(links, { recursive: true, force: true });
const stall = await Promise.race([heard, new Promise((resolve) => setTimeout(() => resolve("no stall heard"), 2_000))]);
console.log(JSON.stringify(stall));
