import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, lockFile, refreshLock, releaseLock, thisProcess } from "../src/lock.ts";
import type { Claimant } from "../src/lock.ts";

let root: string;
beforeEach(async () => {
  root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "lemma-sessions-lock-")), "sessions");
});
afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

/** Sets the lock's modification time `ms` ago, as if its holder last refreshed it then. */
const age = async (ms: number, file = lockFile(root)) => {
  const then = new Date(Date.now() - ms);
  await fs.utimes(file, then, then);
};

/** Another process on this machine (`here`), running or not. */
const other = (pid: number, running: boolean): Claimant => ({ pid, hostname: "here", isAlive: () => running, bootedAt: 0 });
const recorded = async () => JSON.parse(await fs.readFile(lockFile(root), "utf8")) as { readonly pid: number; readonly token: string };

describe("sessions lock", () => {
  it("creates the directory and the lock, and removes the lock on release", async () => {
    const holder = await Effect.runPromise(acquireLock(root));
    expect(await recorded()).toEqual({ pid: process.pid, hostname: thisProcess.hostname, token: holder.token, startedAt: holder.startedAt });
    await Effect.runPromise(releaseLock(root, holder));
    await expect(fs.stat(lockFile(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a lock held by a running process, naming it, the file, and what to do", async () => {
    const holder = await Effect.runPromise(acquireLock(root, other(4242, true)));
    const error = await Effect.runPromise(Effect.flip(acquireLock(root, { ...other(7, true), isAlive: (pid) => pid === 4242 })));
    expect(error.reason).toBe("Io");
    expect(error.message).toContain(`${lockFile(root)} is held by process 4242 on here (since ${new Date(holder.startedAt).toISOString()})`);
    expect(error.message).toContain(`Stop that host first, or delete ${lockFile(root)} if it is not running.`);
    expect((await recorded()).token).toBe(holder.token);
  });

  it("refuses a lock from another hostname, whose process it cannot check, while it is refreshed", async () => {
    await Effect.runPromise(acquireLock(root, { pid: 4242, hostname: "elsewhere", isAlive: () => false, bootedAt: 0 }));
    const error = await Effect.runPromise(Effect.flip(acquireLock(root, other(7, false))));
    expect(error.message).toContain("held by process 4242 on elsewhere");
  });

  it("takes over a lock from another hostname once it has gone unrefreshed (a crash, then the hostname changed)", async () => {
    await Effect.runPromise(acquireLock(root, { pid: 4242, hostname: "old-name", isAlive: () => true, bootedAt: 0 }));
    await age(60_000);
    const holder = await Effect.runPromise(acquireLock(root, other(7, true)));
    expect(await recorded()).toMatchObject({ pid: 7, token: holder.token });
  });

  it("refuses a lock that names nobody, which a process may be writing", async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(lockFile(root), "");
    const error = await Effect.runPromise(Effect.flip(acquireLock(root)));
    expect(error.message).toContain("held by an unknown process");
  });

  it("takes over a lock taken before the machine last booted and not refreshed since, whatever process has its pid now", async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(lockFile(root), JSON.stringify({ pid: 4242, hostname: "here", token: "before", startedAt: Date.now() - 3_600_000 }));
    await age(3_600_000);
    const holder = await Effect.runPromise(acquireLock(root, { ...other(7, true), bootedAt: Date.now() - 60_000 }));
    expect(await recorded()).toMatchObject({ pid: 7, token: holder.token });
  });

  it("refuses a lock that looks older than the boot but is refreshed: its holder started before the clock was set", async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(lockFile(root), JSON.stringify({ pid: 4242, hostname: "here", token: "early", startedAt: Date.now() - 3_600_000 }));
    const error = await Effect.runPromise(Effect.flip(acquireLock(root, { ...other(7, true), bootedAt: Date.now() - 60_000 })));
    expect(error.message).toContain("held by process 4242 on here");
  });

  it("takes over a lock that names nobody once it is too old to be still being written", async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(lockFile(root), "");
    const minuteAgo = new Date(Date.now() - 60_000);
    await fs.utimes(lockFile(root), minuteAgo, minuteAgo);
    const holder = await Effect.runPromise(acquireLock(root, other(7, true)));
    expect(await recorded()).toMatchObject({ pid: 7, token: holder.token });
  });

  it("takes over a lock whose process is no longer running", async () => {
    await Effect.runPromise(acquireLock(root, other(4242, false)));
    const holder = await Effect.runPromise(acquireLock(root, other(7, false)));
    expect(await recorded()).toMatchObject({ pid: 7, token: holder.token });
    expect((await fs.readdir(root)).filter((name) => name.startsWith(".lock"))).toEqual([".lock"]);
  });

  it("waits while another process takes a stale lock over, then refuses the lock it took", async () => {
    await Effect.runPromise(acquireLock(root, other(4242, false)));
    // Process 8 holds the guard: it is taking the lock over, and finishes a moment later.
    await fs.writeFile(`${lockFile(root)}.takeover`, "8");
    setTimeout(() => {
      void fs
        .writeFile(lockFile(root), JSON.stringify({ pid: 8, hostname: "here", token: "eight", startedAt: Date.now() }))
        .then(() => fs.rm(`${lockFile(root)}.takeover`));
    }, 100);
    const error = await Effect.runPromise(Effect.flip(acquireLock(root, { ...other(7, true), isAlive: (pid) => pid !== 4242 })));
    expect(error.message).toContain("held by process 8 on here");
    expect((await recorded()).token).toBe("eight");
  });

  it("clears a takeover guard a crash left, and takes the lock over", async () => {
    await Effect.runPromise(acquireLock(root, other(4242, false)));
    await fs.writeFile(`${lockFile(root)}.takeover`, "8");
    await age(60_000, `${lockFile(root)}.takeover`);
    const holder = await Effect.runPromise(acquireLock(root, other(7, false)));
    expect(await recorded()).toMatchObject({ pid: 7, token: holder.token });
    expect((await fs.readdir(root)).filter((name) => name.startsWith(".lock"))).toEqual([".lock"]);
  });

  it("lets one of two processes taking over one stale lock at once have it", async () => {
    for (let round = 0; round < 20; round++) {
      await fs.rm(root, { recursive: true, force: true });
      await Effect.runPromise(acquireLock(root, other(4242, false)));
      const alive = (pid: number) => pid !== 4242;
      const results = await Effect.runPromise(
        Effect.all(
          [Effect.either(acquireLock(root, { ...other(7, true), isAlive: alive })), Effect.either(acquireLock(root, { ...other(8, true), isAlive: alive }))],
          {
            concurrency: "unbounded",
          },
        ),
      );
      const won = results.flatMap((result) => (result._tag === "Right" ? [result.right] : []));
      expect(won).toHaveLength(1);
      expect((await recorded()).token).toBe(won[0]!.token);
    }
  });

  it("refreshes its lock, writes it again if it was deleted, and fails once another process holds it", async () => {
    const holder = await Effect.runPromise(acquireLock(root));
    await age(60_000);
    await Effect.runPromise(refreshLock(root, holder));
    expect(Date.now() - (await fs.stat(lockFile(root))).mtimeMs).toBeLessThan(10_000);
    await fs.rm(lockFile(root));
    await Effect.runPromise(refreshLock(root, holder));
    expect((await recorded()).token).toBe(holder.token);
    await fs.writeFile(lockFile(root), JSON.stringify({ pid: 8, hostname: "here", token: "eight", startedAt: Date.now() }));
    const error = await Effect.runPromise(Effect.flip(refreshLock(root, holder)));
    expect(error.message).toContain("This host no longer holds the sessions lock");
    expect(error.message).toContain("held by process 8 on here");
  });

  it("takes over this process's own lock, and a release keeps a lock taken over since", async () => {
    const first = await Effect.runPromise(acquireLock(root));
    const second = await Effect.runPromise(acquireLock(root));
    await Effect.runPromise(releaseLock(root, first));
    expect((await recorded()).token).toBe(second.token);
    await Effect.runPromise(releaseLock(root, second));
    await expect(fs.stat(lockFile(root))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
