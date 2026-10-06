import { Schema } from "effect";
import { describe, expect, expectTypeOf, test } from "vitest";
import { createMemoryHistory } from "../src/history.ts";
import { defineRoute, RouteError } from "../src/route.ts";
import type { AnyRoute, ParamsOf } from "../src/route.ts";
import { createRouter, isRoute } from "../src/router.ts";
import type { Match, RouteIssue } from "../src/router.ts";

const Home = defineRoute("home", { path: "/" });
const Thread = defineRoute("thread", {
  path: "/threads/:id/:view?",
  params: Schema.Struct({ id: Schema.String, view: Schema.optional(Schema.String) }),
});
const Settings = defineRoute("settings", { path: "/settings/:section?", params: Schema.Struct({ section: Schema.optional(Schema.String) }) });
const Plugins = defineRoute("settings.plugins", { path: "/settings/plugins" });
const Numbered = defineRoute("numbered", { path: "/threads/:id", params: Schema.Struct({ id: Schema.FiniteFromString }) });

interface Entry {
  readonly route: AnyRoute;
  readonly name: string;
}
const entry = (route: AnyRoute, name = route.id): Entry => ({ route, name });

const setup = (initial = "/", entries: readonly Entry[] = [], known: readonly AnyRoute[] = []) => {
  const history = createMemoryHistory(initial);
  const router = createRouter<Entry>({ history, known, retain: ["safe"] });
  router.setEntries(entries);
  const seen: Match<Entry>[] = [];
  router.subscribe((match) => seen.push(match));
  return { history, router, seen };
};

const shown = (match: Match<Entry>) => (match.status === "matched" ? match.entry.name : match.status);

/** Every ordering of `items`. */
const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));

describe("matching", () => {
  test("does not depend on the order routes were registered in", () => {
    const routes = [Home, Thread, Settings, Plugins, Numbered];
    for (const pathname of ["/", "/threads/7", "/threads/x", "/threads/x/chat", "/settings", "/settings/plugins", "/settings/general", "/nope"]) {
      const answers = new Set(
        permutations(routes).map((order) => {
          const { router } = setup(
            pathname,
            order.map((route) => entry(route)),
          );
          return shown(router.match());
        }),
      );
      expect(answers.size, pathname).toBe(1);
    }
  });

  test("the most specific route wins, and params that do not decode fall through", () => {
    const { router } = setup(
      "/settings/plugins",
      [Settings, Plugins, Thread, Numbered].map((route) => entry(route)),
    );
    expect(shown(router.match())).toBe("settings.plugins");
    router.navigate("/threads/7");
    // Same specificity: ties go by id, so "numbered" first; it decodes, so it wins.
    expect(shown(router.match())).toBe("numbered");
    expect(router.matchOf(Numbered)).toEqual({ params: { id: 7 }, search: {} });
    router.navigate("/threads/x");
    expect(shown(router.match())).toBe("thread");
    expect(router.matchOf(Thread)?.params).toEqual({ id: "x" });
    expect(router.matchOf(Numbered)).toBeUndefined();
  });

  test("a known route with nothing registered is unavailable, not unmatched", () => {
    const { router } = setup("/threads/x", [], [Thread]);
    expect(router.match().status).toBe("unavailable");
    expect(router.matchOf(Thread)?.params).toEqual({ id: "x" });
    router.navigate("/elsewhere");
    expect(router.match().status).toBe("unmatched");
  });
});

describe("entries coming and going", () => {
  test("the page leaves with its entry and returns with it, at the same location", () => {
    const { router, seen } = setup("/threads/x", [entry(Home), entry(Thread)], [Thread]);
    const key = router.location().key;
    router.setEntries([entry(Home)]);
    expect(router.match().status).toBe("unavailable");
    router.setEntries([entry(Home), entry(Thread, "back")]);
    expect(shown(router.match())).toBe("back");
    expect(router.location().key).toBe(key);
    expect(seen.map(shown)).toEqual(["unavailable", "back"]);
  });

  test("the first entry for a route is shown; the default returns when an override leaves", () => {
    const base = entry(Thread, "default");
    const override = entry(Thread, "override");
    const { router } = setup("/threads/x", [base]);
    router.setEntries([override, base]);
    expect(shown(router.match())).toBe("override");
    router.setEntries([base]);
    expect(shown(router.match())).toBe("default");
  });

  test("an unchanged answer notifies no one, and keeps the navigation's signal", () => {
    const home = entry(Home);
    const { router, seen } = setup("/", [home]);
    const signal = router.match().signal;
    router.setEntries([home, entry(Thread)]);
    expect(seen).toEqual([]);
    expect(router.match().signal).toBe(signal);
    expect(signal.aborted).toBe(false);
  });
});

