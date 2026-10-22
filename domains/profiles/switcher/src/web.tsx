import { For, Show, createMemo, createSignal, onMount, untrack } from "solid-js";
import { MAX_TITLE_LENGTH, ProfileChannels, profileNameFor, profilePage, profileTitle, titleProblem } from "@lemma/profiles";
import type { AvatarChange, ProfileAvatar, ProfileInfo } from "@lemma/profiles";
import { Dialogs, Layers } from "@lemma/frame";
import { SettingsGroups, SettingsMenu, SettingsRoute, SettingsSections } from "@lemma/settings";
import { Dialog, filled, identicon, LaptopIcon, MenuItem, PlusIcon, Popover } from "@lemma/look";
import { copyAndTell } from "@lemma/web/clipboard";
import { Client, Notify, Router, Slots, defineWebPlugin } from "@lemma/web";
import styles from "./web.css?inline";

const SECTION = "profiles";
const NEW_DIALOG = "profiles.new";
const DELETE_DIALOG = "profiles.delete";

/**
 * The desktop app's bridge (`window.lemmaDesktop`, `apps/desktop/src/preload.cjs`), in its window: a profile opens in a
 * window of its own, and one deleted takes its windows and what its pages kept with it.
 */
const desktop = (
  window as Window & {
    lemmaDesktop?: { readonly openProfile?: (name: string) => Promise<void>; readonly profileRemoved?: (name: string) => Promise<void> };
  }
).lemmaDesktop;

/** How big a picture a profile keeps: a square this many pixels a side, which every place it shows draws smaller. */
const PICTURE_SIZE = 128;

/** What a profile is called when it was given no name: Core for the default, else its name in words. */
const ownTitle = (profile: ProfileInfo) => profileTitle({ name: profile.name, default: profile.default });

/** A seed no profile is likely to have had: for a pattern of its own. */
const randomSeed = (): string => Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Rows and columns of a pattern. */
const CELLS = [0, 1, 2, 3, 4];

/**
 * A pattern: the seed's identicon (`identicon` in `@lemma/look`), as GitHub draws an account with no picture, its cells
 * in the seed's hue (`--profile-hue`), inset so a circle holds it whole. Drawn apart from the `avatar` part's tile, which
 * a circle would cut; its cells follow its seed (`<Show>`), as `<For>`'s rows are drawn once.
 */
function PatternImage(props: { seed: string }) {
  const picture = createMemo(() => identicon(props.seed));
  return (
    <svg
      class="profiles-pattern"
      viewBox="-1.25 -1.25 7.5 7.5"
      style={{ "--profile-hue": String(picture().hue) }}
      shape-rendering="crispEdges"
      aria-hidden="true"
    >
      <For each={CELLS}>
        {(row) => (
          <For each={CELLS}>
            {(column) => (
              <Show when={filled(picture(), row, column)}>
                <rect x={column} y={row} width="1" height="1" fill="currentColor" />
              </Show>
            )}
          </For>
        )}
      </For>
    </svg>
  );
}

/** A profile's avatar, as a browser shows one: its own picture, else its pattern, in a circle. */
function Avatar(props: { avatar: ProfileAvatar; large?: boolean }) {
  return (
    <span class="profiles-avatar" classList={{ "profiles-avatar-large": props.large === true }} aria-hidden="true">
      <Show
        when={props.avatar.kind === "picture" ? props.avatar.url : undefined}
        fallback={<PatternImage seed={props.avatar.kind === "pattern" ? props.avatar.seed : ""} />}
      >
        {(url) => <img src={url()} alt="" draggable={false} />}
      </Show>
    </span>
  );
}

/** A picture file as a profile keeps it: its middle square, `PICTURE_SIZE` a side, as a WebP (else PNG) `data:` URL. */
const shrink = async (file: File): Promise<string> => {
  const image = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = PICTURE_SIZE;
    canvas.height = PICTURE_SIZE;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("This browser cannot draw the picture");
    const side = Math.min(image.width, image.height);
    context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, PICTURE_SIZE, PICTURE_SIZE);
    const webp = canvas.toDataURL("image/webp", 0.9);
    return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
  } finally {
    image.close();
  }
};

