import { execFile, spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Effect } from "effect";
import { Credentials } from "@lemma/contracts";
import type { Credential } from "@lemma/contracts";
import { pathsPlugin } from "@lemma/contracts/testing";
import { makeCore } from "@lemma/core";
import credentials, { withFileLock } from "../src/index.ts";

let root: string;
let home: string;
let auth: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lemma-credentials-"));
  // Not created: the plugin creates the directory (0700) on first write.
  home = join(root, "home");
  auth = join(home, "auth.json");
});
afterEach(() => rm(root, { recursive: true, force: true }));

const run = <A, E>(body: Effect.Effect<A, E, Credentials>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(makeCore([pathsPlugin(home, { auth, cwd: root }), credentials]), (core) => core.run(body))));

const stored = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(auth, "utf8"));
const set = (credential: Credential) => () => Effect.succeed(credential);
const increment = (current: Credential | undefined): Effect.Effect<Credential> =>
  Effect.succeed({ type: "api_key", key: String(Number(current?.type === "api_key" ? current.key : 0) + 1) });

describe("credentials", () => {
  test("modify takes an update written with promises, or one returning at once", async () => {
    const result = await run(
      Effect.gen(function* () {
        const service = yield* Credentials;
        yield* service.modify("a", async () => ({ type: "api_key" as const, key: "from a promise" }));
        yield* service.modify("b", () => ({ type: "api_key" as const, key: "at once" }));
        return [yield* service.read("a"), yield* service.read("b")];
      }),
    );
    expect(result).toEqual([
      { type: "api_key", key: "from a promise" },
      { type: "api_key", key: "at once" },
    ]);
  });

  test("modify writes atomically with 0600/0700, and read, list, and remove see it", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* Credentials;
        expect(yield* service.read("anthropic")).toBeUndefined();
        expect(yield* service.list).toEqual([]);
        expect(yield* service.modify("anthropic", set({ type: "api_key", key: "sk-1" }))).toEqual({ type: "api_key", key: "sk-1" });
        yield* service.modify("openai", set({ type: "oauth", access: "a", refresh: "r", expires: 1 }));
        expect(yield* service.list).toEqual([
          { provider: "anthropic", type: "api_key" },
          { provider: "openai", type: "oauth" },
        ]);
        expect(yield* service.read("anthropic")).toEqual({ type: "api_key", key: "sk-1" });
        yield* service.remove("openai");
        yield* service.remove("never-there");
        expect(yield* service.list).toEqual([{ provider: "anthropic", type: "api_key" }]);
      }),
    );
    expect((await stat(auth)).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect(await stored()).toEqual({ anthropic: { type: "api_key", key: "sk-1" } });
    // No temp files or lock left behind.
    expect(await readdir(home)).toEqual(["auth.json"]);
  });

  test("an update returning undefined leaves the entry unchanged; a failing update writes nothing", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* Credentials;
        yield* service.modify("p", set({ type: "api_key", key: "k" }));
        const before = (yield* Effect.promise(() => stat(auth))).mtimeMs;
        expect(yield* service.modify("p", () => Effect.succeed(undefined))).toEqual({ type: "api_key", key: "k" });
        expect(yield* service.modify("q", () => Effect.succeed(undefined))).toBeUndefined();
        expect(yield* service.modify("p", () => Effect.fail("nope" as const)).pipe(Effect.flip)).toBe("nope");
        expect((yield* Effect.promise(() => stat(auth))).mtimeMs).toBe(before);
        expect(yield* service.list).toEqual([{ provider: "p", type: "api_key" }]);
      }),
    );
  });

  test("preserves unknown OAuth fields and every other entry verbatim", async () => {
    await mkdir(home, { mode: 0o700 });
    const foreign = { type: "api_key", key: "k", note: "kept" };
    await writeFile(auth, JSON.stringify({ other: foreign }), { mode: 0o600 });
    await run(
      Effect.gen(function* () {
        const service = yield* Credentials;
        yield* service.modify("codex", set({ type: "oauth", access: "a", refresh: "r", expires: 1, accountId: "acct", extra: { deep: true } }));
        // A refresh keeps the provider's own fields.
        const refreshed = yield* service.modify("codex", (current) =>
          Effect.succeed(current?.type === "oauth" ? { ...current, access: "a2", expires: 2 } : undefined),
        );
        expect(refreshed).toEqual({ type: "oauth", access: "a2", refresh: "r", expires: 2, accountId: "acct", extra: { deep: true } });
        expect(yield* service.read("codex")).toEqual(refreshed);
      }),
    );
    expect((await stored()).other).toEqual(foreign);
  });

  test("a corrupt file is a Corrupt error and is never overwritten", async () => {
    await mkdir(home, { mode: 0o700 });
    await writeFile(auth, "{ not json", { mode: 0o600 });
    await run(
      Effect.gen(function* () {
        const service = yield* Credentials;
        expect(yield* service.list.pipe(Effect.flip)).toMatchObject({ reason: "Corrupt" });
        expect(yield* service.read("p").pipe(Effect.flip)).toMatchObject({ reason: "Corrupt", provider: "p" });
        const error = yield* service.modify("p", set({ type: "api_key", key: "k" })).pipe(Effect.flip);
        expect(error).toMatchObject({ reason: "Corrupt", provider: "p" });
        expect(error.message).toContain(auth);
      }),
    );
    expect(await readFile(auth, "utf8")).toBe("{ not json");

    await writeFile(auth, JSON.stringify({ p: { type: "password", value: "x" } }));
    const invalid = await run(Effect.flatMap(Credentials, (service) => service.read("p")).pipe(Effect.flip));
    expect(invalid).toMatchObject({ reason: "Corrupt", provider: "p" });
  });

  test("concurrent modifies of one provider serialize in-process", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* Credentials;
        yield* Effect.all(
          Array.from({ length: 25 }, () => service.modify("counter", increment)),
          { concurrency: "unbounded" },
        );
        yield* Effect.all(
          Array.from({ length: 5 }, (_, i) => service.modify(`p${i}`, increment)),
          { concurrency: "unbounded" },
        );
        expect(yield* service.read("counter")).toEqual({ type: "api_key", key: "25" });
        expect((yield* service.list).length).toBe(6);
      }),
    );
  });

  test("concurrent modifies from several processes do not lose updates", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/increment.ts", import.meta.url));
    const child = () => promisify(execFile)(process.execPath, ["--conditions=lemma-source", fixture, auth, "counter", "10"]);
    await run(
      Effect.gen(function* () {
        const service = yield* Credentials;
        const children = Effect.promise(() => Promise.all([child(), child(), child()]));
        const local = Effect.forEach(Array.from({ length: 10 }), () => service.modify("counter", increment));
        yield* Effect.all([children, local], { concurrency: "unbounded" });
        expect(yield* service.read("counter")).toEqual({ type: "api_key", key: "40" });
      }),
    );
    expect(await readdir(home)).toEqual(["auth.json"]);
  }, 30_000);
});

