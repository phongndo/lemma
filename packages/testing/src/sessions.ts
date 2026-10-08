import { Effect, Exit, Fiber, Layer, Result, Scope } from "effect";
import type { Context } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, test } from "vitest";
import { definePlugin, makeCore, PluginContext } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { SessionAppended, SessionChanged, SessionError, SessionRemoved, SessionRemoveHook, Sessions } from "@lemma/contracts";
import type { EventData, SessionEvent } from "@lemma/contracts";

type Store = Context.Service.Shape<typeof Sessions>;

/**
 * The provider's deletions of a session's stored data, which the suite holds
 * up and fails as a slow or failing disk would: `compose` has its storage
 * wait on `before` ahead of each, and fail the deletion, keeping the data,
 * when `before` rejects.
 */
export interface Deletions {
  readonly before: () => Promise<void>;
}

/**
 * The `Sessions` contract as tests. The sessions plugin runs them on a real
 * and a simulated disk, and a plugin written to replace it can run them to
 * meet the same bar. `compose` returns, fresh for each test, the plugins that
 * provide `Sessions` (and what they require), their deletions going through
 * `deletions`. Time is Effect's test clock, which the body moves.
 */
export function sessionsConformance(name: string, compose: (deletions: Deletions) => readonly Plugin[] | Promise<readonly Plugin[]>): void {
  describe(`Sessions contract: ${name}`, () => {
    const run = async <A>(body: (store: Store, seen: Seen, disk: Disk) => Effect.Effect<A, SessionError, Scope.Scope>) => {
      const disk = slowDisk();
      const plugins = await compose(disk.deletions);
      const seen = recorder();
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const core = yield* makeCore([...plugins, seen.plugin]);
            const store = yield* core.run(Sessions);
            // A deletion held up by a test that failed is let go, or closing the store would wait on it.
            return yield* body(store, seen, disk).pipe(Effect.ensuring(Effect.sync(disk.letGo)));
          }),
        ).pipe(Effect.provide(TestClock.layer())),
      );
    };
    const note = (text: string): EventData => ({ type: "custom", kind: "note", data: { text } });
    const reason = <A>(result: Result.Result<A, SessionError>) => (Result.isFailure(result) ? result.failure.reason : "succeeded");

    test("create gives an empty session that get and list return", () =>
      run((store) =>
        Effect.gen(function* () {
          const info = yield* store.create({ cwd: "/work/a" });
          expect(info).toMatchObject({ cwd: "/work/a", lastSeq: 0 });
          expect(info.leaf).toBeUndefined();
          expect(yield* store.get(info.id)).toEqual(info);
          expect((yield* store.list()).map((listed) => listed.id)).toEqual([info.id]);
          expect(yield* store.events(info.id)).toEqual([]);
          expect(yield* store.branch(info.id)).toEqual([]);
        }),
      ));

    test("append numbers events from 1, follows the leaf, moves it, and the events read back as returned", () =>
      run((store) =>
        Effect.gen(function* () {
          const { id } = yield* store.create({ cwd: "/work/a" });
          const first = yield* store.append(id, note("one"));
          yield* TestClock.adjust("1 second");
          const second = yield* store.append(id, note("two"));
          expect(first).toMatchObject({ seq: 1, parent: null, data: note("one") });
          expect(second).toMatchObject({ seq: 2, parent: first.id, data: note("two") });
          expect(second.at).toBeGreaterThan(first.at);
          expect(yield* store.events(id)).toEqual([first, second]);
          expect(yield* store.events(id, { after: 1 })).toEqual([second]);
          expect(yield* store.get(id)).toMatchObject({ leaf: second.id, lastSeq: 2, updatedAt: second.at });
        }),
      ));

    test("a title event names the session", () =>
      run((store) =>
        Effect.gen(function* () {
          const { id } = yield* store.create({ cwd: "/work/a" });
          yield* store.append(id, { type: "title", title: "First" });
          yield* store.append(id, { type: "title", title: "Second" });
          expect((yield* store.get(id)).title).toBe("Second");
          expect((yield* store.list())[0]?.title).toBe("Second");
        }),
      ));

    test("appending after another event branches; branch is root to leaf, events every event in order", () =>
      run((store) =>
        Effect.gen(function* () {
          const { id } = yield* store.create({ cwd: "/work/a" });
          const root = yield* store.append(id, note("root"));
          const left = yield* store.append(id, note("left"));
          const right = yield* store.append(id, note("right"), { parent: root.id });
          expect(right).toMatchObject({ seq: 3, parent: root.id });
          expect(yield* store.branch(id)).toEqual([root, right]);
          expect(yield* store.branch(id, { leaf: left.id })).toEqual([root, left]);
          expect(yield* store.events(id)).toEqual([root, left, right]);
        }),
      ));

    test("checkout moves the leaf, and the next append follows it", () =>
      run((store) =>
        Effect.gen(function* () {
          const { id } = yield* store.create({ cwd: "/work/a" });
          const root = yield* store.append(id, note("root"));
          yield* store.append(id, note("child"));
          expect((yield* store.checkout(id, root.id)).leaf).toBe(root.id);
          expect(yield* store.branch(id)).toEqual([root]);
          expect((yield* store.append(id, note("sibling"))).parent).toBe(root.id);
        }),
      ));

    test("mark files a session without moving its leaf or updatedAt", () =>
      run((store) =>
        Effect.gen(function* () {
          const { id } = yield* store.create({ cwd: "/work/a" });
          yield* store.append(id, note("one"));
          const before = yield* store.get(id);
          yield* TestClock.adjust("1 second");
          const pinned = yield* store.mark(id, { pinned: true });
          expect(pinned).toMatchObject({ pinned: true, leaf: before.leaf, updatedAt: before.updatedAt });
          expect((yield* store.mark(id, { archived: true })).pinned).toBe(true);
          const unpinned = yield* store.mark(id, { pinned: false });
          expect(unpinned.pinned).toBeUndefined();
          expect(unpinned.archived).toBe(true);
        }),
      ));

    test("list filters by cwd, most recently updated first", () =>
      run((store) =>
        Effect.gen(function* () {
          const a = yield* store.create({ cwd: "/work/a" });
          yield* TestClock.adjust("1 second");
          const b = yield* store.create({ cwd: "/work/b" });
          yield* TestClock.adjust("1 second");
          yield* store.append(a.id, note("later"));
          expect((yield* store.list()).map((info) => info.id)).toEqual([a.id, b.id]);
          expect((yield* store.list({ cwd: "/work/b" })).map((info) => info.id)).toEqual([b.id]);
        }),
      ));

    test("remove deletes it, for good", () =>
      run((store) =>
        Effect.gen(function* () {
          const { id } = yield* store.create({ cwd: "/work/a" });
          yield* store.append(id, note("one"));
          yield* store.remove(id);
          expect(reason(yield* Effect.result(store.get(id)))).toBe("NotFound");
          expect(reason(yield* Effect.result(store.events(id)))).toBe("NotFound");
          expect(yield* store.list()).toEqual([]);
        }),
      ));

    test("remove asks SessionRemoveHook first: a handler's refusal fails it with that error and keeps the session", () =>
      run((store, seen) =>
        Effect.gen(function* () {
          const { id } = yield* store.create({ cwd: "/work/a" });
          yield* store.append(id, note("one"));
          seen.around.set(id, () => Effect.fail(new SessionError({ sessionId: id, reason: "Busy", message: `"${id}" is in use` })));
          expect(reason(yield* Effect.result(store.remove(id)))).toBe("Busy");
          expect((yield* store.get(id)).lastSeq).toBe(1);
          expect((yield* store.events(id)).length).toBe(1);
          expect((yield* store.list()).map((info) => info.id)).toEqual([id]);
          // Let go, it is removed.
          seen.around.delete(id);
          yield* store.remove(id);
          expect(reason(yield* Effect.result(store.get(id)))).toBe("NotFound");
        }),
      ));

    test("remove fails Busy while the session is held, and removes it once every hold's scope has closed", () =>
      run((store) =>
        Effect.gen(function* () {
          const { id } = yield* store.create({ cwd: "/work/a" });
          yield* store.append(id, note("one"));
          const first = yield* Scope.make();
          const second = yield* Scope.make();
          yield* store.hold(id).pipe(Scope.provide(first));
          yield* store.hold(id).pipe(Scope.provide(second));
          expect(reason(yield* Effect.result(store.remove(id)))).toBe("Busy");
          yield* Scope.close(first, Exit.void);
          expect(reason(yield* Effect.result(store.remove(id)))).toBe("Busy");
          expect((yield* store.events(id)).length).toBe(1);
          yield* Scope.close(second, Exit.void);
          yield* store.remove(id);
          expect(reason(yield* Effect.result(store.get(id)))).toBe("NotFound");
        }),
      ));

    test("hold fails NotFound on a missing session; taken while the session is deleted, it waits for the deletion, then fails NotFound", () =>
      run((store, _seen, disk) =>
        Effect.gen(function* () {
          expect(reason(yield* Effect.result(Effect.scoped(store.hold("missing"))))).toBe("NotFound");
          const { id } = yield* store.create({ cwd: "/work/a" });
          const deletion = disk.holdUp();
          const removal = yield* Effect.forkChild(store.remove(id));
          yield* Effect.promise(() => deletion.reached);
          const held = yield* Effect.forkChild(Effect.result(Effect.scoped(store.hold(id))));
          yield* settle;
          expect(held.pollUnsafe()).toBeUndefined();
          deletion.go();
          yield* Fiber.join(removal);
          expect(reason(yield* Fiber.join(held))).toBe("NotFound");
        }),
      ));

    test("hold, taken while a deletion the disk then fails runs, holds the session once it has failed", () =>
      run((store, _seen, disk) =>
        Effect.gen(function* () {
          const { id } = yield* store.create({ cwd: "/work/a" });
          yield* store.append(id, note("one"));
          const deletion = disk.holdUp();
          const removal = yield* Effect.forkChild(store.remove(id));
          yield* Effect.promise(() => deletion.reached);
          const scope = yield* Scope.make();
          const held = yield* Effect.forkChild(store.hold(id).pipe(Scope.provide(scope)));
          yield* settle;
          expect(held.pollUnsafe()).toBeUndefined();
          deletion.fail();
          expect(reason(yield* Effect.result(Fiber.join(removal)))).toBe("Io");
          yield* Fiber.join(held);
          expect((yield* store.events(id)).length).toBe(1);
          expect(reason(yield* Effect.result(store.remove(id)))).toBe("Busy");
          yield* Scope.close(scope, Exit.void);
          yield* store.remove(id);
          expect(reason(yield* Effect.result(store.get(id)))).toBe("NotFound");
        }),
      ));

    test("a SessionRemoveHook handler that holds the session before calling next has it fail Busy, keeping it; one that holds it after next gets NotFound", () =>
      run((store, seen) =>
        Effect.gen(function* () {
          const { id: kept } = yield* store.create({ cwd: "/work/a" });
          seen.around.set(kept, (next) => Effect.scoped(Effect.andThen(store.hold(kept), next)));
          expect(reason(yield* Effect.result(store.remove(kept)))).toBe("Busy");
          expect((yield* store.get(kept)).id).toBe(kept);
          // Not held once the handler has let go.
          seen.around.delete(kept);
          yield* store.remove(kept);

          const { id: gone } = yield* store.create({ cwd: "/work/a" });
          let after: string | undefined;
          seen.around.set(gone, (next) =>
            Effect.andThen(
              next,
              Effect.map(Effect.result(Effect.scoped(store.hold(gone))), (held) => {
                after = reason(held);
              }),
            ),
          );
          yield* store.remove(gone);
          expect(after).toBe("NotFound");
        }),
      ));

    test("refusals: a missing session or event, an unknown parent", () =>
      run((store) =>
        Effect.gen(function* () {
          expect(reason(yield* Effect.result(store.get("missing")))).toBe("NotFound");
          expect(reason(yield* Effect.result(store.append("missing", note("x"))))).toBe("NotFound");
          const { id } = yield* store.create({ cwd: "/work/a" });
          expect(reason(yield* Effect.result(store.append(id, note("x"), { parent: "nowhere" })))).toBe("InvalidParent");
          expect(reason(yield* Effect.result(store.checkout(id, "nowhere")))).toBe("NotFound");
          expect(reason(yield* Effect.result(store.branch(id, { leaf: "nowhere" })))).toBe("NotFound");
          expect(yield* store.events(id)).toEqual([]);
        }),
      ));

    test("publishes what changed: SessionChanged, SessionAppended, SessionRemoved", () =>
      run((store, seen) =>
        Effect.gen(function* () {
          const { id } = yield* store.create({ cwd: "/work/a" });
          const event = yield* store.append(id, note("one"));
          yield* store.remove(id);
          // Each kind has its own observer queue, so one arriving says nothing of the others: wait for all three.
          yield* eventually(
            () =>
              seen.removed.includes(id) &&
              seen.appended.some((payload) => payload.event.id === event.id) &&
              seen.changed.some((info) => info.id === id && info.lastSeq === 1),
          );
          expect(seen.appended).toContainEqual({ sessionId: id, event });
        }),
      ));
  });
}

