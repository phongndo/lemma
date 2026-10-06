import { cpus } from "node:os";
import { Schema } from "effect";
import { finish, record } from "./budgets.ts";
import { createMemoryHistory, createNavigator, createRouter, createRouteTable, defineRoute } from "../src/index.ts";
import type { AnyRoute, RouteEntry } from "../src/index.ts";
import { split } from "../src/history.ts";
import { compileRoutes, resolve } from "../src/router.ts";

// Warm microbenchmarks of the router's own work: matching, compiling, navigating, encoding. Each value is the median
// of `samples` batch means; brackets show min and max. Not end-to-end page latency.
const samples = Number(process.env.LEMMA_BENCH_SAMPLES ?? 7);
if (!Number.isInteger(samples) || samples < 1) throw new Error("LEMMA_BENCH_SAMPLES must be a positive integer");
const iterations = Number(process.env.LEMMA_BENCH_ITERATIONS ?? 10_000);
if (!Number.isInteger(iterations) || iterations < 1) throw new Error("LEMMA_BENCH_ITERATIONS must be a positive integer");
/** Fewer repetitions for operations that cost milliseconds at the largest sizes. */
const heavy = Math.max(1, Math.min(100, Math.floor(iterations / 100)));

let sink = 0;
function measure(name: string, count: number, run: () => void) {
  run();
  const values: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    run();
    values.push(((performance.now() - start) * 1_000) / count);
  }
  values.sort((a, b) => a - b);
  const median = values[Math.floor(samples / 2)]!;
  record(name, median);
  console.log(`${name.padEnd(40)} ${median.toFixed(3).padStart(10)} µs/op  [${values[0]!.toFixed(3)}, ${values.at(-1)!.toFixed(3)}]`);
}

/**
 * A plausible app's routes at scale: literal sections, params, trailing optionals, and rests, a quarter of each, plus
 * a catch-all, so most paths are fitted by several routes of differing specificity.
 */
const routesOf = (count: number): AnyRoute[] => [
  ...Array.from({ length: count }, (_, index) => {
    switch (index % 4) {
      case 0:
        return defineRoute(`r${index}`, { path: `/s${index}` });
      case 1:
        return defineRoute(`r${index}`, { path: `/s${index}/:id` });
      case 2:
        return defineRoute(`r${index}`, { path: `/s${index}/:id/:view?` });
      default:
        return defineRoute(`r${index}`, { path: `/s${index}/files/*rest` });
    }
  }),
  defineRoute("catch-all", { path: "/*rest" }),
];
const entriesOf = (routes: readonly AnyRoute[]): RouteEntry[] => routes.map((route) => ({ route }));
/** Addresses spread over the table: each kind of route, plus one only the catch-all fits. */
const hrefsOf = (count: number) => [`/s0`, `/s${count - 3}/abc`, `/s${count - 2}/abc/details`, `/s${count - 1}/files/a/b/c`, `/nowhere/at/all`];

console.log(`Node ${process.version} · ${process.platform}/${process.arch} · ${cpus()[0]?.model}`);
console.log(`Median batch means, ${samples} samples; brackets show min/max.\n`);

for (const count of [10, 100, 1000]) {
  const table = compileRoutes(entriesOf(routesOf(count)), []);
  const locations = hrefsOf(count).map((href) => split(href, "k", 0));
  const signal = new AbortController().signal;
  measure(`Resolve / ${count} routes`, iterations, () => {
    for (let n = 0; n < iterations; n++) {
      const match = resolve(locations[n % locations.length]!, table, signal);
      sink += match.status.length;
    }
  });
}

for (const count of [100, 1000]) {
  const entries = entriesOf(routesOf(count));
  measure(`Compile / ${count} routes`, heavy, () => {
    for (let n = 0; n < heavy; n++) sink += compileRoutes(entries, []).routes.length;
  });
}

