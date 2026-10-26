import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import type { Component } from "solid-js";
import { Actions } from "@lemma/actions";
import { Layers, holdWhileRead } from "@lemma/frame";
import { SettingsGroups, SettingsSections, Settings } from "@lemma/settings";
import { sessionTitle, Threads } from "@lemma/threads";
import { Slots, defineWebPlugin, usePlugin } from "@lemma/web";
import { radioStep } from "@lemma/web/keys";
import { loadJson, save } from "@lemma/web/storage";
import { Workspace } from "@lemma/workspace/web";
import { AlertIcon, BellIcon, CheckIcon, QuestionIcon, SettingRow, Toggle, XIcon } from "@lemma/look";
import { CHANNELS, CORNERS, DEFAULT_PREFS, TOLD, arrivals, badgeCount, countedTitle, readPrefs, tellsBy, withChannel } from "./model.ts";
import type { Arrival, Channel, Corner, Prefs, Told } from "./model.ts";
import { chime } from "./sound.ts";
import styles from "./notifications.css?inline";

/** What the person chose, kept in this browser: each window decides how it tells them. */
const PREFS_KEY = "lemma.threads.notifications.prefs";
const SECTION = "notifications";
/** How long a notice of a turn's end shows (ms), while the pointer is not on it; one of a thread waiting stays until it is answered. */
const NOTICE_MS = 8000;
/** At most this many notices show; one more lets the oldest go. */
const AT_MOST = 3;
/** Sounds at most this often (ms): a burst of threads finishing chimes once. */
const SOUND_GAP = 1500;

/** The desktop app's bridge (`window.lemmaDesktop.attention`, `apps/desktop/src/preload.cjs`), in its window. */
const desktop = (window as Window & { lemmaDesktop?: { readonly attention?: { readonly setBadge: (count: number) => void; readonly focus: () => void } } })
  .lemmaDesktop?.attention;

const STATE_TITLES: Readonly<Record<Told, string>> = { waiting: "Waiting on you", failed: "Failed", done: "Done" };
const STATE_DETAILS: Readonly<Record<Told, string>> = {
  waiting: "An approval, or an answer to a question",
  failed: "A turn stopped on an error, or ran out of steps",
  done: "A turn finished while you were elsewhere",
};
const STATE_ICONS: Readonly<Record<Told, Component>> = { waiting: QuestionIcon, failed: AlertIcon, done: CheckIcon };
const CHANNEL_TITLES: Readonly<Record<Channel, string>> = { notice: "In the app", system: "System", badge: "Badge", sound: "Sound" };
const CHANNEL_DETAILS: Readonly<Record<Channel, string>> = {
  notice: "a notice in a corner, while you look at this window",
  system: "a system notification, while you are in another window or app",
  badge: "a count on the app's icon and the page's title",
  sound: "a short chime",
};
const CORNER_TITLES: Readonly<Record<Corner, string>> = {
  "top-left": "Top left",
  "top-center": "Top center",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-center": "Bottom center",
  "bottom-right": "Bottom right",
};

/** A notice in the app: a thread that tells the person something, until it is answered, seen, or its time is up. */
interface Notice extends Arrival {
  readonly id: number;
  /** A sample's own words; a thread's notice shows its thread's as they change (a new thread is named as its first turn ends). */
  readonly title?: string;
  readonly project?: string;
}

type Permission = NotificationPermission | "unsupported";
const permissionNow = (): Permission => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);

function NoticeCard(props: { notice: Notice; title: string; project: string; open: () => void; dismiss: () => void }) {
  const plugin = usePlugin();
  let stop: (() => void) | undefined;
  /** A turn's end goes after a while, held while it is read (`holdWhileRead`); a thread waiting stays until it is answered. */
  const wait = (held: boolean) => {
    stop?.();
    stop = undefined;
    if (props.notice.state !== "waiting" && !held) stop = plugin.after(NOTICE_MS, () => props.dismiss(), { name: "dismiss notice" });
  };
  const reading = holdWhileRead(wait);
  wait(false);
  onCleanup(() => stop?.());
  const Glyph = STATE_ICONS[props.notice.state];
  return (
    <div class="thread-notice" data-state={props.notice.state} role={props.notice.state === "done" ? "status" : "alert"} {...reading}>
      <button type="button" class="thread-notice-open" onClick={() => props.open()}>
        <span class="thread-notice-icon">
          <Glyph />
        </span>
        <span class="thread-notice-text">
          <span class="thread-notice-title">{props.title}</span>
          <span class="thread-notice-detail">
            <span class="thread-notice-state">{props.notice.label}</span>
            <Show when={props.project}> · {props.project}</Show>
          </span>
        </span>
      </button>
      <button type="button" class="icon-button thread-notice-close" aria-label="Dismiss" data-tip="Dismiss" onClick={() => props.dismiss()}>
        <XIcon />
      </button>
    </div>
  );
}