interface Seen {
  readonly plugin: Plugin;
  readonly appended: { readonly sessionId: string; readonly event: SessionEvent }[];
  readonly changed: { readonly id: string; readonly lastSeq: number }[];
  readonly removed: string[];
  /** By session, what its `SessionRemoveHook` handler does around `next` (the rest of the removal), as a plugin's may. */
  readonly around: Map<string, <E>(next: Effect.Effect<void, E>) => Effect.Effect<void, E | SessionError>>;
}

/** Another plugin beside the store: it records what the store publishes, and handles the removals it is told to. */
function recorder(): Seen {
  const seen: Omit<Seen, "plugin"> = { appended: [], changed: [], removed: [], around: new Map() };
  const plugin = definePlugin({
    id: "conformance-recorder",
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const owner = yield* PluginContext;
        yield* owner.on(SessionRemoveHook, (input, next) => seen.around.get(input.sessionId)?.(next(input)) ?? next(input));
        yield* owner.observe(SessionAppended, (payload) => Effect.sync(() => void seen.appended.push(payload)), { buffer: 256 });
        yield* owner.observe(SessionChanged, ({ info }) => Effect.sync(() => void seen.changed.push(info)), { buffer: 256 });
        yield* owner.observe(SessionRemoved, ({ sessionId }) => Effect.sync(() => void seen.removed.push(sessionId)), { buffer: 256 });
      }),
    ),
  });
  return { plugin, ...seen };
}

