import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createBrowserHistory } from "../src/history.ts";
import { createRouter } from "../src/router.ts";

/** Enough of a window for the browser history: a stack of entries with state, and `popstate`. */
const fakeWindow = (initial: string, initialState: unknown = null) => {
  const stack: { url: string; state: unknown }[] = [{ url: initial, state: initialState }];
  let index = 0;
  /** With `later`, a `go` lands only on `land()`, as a browser's does on a later task. */
  let later = false;
  let landing: (() => void) | undefined;
  /** With `refusing`, writes throw, as Safari's do past its limit on how often a page writes. */
  let refusing = false;
  const refusal = () => new DOMException("Attempt to use history.pushState() more than 100 times per 30 seconds", "SecurityError");
  const listeners = new Set<() => void>();
  const unloads = new Set<(event: { preventDefault: () => void; returnValue: unknown }) => void>();
  const at = () => new URL(stack[index]!.url, "http://app.test");
  const target = {
    location: {
      get pathname() {
        return at().pathname;
      },
      get search() {
        return at().search;
      },
      get hash() {
        return at().hash;
      },
    },
    history: {
      get state() {
        return stack[index]!.state;
      },
      pushState: (state: unknown, _: string, url?: string) => {
        if (refusing) throw refusal();
        index++;
        stack.splice(index, stack.length, { url: url ?? stack[index - 1]!.url, state });
      },
      replaceState: (state: unknown, _: string, url?: string) => {
        if (refusing) throw refusal();
        stack[index] = { url: url ?? stack[index]!.url, state };
      },
      go: (delta: number) => {
        const move = () => {
          index = Math.max(0, Math.min(stack.length - 1, index + delta));
          for (const listener of listeners) listener();
        };
        if (later) landing = move;
        else move();
      },
    },
    addEventListener: (type: string, listener: any) => (type === "beforeunload" ? unloads : listeners).add(listener),
    removeEventListener: (type: string, listener: any) => (type === "beforeunload" ? unloads : listeners).delete(listener),
    /** The page is about to unload: whether something asked the user to confirm. */
    unload: () => {
      let asked = false;
      for (const listener of unloads) listener({ preventDefault: () => (asked = true), returnValue: undefined });
      return asked;
    },
    /** The user edits the address: a new entry without state, then popstate. */
    edit: (url: string) => {
      index++;
      stack.splice(index, stack.length, { url, state: null });
      for (const listener of listeners) listener();
    },
    later: () => void (later = true),
    refuse: (on = true) => void (refusing = on),
    land: () => {
      const move = landing;
      landing = undefined;
      move?.();
    },
    stack,
  };
  return target;
};

describe("createBrowserHistory", () => {
  test("adopts the first entry, keeping the page's own state", () => {
    const target = fakeWindow("/a?x=1#h", { mine: true });
    const history = createBrowserHistory(target as unknown as Window);
    expect(history.location()).toMatchObject({ href: "/a?x=1#h", pathname: "/a", search: "?x=1", hash: "#h", index: 0 });
    expect(target.stack[0]!.state).toMatchObject({ mine: true, __router: { index: 0 } });
  });

  test("measures back and forward, and resumes an entry's index after a reload", () => {
    const target = fakeWindow("/");
    const history = createBrowserHistory(target as unknown as Window);
    const updates: { action: string; delta: number; pathname: string }[] = [];
    history.subscribe(({ action, delta, location }) => updates.push({ action, delta, pathname: location.pathname }));
    history.push("/one");
    history.push("/two");
    history.go(-2);
    history.go(1);
    expect(updates).toEqual([
      { action: "push", delta: 1, pathname: "/one" },
      { action: "push", delta: 1, pathname: "/two" },
      { action: "pop", delta: -2, pathname: "/" },
      { action: "pop", delta: 1, pathname: "/one" },
    ]);
    history.destroy();
    // A reload reads the entry's state back.
    expect(createBrowserHistory(target as unknown as Window).location().index).toBe(1);
  });

  test("an address edited by hand becomes a new entry after the current one", () => {
    const target = fakeWindow("/");
    const history = createBrowserHistory(target as unknown as Window);
    const actions: string[] = [];
    history.subscribe(({ action, delta }) => actions.push(`${action}:${delta}`));
    target.edit("/typed");
    expect(actions).toEqual(["pop:0"]);
    expect(history.location()).toMatchObject({ pathname: "/typed", index: 1 });
  });

  test("a write the browser refuses throws and changes nothing", () => {
    const target = fakeWindow("/");
    const history = createBrowserHistory(target as unknown as Window);
    const heard: string[] = [];
    history.subscribe(({ location }) => heard.push(location.href));
    target.refuse();
    expect(() => history.push("/one")).toThrow(/100 times/);
    expect(() => history.replace("/two")).toThrow(/100 times/);
    expect(history.location()).toMatchObject({ href: "/", index: 0 });
    expect(heard).toEqual([]);
    target.refuse(false);
    history.push("/one");
    expect(history.location()).toMatchObject({ href: "/one", index: 1 });
  });

  test("an entry reached without state is followed even when the browser refuses to give it some", () => {
    const target = fakeWindow("/");
    const history = createBrowserHistory(target as unknown as Window);
    const heard: string[] = [];
    history.subscribe(({ action, location }) => heard.push(`${action} ${location.href} ${location.index}`));
    target.refuse();
    target.edit("/typed");
    expect(heard).toEqual(["pop /typed 1"]);
    expect(history.location()).toMatchObject({ href: "/typed", index: 1 });
  });
});

