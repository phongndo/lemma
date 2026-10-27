import { createEffect, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import type { SessionInfo } from "@lemma/sessions";
import { written } from "@lemma/threads";
import type { ThreadDraft, ThreadsService } from "@lemma/threads";
import { recordOf } from "@lemma/web/storage";
import { sharedRecord } from "./shared.ts";
import type { Handle } from "./shared.ts";

/** The unsent prompts' text, by thread (`Threads.drafts`), shared by the browser's tabs. */
export const DRAFTS_KEY = "lemma.threads.client.drafts";
/** How long after a draft's last change lists hear of it, and it is written to storage (ms). */
export const SAVE_MS = 400;
/** The new-thread page's draft, with no thread shown: kept while the page lasts, not stored. */
const NEW_THREAD = "";
const isTexts = recordOf((text): text is string => typeof text === "string");

/**
 * The unsent prompts (`Threads.drafts`): their text kept in the browser, their images and retry ids, and the
 * new-thread page's, while the page lasts. `held` is the truth, at once (`draft`); the signal is told at once when a
 * thread gains or loses one, and a moment after the last change otherwise, so typing does not redraw every list that
 * reads it at each key. A deleted thread's goes, once `threads` has listed them.
 */
export const createDrafts = (
  plugin: Handle,
  threads: { readonly list: Accessor<readonly SessionInfo[]>; readonly loaded: Accessor<boolean> },
): Pick<ThreadsService, "drafts" | "draft" | "setDraft"> => {
  /**
   * Drafts' texts not yet written to storage, by thread (undefined: none). They are written a moment after the last
   * change, and as the page goes, into what storage holds then: another tab's drafts stay.
   */
  const unsaved = new Map<string, string | undefined>();
  // Another tab's drafts, as it saves them: its text for each thread this tab has not changed since its last save.
  const stored = sharedRecord(plugin, DRAFTS_KEY, isTexts, (after) => {
    let changed = false;
    for (const [id, text] of Object.entries(after)) {
      if (unsaved.has(id) || held.get(id)?.text === text) continue;
      held.set(id, { text, images: held.get(id)?.images ?? [] });
      changed = true;
    }
    for (const [id, draft] of held) {
      if (id === NEW_THREAD || unsaved.has(id) || id in after || draft.images.length > 0) continue;
      held.delete(id);
      changed = true;
    }
    if (changed) tell();
  });
  const held = new Map<string, ThreadDraft>(Object.entries(stored.read()).map(([id, text]) => [id, { text, images: [] }] as const));
  const [drafts, setDrafts] = createSignal<ReadonlyMap<string, ThreadDraft>>(new Map(held));
  let telling: (() => void) | undefined;
  const tell = () => {
    telling?.();
    telling = undefined;
    setDrafts(new Map(held));
  };
  let saving: (() => void) | undefined;
  const saveDrafts = () => {
    saving?.();
    saving = undefined;
    if (unsaved.size === 0) return;
    stored.write((kept) => {
      for (const [id, text] of unsaved) {
        if (text === undefined) delete kept[id];
        else kept[id] = text;
      }
      return kept;
    });
    unsaved.clear();
  };
  plugin.listen(window, "pagehide", saveDrafts);
  plugin.onCleanup(saveDrafts);
  const setDraft = (sessionId: string, draft: ThreadDraft | undefined) => {
    const was = held.get(sessionId);
    const now = written(draft) ? draft : undefined;
    if (now === undefined ? was === undefined : was?.text === now.text && was.images === now.images && was.requestId === now.requestId) return;
    if (now === undefined) held.delete(sessionId);
    else held.set(sessionId, { text: now.text, images: now.images, ...(now.requestId === undefined ? {} : { requestId: now.requestId }) });
    if ((was === undefined) !== (now === undefined)) tell();
    else telling ??= plugin.after(SAVE_MS, tell);
    if (sessionId === NEW_THREAD) return;
    unsaved.set(sessionId, now !== undefined && now.text.trim() !== "" ? now.text : undefined);
    saving ??= plugin.after(SAVE_MS, saveDrafts);
  };
  // A deleted thread's draft goes with it.
  createEffect(() => {
    if (!threads.loaded()) return;
    const known = new Set(threads.list().map((session) => session.id));
    // Deleting while iterating a Map is safe: the iteration goes on past each deleted key.
    for (const id of held.keys()) if (id !== NEW_THREAD && !known.has(id)) setDraft(id, undefined);
  });
  return { drafts, draft: (sessionId) => held.get(sessionId), setDraft };
};