/** The grid of each state and each channel: whether that state reaches the person that way. */
function ChannelGrid(props: { prefs: () => Prefs; change: (state: Told, channel: Channel, on: boolean) => void }) {
  return (
    <div class="notify-grid" role="table" aria-label="How each state tells you">
      <div class="notify-grid-row notify-grid-head" role="row">
        <span role="columnheader" class="notify-grid-corner">
          Tell me when a thread is
        </span>
        <For each={CHANNELS}>
          {(channel) => (
            <span role="columnheader" data-tip={`Its ${CHANNEL_DETAILS[channel]}`}>
              {CHANNEL_TITLES[channel]}
            </span>
          )}
        </For>
      </div>
      <For each={TOLD}>
        {(state) => {
          const Glyph = STATE_ICONS[state];
          return (
            <div class="notify-grid-row" role="row">
              <span role="rowheader" class="notify-grid-state" data-state={state}>
                <span class="notify-grid-icon">
                  <Glyph />
                </span>
                <span class="setting-text">
                  <span class="setting-title">{STATE_TITLES[state]}</span>
                  <span class="setting-desc">{STATE_DETAILS[state]}</span>
                </span>
              </span>
              <For each={CHANNELS}>
                {(channel) => (
                  <span role="cell" class="notify-grid-cell">
                    <Toggle
                      label={`${STATE_TITLES[state]}: ${CHANNEL_DETAILS[channel]}`}
                      checked={tellsBy(props.prefs(), state, channel)}
                      onChange={(on) => props.change(state, channel, on)}
                    />
                  </span>
                )}
              </For>
            </div>
          );
        }}
      </For>
    </div>
  );
}

/** Where notices stack, picked on a window in miniature: one Tab stop, whose arrow keys, Home, and End move the choice. */
function CornerPicker(props: { corner: () => Corner; pick: (corner: Corner) => void }) {
  const onKeyDown = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const next = radioStep(event.key, CORNERS.indexOf(props.corner()), CORNERS.length);
    if (next === undefined) return;
    event.preventDefault();
    props.pick(CORNERS[next]!);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };
  return (
    <SettingRow title="Where notices show" description={`${CORNER_TITLES[props.corner()]} of the window.`}>
      <div class="notify-corners" role="radiogroup" aria-label="Where notices show" onKeyDown={onKeyDown}>
        <For each={CORNERS}>
          {(corner) => (
            <button
              type="button"
              role="radio"
              class="notify-corner"
              data-corner={corner}
              aria-checked={props.corner() === corner}
              tabIndex={props.corner() === corner ? 0 : -1}
              aria-label={CORNER_TITLES[corner]}
              data-tip={CORNER_TITLES[corner]}
              onClick={() => props.pick(corner)}
            >
              <Show when={props.corner() === corner}>
                <CheckIcon />
              </Show>
            </button>
          )}
        </For>
      </div>
    </SettingRow>
  );
}

/** Whether this browser shows system notifications, asking it once, and a test of every channel. */
function SystemRow(props: { permission: () => Permission; ask: () => void; test: () => void }) {
  const description = () => {
    switch (props.permission()) {
      case "granted":
        return "Allowed in this browser.";
      case "denied":
        return "Blocked in this browser's settings for this site. Allow notifications there to get them.";
      case "default":
        return "This browser asks before showing them.";
      case "unsupported":
        return "This browser cannot show them.";
    }
  };
  return (
    <SettingRow title="System notifications" description={description()}>
      <Show when={props.permission() === "default"}>
        <button type="button" class="button small" onClick={() => props.ask()}>
          Allow
        </button>
      </Show>
      <button type="button" class="button small" onClick={() => props.test()}>
        Try it
      </button>
    </SettingRow>
  );
}

/**
 * How a thread tells the person it needs them, as `Threads.attention` has it: it waits on them, or a turn failed or
 * finished while they were elsewhere. Each state reaches them by the channels they choose in Settings › Notifications:
 * a notice in a corner of the app while they look at the window, a system notification while they are in another, a
 * count on the app's icon and the page's title, a chime. The thread they are looking at tells nothing, nor does an
 * agent's finished turn, which its thread goes on with.
 */