// What a plugin coming or going costs: compiling, finding conflicts, and matching the location again.
for (const count of [100, 1000]) {
  const entries = entriesOf(routesOf(count));
  const router = createRouter({ history: createMemoryHistory(`/s${count - 3}/abc`), onIssue: () => {} });
  const rounds = count >= 1000 ? Math.max(1, Math.floor(heavy / 10)) : heavy;
  measure(`Set entries / ${count} routes`, rounds, () => {
    for (let n = 0; n < rounds; n++) router.setEntries(n % 2 === 0 ? entries : entries.slice(1));
  });
  router.destroy();
}

{
  const count = 100;
  const router = createRouter({ history: createMemoryHistory("/"), onIssue: () => {} });
  router.setEntries(entriesOf(routesOf(count)));
  let heard = 0;
  router.subscribe(() => heard++);
  const hrefs = hrefsOf(count);
  measure(`Navigate / ${count} routes`, iterations, () => {
    for (let n = 0; n < iterations; n++) router.navigate(hrefs[n % hrefs.length]!);
  });
  sink += heard;
  measure(`Explain / ${count} routes`, heavy, () => {
    for (let n = 0; n < heavy; n++) sink += router.explain(hrefs[n % hrefs.length]!).verdicts.length;
  });
  router.destroy();
}

{
  const route = defineRoute("user", {
    path: "/users/:id/:tab?",
    params: Schema.Struct({ id: Schema.String, tab: Schema.optional(Schema.String) }),
    search: Schema.Struct({ page: Schema.optional(Schema.FiniteFromString), q: Schema.optional(Schema.String) }),
  });
  measure("Href / Schema params and search", iterations, () => {
    for (let n = 0; n < iterations; n++) sink += route.href({ id: `u${n & 7}`, tab: "posts" }, { page: n & 3, q: "x" }).length;
  });
}

// Many locations over one table (tabs, panes): what one costs to make, and what a change of routes costs them all. The
// table compiles once; each navigator matches its own location again.
{
  const routes = routesOf(100);
  const table = createRouteTable();
  table.setEntries(entriesOf(routes));
  const hrefs = hrefsOf(100);
  measure("Navigator create + destroy / 100 routes", heavy, () => {
    for (let n = 0; n < heavy; n++) createNavigator(table, { history: createMemoryHistory(hrefs[n % hrefs.length]) }).destroy();
  });
  const tabs = Array.from({ length: 100 }, (_, index) => createNavigator(table, { history: createMemoryHistory(hrefs[index % hrefs.length]) }));
  const entries = entriesOf(routes);
  measure("Set entries / 100 routes, 100 navigators", heavy, () => {
    for (let n = 0; n < heavy; n++) table.setEntries(n % 2 === 0 ? entries : entries.slice(1));
  });
  sink += tabs.filter((tab) => tab.match().status === "matched").length;
  for (const tab of tabs) tab.destroy();

  // What a navigator holds while it lives: the heap while 2000 are held, less the heap once they are gone, each read
  // after collecting until it settles. They are made and held inside a function, so nothing outside it (a variable a
  // loop reused, a stack slot) keeps them past it. The median of five rounds; only when the runtime can collect.
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc !== undefined) {
    const settled = () => {
      for (let n = 0; n < 4; n++) gc();
      return process.memoryUsage().heapUsed;
    };
    const count = 2000;
    const holding = () => {
      const held = Array.from({ length: count }, (_, index) => createNavigator(table, { history: createMemoryHistory(hrefs[index % hrefs.length]) }));
      const heap = settled();
      for (const navigator of held) navigator.destroy();
      sink += held.length;
      return heap;
    };
    const rounds: number[] = [];
    for (let round = 0; round < 5; round++) {
      const held = holding();
      rounds.push((held - settled()) / count);
    }
    rounds.sort((a, b) => a - b);
    const bytes = rounds[2]!;
    record("Navigator heap bytes", bytes);
    console.log(`${"Navigator heap bytes".padEnd(40)} ${bytes.toFixed(0).padStart(10)} bytes  [${rounds[0]!.toFixed(0)}, ${rounds.at(-1)!.toFixed(0)}]`);
  }
}

if (sink === 0) throw new Error("Unobserved benchmark result");
finish("microbench");