interface Disk {
  readonly deletions: Deletions;
  /** Holds up the next deletion: `reached` once it waits, until `go` lets it delete or `fail` fails it as the disk would. */
  readonly holdUp: () => { readonly reached: Promise<void>; readonly go: () => void; readonly fail: () => void };
  /** Lets a deletion still held up go. */
  readonly letGo: () => void;
}

/** `Deletions` that go at once, except one `holdUp` holds up. */
function slowDisk(): Disk {
  let next: { readonly reach: () => void; readonly outcome: Promise<void> } | undefined;
  let go = () => {};
  return {
    deletions: {
      before: () => {
        const held = next;
        next = undefined;
        held?.reach();
        return held?.outcome ?? Promise.resolve();
      },
    },
    holdUp: () => {
      let reach = () => {};
      let fail = () => {};
      const reached = new Promise<void>((resolve) => (reach = resolve));
      const outcome = new Promise<void>((resolve, reject) => {
        go = resolve;
        fail = () => reject(Object.assign(new Error("I/O error"), { code: "EIO" }));
      });
      next = { reach, outcome };
      return { reached, go, fail };
    },
    letGo: () => go(),
  };
}

/** Lets every fiber that can run do so, as far as it can without waiting on anything but another's turn. */
const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 100; turn++) yield* Effect.yieldNow;
});

/** Lets observers run until `check` holds; on the test clock, so it yields instead of sleeping. */
const eventually = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 10_000; attempt++) {
      if (check()) return;
      yield* Effect.yieldNow;
    }
    expect.fail("never happened");
  });