export default defineWebPlugin({
  id: "threads.notifications",
  styles,
  requires: { threads: Threads, slots: Slots, workspace: Workspace, settings: Settings },
  setup: ({ threads, slots, workspace, settings }, plugin) => {
    const loadPrefs = () => readPrefs(loadJson<unknown>(PREFS_KEY, DEFAULT_PREFS, (value): value is unknown => value !== null));
    const [prefs, setPrefsRaw] = createSignal<Prefs>(loadPrefs());
    const setPrefs = (next: Prefs) => {
      setPrefsRaw(next);
      save(PREFS_KEY, JSON.stringify(next));
    };
    plugin.listen(window, "storage", (event) => {
      if (event.key === PREFS_KEY) setPrefsRaw(loadPrefs());
    });
    const [permission, setPermission] = createSignal<Permission>(permissionNow());

    /** The person is looking at this window: the page shows, and its window has focus. */
    const looking = () => document.visibilityState === "visible" && document.hasFocus();
    const [attending, setAttending] = createSignal(looking());
    const lookAgain = () => {
      setAttending(looking());
      setPermission(permissionNow());
    };
    plugin.listen(document, "visibilitychange", lookAgain);
    plugin.listen(window, "focus", lookAgain);
    plugin.listen(window, "blur", lookAgain);

    const byId = createMemo(() => new Map(threads.list().map((session) => [session.id, session])));
    const isAgent = (id: string) => byId().get(id)?.parent !== undefined;
    const projectOf = (id: string) => {
      const session = byId().get(id);
      return session === undefined || workspace.isStandalone(session.cwd) ? "" : workspace.projectName(session.cwd);
    };
    const titleOf = (id: string) => {
      const session = byId().get(id);
      return session === undefined ? "A thread" : sessionTitle(session);
    };
    const open = (id: string) => {
      desktop?.focus();
      window.focus();
      void threads.select(id);
    };

    // ---------------------------------------------------------------- notices

    const [notices, setNotices] = createSignal<readonly Notice[]>([]);
    let noticeId = 0;
    const dismiss = (id: number) => setNotices(untrack(notices).filter((notice) => notice.id !== id));
    const notice = (arrival: Arrival) =>
      setNotices([...untrack(notices).filter((item) => item.sessionId !== arrival.sessionId), { ...arrival, id: ++noticeId }].slice(-AT_MOST));
    // A notice goes once what it says is over: the thread answered, seen, or shown to the person looking.
    createEffect(() => {
      const now = threads.attention();
      const shown = attending() ? threads.activeId() : undefined;
      const kept = untrack(notices).filter((item) => {
        const current = now.get(item.sessionId);
        return item.sessionId !== shown && current !== undefined && current.state === item.state && current.label === item.label;
      });
      if (kept.length !== untrack(notices).length) setNotices(kept);
    });

    // ---------------------------------------------------------------- system notifications

    const shownSystem = new Map<string, Notification>();
    const closeSystem = (id: string) => {
      shownSystem.get(id)?.close();
      shownSystem.delete(id);
    };
    plugin.onCleanup(() => {
      for (const id of shownSystem.keys()) closeSystem(id);
    });
    const tellSystem = (arrival: Arrival, silent: boolean) => {
      if (permissionNow() !== "granted") return;
      closeSystem(arrival.sessionId);
      const project = projectOf(arrival.sessionId);
      try {
        const note = new Notification(titleOf(arrival.sessionId), {
          body: project === "" ? arrival.label : `${arrival.label} · ${project}`,
          tag: `lemma-thread-${arrival.sessionId}`,
          silent,
        });
        note.onclick = () => {
          open(arrival.sessionId);
          closeSystem(arrival.sessionId);
        };
        note.onclose = () => {
          if (shownSystem.get(arrival.sessionId) === note) shownSystem.delete(arrival.sessionId);
        };
        shownSystem.set(arrival.sessionId, note);
      } catch {
        // A browser that only shows them from a service worker (Chrome on Android): the badge and the sidebar still say.
      }
    };
    // What the person has seen, or is over, takes its system notification with it.
    createEffect(() => {
      const now = threads.attention();
      for (const id of shownSystem.keys()) if (now.get(id) === undefined || now.get(id)?.state === "working") closeSystem(id);
    });

    // ---------------------------------------------------------------- sound

    let audio: AudioContext | undefined;
    let soundedAt = 0;
    const sound = (state: Told) => {
      const now = Date.now();
      if (now - soundedAt < SOUND_GAP || typeof AudioContext === "undefined") return;
      soundedAt = now;
      try {
        audio ??= new AudioContext();
        chime(audio, state);
      } catch {
        // No sound here (an embedded view refusing audio): the other channels still tell.
      }
    };
    plugin.onCleanup(() => void audio?.close().catch(() => {}));

    // ---------------------------------------------------------------- telling

    const tell = (arrival: Arrival) => {
      const chosen = prefs();
      const sounds = tellsBy(chosen, arrival.state, "sound");
      if (attending()) {
        if (tellsBy(chosen, arrival.state, "notice")) notice(arrival);
      } else if (tellsBy(chosen, arrival.state, "system")) tellSystem(arrival, sounds);
      if (sounds) sound(arrival.state);
    };
    createEffect(
      on(threads.attention, (now, before) => {
        // The first look is what was so before this page: nothing arrives.
        if (before === undefined) return;
        const shown = untrack(attending) ? untrack(threads.activeId) : undefined;
        for (const arrival of arrivals(before, now, (id, state) => id === shown || (state !== "waiting" && isAgent(id)))) tell(arrival);
      }),
    );

    // ---------------------------------------------------------------- badge

    const count = createMemo(() => badgeCount(threads.attention(), prefs(), isAgent));
    const title = document.title.replace(/^\(\d+\) /, "");
    createEffect(() => {
      const n = count();
      desktop?.setBadge(n);
      document.title = countedTitle(title, n);
      const navigatorBadge = navigator as Navigator & { setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
      void (n > 0 ? navigatorBadge.setAppBadge?.(n) : navigatorBadge.clearAppBadge?.())?.catch(() => {});
    });
    plugin.onCleanup(() => {
      desktop?.setBadge(0);
      document.title = title;
      void (navigator as Navigator & { clearAppBadge?: () => Promise<void> }).clearAppBadge?.()?.catch(() => {});
    });

    // ---------------------------------------------------------------- view

    // After the toasts (100), so at the top right they stack under them (`Layers`).
    slots.add(Layers, {
      id: "thread-notices",
      order: 110,
      component: () => (
        <div class="thread-notices" data-corner={prefs().corner} aria-live="polite">
          <For each={prefs().corner.startsWith("bottom") ? notices() : [...notices()].reverse()}>
            {(item) => (
              <NoticeCard
                notice={item}
                title={item.title ?? titleOf(item.sessionId)}
                project={item.project ?? projectOf(item.sessionId)}
                open={() => {
                  dismiss(item.id);
                  open(item.sessionId);
                }}
                dismiss={() => dismiss(item.id)}
              />
            )}
          </For>
        </div>
      ),
    });

    const ask = plugin.action("ask for notifications", async () => {
      if (typeof Notification === "undefined") return;
      setPermission(await Notification.requestPermission());
    });
    /** Each channel at once, as a thread waiting on the person would tell them, but for the page they are on. */
    const test = () => {
      const sample: Arrival = { sessionId: threads.activeId() ?? "", state: "waiting", label: "Needs approval", since: Date.now() };
      setNotices([...untrack(notices), { ...sample, id: ++noticeId, title: "A thread waiting on you", project: "Lemma" }].slice(-AT_MOST));
      if (permissionNow() === "granted")
        try {
          new Notification("A thread waiting on you", { body: "Needs approval · Lemma", tag: "lemma-thread-test", silent: true });
        } catch {
          // Shown in the app only.
        }
      sound("waiting");
    };

    const channelRows = [
      {
        text: "notifications tell waiting failed done approval notice system badge sound chime dock count",
        view: () => <ChannelGrid prefs={prefs} change={(state, channel, on) => setPrefs(withChannel(prefs(), state, channel, on))} />,
      },
    ];
    const systemRows = [
      { text: "system notifications permission allow browser desktop test try", view: () => <SystemRow permission={permission} ask={ask} test={test} /> },
    ];
    const noticeRows = [
      {
        text: "notices position corner where in the app",
        view: () => <CornerPicker corner={() => prefs().corner} pick={(corner) => setPrefs({ ...prefs(), corner })} />,
      },
    ];
    slots.add(SettingsSections, {
      id: SECTION,
      order: 18,
      title: "Notifications",
      icon: BellIcon,
      description: "How a thread tells you it waits on you, failed, or finished while you were elsewhere. Kept in this browser.",
    });
    slots.add(SettingsGroups, { id: "notifications.channels", order: 10, section: SECTION, entries: () => channelRows });
    slots.add(SettingsGroups, { id: "notifications.system", order: 20, section: SECTION, title: "System", entries: () => systemRows });
    slots.add(SettingsGroups, { id: "notifications.notices", order: 30, section: SECTION, title: "In the app", entries: () => noticeRows });
    slots.add(Actions, {
      id: "notifications.open",
      order: 13,
      title: "Notifications",
      category: "Settings",
      keywords: ["alerts", "sound", "badge", "dock", "system notifications", "notices"],
      icon: BellIcon,
      run: () => settings.open(SECTION),
    });
  },
});
