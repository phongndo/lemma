import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Cause, Chunk, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { definePlugin, Events, makeCore, makeLoader, PluginFault } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { Notice, SessionAppended, SessionChanged, SessionRemoved, Sessions } from "@lemma/contracts";
import type { EventData } from "@lemma/contracts";
import { pathsPlugin } from "@lemma/contracts/testing";
import sessions, { encodeCwd } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-sessions-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const paths = () => pathsPlugin(dir, { cwd: "/work/app" });

/** Runs `body` against a fresh core over the same directory, as a restarted host would. */
const run = <A, E>(body: Effect.Effect<A, E, Sessions | Events>, config?: { readonly unloadAfter?: number }) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([paths(), sessions], config === undefined ? {} : { configs: { sessions: config } });
        return yield* core.run(body);
      }),
    ),
  );

/** Short enough that a test sees sessions unloaded: swept every 10ms. */
const quickly = { unloadAfter: 0.02 };

const title = (value: string): EventData => ({ type: "title", title: value });
const custom = (n: number): EventData => ({ type: "custom", kind: "test/n", data: n });

const sessionFiles = async () => {
  const root = path.join(dir, "sessions");
  const out: string[] = [];
  for (const project of await fs.readdir(root, { withFileTypes: true })) {
    // Not the lock.
    if (!project.isDirectory()) continue;
    for (const name of await fs.readdir(path.join(root, project.name))) out.push(path.join(root, project.name, name));
  }
  return out;
};

/** `FileHandle.prototype`, to fake what the disk does. */
const fileHandles = async () => {
  const probe = await fs.open(path.join(dir, "probe"), "w");
  await probe.close();
  return Object.getPrototypeOf(probe) as fs.FileHandle;
};

/** Files closed, among those opened from now on: each handle has its own `close`, not one on the prototype. */
const watchCloses = () => {
  const closed: string[] = [];
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    const close = handle.close;
    handle.close = () => {
      closed.push(String(file));
      return close.call(handle);
    };
    return handle;
  });
  return closed;
};

/** Handles on a session's file closed so far: reading it, and unloading it, each close one. */
const closesOf = (closed: readonly string[], id: string) => closed.filter((file) => file.endsWith(`_${id}.jsonl`)).length;

/** Waits for the sweep to unload a session: closing its file is the last thing it does. */
const unloaded = (closed: readonly string[], id: string) =>
  Effect.promise(() => vi.waitFor(() => expect(closed.some((file) => file.endsWith(`_${id}.jsonl`))).toBe(true)));

const lockPath = () => path.join(dir, "sessions", ".lock");

/** The session id in a file name; ids may themselves contain `_`, so take the fixed-length tail. */
const idOfFile = (file: string) => path.basename(file, ".jsonl").slice(-12);