describe("a router on the browser history", () => {
  test("a navigation made while a back is landing waits for it, so the back does not leave it", () => {
    const target = fakeWindow("/a");
    const router = createRouter({ history: createBrowserHistory(target as unknown as Window) });
    router.navigate("/settings");
    target.later();
    router.back();
    router.navigate("/b");
    expect(router.location().href).toBe("/settings");
    target.land();
    expect(router.location()).toMatchObject({ href: "/b", index: 1 });
    expect(target.stack.map((entry) => entry.url)).toEqual(["/a", "/b"]);
  });

  test("a forward past the last known entry is not waited for", () => {
    const target = fakeWindow("/a");
    const router = createRouter({ history: createBrowserHistory(target as unknown as Window) });
    router.navigate("/b");
    router.back();
    target.later();
    router.go(2);
    router.navigate("/c");
    expect(router.location()).toMatchObject({ href: "/c", index: 1 });
  });

  test("a forward within the known entries is waited for", () => {
    const target = fakeWindow("/a");
    const router = createRouter({ history: createBrowserHistory(target as unknown as Window) });
    router.navigate("/b");
    router.back();
    target.later();
    router.go(1);
    router.navigate("/c");
    expect(router.location().href).toBe("/a");
    target.land();
    expect(router.location()).toMatchObject({ href: "/c", index: 2 });
    expect(target.stack.map((entry) => entry.url)).toEqual(["/a", "/b", "/c"]);
  });

  test("after a reload the entries ahead are unknown, so a forward is not waited for", () => {
    const target = fakeWindow("/a", { __router: { key: "k", index: 3 } });
    const history = createBrowserHistory(target as unknown as Window);
    expect(history.go(1)).toBe(false);
    expect(history.go(-1)).toBe(true);
  });

  test("a back past the first entry is not waited for", () => {
    const target = fakeWindow("/a");
    const router = createRouter({ history: createBrowserHistory(target as unknown as Window) });
    target.later();
    router.back();
    router.navigate("/b");
    expect(router.location().href).toBe("/b");
  });

  test("a write the browser refuses is reported, and the navigation returns false and goes nowhere", () => {
    const target = fakeWindow("/a");
    const errors: string[] = [];
    const router = createRouter({ history: createBrowserHistory(target as unknown as Window), onError: (_, during) => errors.push(during) });
    target.refuse();
    expect(router.navigate("/b")).toBe(false);
    expect(router.navigate("/c", { replace: true })).toBe(false);
    expect(errors).toEqual(["navigate", "navigate"]);
    expect(router.journal().map((event) => event.kind)).toEqual(["navigate", "failed", "navigate", "failed"]);
    expect(router.location()).toMatchObject({ href: "/a", index: 0 });
    expect(router.match().location.href).toBe("/a");
    target.refuse(false);
    expect(router.navigate("/b")).toBe(true);
    expect(router.location()).toMatchObject({ href: "/b", index: 1 });
  });
});