describe("navigation", () => {
  test("pushes, replaces, and steps back and forward", () => {
    const { router, history } = setup("/", [entry(Home), entry(Thread)]);
    router.navigate(router.href(Thread, { id: "a" }));
    router.navigate(router.href(Thread, { id: "b", view: "trajectory" }));
    expect(router.location().pathname).toBe("/threads/b/trajectory");
    router.back();
    expect(router.matchOf(Thread)?.params).toEqual({ id: "a" });
    router.navigate("/threads/c", { replace: true });
    router.back();
    expect(shown(router.match())).toBe("home");
    history.go(1);
    expect(router.location().pathname).toBe("/threads/c");
  });

  test("the same address again adds no entry", () => {
    const { router } = setup("/", [entry(Home), entry(Thread)]);
    router.navigate("/threads/a");
    const index = router.location().index;
    router.navigate("/threads/a");
    expect(router.location().index).toBe(index);
  });

  test("a new location aborts the previous match's signal", () => {
    const { router } = setup("/", [entry(Home), entry(Thread)]);
    const first = router.match().signal;
    router.navigate("/threads/a");
    expect(first.aborted).toBe(true);
    expect(router.match().signal.aborted).toBe(false);
  });

  test("retained search keys carry over unless set", () => {
    const { router } = setup("/?safe=&other=1", [entry(Home), entry(Thread)]);
    expect(router.href(Thread, { id: "a" })).toBe("/threads/a?safe=");
    router.navigate("/threads/a");
    expect(router.location().href).toBe("/threads/a?safe=");
    router.navigate("/?safe=1");
    expect(router.location().search).toBe("?safe=1");
  });

  test("a blocker stops pushes, and undoes back and forward", () => {
    const { router } = setup("/", [entry(Home), entry(Thread)]);
    router.navigate("/threads/a");
    router.navigate("/threads/b");
    let block = true;
    const release = router.block(() => !block);
    expect(router.navigate("/threads/c")).toBe(false);
    router.back();
    expect(router.location().pathname).toBe("/threads/b");
    expect(router.matchOf(Thread)?.params).toEqual({ id: "b" });
    block = false;
    router.back();
    expect(router.location().pathname).toBe("/threads/a");
    release();
  });

  test("history keeps an entry's key across replaces and gives each push a new one", () => {
    const { router } = setup("/", [entry(Home), entry(Thread)]);
    const key = router.location().key;
    router.navigate("/threads/a", { replace: true });
    expect(router.location().key).toBe(key);
    router.navigate("/threads/b");
    expect(router.location().key).not.toBe(key);
  });
});

describe("plugins' routes in conflict", () => {
  test("two routes with one id, or nothing to tell apart, are reported once each, and again only after they part", () => {
    const issues: RouteIssue[] = [];
    const router = createRouter<Entry>({ history: createMemoryHistory("/notes/1"), onIssue: (issue) => issues.push(issue) });
    const Note = defineRoute("note", { path: "/notes/:id" });
    const Memo = defineRoute("memo", { path: "/notes/:key" });
    const Other = defineRoute("note", { path: "/other/:id" });
    router.setEntries([entry(Note), entry(Memo), entry(Other)]);
    expect(issues.map((issue) => issue.kind).sort()).toEqual(["duplicate-id", "same-addresses"]);
    expect(router.match()).toMatchObject({ status: "matched", route: Memo });
    router.setEntries([entry(Note), entry(Memo), entry(Other)]);
    expect(issues).toHaveLength(2);
    router.setEntries([entry(Note)]);
    expect(router.issues()).toEqual([]);
    router.setEntries([entry(Note), entry(Memo)]);
    expect(issues).toHaveLength(3);
  });

  test("routes told apart by their Schemas are a fallback, not a conflict", () => {
    const issues: RouteIssue[] = [];
    const router = createRouter<Entry>({ history: createMemoryHistory("/threads/ada"), onIssue: (issue) => issues.push(issue) });
    const Named = defineRoute("named", { path: "/threads/:id" });
    router.setEntries([entry(Numbered), entry(Named)]);
    expect(issues).toEqual([]);
    expect(router.match()).toMatchObject({ route: Named });
  });
});

