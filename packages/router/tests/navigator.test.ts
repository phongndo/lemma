import { describe, expect, test } from "vitest";
import { createMemoryHistory } from "../src/history.ts";
import { defineRoute } from "../src/route.ts";
import type { AnyRoute } from "../src/route.ts";
import { createNavigator, createRouter, createRouteTable } from "../src/router.ts";
import type { Match, RouteIssue } from "../src/router.ts";

interface Entry {
  readonly route: AnyRoute;
  readonly name: string;
}
const Home = defineRoute("home", { path: "/" });
const Item = defineRoute("item", { path: "/items/:id" });
const Twin = defineRoute("twin", { path: "/items/:other" });

const shown = (match: Match<Entry>) => (match.status === "matched" ? `${match.entry.name} ${match.location.pathname}` : match.status);

describe("navigators over one route table", () => {
  test("each keeps its own location and history; the table's changes reach all of them", () => {
    const table = createRouteTable<Entry>({ known: [Item] });
    const tabs = Array.from({ length: 100 }, (_, index) => createNavigator(table, { history: createMemoryHistory(index % 2 === 0 ? "/" : `/items/${index}`) }));
    expect(shown(tabs[0]!.match())).toBe("unmatched");
    expect(shown(tabs[1]!.match())).toBe("unavailable");

    let changes = 0;
    table.subscribe(() => changes++);
    table.setEntries([
      { route: Home, name: "home" },
      { route: Item, name: "item" },
    ]);
    expect(changes).toBe(1);
    expect(shown(tabs[0]!.match())).toBe("home /");
    expect(shown(tabs[99]!.match())).toBe("item /items/99");

    // Moving one tab moves no other.
    tabs[0]!.navigate(Item, { id: "x" });
    expect(shown(tabs[0]!.match())).toBe("item /items/x");
    expect(shown(tabs[2]!.match())).toBe("home /");
    tabs[0]!.back();
    expect(shown(tabs[0]!.match())).toBe("home /");
    expect(tabs[1]!.matchOf(Item)?.params.id).toBe("1");
  });

  test("a destroyed navigator stops following the table; a destroyed table leaves its navigators the last routes", () => {
    const table = createRouteTable<Entry>();
    const kept = createNavigator(table, { history: createMemoryHistory("/") });
    const gone = createNavigator(table, { history: createMemoryHistory("/") });
    const heard: string[] = [];
    kept.subscribe((match) => heard.push(`kept ${shown(match)}`));
    gone.subscribe((match) => heard.push(`gone ${shown(match)}`));
    gone.destroy();
    table.setEntries([{ route: Home, name: "home" }]);
    expect(heard).toEqual(["kept home /"]);
    table.destroy();
    table.setEntries([]);
    expect(shown(kept.match())).toBe("home /");
    // Still navigable over the routes it last had.
    kept.navigate("/items/1");
    expect(shown(kept.match())).toBe("unmatched");
  });

  test("a conflict is reported once by the table and journaled by every navigator", () => {
    const reported: RouteIssue[] = [];
    const table = createRouteTable<Entry>({ onIssue: (issue) => reported.push(issue), label: (entry: Entry) => entry.name });
    const a = createNavigator(table, { history: createMemoryHistory("/items/1") });
    const b = createNavigator(table, { history: createMemoryHistory("/") });
    table.setEntries([
      { route: Item, name: "item" },
      { route: Twin, name: "twin" },
    ]);
    expect(reported.map((issue) => issue.kind)).toEqual(["same-addresses"]);
    for (const navigator of [a, b]) expect(navigator.journal().filter((event) => event.kind === "issue")).toHaveLength(1);
    expect(a.inspect().routes.map((route) => [route.id, route.entries])).toEqual([
      ["item", ["item"]],
      ["twin", ["twin"]],
    ]);
    expect(a.inspect().issues).toHaveLength(1);
  });

  test("a reporter of conflicts that throws does not keep the navigators on the old routes", () => {
    const table = createRouteTable<Entry>({
      onIssue: () => {
        throw new Error("reporter broke");
      },
    });
    const navigator = createNavigator(table, { history: createMemoryHistory("/items/1") });
    const error = console.error;
    console.error = () => {};
    try {
      table.setEntries([
        { route: Item, name: "item" },
        { route: Twin, name: "twin" },
      ]);
    } finally {
      console.error = error;
    }
    expect(shown(navigator.match())).toBe("item /items/1");
    expect(navigator.journal().filter((event) => event.kind === "issue")).toHaveLength(1);
  });

  test("a destroyed table keeps the routes it last had, for the navigators still over it", () => {
    const table = createRouteTable<Entry>();
    table.setEntries([{ route: Home, name: "home" }]);
    const navigator = createNavigator(table, { history: createMemoryHistory("/") });
    table.destroy();
    table.setEntries([]);
    expect(navigator.matchHref("/").status).toBe("matched");
    expect(table.entries()).toHaveLength(1);
  });

  test("a journal of 0 keeps nothing; one that is not a whole number keeps the default", () => {
    const table = createRouteTable<Entry>();
    table.setEntries([{ route: Item, name: "item" }]);
    const none = createNavigator(table, { history: createMemoryHistory("/"), journal: 0 });
    const odd = createNavigator(table, { history: createMemoryHistory("/"), journal: Number.NaN });
    for (let n = 0; n < 500; n++) {
      none.navigate(`/items/${n}`);
      odd.navigate(`/items/${n}`);
    }
    expect(none.journal()).toEqual([]);
    expect(odd.journal()).toHaveLength(200);
  });

  test("createRouter is a table and one navigator, destroyed together", () => {
    const router = createRouter<Entry>({ history: createMemoryHistory("/") });
    router.setEntries([{ route: Home, name: "home" }]);
    expect(router.table.entries()).toHaveLength(1);
    let heard = 0;
    router.table.subscribe(() => heard++);
    router.destroy();
    router.table.setEntries([]);
    expect(heard).toBe(0);
  });
});
