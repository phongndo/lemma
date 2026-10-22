import { For, Show, createMemo, createSignal } from "solid-js";
import { CliChannels } from "@lemma/cli";
import { Layers } from "@lemma/frame";
import { Dialog, QuestionIcon, SettingRow, Spinner, Toggle } from "@lemma/look";
import { INSTALLER_TITLES, ReleaseChannels } from "@lemma/release";
import type { Channel, ReleaseStatus } from "@lemma/release";
import { SettingsGroups, SettingsSections, configSetting } from "@lemma/settings";
import type { SettingsEntry } from "@lemma/settings";
import { Client, HostPlugins, Notify, Slots, defineWebPlugin } from "@lemma/web";

const SECTION = "about";
/** How often the page asks the host what its last check found. */
const REFRESH_MS = 10 * 60_000;
/** How long the page waits for the host to come back on the new release before saying so, and how often it looks. */
const BACK_MS = 3 * 60_000;
const LOOK_MS = 1_000;

type Restart = { readonly outcome: "back" } | { readonly outcome: "failed"; readonly why: string } | { readonly outcome: "late" };

/** Where a commit is, on the repository releases come from. */
const commitUrl = (commit: string) => `https://github.com/phongndo/lemma/commit/${commit}`;

const when = (iso: string | undefined) => (iso === undefined ? undefined : new Date(iso).toLocaleString());

/** What following each channel brings, or none. */
const CHANNEL_MEANS: Record<Channel | "none", string> = {
  stable: "Releases that held up as nightlies, then were promoted.",
  nightly: "Each night's build of main.",
  none: "Installed by version, it stays on that version.",
};

/**
 * Where updating is: asked, under way on the host, waiting for the host to come back on the new release, or, the
 * desktop app replaced (Homebrew's cask), waiting for it to be reopened.
 */
type Updating =
  | { readonly step: "confirm"; readonly cutOff: readonly string[] }
  | { readonly step: "installing" }
  | { readonly step: "restarting"; readonly version: string }
  | { readonly step: "reopen"; readonly version: string };

/** The desktop app's bridge (`apps/desktop/src/preload.cjs`), in its window: `relaunch` quits the app and opens it again. */
const desktop = (window as Window & { lemmaDesktop?: { readonly relaunch?: () => Promise<void> } }).lemmaDesktop;

/**
 * The web half of `release.updates`: Settings › About, what this Lemma is and whether a newer release is out, with a
 * badge when one is, its Update button, and its check's switch.
 */