describe("errors", () => {
  test("a listener or blocker that throws is reported, and navigation goes on", () => {
    const errors: string[] = [];
    const router = createRouter<Entry>({ history: createMemoryHistory("/"), onError: (_, during) => errors.push(during) });
    router.setEntries([entry(Home), entry(Thread)]);
    const heard: string[] = [];
    router.subscribe(() => {
      throw new Error("listener");
    });
    router.subscribe((match) => heard.push(match.location.pathname));
    router.block(() => {
      throw new Error("blocker");
    });
    expect(router.navigate("/threads/a")).toBe(true);
    expect(heard).toEqual(["/threads/a"]);
    expect(errors).toEqual(["blocker", "listener"]);
  });

  test("navigating to values that do not encode is reported and goes nowhere", () => {
    const errors: unknown[] = [];
    const router = createRouter<Entry>({ history: createMemoryHistory("/"), onError: (error) => errors.push(error) });
    expect(router.navigate(Thread, { id: "" })).toBe(false);
    expect(errors[0]).toBeInstanceOf(RouteError);
    expect(router.location().pathname).toBe("/");
  });

  test("navigating to a URL rather than a path is reported and goes nowhere; paths, relative ones too, go", () => {
    const errors: [string, unknown][] = [];
    const router = createRouter<Entry>({ history: createMemoryHistory("/"), retain: ["safe"], onError: (error, during) => errors.push([during, error]) });
    const urls = ["//evil.example/x", "/\\evil.example/x", "https://other.example/x", "javascript:alert(1)"];
    for (const href of urls) expect(router.navigate(href), href).toBe(false);
    expect(errors.map(([during]) => during)).toEqual(urls.map(() => "navigate"));
    expect(errors.map(([, error]) => (error as Error).message)).toEqual(urls.map((href) => expect.stringContaining(`"${href}"`)));
    expect(router.location()).toMatchObject({ href: "/", index: 0 });
    expect(router.navigate("/x?y#z")).toBe(true);
    expect(router.location().href).toBe("/x?y#z");
    expect(router.navigate("y")).toBe(true);
    expect(router.location().href).toBe("/y");
  });
});

describe("typed navigation", () => {
  test("navigate takes a route and its values, and isRoute narrows a match to them", () => {
    const { router } = setup("/", [entry(Home), entry(Thread)]);
    router.navigate(Thread, { id: "a", view: "trajectory" }, { replace: true });
    const match = router.match();
    expect(router.location()).toMatchObject({ pathname: "/threads/a/trajectory", index: 0 });
    if (!isRoute(match, Thread)) throw new Error("not the thread route");
    expectTypeOf(match.params).toEqualTypeOf<ParamsOf<typeof Thread>>();
    expect(match.params.view).toBe("trajectory");
    expect(isRoute(match, Home)).toBe(false);
  });
});

describe("matchHref", () => {
  test("says what an address would show without going there", () => {
    const { router, seen } = setup("/?safe=", [entry(Home), entry(Thread)]);
    expect(router.matchHref("/threads/b/trajectory")).toMatchObject({ status: "matched", route: Thread, params: { id: "b", view: "trajectory" } });
    expect(router.matchHref("/threads/b").location.search).toBe("?safe=");
    expect(router.matchHref("/nowhere").status).toBe("unmatched");
    expect(router.location().pathname).toBe("/");
    expect(seen).toEqual([]);
  });
});
