import { createEffect, createSignal, on, untrack } from "solid-js";
import type { Accessor } from "solid-js";
import { SessionChannels } from "@lemma/sessions";
import type { SessionInfo } from "@lemma/sessions";
import { isBlank, ThreadHolds } from "@lemma/threads";
import type { ThreadsService } from "@lemma/threads";
import type { ClientService, SlotsService } from "@lemma/web";
import { loadStrings, save } from "@lemma/web/storage";

/** The blank threads this tab made (`made` below), in the tab's own storage. */
export const MADE_KEY = "lemma.threads.client.made";

/** What the blank threads are managed with: the threads, where the page is, and the calls that change them. */
export interface BlankDeps {
  readonly client: ClientService;
  readonly slots: SlotsService;
  readonly list: Accessor<readonly SessionInfo[]>;
  readonly loaded: Accessor<boolean>;
  readonly activeId: Accessor<string | undefined>;
  readonly active: Accessor<SessionInfo | undefined>;
  readonly pendingCwd: Accessor<string | undefined>;
  /** A draft is written in it (`Threads.drafts`). */
  readonly drafted: (sessionId: string) => boolean;
  /** Nothing sent to it: no prompt in its log, and none on its way. */
  readonly unsent: (session: SessionInfo) => boolean;
  /** The thread the address names, if it names one; reactive. */
  readonly addressed: () => string | undefined;
  /** The address is the new-thread page's; reactive. */
  readonly onNewThreadPage: () => boolean;
  /** Goes to a thread, `replace` in place of the address shown; resolves once its log has loaded. */
  readonly go: (sessionId: string, replace?: boolean) => Promise<void>;
  /** Goes to the new-thread page. */
  readonly select: (sessionId: undefined) => Promise<void>;
  /** A new, empty session in `cwd`, listed; undefined, and reported, when it fails. */
  readonly create: (cwd: string | undefined) => Promise<SessionInfo | undefined>;
  /** Moves a blank thread to `cwd`; false, and reported, when it failed. */
  readonly relocate: (sessionId: string, cwd: string) => Promise<boolean>;
  /** A session deleted: off the list. */
  readonly forget: (sessionId: string) => void;
  /** A session's info changed: in the list. */
  readonly upsert: (info: SessionInfo) => void;
}

/** The blank threads this tab made (`made`), and making them as a browser opens tabs (`Threads.newThread`). */
export interface BlankThreads extends Pick<ThreadsService, "newThread"> {
  /** This tab made the blank thread: it is the one to move or delete. */
  readonly madeHere: (sessionId: string) => boolean;
}

/**
 * The blank threads this tab made, kept across its reloads and seen by no other tab: the new-thread page lands on one
 * of these, and only these are moved or deleted here, never one another tab or window or a script (`lemma sessions
 * new`) made. One a closed tab left goes on the host once it has been empty a while (`SessionMarks.kept`).
 */