export default defineWebPlugin({
  id: "release.updates",
  requires: { slots: Slots, client: Client, notify: Notify, host: HostPlugins },
  setup: ({ slots, client, notify, host }, plugin) => {
    const [status, setStatus] = createSignal<ReleaseStatus>();
    const [updating, setUpdating] = createSignal<Updating>();
    const [checking, setChecking] = createSignal(false);
    const checks = configSetting<boolean>(host, notify, plugin.id, "check");

    const load = () =>
      client.channel.call(ReleaseChannels.status, undefined).then(setStatus, () => {
        // A host without the host half: the section says nothing it cannot know.
      });
    plugin.onCleanup(client.onConnect(plugin.action("load the release's status", load)));
    plugin.every(REFRESH_MS, load);

    /** Asks now whether a newer release is out; a failure it reports. */
    const checkNow = async () => {
      setChecking(true);
      try {
        setStatus(await client.channel.call(ReleaseChannels.check, undefined));
      } catch (error) {
        notify.report(error, "Could not check for updates");
      } finally {
        setChecking(false);
      }
    };

    /** What restarting the host would cut off, as `lemma stop` asks; nothing said when it cannot say. */
    const ask = async () => {
      const work = await client.channel.call(CliChannels.inProgress, {}).catch(() => []);
      setUpdating({ step: "confirm", cutOff: work.flatMap((report) => report.items) });
    };

    /**
     * Where the restart onto `version` is. `back`: the page is connected to a host running it, or its connection
     * dropped and the page's own address answers again, over plain HTTP, so a new host on another RPC protocol, which
     * this page's client cannot talk to, counts too. `failed`: the old host, still answering, says its restart failed,
     * and why. `late`: neither, after `BACK_MS`.
     */
    const restarted = (version: string) =>
      new Promise<Restart>((resolve) => {
        const deadline = Date.now() + BACK_MS;
        let dropped = false;
        const look = async (): Promise<void> => {
          if (Date.now() > deadline) return resolve({ outcome: "late" });
          if (!dropped && client.connected()) {
            const now = await client.channel.call(ReleaseChannels.status, undefined).catch(() => undefined);
            if (now?.build.version === version) return resolve({ outcome: "back" });
            if (now?.restartError !== undefined) return resolve({ outcome: "failed", why: now.restartError });
          } else {
            dropped = true;
            const up = await fetch(`${window.location.origin}/`, { cache: "no-store" }).then(
              (response) => response.ok,
              () => false,
            );
            if (up) return resolve({ outcome: "back" });
          }
          plugin.after(LOOK_MS, look);
        };
        plugin.after(LOOK_MS, look);
      });

    const update = async () => {
      setUpdating({ step: "installing" });
      try {
        const result = await client.channel.call(ReleaseChannels.update, {});
        if (result.reopen === true) return void setUpdating({ step: "reopen", version: result.version });
        if (!result.restarting) {
          setUpdating(undefined);
          notify.toast({ level: "info", message: `Lemma ${result.version} is installed already` });
          return void load();
        }
        setUpdating({ step: "restarting", version: result.version });
        // The page the new host serves is the new release's: load it once the host is back.
        const restart = await restarted(result.version);
        if (restart.outcome === "back") return window.location.reload();
        setUpdating(undefined);
        void load();
        const log = `${client.info()?.home ?? "~/.lemma"}/logs/restart.log`;
        notify.toast({
          level: "error",
          message:
            restart.outcome === "failed"
              ? `Lemma ${result.version} is installed, but the host did not restart on it: ${restart.why}`
              : `The host did not come back on Lemma ${result.version}: ${log} and lemma logs say why`,
        });
      } catch (error) {
        setUpdating(undefined);
        notify.report(error, "Could not update Lemma");
      }
    };

    /** Whether updating replaces the desktop app this page is in (Homebrew's cask), which runs the release once reopened. */
    const replacesApp = () => status()?.build.installer === "homebrew-cask" && desktop !== undefined;
    /** How the host installs the release: with the package manager that installed this one, or the installer. */
    const installing = () => {
      const installer = status()?.build.installer;
      return installer === undefined || installer === "script" ? "" : ` with ${INSTALLER_TITLES[installer]}`;
    };

    /**
     * While updating: what it cuts off, asked first; then what it is doing, until the page reloads on the new release,
     * or the desktop app, replaced, is reopened.
     */
    const UpdateDialog = (props: { readonly step: Updating }) => (
      <Dialog
        title={props.step.step === "reopen" ? `Lemma ${props.step.version} is installed` : `Update to Lemma ${status()?.newest ?? ""}`}
        closeOnBackdrop={false}
        onClose={props.step.step === "confirm" || props.step.step === "reopen" ? () => setUpdating(undefined) : undefined}
        footer={
          <>
            <Show when={props.step.step === "confirm"}>
              <button type="button" class="button" onClick={() => setUpdating(undefined)}>
                Cancel
              </button>
              <button type="button" class="button button-primary" data-autofocus onClick={plugin.action("update Lemma", update)}>
                {replacesApp() ? "Update" : "Update and restart"}
              </button>
            </Show>
            <Show when={props.step.step === "reopen"}>
              <button type="button" class="button" onClick={() => setUpdating(undefined)}>
                Later
              </button>
              <Show when={desktop?.relaunch}>
                {(relaunch) => (
                  <button type="button" class="button button-primary" data-autofocus onClick={plugin.action("reopen Lemma", () => relaunch()())}>
                    Reopen Lemma
                  </button>
                )}
              </Show>
            </Show>
          </>
        }
      >
        <Show
          when={props.step.step === "confirm" ? props.step : undefined}
          fallback={
            <Show
              when={props.step.step === "reopen"}
              fallback={
                <p>
                  <Spinner /> {props.step.step === "restarting" ? `Restarting the host on Lemma ${props.step.version}…` : `Installing${installing()}…`}
                </p>
              }
            >
              <p>Homebrew replaced the app. It runs the new release once you quit and reopen it: what is running is cut off, and turns resume.</p>
            </Show>
          }
        >
          {(asked) => (
            <>
              <p>
                {replacesApp()
                  ? "Homebrew installs the release, replacing the app, which runs it once you reopen it."
                  : `The host installs the release${installing()}, then restarts on it, and this page reloads once it is back.`}
              </p>
              <Show when={asked().cutOff.length > 0}>
                <p>Restarting cuts off what is running; turns resume once it is back:</p>
                <ul>
                  <For each={asked().cutOff}>{(item) => <li>{item}</li>}</For>
                </ul>
              </Show>
            </>
          )}
        </Show>
      </Dialog>
    );

    // Over whatever shows, so it stays while the host restarts under the page.
    slots.add(Layers, { id: "release.update", order: 40, component: () => <Show when={updating()}>{(step) => <UpdateDialog step={step()} />}</Show> });

    slots.add(SettingsSections, {
      id: SECTION,
      order: 95,
      title: "About",
      icon: QuestionIcon,
      description: "Which Lemma this is, and whether a newer release is out.",
      badge: () => (status()?.newer ? "Update" : undefined),
      badgeTone: "info",
    });

    const row = (text: string, title: () => string, value: () => string | undefined, description?: () => string | undefined): SettingsEntry => ({
      text,
      view: () => (
        <SettingRow title={title()} description={description?.()}>
          <span class="muted">{value()}</span>
        </SettingRow>
      ),
    });

    // The rows made once, reading the status as it changes, so a check for updates (which changes it) leaves them drawn,
    // with focus where it was (`SettingsGroup.entries`). They show while there is a status; one leaving reads the last.
    const known = createMemo<ReleaseStatus | undefined>((last) => status() ?? last);
    const now = () => known()!;
    const build = () => now().build;
    const about: SettingsEntry[] = [
      {
        text: "Lemma version release update newest channel",
        view: () => (
          <SettingRow
            title={`Lemma ${build().version}`}
            description={
              build().kind === "checkout"
                ? "A checkout, as developers run Lemma: it updates with git."
                : build().installer === undefined
                  ? "Installed by neither the installer nor a package manager, so Lemma cannot replace it."
                  : !now().updatable
                    ? `${now().newer ? `Lemma ${now().newest} is out on the ${now().channel} channel. ` : ""}Installed with ${INSTALLER_TITLES[build().installer!]}, it updates as: ${build().update}.`
                    : now().channel === undefined
                      ? "Installed by version: it follows no channel."
                      : now().newer
                        ? `Lemma ${now().newest} is out on the ${now().channel} channel.`
                        : now().newest === undefined
                          ? `On the ${now().channel} channel.`
                          : `No newer release is out on the ${now().channel} channel.`
            }
          >
            <Show when={now().updatable && now().channel !== undefined}>
              <Show
                when={now().newer}
                fallback={
                  <button type="button" class="button small" disabled={checking()} onClick={plugin.action("check for updates", checkNow)}>
                    {checking() ? "Checking for updates…" : "Check for updates"}
                  </button>
                }
              >
                <button type="button" class="button small button-primary" onClick={plugin.action("ask what updating cuts off", ask)}>
                  Update to Lemma {now().newest}
                </button>
              </Show>
            </Show>
          </SettingRow>
        ),
      },
      {
        text: "commit built",
        view: () => (
          <SettingRow title="Built" description={when(build().built) ?? (build().kind === "checkout" ? "From this checkout" : undefined)}>
            <Show when={build().commit} fallback={<span class="muted">Unknown</span>}>
              {(commit) => (
                <a class="button small" href={commitUrl(commit())} target="_blank" rel="noreferrer">
                  {commit().slice(0, 12)}
                </a>
              )}
            </Show>
          </SettingRow>
        ),
      },
      row(
        "installed where path root link homebrew mise npm nix",
        () => (build().kind === "checkout" ? "Checkout" : "Installed"),
        () => build().root,
        () =>
          [build().installer && `With ${INSTALLER_TITLES[build().installer!]}`, build().link && `linked from ${build().link}`].filter(Boolean).join(", ") ||
          undefined,
      ),
      row(
        "node.js runtime",
        () => "Node.js",
        () => build().node,
      ),
    ];
    const checkRow: SettingsEntry = {
      text: "Check for updates automatically newer release notice",
      view: () => (
        <SettingRow
          title="Check automatically"
          description={`Ask every few hours whether a newer release is out on the ${now().channel} channel.${now().error === undefined ? "" : ` The last check failed: ${now().error}`}`}
        >
          <Toggle label="Check for updates automatically" checked={checks.value() ?? true} onChange={(on) => checks.set(on)} />
        </SettingRow>
      ),
    };
    const channelRow = row(
      "channel stable nightly pinned switch",
      () => "Channel",
      () => now().channel ?? "None",
      () =>
        `${CHANNEL_MEANS[now().channel ?? "none"]} ${
          build().installer === "script"
            ? "Updating from a terminal can switch it."
            : `${INSTALLER_TITLES[build().installer!]} installs stable releases; the nightly channel comes from the installer.`
        }`,
    );

    slots.add(SettingsGroups, {
      id: "release.about",
      section: SECTION,
      title: "Lemma",
      entries: () => (status() === undefined ? [] : about),
    });

    slots.add(SettingsGroups, {
      id: "release.updates",
      section: SECTION,
      title: "Updates",
      entries: () => {
        const current = status();
        // A checkout updates with git, and a release nothing installed follows no channel.
        if (current === undefined || current.build.kind === "checkout" || current.build.installer === undefined) return [];
        // Pinned, it follows no channel: there is nothing to check for.
        return current.channel === undefined ? [channelRow] : [checkRow, channelRow];
      },
    });
  },
});