describe("sessions", () => {
  it("writes a header and one line per event under the encoded cwd", async () => {
    const info = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const info = yield* store.create();
        yield* store.append(info.id, custom(1));
        return info;
      }),
    );
    expect(info.cwd).toBe("/work/app");
    expect(info.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const [file] = await sessionFiles();
    expect(path.basename(path.dirname(file!))).toBe(encodeCwd("/work/app"));
    expect(path.basename(file!)).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[\\d-]+Z_${info.id}\\.jsonl$`));
    const lines = (await fs.readFile(file!, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0]).toEqual({ type: "session", version: 1, id: info.id, cwd: "/work/app", createdAt: info.createdAt });
    expect(lines[1]).toMatchObject({ seq: 1, parent: null, data: custom(1) });
  });

  it("chains appends, branches from an explicit parent, and restores the leaf after a checkout on reopen", async () => {
    const { id, first, third } = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create({ cwd: "/work/other" });
        const first = yield* store.append(id, custom(1));
        const second = yield* store.append(id, custom(2));
        expect(second.parent).toBe(first.id);
        const third = yield* store.append(id, custom(3), { parent: first.id });
        expect(third.seq).toBe(3);
        expect((yield* store.branch(id)).map((event) => event.id)).toEqual([first.id, third.id]);
        expect((yield* store.branch(id, { leaf: second.id })).map((event) => event.id)).toEqual([first.id, second.id]);
        const info = yield* store.checkout(id, second.id);
        expect(info.leaf).toBe(second.id);
        return { id, first, third };
      }),
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const info = yield* store.get(id);
        expect(info.lastSeq).toBe(3);
        expect((yield* store.branch(id)).map((event) => event.data)).toEqual([custom(1), custom(2)]);
        expect((yield* store.events(id, { after: 1 })).map((event) => event.seq)).toEqual([2, 3]);
        yield* store.checkout(id, third.id);
        const next = yield* store.append(id, custom(4));
        expect(next.parent).toBe(third.id);
        expect(first.parent).toBeNull();
      }),
    );
  });

  it("rejects an unknown parent and unknown checkout target", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        const parent = yield* Effect.flip(store.append(id, custom(1), { parent: "nope" }));
        expect(parent.reason).toBe("InvalidParent");
        expect((yield* Effect.flip(store.checkout(id, "nope"))).reason).toBe("NotFound");
        expect((yield* Effect.flip(store.get("missing"))).reason).toBe("NotFound");
        expect((yield* store.get(id)).lastSeq).toBe(0);
      }),
    );
  });

  it("ignores a torn final line and cuts it before the next append", async () => {
    const id = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* store.append(id, custom(1));
        return id;
      }),
    );
    const [file] = await sessionFiles();
    await fs.appendFile(file!, '{"seq":2,"id":"torn","par');
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.list()).map((info) => info.lastSeq)).toEqual([1]);
        expect((yield* store.events(id)).length).toBe(1);
        const next = yield* store.append(id, custom(2));
        expect(next.seq).toBe(2);
      }),
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.events(id)).map((event) => event.data)).toEqual([custom(1), custom(2)]);
      }),
    );
  });

  it("treats a damaged complete line as Corrupt and skips that session in list with a notice", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        yield* store.create();
        yield* store.create();
      }),
    );
    const [bad] = await sessionFiles();
    // Damage with a line after it, so not a write cut short at the end.
    await fs.appendFile(bad!, `garbage\n${JSON.stringify({ seq: 1, id: "x1", parent: null, at: 1, data: custom(1) })}\n`);
    const badId = idOfFile(bad!);
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const events = yield* Events;
        const notices = yield* Effect.fork(Stream.runCollect(Stream.take(events.stream(Notice), 1)));
        yield* Effect.yieldNow();
        const listed = yield* store.list();
        expect(listed.length).toBe(1);
        expect(Chunk.toArray(yield* Fiber.join(notices))[0]!.message).toContain("line 2");
        expect((yield* Effect.flip(store.events(badId))).reason).toBe("Corrupt");
      }),
    );
  });

  it("skips a session with a complete null line in list instead of failing", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        yield* store.create();
        yield* store.create();
      }),
    );
    const [bad] = await sessionFiles();
    await fs.appendFile(bad!, "null\n");
    const badId = idOfFile(bad!);
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.list()).length).toBe(1);
        expect((yield* Effect.flip(store.get(badId))).reason).toBe("Corrupt");
        expect((yield* Effect.flip(store.events(badId))).reason).toBe("Corrupt");
      }),
    );
  });

  it("keeps the file and memory in step when an append is interrupted mid-write", async () => {
    const id = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        const first = yield* Effect.fork(store.append(id, title("first")));
        // Let the append reach the file write, then interrupt it there.
        for (let i = 0; i < 5; i++) yield* Effect.yieldNow();
        yield* Fiber.interrupt(first);
        const next = yield* store.append(id, title("second"));
        const all = yield* store.events(id);
        expect(all.at(-1)).toBe(next);
        expect(next.seq).toBe(all.length);
        return id;
      }),
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const all = yield* store.events(id);
        expect(all.map((event) => event.seq)).toEqual(all.map((_, i) => i + 1));
        expect(all.at(-1)!.data).toEqual(title("second"));
      }),
    );
  });

  it("lists newest first, filters by cwd, takes the latest title, and sees files changed on disk", async () => {
    const [a, b] = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const a = yield* store.create({ cwd: "/p/one" });
        yield* Effect.sleep(5);
        const b = yield* store.create({ cwd: "/p/two" });
        yield* store.append(a.id, title("first"));
        yield* store.append(a.id, title("second"));
        const listed = yield* store.list();
        expect(listed.map((info) => info.id)).toEqual([a.id, b.id]);
        expect(listed[0]!.title).toBe("second");
        expect((yield* store.list({ cwd: "/p/two" })).map((info) => info.id)).toEqual([b.id]);
        return [a, b];
      }),
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.list()).map((info) => info.id)).toEqual([a!.id, b!.id]);
        // Another writer appends to b; the cached info refreshes because the file changed.
        const file = (yield* Effect.promise(sessionFiles)).find((name) => name.includes(b!.id))!;
        const line = { seq: 1, id: "x1", parent: null, at: Date.now() + 1000, data: title("external") };
        yield* Effect.promise(() => fs.appendFile(file, `${JSON.stringify(line)}\n`));
        const listed = yield* store.list();
        expect(listed[0]).toMatchObject({ id: b!.id, title: "external", lastSeq: 1, leaf: "x1" });
      }),
    );
  });

  it("serializes concurrent appends and publishes appended and changed events", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const events = yield* Events;
        const { id } = yield* store.create();
        const appended = yield* Effect.fork(Stream.runCollect(Stream.take(events.stream(SessionAppended), 20)));
        const changed = yield* Effect.fork(Stream.runCollect(Stream.take(events.stream(SessionChanged), 20)));
        yield* Effect.yieldNow();
        yield* Effect.forEach(
          Array.from({ length: 20 }, (_, i) => i),
          (i) => store.append(id, custom(i)),
          { concurrency: "unbounded" },
        );
        const all = yield* store.events(id);
        expect(all.map((event) => event.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
        // Every event's parent is its predecessor: no two appends raced for the same leaf.
        all.slice(1).forEach((event, i) => expect(event.parent).toBe(all[i]!.id));
        expect(Chunk.toArray(yield* Fiber.join(appended)).map((payload) => payload.event.seq)).toEqual(all.map((event) => event.seq));
        expect(Chunk.toArray(yield* Fiber.join(changed)).at(-1)!.info.lastSeq).toBe(20);
      }),
    );
  });
  it("recovers from a failed write: the next append follows the last good line, and the file stays loadable", async () => {
    const FileHandle = await fileHandles();
    const appendFile = FileHandle.appendFile;
    const id = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* store.append(id, custom(1));

        // A full disk tears the line: some bytes land, then the write fails.
        vi.spyOn(FileHandle, "appendFile").mockImplementationOnce(async function (this: fs.FileHandle, data) {
          await appendFile.call(this, String(data).slice(0, 10));
          throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
        });
        expect((yield* Effect.flip(store.append(id, custom(2)))).reason).toBe("Io");
        expect((yield* store.append(id, custom(3))).seq).toBe(2);

        // The line lands but is not confirmed durable; the append failed, so its seq is reused.
        vi.spyOn(FileHandle, "datasync").mockRejectedValueOnce(Object.assign(new Error("I/O error"), { code: "EIO" }));
        expect((yield* Effect.flip(store.append(id, custom(4)))).reason).toBe("Io");
        expect((yield* store.append(id, custom(5))).seq).toBe(3);
        return id;
      }),
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.events(id)).map((event) => event.data)).toEqual([custom(1), custom(3), custom(5)]);
      }),
    );
  });

  it("pins and archives without moving the leaf or updatedAt, and keeps the marks across a restart", async () => {
    const before = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const info = yield* store.create();
        yield* store.append(info.id, custom(1));
        const before = yield* store.get(info.id);
        yield* Effect.sleep(5);
        expect(yield* store.mark(info.id, { pinned: true })).toMatchObject({ pinned: true, leaf: before.leaf, updatedAt: before.updatedAt });
        const archived = yield* store.mark(info.id, { archived: true });
        expect(archived).toMatchObject({ pinned: true, archived: true, lastSeq: 1 });
        expect(yield* store.mark(info.id, { pinned: false })).not.toHaveProperty("pinned");
        return before;
      }),
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        // Listing scans the file; opening it loads and validates every line.
        const [listed] = yield* store.list();
        expect(listed).toMatchObject({ archived: true, leaf: before.leaf, updatedAt: before.updatedAt });
        expect(listed).not.toHaveProperty("pinned");
        expect((yield* store.events(before.id)).length).toBe(1);
        expect(yield* store.get(before.id)).toEqual(listed);
        const next = yield* store.append(before.id, custom(2));
        expect(next.parent).toBe(before.leaf);
      }),
    );
  });

  it("removes a session from disk and memory and publishes its removal", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const events = yield* Events;
        const removed = yield* Effect.fork(Stream.runCollect(Stream.take(events.stream(SessionRemoved), 1)));
        yield* Effect.yieldNow();
        const keep = yield* store.create();
        const gone = yield* store.create();
        yield* store.append(gone.id, custom(1));
        yield* store.remove(gone.id);
        expect(Chunk.toReadonlyArray(yield* Fiber.join(removed))).toEqual([{ sessionId: gone.id }]);
        expect((yield* store.list()).map((info) => info.id)).toEqual([keep.id]);
        expect((yield* Effect.either(store.get(gone.id)))._tag).toBe("Left");
        expect((yield* Effect.either(store.remove(gone.id)))._tag).toBe("Left");
      }),
    );
    expect((await sessionFiles()).map(idOfFile)).toHaveLength(1);
  });

  it("fails writes queued behind a removal instead of recreating the file", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        const [removed, marked, appended] = yield* Effect.all(
          [Effect.either(store.remove(id)), Effect.either(store.mark(id, { pinned: true })), Effect.either(store.append(id, custom(1)))],
          { concurrency: "unbounded" },
        );
        expect([removed._tag, marked._tag, appended._tag]).toEqual(["Right", "Left", "Left"]);
      }),
    );
    expect(await sessionFiles()).toEqual([]);
  });

  it("leaves a session intact when deleting its file fails", async () => {
    const id = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* store.append(id, custom(1));
        vi.spyOn(fs, "rm").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EPERM" }));
        expect((yield* Effect.either(store.remove(id)))._tag).toBe("Left");
        yield* store.append(id, custom(2));
        return id;
      }),
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.events(id)).map((event) => event.data)).toEqual([custom(1), custom(2)]);
      }),
    );
  });

  it("fails to activate while another host holds the sessions directory, and leaves its lock alone", async () => {
    const held = { pid: 4242, hostname: "another-machine", token: "theirs", startedAt: Date.now() };
    await fs.mkdir(path.dirname(lockPath()), { recursive: true });
    await fs.writeFile(lockPath(), JSON.stringify(held));
    const fault = await Effect.runPromise(Effect.scoped(Effect.flip(makeCore([paths(), sessions]))));
    expect(fault).toBeInstanceOf(PluginFault);
    expect(Cause.squash((fault as PluginFault).cause)).toMatchObject({
      _tag: "SessionError",
      message: expect.stringContaining(`${lockPath()} is held by process 4242 on another-machine`),
    });
    expect(JSON.parse(await fs.readFile(lockPath(), "utf8"))).toEqual(held);
  });

  it("stops before a reloaded instance starts, so the two never write one log, and the last removes the lock at shutdown", async () => {
    const holder = () => Effect.promise(async () => JSON.parse(await fs.readFile(lockPath(), "utf8")) as { readonly pid: number; readonly token: string });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([paths(), sessions]);
          const before = yield* holder();
          const { id } = yield* core.run(Effect.flatMap(Sessions, (store) => store.create()));
          // An operation the old instance admitted, still going when the reload begins.
          const ready = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const old = yield* Effect.fork(
            core.run(
              Effect.gen(function* () {
                const store = yield* Sessions;
                yield* store.events(id);
                yield* Deferred.succeed(ready, undefined);
                yield* Deferred.await(release);
                yield* store.append(id, title("old"));
              }),
            ),
          );
          yield* Deferred.await(ready);
          const restarting = yield* Effect.fork(core.restart("sessions", { force: true }));
          yield* Effect.sleep(50);
          // A write made meanwhile: a replacement running beside the old instance would take it first.
          const meanwhile = yield* Effect.fork(core.run(Effect.flatMap(Sessions, (store) => store.append(id, title("meanwhile")))));
          yield* Effect.sleep(50);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.await(old);
          yield* Fiber.await(meanwhile);
          yield* Fiber.join(restarting);
          const after = yield* holder();
          expect(after.pid).toBe(process.pid);
          expect(after.token).not.toBe(before.token);
          const appended = yield* core.run(Effect.flatMap(Sessions, (store) => store.append(id, title("new"))));
          // One writer at a time: what is on disk is one unbroken sequence, and the new instance read all of it.
          const [file] = yield* Effect.promise(sessionFiles);
          const lines = (yield* Effect.promise(() => fs.readFile(file!, "utf8"))).trim().split("\n").slice(1);
          const seqs = lines.map((line) => (JSON.parse(line) as { readonly seq: number }).seq);
          expect(seqs).toEqual(seqs.map((_, i) => i + 1));
          expect(appended.seq).toBe(seqs.length);
        }),
      ),
    );
    await expect(fs.stat(lockPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves no instance writing without the lock when a reload fails after it", async () => {
    let activations = 0;
    const flaky = definePlugin({
      id: "flaky",
      requires: [Sessions],
      layer: Layer.effectDiscard(Effect.suspend(() => (activations++ === 0 ? Effect.void : Effect.fail(new Error("fails when restarted"))))),
    });
    const plugins: Record<string, Plugin> = { paths: paths(), sessions, flaky };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const loader = yield* makeLoader({
            source: { resolve: (id) => Effect.succeed(plugins[id]!) },
            composition: { plugins: { paths: {}, sessions: {}, flaky: {} } },
          });
          const applied = yield* Effect.either(loader.apply({ plugins: { paths: {}, sessions: { config: { unloadAfter: 100 } }, flaky: {} } }));
          expect(applied._tag).toBe("Left");
          const locked = yield* Effect.promise(() =>
            fs.stat(lockPath()).then(
              () => true,
              () => false,
            ),
          );
          // The old instance stopped before the new one started; the new one went with the failed reload.
          const wrote = yield* Effect.exit(loader.core.run(Effect.flatMap(Sessions, (store) => store.create())));
          expect(Exit.isFailure(wrote) || locked).toBe(true);
        }),
      ),
    );
  });
});

describe("unloading idle sessions", () => {
  it("closes a session unused for unloadAfter, lists it without re-reading, and reloads it unchanged on the next use", async () => {
    const closed = watchCloses();
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        const first = yield* store.append(id, title("first"));
        const second = yield* store.append(id, custom(2));
        const info = yield* store.checkout(id, first.id);
        yield* unloaded(closed, id);
        const atUnload = closesOf(closed, id);
        expect(yield* store.list()).toEqual([info]);
        expect(closesOf(closed, id)).toBe(atUnload);
        expect((yield* store.events(id)).map((event) => event.id)).toEqual([first.id, second.id]);
        expect(closesOf(closed, id)).toBe(atUnload + 1);
        expect(yield* store.get(id)).toEqual(info);
        expect(yield* store.append(id, custom(3))).toMatchObject({ seq: 3, parent: first.id });
      }),
      quickly,
    );
  });

  it("cuts what a failed write left before unloading, and ignores a torn tail after reloading", async () => {
    const FileHandle = await fileHandles();
    const closed = watchCloses();
    const id = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* store.append(id, custom(1));
        // The line lands but is not confirmed durable, so the append fails: a reload must not read it.
        vi.spyOn(FileHandle, "datasync").mockRejectedValueOnce(Object.assign(new Error("I/O error"), { code: "EIO" }));
        expect((yield* Effect.flip(store.append(id, custom(2)))).reason).toBe("Io");
        yield* unloaded(closed, id);
        const [file] = yield* Effect.promise(sessionFiles);
        expect((yield* Effect.promise(() => fs.readFile(file!, "utf8"))).trimEnd().split("\n")).toHaveLength(2);
        yield* Effect.promise(() => fs.appendFile(file!, '{"seq":2,"id":"torn","par'));
        expect((yield* store.events(id)).map((event) => event.data)).toEqual([custom(1)]);
        expect((yield* store.append(id, custom(3))).seq).toBe(2);
        return id;
      }),
      quickly,
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.events(id)).map((event) => event.data)).toEqual([custom(1), custom(3)]);
      }),
    );
  });

  it("does not unload a session while an append to it is in flight", async () => {
    const FileHandle = await fileHandles();
    const datasync = FileHandle.datasync;
    const closed = watchCloses();
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* store.append(id, custom(1));
        // Far longer than unloadAfter: sweeps run meanwhile, and closing the file under the append would fail it.
        vi.spyOn(FileHandle, "datasync").mockImplementationOnce(async function (this: fs.FileHandle) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return datasync.call(this);
        });
        expect((yield* store.append(id, custom(2))).seq).toBe(2);
        // Unloaded once idle: the sweep was running all along.
        yield* unloaded(closed, id);
        expect((yield* store.events(id)).map((event) => event.data)).toEqual([custom(1), custom(2)]);
      }),
      quickly,
    );
  });

  it("keeps a session in use loaded past unloadAfter", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        const closed = watchCloses();
        for (let i = 0; i < 25; i++) {
          yield* store.get(id);
          yield* Effect.sleep(10);
        }
        yield* store.events(id);
        expect(closesOf(closed, id)).toBe(0);
      }),
      { unloadAfter: 0.1 },
    );
  });

  it("keeps sessions loaded when unloadAfter is 0", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* store.append(id, custom(1));
        const closed = watchCloses();
        yield* Effect.sleep(50);
        expect((yield* store.events(id)).length).toBe(1);
        expect(closesOf(closed, id)).toBe(0);
      }),
      { unloadAfter: 0 },
    );
  });
});

describe("the session file", () => {
  it("treats an unreadable last line as a write a crash cut short: ignored with a notice, then cut before the next append", async () => {
    const id = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* store.append(id, custom(1));
        return id;
      }),
    );
    const [file] = await sessionFiles();
    // A power loss can keep a line's newline but leave zeros where its bytes were.
    await fs.appendFile(file!, `${"\0".repeat(40)}\n`);
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const events = yield* Events;
        expect((yield* store.list()).map((info) => info.lastSeq)).toEqual([1]);
        const notices = yield* Effect.fork(Stream.runCollect(Stream.take(events.stream(Notice), 1)));
        yield* Effect.yieldNow();
        expect((yield* store.events(id)).length).toBe(1);
        expect(Chunk.toArray(yield* Fiber.join(notices))[0]!.message).toContain("ignored the last 41 bytes");
        expect((yield* store.append(id, custom(2))).seq).toBe(2);
      }),
    );
    expect(await fs.readFile(file!, "utf8")).not.toContain("\0");
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.events(id)).map((event) => event.data)).toEqual([custom(1), custom(2)]);
      }),
    );
  });

  it("refuses an event with a field its schema lacks, which reading the line back would drop", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        const error = yield* Effect.flip(store.append(id, { ...title("x"), note: "lost on reload" } as unknown as EventData));
        expect(error.reason).toBe("Corrupt");
        expect(error.message).toContain("data.note: is unexpected");
        expect((yield* store.get(id)).lastSeq).toBe(0);
      }),
    );
  });

  it("reads lines longer than its read buffer", async () => {
    const long = "é".repeat(1_500_000);
    const id = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* store.append(id, { type: "custom", kind: "test/long", data: long });
        yield* store.append(id, custom(2));
        return id;
      }),
    );
    await fs.rm(path.join(dir, "sessions", ".index.json"));
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.list())[0]!.lastSeq).toBe(2);
        expect((yield* store.events(id)).map((event) => event.data)).toEqual([{ type: "custom", kind: "test/long", data: long }, custom(2)]);
      }),
    );
  });

  it("refuses an event JSON cannot carry, which would not read back", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        const first = yield* store.append(id, custom(1));
        const compaction: EventData = { type: "compaction", summary: "s", firstKeptId: first.id, tokensBefore: Number.NaN, source: "test" };
        const error = yield* Effect.flip(store.append(id, compaction));
        expect(error.reason).toBe("Corrupt");
        expect(error.message).toContain("tokensBefore");
        // What JSON turns into something readable is kept as it reads back.
        const kept = yield* store.append(id, { type: "custom", kind: "test/nan", data: [Number.NaN, undefined] });
        expect(kept.data).toEqual({ type: "custom", kind: "test/nan", data: [null, null] });
        expect((yield* store.events(id)).at(-1)).toBe(kept);
      }),
    );
  });

  it("removes a line whose sync failed even when nothing is written after it", async () => {
    const probe = await fs.open(path.join(dir, "probe"), "w");
    const FileHandle = Object.getPrototypeOf(probe) as fs.FileHandle;
    await probe.close();
    const id = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* store.append(id, custom(1));
        vi.spyOn(FileHandle, "datasync").mockRejectedValueOnce(Object.assign(new Error("I/O error"), { code: "EIO" }));
        expect((yield* Effect.flip(store.append(id, custom(2)))).reason).toBe("Io");
        return id;
      }),
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.events(id)).map((event) => event.data)).toEqual([custom(1)]);
      }),
    );
  });

  it("stops writing a file another program changed, then reads it again", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        const first = yield* store.append(id, custom(1));
        const [file] = yield* Effect.promise(sessionFiles);
        const outside = { seq: 2, id: "outside", parent: first.id, at: Date.now(), data: custom(2) };
        yield* Effect.promise(() => fs.appendFile(file!, `${JSON.stringify(outside)}\n`));
        const error = yield* Effect.flip(store.append(id, custom(3)));
        expect(error.reason).toBe("Io");
        expect(error.message).toContain("changed on disk");
        expect(yield* store.append(id, custom(3))).toMatchObject({ seq: 3, parent: "outside" });
      }),
    );
  });

  it("refuses to open for writing a file another program changed since it was read, then reads it again", async () => {
    const id = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* store.append(id, custom(1));
        return id;
      }),
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const [first] = yield* store.events(id);
        // Read, not yet written: then another program appends.
        const [file] = yield* Effect.promise(sessionFiles);
        const outside = { seq: 2, id: "outside", parent: first!.id, at: Date.now(), data: custom(2) };
        yield* Effect.promise(() => fs.appendFile(file!, `${JSON.stringify(outside)}\n`));
        expect((yield* Effect.flip(store.append(id, custom(3)))).message).toContain("changed on disk");
        expect(yield* store.append(id, custom(3))).toMatchObject({ seq: 3, parent: "outside" });
        expect((yield* store.events(id)).map((event) => event.data)).toEqual([custom(1), custom(2), custom(3)]);
      }),
    );
  });

  it("stops writing a file that was deleted or replaced under it", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* store.append(id, custom(1));
        const [file] = yield* Effect.promise(sessionFiles);
        yield* Effect.promise(async () => {
          const copy = `${file}.copy`;
          await fs.copyFile(file!, copy);
          await fs.rename(copy, file!);
        });
        const error = yield* Effect.flip(store.append(id, custom(2)));
        expect(error).toMatchObject({ reason: "Io" });
        expect(error.message).toContain("deleted or replaced");
        // The replacement is read and written from then on.
        expect((yield* store.append(id, custom(2))).seq).toBe(2);
      }),
    );
  });

  it("finishes a removal or creation interrupted part-way, so memory matches the disk", async () => {
    const id = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        return (yield* store.create()).id;
      }),
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        // The removal is interrupted while it deletes the file.
        const rm = fs.rm;
        let resume: (() => void) | undefined;
        const deleting = new Promise<void>((resolve) => {
          vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
            if (String(target).endsWith(".jsonl") && resume === undefined) {
              await new Promise<void>((done) => {
                resume = done;
                resolve();
              });
            }
            return rm(target, options);
          });
        });
        const removal = yield* Effect.fork(store.remove(id));
        yield* Effect.promise(() => deleting);
        const interrupting = yield* Effect.fork(Fiber.interrupt(removal));
        resume!();
        yield* Fiber.join(interrupting);
        vi.restoreAllMocks();
        expect(yield* store.list()).toEqual([]);
        expect((yield* Effect.flip(store.get(id))).reason).toBe("NotFound");
        // Interrupting a creation leaves a session that can be written, or none.
        const creating = yield* Effect.fork(store.create());
        yield* Effect.yieldNow();
        yield* Fiber.interrupt(creating);
        for (const info of yield* store.list()) yield* store.append(info.id, custom(1));
      }),
    );
    expect((await sessionFiles()).length).toBeLessThanOrEqual(1);
  });

  it("lists a restarted host's sessions from its index, reading only what was appended since", async () => {
    const id = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* store.append(id, title("first"));
        return id;
      }),
    );
    // The first host indexed the session from memory as it stopped, so this one lists it without reading the file.
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.list())[0]).toMatchObject({ id, title: "first", lastSeq: 1 });
      }),
    );
    const index = path.join(dir, "sessions", ".index.json");
    const saved = JSON.parse(await fs.readFile(index, "utf8")) as { files: Record<string, { info: { title?: string; leaf?: string } }> };
    const [record] = Object.values(saved.files);
    // A title only the index has shows that an unchanged file is not read again.
    record!.info.title = "from the index";
    await fs.writeFile(index, JSON.stringify(saved));
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.list())[0]!.title).toBe("from the index");
      }),
    );
    // Appended by another program: only the new line is read, so the index's title stays.
    const [file] = await sessionFiles();
    const line = { seq: 2, id: "x2", parent: record!.info.leaf, at: Date.now(), data: custom(2) };
    await fs.appendFile(file!, `${JSON.stringify(line)}\n`);
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.list())[0]).toMatchObject({ title: "from the index", lastSeq: 2, leaf: "x2" });
      }),
    );
    // An unreadable index is rebuilt from the files.
    await fs.writeFile(index, "{");
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.list())[0]).toMatchObject({ title: "first", lastSeq: 2 });
        yield* store.remove(id);
        expect(yield* store.list()).toEqual([]);
      }),
    );
    expect(JSON.parse(await fs.readFile(index, "utf8")).files).toEqual({});
  });

  it("reads a whole file again for the listing when the line it read last has changed", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* store.append(id, title("AAAA"));
      }),
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.list())[0]!.title).toBe("AAAA");
      }),
    );
    // As when a failed write's line, already read by another host, is replaced by one of the same length.
    const [file] = await sessionFiles();
    const text = await fs.readFile(file!, "utf8");
    const handle = await fs.open(file!, "r+");
    await handle.write(Buffer.from("BBBB"), 0, 4, Buffer.byteLength(text.slice(0, text.lastIndexOf("AAAA"))));
    await handle.close();
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.list())[0]!.title).toBe("BBBB");
      }),
    );
  });
});