export const manageBlankThreads = (deps: BlankDeps): BlankThreads => {
  const { client, slots, list, loaded, activeId, active, pendingCwd, drafted, unsent } = deps;
  const made = new Set(loadStrings(MADE_KEY, "session"));
  /** Told each change to `made`, for what follows which blank threads are this tab's. */
  const [madeChanged, setMadeChanged] = createSignal(0);
  const keepMade = () => {
    save(MADE_KEY, JSON.stringify([...made]), "session");
    setMadeChanged((count) => count + 1);
  };
  /** The new threads being made, by directory: asked for again meanwhile, the one under way is the answer. */
  const making = new Map<string, Promise<SessionInfo | undefined>>();
  const tab = (cwd: string | undefined): Promise<SessionInfo | undefined> => {
    const key = cwd ?? "";
    const pending = making.get(key);
    if (pending !== undefined) return pending;
    const creating = deps
      .create(cwd)
      .then((info) => {
        if (info !== undefined) {
          made.add(info.id);
          keepMade();
        }
        return info;
      })
      .finally(() => making.delete(key));
    making.set(key, creating);
    return creating;
  };
  // One no longer blank (or gone) is no longer a tab to land on.
  createEffect(() => {
    if (!loaded()) return;
    const blanks = new Set(
      list()
        .filter(isBlank)
        .map((session) => session.id),
    );
    const before = made.size;
    for (const id of made) if (!blanks.has(id)) made.delete(id);
    if (made.size !== before) keepMade();
  });
  /** Something is kept for a thread: a draft, or what a plugin holds for it (`ThreadHolds`: a page in its pane). */
  const keeps = (sessionId: string) => drafted(sessionId) || slots.list(ThreadHolds).some((hold) => hold.holds(sessionId));
  // The host keeps a blank thread made here while something is kept for it, and lets one go once nothing is
  // (`SessionMarks.kept`): left in a tab that closed, it goes there once it has been empty a while.
  const marking = new Set<string>();
  createEffect(() => {
    if (!loaded()) return;
    madeChanged();
    for (const session of list()) {
      if (!made.has(session.id) || !isBlank(session) || marking.has(session.id)) continue;
      const kept = keeps(session.id);
      if ((session.kept === true) === kept) continue;
      marking.add(session.id);
      client.channel
        .call(SessionChannels.mark, { sessionId: session.id, kept })
        .then(deps.upsert, () => {
          // Gone meanwhile, or the host away: tried again on the next change.
        })
        .finally(() => marking.delete(session.id));
    }
  });
  // A blank thread made here, left with nothing kept for it, goes, as a tab closed does: new threads do not pile up
  // on the host. Not for the new-thread page, which lands on it again.
  createEffect(
    on(activeId, (id, left) => {
      if (left === undefined || id === undefined || left === id) return;
      const session = untrack(list).find((candidate) => candidate.id === left);
      if (session === undefined || !made.has(left) || !unsent(session) || untrack(() => keeps(left))) return;
      // Quietly: one in use meanwhile (Busy) stays.
      client.channel.call(SessionChannels.delete, { sessionId: left }).then(
        () => deps.forget(left),
        () => {},
      );
    }),
  );
  /** The blank threads being moved, so asking again while one is under way waits for it rather than racing it. */
  const moving = new Map<string, Promise<void>>();
  const newThread = async (cwd?: string, options: { readonly inPlace?: boolean } = {}): Promise<void> => {
    const shown = active();
    const dir = cwd ?? pendingCwd() ?? shown?.cwd;
    const over = options.inPlace === true && shown !== undefined && unsent(shown) && made.has(shown.id) ? shown : undefined;
    // Nowhere said yet (the workspace not yet known): the new-thread page, which makes one once there is somewhere.
    if (over === undefined && dir === undefined) return deps.select(undefined);
    if (over === undefined) {
      // One new thread per directory: an empty one made here is gone to rather than another made beside it. One with a
      // prompt written in it is held as a draft, not empty.
      const empty = [...(shown === undefined ? [] : [shown]), ...list()].find(
        (session) => made.has(session.id) && unsent(session) && !drafted(session.id) && session.archived !== true && session.cwd === dir,
      );
      if (empty !== undefined) {
        if (deps.addressed() !== empty.id) await deps.go(empty.id);
        return;
      }
      const info = await tab(dir);
      if (info !== undefined) await deps.go(info.id);
      return;
    }
    // Already there: it is the new thread, gone to from wherever is shown (settings, say).
    if (over.cwd === dir || dir === undefined) {
      if (deps.addressed() !== over.id) await deps.go(over.id);
      return;
    }
    const pending = moving.get(over.id);
    if (pending !== undefined) return pending;
    const done = deps
      .relocate(over.id, dir)
      .then(() => {})
      .finally(() => moving.delete(over.id));
    moving.set(over.id, done);
    return done;
  };

  // The new-thread page shows a blank thread: the newest made here with nothing written in it, else one made once there
  // is somewhere to start it (`pendingCwd`), which the list then holds. Until then, or with nothing to say where, its
  // first prompt creates it. A place it could not be made in is not tried again until there is another.
  let landing = false;
  let failedIn: string | undefined;
  createEffect(() => {
    if (!deps.onNewThreadPage() || !loaded()) return;
    const newest = list()
      .filter((session) => made.has(session.id) && isBlank(session) && !drafted(session.id) && session.archived !== true)
      .reduce<SessionInfo | undefined>((best, session) => (best === undefined || session.createdAt > best.createdAt ? session : best), undefined);
    if (newest !== undefined) return void deps.go(newest.id, true);
    const cwd = pendingCwd();
    if (cwd === undefined || landing || cwd === failedIn) return;
    landing = true;
    void tab(cwd)
      .then((info) => {
        failedIn = info === undefined ? cwd : undefined;
        // Made, it is gone to: the list held it before it was known to be made here.
        if (info !== undefined && untrack(deps.onNewThreadPage)) void deps.go(info.id, true);
      })
      .finally(() => (landing = false));
  });

  return { madeHere: (sessionId) => made.has(sessionId), newThread };
};
