# threads.notifications

How a thread tells you it needs you while you look elsewhere. It reads
`Threads.attention` ([`@lemma/threads`](../contract/src/attention.ts)). For each
thread that begins waiting on you, fails, or finishes, it tells you by the
channels you chose in Settings › Notifications:

| Channel    | When                                   | How                                                                                                                                                                                                    |
| ---------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| In the app | You are looking at this window         | A notice in the corner you chose (a `Layers` item at order 110); picked, it opens the thread. A turn's end goes after 8 s, unless the pointer or focus is on it; a thread waiting stays until answered |
| System     | You are in another window or app       | A system notification (the browser's `Notification`, once allowed); picked, it brings the window forward (`lemmaDesktop.attention.focus()` in the desktop app) and opens the thread                    |
| Badge      | Always                                 | A count of what needs you on the app's icon (`lemmaDesktop.attention.setBadge`, or an installed web app's `navigator.setAppBadge`) and in the page's title, `(2) lemma`                                |
| Sound      | With a notice or a system notification | A short chime, made rather than loaded: rising for waiting, falling for failed, one note for done; at most one every 1.5 s                                                                             |

By default every channel is on for waiting and failed, and all but sound for
done. It adds the Notifications section and its rows to `SettingsSections` and
`SettingsGroups` ([`@lemma/settings`](../../settings/contract/src/index.ts)),
and `notifications.open` (Settings: Notifications) to `Actions`. No config.

## Behavior

- **Quiet where you are.** The thread you are looking at tells nothing. An
  agent's finished or failed turn tells nothing, since its thread goes on with
  what it did; an agent waiting on you does tell. Only what changes while the
  page runs tells.
- **What is over goes.** A notice or system notification goes once its thread
  is answered, seen, or shown to you.
- **Kept in this browser** (`lemma.threads.notifications.prefs`), not in
  config, because each window decides how it tells you, and system
  notifications are this browser's permission.
- **A page you have not touched yet** may not make sound (the browser's
  autoplay rule); the other channels still tell.
