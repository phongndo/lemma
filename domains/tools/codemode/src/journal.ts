import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodemodeDeclaredGlobal, CodemodeDeclaredTool, CodemodeOutcome } from "@earendil-works/pi-codemode";
import type { CodemodeDisplay } from "./details.ts";

/**
 * A script's journal: what it needs to run again after a host restart and behave as it did, so a call cut off by one
 * resumes instead of running its tools again. One JSON line each: the header (the script and everything it read from
 * its environment), each call as it began, each result in the order the VM took them, and the final result.
 */
export type JournalRecord =
  | {
      readonly type: "header";
      readonly version: 1;
      readonly code: string;
      readonly startedAt: number;
      readonly seed: number;
      readonly timeoutMs: number;
      /** What the VM is (engine versions, prelude, limits): a run resumes only on the same. */
      readonly fingerprint?: string;
      readonly tools: readonly CodemodeDeclaredTool[];
      readonly globals: readonly CodemodeDeclaredGlobal[];
      readonly store: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "fingerprint"; readonly fingerprint: string }
  /** A call about to run: one with no result after it was cut off while it ran. */
  | { readonly type: "start"; readonly id: number }
  /** A call begun that never reached its tool (it was gone as the core shut down): it runs when the script resumes. */
  | { readonly type: "unrun"; readonly id: number }
  /** A call settled; `display`: what a `display` tool's call showed, which a resumed run shows again. */
  | {
      readonly type: "result";
      readonly seq: number;
      readonly now: number;
      readonly id: number;
      readonly outcome: CodemodeOutcome;
      readonly display?: CodemodeDisplay;
    }
  /** The call's result, as the tool returned it: a host that stops before the agent logs it runs the call again. */
  | { readonly type: "done"; readonly result: unknown };

export type JournalHeader = Extract<JournalRecord, { readonly type: "header" }>;
type Result = Extract<JournalRecord, { readonly type: "result" }>;

/** What a call finds of an earlier run of itself. */
export type Earlier =
  | { readonly kind: "none" }
  /** Cut off: replay its results, then go on. */
  | { readonly kind: "cut"; readonly header: JournalHeader; readonly results: ReadonlyMap<number, Result>; readonly started: ReadonlySet<number> }
  /** Finished, its result not yet logged. */
  | { readonly kind: "done"; readonly result: unknown };

/** A journal whose call's result was never logged (cut off, and never resumed) is kept this long. */
const KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The journals of one host, in `<home>/codemode/journals`, one file per call (named by a hash of its session and call
 * id), readable only by the user: they hold what the script's tools returned, so each goes once its call's result is
 * logged (`remove`).
 */
export class Journals {
  private readonly dir: string;

  constructor(home: string) {
    this.dir = join(home, "codemode", "journals");
  }

  /** Deletes journals older than a week. */
  async prune(now: number): Promise<void> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    await Promise.all(
      names.map(async (name) => {
        const file = join(this.dir, name);
        const { mtimeMs } = await stat(file).catch(() => ({ mtimeMs: now }));
        if (now - mtimeMs > KEPT_MS) await rm(file, { force: true });
      }),
    );
  }

  /** The journal of call `toolCallId` of `sessionId`. */
  open(sessionId: string, toolCallId: string): Journal {
    return new Journal(this.dir, this.file(sessionId, toolCallId));
  }

  /** Deletes the journal of call `toolCallId` of `sessionId`, whose result is logged. */
  async remove(sessionId: string, toolCallId: string): Promise<void> {
    await rm(this.file(sessionId, toolCallId), { force: true }).catch(() => {});
  }

  private file(sessionId: string, toolCallId: string): string {
    const name = createHash("sha256").update(`${sessionId}\0${toolCallId}`).digest("hex").slice(0, 32);
    return join(this.dir, `${name}.jsonl`);
  }
}

export class Journal {
  private writing: Promise<void> = Promise.resolve();
  private failed = false;
  private readonly dir: string;
  readonly file: string;

  constructor(dir: string, file: string) {
    this.dir = dir;
    this.file = file;
  }

  /**
   * What an earlier run of this call left, when it ran `code`: a journal of another script (a provider that reuses
   * call ids) is none. Read only for a call whose result the session has not logged: one it has logged was another
   * call under the same id, cancelled or finished, and its journal is stale.
   */
  async earlier(code: string): Promise<Earlier> {
    const text = await readFile(this.file, "utf8").catch(() => undefined);
    if (text === undefined) return { kind: "none" };
    let header: JournalHeader | undefined;
    const results = new Map<number, Result>();
    const started = new Set<number>();
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let record: JournalRecord;
      try {
        record = JSON.parse(line) as JournalRecord;
      } catch {
        // A line torn by the crash ends what can be trusted.
        break;
      }
      if (record.type === "header") header = record;
      else if (header === undefined) break;
      else if (record.type === "fingerprint") header = { ...header, fingerprint: record.fingerprint };
      else if (record.type === "start") started.add(record.id);
      else if (record.type === "unrun") started.delete(record.id);
      else if (record.type === "result") {
        if (record.seq !== results.size + 1) break;
        results.set(record.id, record);
      } else if (record.type === "done") return header.code === code ? { kind: "done", result: record.result } : { kind: "none" };
    }
    return header === undefined || header.code !== code || header.version !== 1 ? { kind: "none" } : { kind: "cut", header, results, started };
  }

  /** Starts the journal anew with `header`. */
  begin(header: JournalHeader): Promise<void> {
    return this.queue(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFile(this.file, `${JSON.stringify(header)}\n`, { mode: 0o600 });
    });
  }

  /** Appends `record` after those before it. A journal that cannot be written stops being written; the run goes on. */
  append(record: JournalRecord): Promise<void> {
    return this.queue(() => appendFile(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 }));
  }

  private queue(write: () => Promise<void>): Promise<void> {
    const next = this.writing.then(async () => {
      if (this.failed) return;
      try {
        await write();
      } catch {
        this.failed = true;
      }
    });
    this.writing = next;
    return next;
  }
}