describe("a back or forward that does not land", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  test("is waited for only so long: then it is reported, and the navigations made meanwhile go ahead", () => {
    const target = fakeWindow("/a");
    const errors: string[] = [];
    const router = createRouter({ history: createBrowserHistory(target as unknown as Window), onError: (_, during) => errors.push(during) });
    router.navigate("/settings");
    target.later();
    router.back();
    expect(router.navigate("/b")).toBe(true);
    vi.advanceTimersByTime(999);
    expect(router.location().href).toBe("/settings");
    vi.advanceTimersByTime(1);
    expect(errors).toEqual(["history"]);
    expect(router.location()).toMatchObject({ href: "/b", index: 2 });
    expect(router.inspect().moving).toBe(false);
    expect(router.journal().slice(-3)).toMatchObject([
      { kind: "failed", during: "history", message: expect.stringMatching(/did not land within 1000 ms/) },
      { kind: "navigate", href: "/b", held: true },
      { kind: "matched" },
    ]);
    // Landing after all, it is a move like any other: the router follows the address.
    target.land();
    expect(router.match().location).toMatchObject({ href: "/settings", index: 1 });
  });

  test("settleTimeout sets how long; a move landing in time, or the router's destroy, stops the clock", () => {
    const target = fakeWindow("/a");
    const errors: string[] = [];
    const router = createRouter({ history: createBrowserHistory(target as unknown as Window), onError: (_, during) => errors.push(during), settleTimeout: 50 });
    router.navigate("/b");
    target.later();
    router.back();
    vi.advanceTimersByTime(49);
    target.land();
    expect(vi.getTimerCount()).toBe(0);
    router.go(1);
    vi.advanceTimersByTime(50);
    expect(errors).toEqual(["history"]);
    target.land();
    router.back();
    router.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).toEqual(["history"]);
  });
});

describe("a back or forward a blocker refuses", () => {
  /** A router at `/c` after `/a` and `/b`, refusing every back and forward while `refusing` says so. */
  const setup = () => {
    const target = fakeWindow("/a");
    const router = createRouter({ history: createBrowserHistory(target as unknown as Window) });
    router.navigate("/b");
    router.navigate("/c");
    const refused: string[] = [];
    const state = { refusing: true };
    router.block((transition) => {
      if (transition.action !== "pop" || !state.refusing) return true;
      refused.push(transition.href);
      return false;
    });
    target.later();
    return { target, router, refused, state };
  };

  test("is undone, navigations wait for the undo, and its pop is not taken for a move", () => {
    const { target, router, refused } = setup();
    // The user presses back.
    target.history.go(-1);
    target.land();
    expect(refused).toEqual(["/b"]);
    expect(router.location().href).toBe("/b");
    expect(router.match().location.href).toBe("/c");
    expect(router.navigate("/d")).toBe(true);
    expect(router.inspect().moving).toBe(true);
    target.land();
    expect(refused).toEqual(["/b"]);
    expect(router.location()).toMatchObject({ href: "/d", index: 3 });
    expect(target.stack.map((entry) => entry.url)).toEqual(["/a", "/b", "/c", "/d"]);
    expect(router.journal().some((event) => event.kind === "moved")).toBe(false);
  });

  test("when the undo never lands, the next move is followed, not taken for it", () => {
    const { target, router, state } = setup();
    target.history.go(-1);
    target.land();
    state.refusing = false;
    // The user presses back again before the undo lands; it never does.
    target.history.go(-1);
    target.land();
    expect(router.match().location).toMatchObject({ href: "/a", index: 0 });
    expect(router.inspect().moving).toBe(false);
  });

  test("an undo landing after the wait gave up is still the undo, not a move to refuse again", () => {
    vi.useFakeTimers();
    try {
      const target = fakeWindow("/a");
      const errors: string[] = [];
      const router = createRouter({
        history: createBrowserHistory(target as unknown as Window),
        settleTimeout: 20,
        onError: (_, during) => errors.push(during),
      });
      router.navigate("/b");
      router.navigate("/c");
      const refused: string[] = [];
      router.block((transition) => {
        if (transition.action !== "pop") return true;
        refused.push(transition.href);
        return false;
      });
      target.later();
      // The user presses back; it is refused, and its undo is slow.
      target.history.go(-1);
      target.land();
      vi.advanceTimersByTime(25);
      expect(errors).toEqual(["history"]);
      target.land();
      expect(refused).toEqual(["/b"]);
      expect(router.location().href).toBe("/c");
      expect(router.match().location.href).toBe("/c");
    } finally {
      vi.useRealTimers();
    }
  });

  test("an address edited by hand while the undo is landing is followed, though it takes the undo's index", () => {
    const { target, router } = setup();
    target.history.go(-1);
    target.land();
    target.edit("/typed");
    expect(router.match().location).toMatchObject({ href: "/typed", index: 2 });
  });
});

describe("leaving the page", () => {
  test("a blocker refusing an unload has the browser ask; one allowing it, or removed, does not", () => {
    const target = fakeWindow("/a");
    const router = createRouter({ history: createBrowserHistory(target as unknown as Window) });
    let unsent = true;
    const unblock = router.block((transition) => transition.action !== "unload" || !unsent);
    expect(target.unload()).toBe(true);
    unsent = false;
    expect(target.unload()).toBe(false);
    unsent = true;
    unblock();
    expect(target.unload()).toBe(false);
    router.block(() => false);
    router.destroy();
    expect(target.unload()).toBe(false);
  });
});