/** What a call's failure says, for a dialog to show. */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Switches between the profiles on the host's machine, each a separate Lemma, and manages them. With one profile there
 * is nothing to switch, and the settings button stays a gear. With more, the settings button shows the one this page
 * is as its avatar, as a browser shows its profile, and its menu (`SettingsMenu`) opens another above Settings: in a
 * window of its own in the desktop app, else a tab at that profile's address, its host started when none runs.
 * Settings › Profiles lists them, a row each: its picture, its name, opening it, and its menu (renaming it, stopping
 * its host, copying how to reach it, deleting it); and makes another. A profile's avatar is a pattern its name makes
 * (`PatternImage`), until another pattern or a picture of its own is chosen.
 */
export default defineWebPlugin({
  id: "profiles.switcher",
  styles,
  requires: { client: Client, slots: Slots, router: Router, notify: Notify, dialogs: Dialogs },
  setup: ({ client, slots, router, notify, dialogs }, plugin) => {
    const [profiles, setProfiles] = createSignal<readonly ProfileInfo[]>([]);
    /** Lists them again: when the page connects, the menu opens, the section shows, and after one was changed. */
    const refresh = plugin.action("list profiles", async () => {
      // A host without the list (the plugin off there) has no other profile to show.
      setProfiles(await client.channel.call(ProfileChannels.list, undefined).catch(() => []));
    });
    plugin.onCleanup(client.onConnect(refresh));
    const current = () => profiles().find((profile) => profile.current);
    const named = (name: string) => profiles().find((profile) => profile.name === name);

    /** The profile being opened, and the one whose host is being stopped. */
    const [opening, setOpening] = createSignal<string | undefined>();
    const [stopping, setStopping] = createSignal<string | undefined>();

    /**
     * Opens `name`: in the desktop app, a window of its own; in a browser, a new tab at its address (this tab when the
     * browser refuses a new one), opened as the pick is made so no popup blocker takes it for one.
     */
    const open = plugin.action("open profile", async (name: string) => {
      setOpening(name);
      try {
        if (desktop?.openProfile !== undefined) {
          await desktop.openProfile(name).catch((error: unknown) => notify.report(error, `Could not open the profile "${name}"`));
          return;
        }
        const tab = window.open("", "_blank");
        try {
          const opened = await client.channel.call(ProfileChannels.open, { name });
          const page = profilePage(window.location.href, opened);
          if (tab === null) window.location.assign(page);
          else {
            tab.opener = null;
            tab.location.href = page;
          }
        } catch (error) {
          tab?.close();
          notify.report(error, `Could not open the profile "${name}"`);
        }
      } finally {
        setOpening(undefined);
        refresh();
      }
    });

    /** Gives `profile` the name `title` to be shown by; blank gives it back its own. */
    const rename = plugin.action("rename profile", async (profile: ProfileInfo, title: string) => {
      if (title.trim() === (profile.title ?? "")) return;
      try {
        await client.channel.call(ProfileChannels.rename, { name: profile.name, title });
      } catch (error) {
        notify.report(error, `Could not rename ${profileTitle(profile)}`);
      }
      refresh();
    });

    const stop = plugin.action("stop profile", async (profile: ProfileInfo) => {
      setStopping(profile.name);
      try {
        await client.channel.call(ProfileChannels.stop, { name: profile.name });
      } catch (error) {
        notify.report(error, `Could not stop ${profileTitle(profile)}`);
      } finally {
        setStopping(undefined);
      }
      refresh();
    });

    const copy = plugin.action("copy", (text: string) => copyAndTell(notify, text));

    /** Gives `name` the picture `avatar` says, and lists them again. */
    const changePicture = async (name: string, avatar: AvatarChange) => {
      try {
        await client.channel.call(ProfileChannels.setAvatar, { name, avatar });
      } catch (error) {
        notify.report(error, `Could not change the picture of ${profileTitle(named(name) ?? { name, default: false })}`);
      }
      refresh();
    };
    const pickPicture = plugin.action("change profile picture", changePicture);
    const upload = plugin.action("upload profile picture", async (name: string, file: File) => {
      const url = await shrink(file).catch((error: unknown) => void notify.report(error, "Could not read that picture"));
      if (url !== undefined) await changePicture(name, { kind: "picture", url });
    });

    /**
     * A profile's avatar, which opens its choices: patterns made afresh each time, a picture of one's own, or the pattern
     * its name makes again.
     */
    function PicturePicker(props: { profile: ProfileInfo }) {
      let input!: HTMLInputElement;
      const [seeds, setSeeds] = createSignal<readonly string[]>([]);
      const own = () => props.profile.avatar.kind === "pattern" && props.profile.avatar.seed === props.profile.name;
      return (
        <>
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file !== undefined) upload(props.profile.name, file);
            }}
          />
          <Popover
            label={`${profileTitle(props.profile)}'s picture`}
            tip="Change its picture"
            triggerClass="profiles-picture"
            menuClass="profiles-picture-menu"
            placement="bottom-start"
            onOpen={() => setSeeds(Array.from({ length: 8 }, randomSeed))}
            trigger={<Avatar avatar={props.profile.avatar} large />}
          >
            {(close) => (
              <>
                <div class="profiles-patterns">
                  <For each={seeds()}>
                    {(seed) => (
                      <button
                        class="profiles-pattern-choice"
                        role="menuitem"
                        aria-label="Use this pattern"
                        onClick={() => {
                          close();
                          pickPicture(props.profile.name, { kind: "pattern", seed });
                        }}
                      >
                        <Avatar avatar={{ kind: "pattern", seed }} large />
                      </button>
                    )}
                  </For>
                </div>
                <div class="menu-sep" role="separator" />
                <MenuItem label="Upload a picture…" close={close} run={() => input.click()} />
                <Show when={!own()}>
                  <MenuItem label="Use its name's pattern" close={close} run={() => pickPicture(props.profile.name, { kind: "default" })} />
                </Show>
              </>
            )}
          </Popover>
        </>
      );
    }

    /**
     * Its rows of the settings button's menu: the profile this page is, the others to open, and the way to manage them.
     * They list again as the menu opens.
     */
    function Rows(props: { close: () => void }) {
      onMount(refresh);
      const others = () => profiles().filter((profile) => !profile.current);
      return (
        <>
          <Show when={current()}>
            {(here) => (
              <div class="profiles-current" role="none">
                <Avatar avatar={here().avatar} large />
                <span class="profiles-current-name">{profileTitle(here())}</span>
              </div>
            )}
          </Show>
          <div class="menu-sep" role="separator" />
          <div class="menu-section">Other profiles</div>
          <For each={others()}>
            {(profile) => (
              <button
                class="menu-item profiles-item"
                role="menuitem"
                data-tip={profile.running ? "Running: opens it" : "Not running: starts its host, then opens it"}
                onClick={() => {
                  props.close();
                  open(profile.name);
                }}
              >
                <Avatar avatar={profile.avatar} />
                <span class="menu-label">{profileTitle(profile)}</span>
                <Show when={profile.running}>
                  <span class="profiles-running" aria-label="running" />
                </Show>
              </button>
            )}
          </For>
          <a class="menu-item profiles-manage" role="menuitem" href={router.href(SettingsRoute, { section: SECTION })} onClick={() => props.close()}>
            <span class="menu-label">Manage profiles…</span>
          </a>
        </>
      );
    }

    // The settings button's face and the top of its menu: which Lemma this is, once there is more than one.
    slots.add(SettingsMenu, {
      id: "profiles",
      when: () => profiles().length > 1 && current() !== undefined,
      face: {
        icon: () => <Show when={current()}>{(here) => <Avatar avatar={here().avatar} />}</Show>,
        label: () => {
          const here = current();
          return `Profile: ${here === undefined ? "" : profileTitle(here)}`;
        },
      },
      component: Rows,
    });

    /** Its name, edited in place: Enter or leaving keeps it, Escape does not; blank gives it back its own. */
    function NameField(props: { profile: ProfileInfo; done: () => void }) {
      let input!: HTMLInputElement;
      let finished = false;
      const finish = (keep: boolean) => {
        if (finished) return;
        finished = true;
        if (keep) rename(props.profile, input.value);
        props.done();
      };
      onMount(() => {
        input.focus();
        input.select();
      });
      return (
        <input
          ref={input}
          class="field profiles-name-field"
          aria-label={`Rename ${profileTitle(props.profile)}`}
          value={props.profile.title ?? ""}
          placeholder={ownTitle(props.profile)}
          maxLength={MAX_TITLE_LENGTH}
          onKeyDown={(event) => {
            if (event.key === "Enter") finish(true);
            if (event.key === "Escape") {
              event.stopPropagation();
              finish(false);
            }
          }}
          onBlur={() => finish(true)}
        />
      );
    }

    /** A profile's row: its picture (which changes it), its name and state, opening it, and its menu. */
    function ProfileRow(props: { name: string }) {
      const [editing, setEditing] = createSignal(false);
      return (
        <Show when={named(props.name)}>
          {(profile) => {
            const command = () => (profile().default ? "lemma" : `lemma --profile ${profile().name}`);
            const state = () => {
              if (stopping() === profile().name) return "Stopping…";
              if (opening() === profile().name && !profile().running) return "Starting…";
              if (profile().current) return "Current";
              return profile().running ? "Running" : "Stopped";
            };
            return (
              <div class="setting-row profiles-row">
                <span class="setting-lead">
                  <PicturePicker profile={profile()} />
                </span>
                <span class="setting-text">
                  <Show when={editing()} fallback={<span class="setting-title profiles-name">{profileTitle(profile())}</span>}>
                    <NameField profile={profile()} done={() => setEditing(false)} />
                  </Show>
                  <span class="setting-desc">{state()}</span>
                </span>
                <span class="setting-control">
                  <Show when={!profile().current}>
                    <button class="button small" disabled={opening() === profile().name} onClick={() => open(profile().name)}>
                      Open
                    </button>
                  </Show>
                  <Popover label={`${profileTitle(profile())} options`} tip="Options" triggerClass="button small" placement="bottom-end" trigger="Manage">
                    {(close) => (
                      <>
                        <MenuItem label="Rename" close={close} run={() => setEditing(true)} />
                        <Show when={profile().running && !profile().current && stopping() !== profile().name}>
                          <MenuItem label="Stop" close={close} run={() => stop(profile())} />
                        </Show>
                        <div class="menu-sep" role="separator" />
                        <MenuItem label="Copy command" close={close} run={() => copy(command())} />
                        <Show when={profile().home}>{(home) => <MenuItem label="Copy folder path" close={close} run={() => copy(home())} />}</Show>
                        <Show when={!profile().default && !profile().current}>
                          <div class="menu-sep" role="separator" />
                          <MenuItem
                            label="Delete…"
                            danger
                            close={close}
                            run={() => {
                              setDeleting(profile().name);
                              dialogs.open(DELETE_DIALOG);
                            }}
                          />
                        </Show>
                      </>
                    )}
                  </Popover>
                </span>
              </div>
            );
          }}
        </Show>
      );
    }

    slots.add(SettingsSections, {
      id: SECTION,
      order: 90,
      title: "Profiles",
      icon: LaptopIcon,
      description: "Separate Lemmas on this machine, each with its own plugins, look, threads, and logins.",
      actions: () => (
        <button class="button small" onClick={() => dialogs.open(NEW_DIALOG)}>
          <PlusIcon /> New profile
        </button>
      ),
    });

    /** Which profiles there are, by what they are called: their rows are made again only when it changes, so a name being typed stays. */
    const listed = createMemo(() =>
      profiles()
        .map((profile) => `${profile.name}\n${profileTitle(profile)}`)
        .join("\n\n"),
    );
    slots.add(SettingsGroups, {
      id: "profiles.list",
      section: SECTION,
      entries: () => {
        listed();
        return untrack(() =>
          profiles().map((profile) => ({
            text: `profile ${profile.name} ${profileTitle(profile)} open rename stop delete picture avatar command folder`,
            view: () => <ProfileRow name={profile.name} />,
          })),
        );
      },
    });

    /** Makes a profile from the name it is to be shown by, its command-line name made from that. */
    function NewDialog(props: { close: () => void }) {
      const [title, setTitle] = createSignal("");
      const [problem, setProblem] = createSignal<string | undefined>();
      const [busy, setBusy] = createSignal(false);
      const name = () =>
        profileNameFor(
          title(),
          profiles().map((profile) => profile.name),
        );
      const wrong = () => titleProblem(title(), { default: false });
      const make = plugin.action("create profile", async () => {
        const wanted = title().trim();
        if (wanted === "" || wrong() !== undefined || busy()) return;
        setBusy(true);
        setProblem(undefined);
        try {
          // Its new row says it was made.
          await client.channel.call(ProfileChannels.create, { name: name(), title: wanted });
          props.close();
        } catch (error) {
          setProblem(messageOf(error));
        } finally {
          setBusy(false);
        }
        refresh();
      });
      return (
        <Dialog
          title="New profile"
          onClose={props.close}
          class="profiles-dialog"
          footer={
            <>
              <button class="button" onClick={props.close}>
                Cancel
              </button>
              <button class="button button-primary" type="submit" form="profiles-new-form" disabled={title().trim() === "" || wrong() !== undefined || busy()}>
                {busy() ? "Making…" : "Make profile"}
              </button>
            </>
          }
        >
          <form
            id="profiles-new-form"
            class="profiles-form"
            onSubmit={(event) => {
              event.preventDefault();
              make();
            }}
          >
            <input
              class="field"
              aria-label="Name"
              placeholder="Name"
              maxLength={MAX_TITLE_LENGTH}
              value={title()}
              data-autofocus
              onInput={(event) => setTitle(event.currentTarget.value)}
            />
          </form>
          <Show
            when={problem() ?? wrong()}
            fallback={<p class="profiles-dialog-text muted">A separate Lemma with its own plugins, look, threads, and logins.</p>}
          >
            {(text) => <p class="profiles-dialog-text profiles-problem">{text()}</p>}
          </Show>
        </Dialog>
      );
    }

    /** The profile the delete dialog asks about. */
    const [deleting, setDeleting] = createSignal<string | undefined>();

    /** Asks before deleting a profile, saying what goes with it, and stops its host first. */
    function DeleteDialog(props: { profile: ProfileInfo; close: () => void }) {
      const [busy, setBusy] = createSignal(false);
      const [problem, setProblem] = createSignal<string | undefined>();
      const remove = plugin.action("delete profile", async () => {
        const { name } = props.profile;
        const title = profileTitle(props.profile);
        setBusy(true);
        setProblem(undefined);
        try {
          await client.channel.call(ProfileChannels.remove, { name });
        } catch (error) {
          setBusy(false);
          return setProblem(messageOf(error));
        }
        // The desktop app closes its windows, and forgets what their pages kept.
        await desktop?.profileRemoved?.(name).catch(() => undefined);
        notify.toast({ level: "info", message: `Deleted ${title}` });
        props.close();
        refresh();
      });
      return (
        <Dialog
          title={`Delete ${profileTitle(props.profile)}?`}
          onClose={() => !busy() && props.close()}
          closeOnBackdrop={!busy()}
          class="profiles-dialog"
          footer={
            <>
              <button class="button" data-autofocus disabled={busy()} onClick={props.close}>
                Cancel
              </button>
              <button class="button button-danger" disabled={busy()} onClick={() => remove()}>
                {busy() ? "Deleting…" : "Delete profile"}
              </button>
            </>
          }
        >
          <p class="profiles-dialog-text">
            Its threads, config, plugins, and logins go with it, for good{props.profile.running ? ", and its host is stopped first" : ""}.
          </p>
          <Show when={props.profile.home}>
            {(home) => (
              <p class="profiles-dialog-text muted">
                <code>{home()}</code>
              </p>
            )}
          </Show>
          <Show when={problem()}>{(text) => <p class="profiles-dialog-text profiles-problem">{text()}</p>}</Show>
        </Dialog>
      );
    }

    slots.add(Layers, {
      id: NEW_DIALOG,
      order: 36,
      component: () => (
        <Show when={dialogs.current() === NEW_DIALOG}>
          <NewDialog close={() => dialogs.open(undefined)} />
        </Show>
      ),
    });
    slots.add(Layers, {
      id: DELETE_DIALOG,
      order: 36,
      component: () => (
        <Show when={dialogs.current() === DELETE_DIALOG ? deleting() : undefined} keyed>
          {(name) => (
            <Show when={named(name)}>
              {(profile) => (
                <DeleteDialog
                  profile={profile()}
                  close={() => {
                    dialogs.open(undefined);
                    setDeleting(undefined);
                  }}
                />
              )}
            </Show>
          )}
        </Show>
      ),
    });
  },
});
