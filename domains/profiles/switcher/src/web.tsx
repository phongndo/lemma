import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { ProfileChannels, profilePage, profileTitle } from "@lemma/profiles";
import type { AvatarChange, ProfileAvatar, ProfileInfo } from "@lemma/profiles";
import { SidebarFooter } from "@lemma/frame";
import { SettingsGroups, SettingsRoute, SettingsSections } from "@lemma/settings";
import { CheckIcon, LaptopIcon, Popover, SettingRow } from "@lemma/look";
import { Client, Notify, Router, Slots, defineWebPlugin } from "@lemma/web";
import { patternOf, randomSeed } from "./pattern.ts";
import styles from "./web.css?inline";

const SECTION = "profiles";

/** The desktop app's bridge (`window.lemmaDesktop`, `apps/desktop/src/preload.cjs`), in its window: a profile opens in a window of its own. */
const desktop = (window as Window & { lemmaDesktop?: { readonly openProfile?: (name: string) => Promise<void> } }).lemmaDesktop;

/** How big a picture a profile keeps: a square this many pixels a side, which every place it shows draws smaller. */
const PICTURE_SIZE = 128;

/** A pattern, as an SVG of its filled cells in its hue (`--profile-hue-<n>`), inset so a circle holds it whole. */
function PatternImage(props: { seed: string }) {
  const pattern = createMemo(() => patternOf(props.seed));
  const filled = () => pattern().cells.flatMap((on, index) => (on ? [index] : []));
  return (
    <svg class={`profiles-pattern profiles-hue-${pattern().hue}`} viewBox="-1.25 -1.25 7.5 7.5" shape-rendering="crispEdges" aria-hidden="true">
      <For each={filled()}>{(index) => <rect x={index % 5} y={Math.floor(index / 5)} width="1" height="1" fill="currentColor" />}</For>
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

/**
 * Switches between the profiles on the host's machine, each a separate Lemma. With one profile there is nothing to
 * switch, and the sidebar shows nothing: Settings › Profiles says what one is and makes another. With more, the
 * sidebar's foot shows the one this page is as its avatar, as a browser shows its profile, and its menu opens another:
 * in a window of its own in the desktop app, else a tab at that profile's address, its host started when none runs.
 * A profile's avatar is a pattern its name makes (`pattern.ts`), until another pattern or a picture of its own is
 * chosen in Settings › Profiles.
 */
export default defineWebPlugin({
  id: "profiles.switcher",
  styles,
  requires: { client: Client, slots: Slots, router: Router, notify: Notify },
  setup: ({ client, slots, router, notify }, plugin) => {
    const [profiles, setProfiles] = createSignal<readonly ProfileInfo[]>([]);
    /** Lists them again: when the page connects, the menu opens, the section shows, and after one was opened or made. */
    const refresh = plugin.action("list profiles", async () => {
      // A host without the list (the plugin off there) has no other profile to show.
      setProfiles(await client.channel.call(ProfileChannels.list, undefined).catch(() => []));
    });
    plugin.onCleanup(client.onConnect(refresh));
    const current = () => profiles().find((profile) => profile.current);

    /**
     * Opens `name`: in the desktop app, a window of its own; in a browser, a new tab at its address (this tab when the
     * browser refuses a new one), opened as the pick is made so no popup blocker takes it for one.
     */
    const open = plugin.action("open profile", async (name: string) => {
      if (desktop?.openProfile !== undefined) return await desktop.openProfile(name);
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
      refresh();
    });

    /** Gives `name` the picture `avatar` says, and lists them again. */
    const changePicture = async (name: string, avatar: AvatarChange) => {
      try {
        await client.channel.call(ProfileChannels.setAvatar, { name, avatar });
      } catch (error) {
        notify.report(error, `Could not change the picture of ${profileTitle(name)}`);
      }
      refresh();
    };
    const choose = plugin.action("change profile picture", changePicture);
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
            label={`${profileTitle(props.profile.name)}'s picture`}
            tip="Change its picture"
            triggerClass="profiles-picture"
            menuClass="profiles-picture-menu"
            placement="bottom-end"
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
                          choose(props.profile.name, { kind: "pattern", seed });
                        }}
                      >
                        <Avatar avatar={{ kind: "pattern", seed }} large />
                      </button>
                    )}
                  </For>
                </div>
                <div class="menu-sep" role="separator" />
                <button
                  class="menu-item"
                  role="menuitem"
                  onClick={() => {
                    close();
                    input.click();
                  }}
                >
                  <span class="menu-label">Upload a picture…</span>
                </button>
                <Show when={!own()}>
                  <button
                    class="menu-item"
                    role="menuitem"
                    onClick={() => {
                      close();
                      choose(props.profile.name, { kind: "default" });
                    }}
                  >
                    <span class="menu-label">Use its name's pattern</span>
                  </button>
                </Show>
              </>
            )}
          </Popover>
        </>
      );
    }

    function Switcher() {
      return (
        <Show when={profiles().length > 1 && current()}>
          {(here) => (
            <Popover
              label={`Profile: ${profileTitle(here().name)}`}
              tip={`Profile: ${profileTitle(here().name)}. Switch to another, a separate Lemma`}
              triggerClass="icon-button profiles-trigger"
              menuClass="profiles-menu"
              placement="top-start"
              onOpen={refresh}
              trigger={<Avatar avatar={here().avatar} />}
            >
              {(close) => (
                <>
                  <For each={profiles()}>
                    {(profile) => (
                      <button
                        class="menu-item profiles-item"
                        role="menuitemradio"
                        aria-checked={profile.current}
                        data-tip={profile.current ? "This one" : profile.running ? "Running: opens it" : "Not running: starts its host, then opens it"}
                        onClick={() => {
                          close();
                          if (!profile.current) open(profile.name);
                        }}
                      >
                        <Avatar avatar={profile.avatar} />
                        <span class="menu-label">{profileTitle(profile.name)}</span>
                        <Show when={profile.running && !profile.current}>
                          <span class="profiles-running" aria-label="running" />
                        </Show>
                        <span class="menu-check">
                          <Show when={profile.current}>
                            <CheckIcon />
                          </Show>
                        </span>
                      </button>
                    )}
                  </For>
                  <div class="menu-sep" role="separator" />
                  <a class="menu-item" role="menuitem" href={router.href(SettingsRoute, { section: SECTION })} onClick={() => close()}>
                    <span class="menu-label">Manage profiles…</span>
                  </a>
                </>
              )}
            </Popover>
          )}
        </Show>
      );
    }

    // Before the settings button: which Lemma this is, once there is more than one.
    slots.add(SidebarFooter, { id: "profiles", order: -10, component: () => <Switcher /> });

    slots.add(SettingsSections, {
      id: SECTION,
      order: 90,
      title: "Profiles",
      icon: LaptopIcon,
      intro: () => {
        onMount(refresh);
        return (
          <p class="muted profiles-intro">
            A profile is a separate Lemma on this machine: its own plugins, look, threads, and logins, in a window or tab of its own. Nothing is shared between
            profiles; each runs its own host.
          </p>
        );
      },
    });

    slots.add(SettingsGroups, {
      id: "profiles.list",
      section: SECTION,
      title: "On this machine",
      entries: () =>
        profiles().map((profile) => ({
          text: `profile ${profile.name} switch open window picture avatar pattern photo`,
          view: () => (
            <SettingRow
              title={profileTitle(profile.name)}
              description={[
                profile.current ? "This one" : profile.running ? "Running" : "Not running",
                ...(profile.port === undefined ? [] : [`port ${profile.port}`]),
                ...(profile.default ? ["the home's own"] : []),
              ].join(" · ")}
            >
              <div class="profiles-row">
                <PicturePicker profile={profile} />
                <Show when={!profile.current}>
                  <button class="button small" onClick={() => open(profile.name)}>
                    Open
                  </button>
                </Show>
              </div>
            </SettingRow>
          ),
        })),
    });

    const [name, setName] = createSignal("");
    const [problem, setProblem] = createSignal<string | undefined>();
    const create = plugin.action("create profile", async () => {
      const wanted = name().trim();
      if (wanted === "") return;
      try {
        const made = await client.channel.call(ProfileChannels.create, { name: wanted });
        setName("");
        setProblem(undefined);
        notify.toast({ level: "info", message: `Made the profile ${profileTitle(made.name)}: open it to set it up` });
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error));
      }
      refresh();
    });
    slots.add(SettingsGroups, {
      id: "profiles.new",
      section: SECTION,
      title: "New profile",
      entries: () => [
        {
          text: "new profile create add another lemma separate",
          view: () => (
            <SettingRow
              title="Name"
              description={
                problem() ??
                "Lowercase letters, digits, - and _. It starts empty, as Lemma does when first installed, with a port of its own; opening it starts its host."
              }
            >
              <form
                class="profiles-new"
                onSubmit={(event) => {
                  event.preventDefault();
                  create();
                }}
              >
                <input
                  class="field"
                  aria-label="New profile's name"
                  placeholder="research"
                  value={name()}
                  onInput={(event) => setName(event.currentTarget.value)}
                />
                <button class="button small" type="submit" disabled={name().trim() === ""}>
                  Make it
                </button>
              </form>
            </SettingRow>
          ),
        },
      ],
    });
  },
});
