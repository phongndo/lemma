import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { createMemoryHistory } from "../src/history.ts";
import { defineRoute } from "../src/route.ts";
import type { AnyRoute } from "../src/route.ts";
import { createRouter } from "../src/router.ts";

const Home = defineRoute("home", { path: "/" });
const Item = defineRoute("item", { path: "/items/:id/:tab?" });
const New = defineRoute("item.new", { path: "/items/new" });
// Equally specific, so tried by id: digits first, and a word falls through to the next.
const Numbered = defineRoute("n.digits", { path: "/n/:id", params: Schema.Struct({ id: Schema.FiniteFromString }) });
const Named = defineRoute("n.word", { path: "/n/:name" });
const Files = defineRoute("files", { path: "/files/*rest" });
const Off = defineRoute("off", { path: "/off" });

interface Entry {
  readonly route: AnyRoute;
  readonly name: string;
}
const entry = (route: AnyRoute, name = `${route.id} page`): Entry => ({ route, name });

const setup = (initial = "/") => {
  const router = createRouter<Entry>({ history: createMemoryHistory(initial), known: [Off], retain: ["safe"], label: (e: Entry) => e.name });
  router.setEntries([entry(Home), entry(Item), entry(New), entry(Numbered), entry(Named), entry(Files), entry(Item, "item override")]);
  return router;
};

describe("explain", () => {
  test("says which route shows an address and why each other one does not", () => {
    const router = setup("/?safe=");
    const explained = router.explain("/items/new");
    expect(explained).toMatchObject({ href: "/items/new?safe=", status: "matched", route: "item.new" });
    const byRoute = Object.fromEntries(explained.verdicts.map((verdict) => [verdict.route, verdict]));
    expect(explained.verdicts[0]).toMatchObject({ route: "item.new", outcome: "shown" });
    expect(byRoute.item).toMatchObject({ outcome: "outranked" });
    expect(byRoute.item!.detail).toMatch(/"item.new" is more specific: at segment 2 it has a literal where this has a param/);
    expect(byRoute.home).toMatchObject({ outcome: "no-match", detail: "it takes 0 segments; the path has 2" });
    expect(byRoute.files).toMatchObject({ outcome: "no-match", detail: "its literal segments differ from the path's" });
    expect(router.location().pathname).toBe("/");
  });

  test("a route whose params do not decode is rejected, and the next one shows", () => {
    const explained = setup().explain("/n/ada");
    expect(explained.route).toBe("n.word");
    expect(explained.verdicts.find((verdict) => verdict.route === "n.digits")).toMatchObject({ outcome: "rejected" });
    expect(explained.verdicts.find((verdict) => verdict.route === "n.digits")!.detail).toMatch(/params do not decode/);
    expect(
      setup()
        .explain("/n/7")
        .verdicts.find((verdict) => verdict.route === "n.word")!.detail,
    ).toBe('as specific as "n.digits", which comes first by id');
  });

  test("a known route with nothing registered is unavailable; an address nothing fits is unmatched", () => {
    const router = setup();
    expect(router.explain("/off")).toMatchObject({ status: "unavailable", route: "off" });
    expect(router.explain("/off").verdicts[0]!.detail).toMatch(/nothing is registered/);
    const nowhere = router.explain("/nowhere/at/all");
    expect(nowhere.status).toBe("unmatched");
    expect(nowhere.verdicts.every((verdict) => verdict.outcome === "no-match")).toBe(true);
  });
});

describe("inspect", () => {
  test("lists every route with what is registered there, in priority order, as plain data", () => {
    const router = setup("/items/1");
    router.block(() => true, { label: "editor: unsaved changes" });
    const snapshot = router.inspect();
    expect(snapshot.routes.find((route) => route.id === "item")).toEqual({
      id: "item",
      path: "/items/:id/:tab?",
      known: false,
      entries: ["item page", "item override"],
    });
    expect(snapshot.routes.find((route) => route.id === "off")).toEqual({ id: "off", path: "/off", known: true, entries: [] });
    expect(snapshot.match).toEqual({ status: "matched", href: "/items/1", route: "item", entry: "item page", params: { id: "1" }, search: {} });
    expect(snapshot.blockers).toEqual(["editor: unsaved changes"]);
    expect(snapshot.retain).toEqual(["safe"]);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});

describe("journal", () => {
  test("records navigations, matches, moves, refusals by label, and failures, in order", () => {
    const router = setup();
    const heard: string[] = [];
    router.onEvent((event) => heard.push(event.kind));
    router.navigate("/items/1");
    router.back();
    const unblock = router.block((transition) => transition.href !== "/off", { label: "guard" });
    router.navigate("/off");
    unblock();
    router.navigate(Item, { id: "" });
    // Setting the entries matched the location first.
    const [first, ...journal] = router.journal().map(({ seq: _seq, at: _at, ...event }) => event);
    expect(first).toMatchObject({ kind: "matched", match: { route: "home" } });
    expect(journal).toEqual([
      { kind: "navigate", href: "/items/1", action: "push", held: false, index: 0 },
      { kind: "matched", match: expect.objectContaining({ route: "item", entry: "item page" }), index: 1 },
      { kind: "moved", href: "/", delta: -1, index: 0 },
      { kind: "matched", match: expect.objectContaining({ route: "home" }), index: 0 },
      { kind: "blocked", href: "/off", action: "push", by: "guard", index: 0 },
      { kind: "failed", during: "navigate", message: expect.stringMatching(/"item".*"id" is required/), index: 0 },
    ]);
    expect(heard).toEqual(journal.map((event) => event.kind));
    expect(router.journal().map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("keeps the latest events up to its size", () => {
    const router = createRouter<Entry>({ history: createMemoryHistory("/"), journal: 3 });
    router.setEntries([entry(Home), entry(Item)]);
    for (const id of ["1", "2", "3"]) router.navigate(`/items/${id}`);
    // One match for the entries, then a navigation and a match each.
    expect(router.journal().map((event) => event.seq)).toEqual([5, 6, 7]);
  });
});
