import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import type { SessionInfo } from "@lemma/sessions";
import { SessionChannels } from "@lemma/sessions";
import { ThreadHolds, upsertSession } from "@lemma/threads";
import type { ThreadHold } from "@lemma/threads";
import type { SlotsService } from "@lemma/web";
import { MADE_KEY, manageBlankThreads } from "../src/blank.ts";
import { browser, fakeClient, info, rooted, settle } from "./fakes.ts";

/**
 * The blank threads of a tab, over a fake host that makes, marks, moves, and deletes sessions in `list`, with the
 * address as a signal (`at`: a thread's id, `"new"` for the new-thread page, or another page).
 */
const setup = (options: { readonly threads?: readonly SessionInfo[]; readonly made?: readonly string[] } = {}) => {
  const page = browser();
  if (options.made !== undefined) page.session.set(MADE_KEY, JSON.stringify(options.made));
  const host = fakeClient();
  const [list, setList] = createSignal<readonly SessionInfo[]>(options.threads ?? []);
  const [loaded, setLoaded] = createSignal(true);
  const [at, setAt] = createSignal<string | undefined>("settings");
  const [pendingCwd, setPendingCwd] = createSignal<string>();
  const [drafted, setDrafted] = createSignal<ReadonlySet<string>>(new Set());
  const [holds, setHolds] = createSignal<readonly ThreadHold[]>([]);
  const activeId = () => (list().some((session) => session.id === at()) ? at() : undefined);
  const active = () => list().find((session) => session.id === activeId());
  let made = 0;
  host.answer(SessionChannels.create.id, ({ cwd }: { cwd?: string }) => {
    const created = info(`new${++made}`, { cwd: cwd ?? "/host", createdAt: made });
    return created;
  });
  host.answer(SessionChannels.mark.id, ({ sessionId, kept }: { sessionId: string; kept: boolean }) => ({
    ...list().find((session) => session.id === sessionId)!,
    ...(kept ? { kept } : {}),
  }));
  host.answer(SessionChannels.delete.id, () => null);
  const upsert = (session: SessionInfo) => setList((threads) => upsertSession(threads, session));
  const slots = { list: (slot: unknown) => (slot === ThreadHolds ? holds() : []) } as unknown as SlotsService;
  const blanks = rooted(() =>
    manageBlankThreads({
      client: host.client,
      slots,
      list,
      loaded,
      activeId,
      active,
      pendingCwd,
      drafted: (sessionId) => drafted().has(sessionId),
      unsent: (session) => session.lastSeq === 0,
      addressed: () => (at() === "new" || at() === "settings" ? undefined : at()),
      onNewThreadPage: () => at() === "new",
      go: async (sessionId) => void setAt(sessionId),
      select: async () => void setAt("new"),
      create: async (cwd) => {
        const created = (await host.client.channel.call(SessionChannels.create, cwd === undefined ? {} : { cwd })) as SessionInfo;
        upsert(created);
        return created;
      },
      relocate: async (sessionId, cwd) => {
        upsert({ ...list().find((session) => session.id === sessionId)!, cwd });
        return true;
      },
      forget: (sessionId) => setList((threads) => threads.filter((session) => session.id !== sessionId)),
      upsert,
    }),
  );
  return { page, host, blanks, list, setList, setLoaded, at, setAt, setPendingCwd, setDrafted, setHolds };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("this tab's blank threads", () => {
  it("are made one per directory, as a browser opens tabs: asked again, the one made here is gone to", async () => {
    const { host, blanks, at, page } = setup();
    // Asked twice while it is being made, one is made.
    await Promise.all([blanks.newThread("/a"), blanks.newThread("/a")]);
    expect(host.made(SessionChannels.create.id)).toEqual([{ cwd: "/a" }]);
    expect(at()).toBe("new1");
    expect(blanks.madeHere("new1")).toBe(true);
    expect(JSON.parse(page.session.get(MADE_KEY)!)).toEqual(["new1"]);
    await blanks.newThread("/a");
    await blanks.newThread("/b");
    expect(host.made(SessionChannels.create.id)).toEqual([{ cwd: "/a" }, { cwd: "/b" }]);
    expect(at()).toBe("new2");
  });

  it("are only those this tab made: another's is neither gone to as new nor deleted when left", async () => {
    const { host, blanks, setAt } = setup({ threads: [info("theirs", { cwd: "/a" })] });
    setAt("theirs");
    await blanks.newThread("/a");
    expect(host.made(SessionChannels.create.id)).toEqual([{ cwd: "/a" }]);
    setAt("new1");
    await settle();
    expect(host.made(SessionChannels.delete.id)).toEqual([]);
    expect(blanks.madeHere("theirs")).toBe(false);
  });

  it("go when left with nothing kept for them; one with a draft or a plugin's hold stays, kept on the host", async () => {
    const { host, blanks, list, setAt, setDrafted, setHolds } = setup();
    await blanks.newThread("/a");
    await settle();
    setDrafted(new Set(["new1"]));
    await settle();
    expect(host.made(SessionChannels.mark.id)).toEqual([{ sessionId: "new1", kept: true }]);
    expect(list()[0]!.kept).toBe(true);
    setAt("settings");
    await blanks.newThread("/b");
    await settle();
    expect(host.made(SessionChannels.delete.id)).toEqual([]);
    // new2, held by a plugin, stays when left; let go and left, it goes.
    setHolds([{ holds: (id) => id === "new2" }]);
    setAt("new1");
    await settle();
    expect(host.made(SessionChannels.delete.id)).toEqual([]);
    setHolds([]);
    setAt("new2");
    setAt("new1");
    await settle();
    expect(host.made(SessionChannels.delete.id)).toEqual([{ sessionId: "new2" }]);
    expect(list().map((session) => session.id)).toEqual(["new1"]);
  });

  it("land the new-thread page on the newest made here with nothing written, else on one made once there is somewhere", async () => {
    const { host, at, setAt, setPendingCwd, setDrafted } = setup({
      threads: [info("older", { createdAt: 1 }), info("newer", { createdAt: 2 }), info("sent", { createdAt: 3, lastSeq: 2 })],
      made: ["older", "newer", "sent"],
    });
    setDrafted(new Set(["newer"]));
    setAt("new");
    expect(at()).toBe("older");
    setDrafted(new Set(["older", "newer"]));
    setAt("new");
    expect(at()).toBe("new");
    setPendingCwd("/a");
    await settle();
    expect(host.made(SessionChannels.create.id)).toEqual([{ cwd: "/a" }]);
    expect(at()).toBe("new1");
  });

  it("move in place, keeping the thread, when another project is picked for the blank one shown", async () => {
    const { blanks, list, at } = setup();
    await blanks.newThread("/a");
    await blanks.newThread("/b", { inPlace: true });
    expect(list().map((session) => [session.id, session.cwd])).toEqual([["new1", "/b"]]);
    expect(at()).toBe("new1");
  });

  it("are kept across the tab's reloads, until one is no longer blank or gone", () => {
    const { page, blanks, setList } = setup({ threads: [info("kept"), info("used")], made: ["kept", "used"] });
    expect(blanks.madeHere("kept")).toBe(true);
    setList([info("kept"), info("used", { lastSeq: 1 })]);
    expect(blanks.madeHere("used")).toBe(false);
    expect(JSON.parse(page.session.get(MADE_KEY)!)).toEqual(["kept"]);
  });
});