describe("file lock", () => {
  const holdLock = async (owner: object, ageMs = 0) => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(`${auth}.lock`, JSON.stringify(owner));
    if (ageMs) {
      const old = new Date(Date.now() - ageMs);
      await utimes(`${auth}.lock`, old, old);
    }
  };

  test("releases the lock when its body runs uninterruptibly", async () => {
    // A token refresh runs so, to keep a rotated token; the lock's heartbeat must still stop.
    const run = withFileLock(auth, Effect.succeed("done")).pipe(Effect.uninterruptible);
    const outcome = await Promise.race([Effect.runPromise(run), new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000))]);
    expect(outcome).toBe("done");
    await expect(stat(`${auth}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("fails Locked after the wait bound while a live process holds it", async () => {
    await holdLock({ pid: process.pid, host: hostname(), nonce: "other" });
    const error = await Effect.runPromise(withFileLock(auth, Effect.void, { waitMs: 150 }).pipe(Effect.flip));
    expect(error).toMatchObject({ reason: "Locked" });
    // The live holder's lock is untouched.
    expect(JSON.parse(await readFile(`${auth}.lock`, "utf8"))).toMatchObject({ nonce: "other" });
  });

  test("takes over a lock whose process is gone or that has not been touched", async () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    await holdLock({ pid: dead, host: hostname(), nonce: "dead" });
    expect(await Effect.runPromise(withFileLock(auth, Effect.succeed("ran"), { waitMs: 150 }))).toBe("ran");

    await holdLock({ pid: process.pid, host: hostname(), nonce: "idle" }, 60_000);
    expect(await Effect.runPromise(withFileLock(auth, Effect.succeed("ran"), { waitMs: 150 }))).toBe("ran");
    expect(await readdir(home)).toEqual([]);
  });

  test("takes over a stale empty lock left by a crash between create and write", async () => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(`${auth}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${auth}.lock`, old, old);
    expect(await Effect.runPromise(withFileLock(auth, Effect.succeed("ran"), { waitMs: 500 }))).toBe("ran");
    expect(await readdir(home)).toEqual([]);
  });

  test("waits out a fresh empty lock whose holder is still writing it", async () => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(`${auth}.lock`, "");
    const error = await Effect.runPromise(withFileLock(auth, Effect.void, { waitMs: 150 }).pipe(Effect.flip));
    expect(error).toMatchObject({ reason: "Locked" });
  });

  test("the holder keeps a long-held lock fresh", async () => {
    await Effect.runPromise(
      withFileLock(
        auth,
        Effect.gen(function* () {
          yield* Effect.sleep("250 millis");
          const age = Date.now() - (yield* Effect.promise(() => stat(`${auth}.lock`))).mtimeMs;
          expect(age).toBeLessThan(150);
        }),
        { staleMs: 150 },
      ),
    );
  });
});
