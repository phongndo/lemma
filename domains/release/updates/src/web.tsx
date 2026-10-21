import { For, Show, createSignal } from "solid-js";
import { CliChannels } from "@lemma/cli";
import { Dialog, QuestionIcon, SettingRow, Spinner, Toggle } from "@lemma/look";
import { ReleaseChannels } from "@lemma/release";
import type { ReleaseStatus } from "@lemma/release";
import { SettingsGroups, SettingsSections, configSetting } from "@lemma/settings";
import { Client, HostPlugins, Notify, Slots, defineWebPlugin } from "@lemma/web";

const SECTION = "about";
/** How often the page asks the host what its last check found. */
const REFRESH_MS = 10 * 60_000;
/** How long the page waits for the host to come back on the new release before saying so. */
const BACK_MS = 3 * 60_000;

/** Where a commit is, on the repository releases come from. */
const commitUrl = (commit: string) => `https://github.com/phongndo/lemma/commit/${commit}`;

const when = (iso: string | undefined) => (iso === undefined ? undefined : new Date(iso).toLocaleString());

/** Where updating is: asked, under way on the host, or waiting for the host to come back on the new release. */
type Updating =
  | { readonly step: "confirm"; readonly cutOff: readonly string[] }
  | { readonly step: "installing" }
  | { readonly step: "restarting"; readonly version: string };

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

    /** Resolves once the connection is back after dropping, or false after `BACK_MS`. */
    const back = () =>
      new Promise<boolean>((resolve) => {
        const generation = client.status().generation;
        const timeout = setTimeout(() => finish(false), BACK_MS);
        const stop = client.onConnect(() => {
          if (client.status().generation > generation) finish(true);
        });
        function finish(ok: boolean) {
          clearTimeout(timeout);
          stop();
          resolve(ok);
        }
      });

    const update = async () => {
      setUpdating({ step: "installing" });
      try {
        const restarted = back();
        const result = await client.channel.call(ReleaseChannels.update, {});
        if (!result.restarting) {
          setUpdating(undefined);
          notify.toast({ level: "info", message: `Lemma ${result.version} is installed already` });
          return void load();
        }
        setUpdating({ step: "restarting", version: result.version });
        // The page the new host serves is the new release's: load it once the host is back.
        if (await restarted) window.location.reload();
        else {
          setUpdating(undefined);
          notify.toast({ level: "error", message: `The host did not come back on Lemma ${result.version}: lemma logs says why` });
        }
      } catch (error) {
        setUpdating(undefined);
        notify.report(error, "Could not update Lemma");
      }
    };

    /** While updating: what it cuts off, asked first; then what it is doing, until the page reloads on the new release. */
    const UpdateDialog = (props: { readonly step: Updating }) => (
      <Dialog
        title={`${status()?.older ? "Go back to" : "Update to"} Lemma ${status()?.newest ?? ""}`}
        closeOnBackdrop={false}
        onClose={props.step.step === "confirm" ? () => setUpdating(undefined) : undefined}
        footer={
          <Show when={props.step.step === "confirm"}>
            <button type="button" class="button" onClick={() => setUpdating(undefined)}>
              Cancel
            </button>
            <button type="button" class="button button-primary" data-autofocus onClick={plugin.action("update Lemma", update)}>
              Update and restart
            </button>
          </Show>
        }
      >
        <Show
          when={props.step.step === "confirm" ? props.step : undefined}
          fallback={
            <p>
              <Spinner /> {props.step.step === "restarting" ? `Restarting the host on Lemma ${props.step.version}…` : "Installing…"}
            </p>
          }
        >
          {(asked) => (
            <>
              <p>The host installs the release, then restarts on it, and this page reloads once it is back.</p>
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

    slots.add(SettingsSections, {
      id: SECTION,
      order: 95,
      title: "About",
      icon: QuestionIcon,
      badge: () => (status()?.newer || status()?.older ? "Update" : undefined),
    });

    const row = (text: string, title: string, value: () => string | undefined, description?: () => string | undefined) => ({
      text,
      view: () => (
        <SettingRow title={title} description={description?.()}>
          <span class="muted">{value()}</span>
        </SettingRow>
      ),
    });

    slots.add(SettingsGroups, {
      id: "release.about",
      section: SECTION,
      title: "Lemma",
      entries: () => {
        const now = status();
        if (now === undefined) return [];
        const { build } = now;
        return [
          {
            text: "Lemma version release update newest channel",
            view: () => (
              <SettingRow
                title={`Lemma ${build.version}`}
                description={
                  build.kind === "checkout"
                    ? "A checkout, as developers run Lemma: it updates with git."
                    : !now.updatable
                      ? "Not installed by the installer, so it cannot replace it."
                      : now.newer
                        ? `Lemma ${now.newest} is out on ${build.channel ?? "its channel"}.`
                        : now.older
                          ? `The ${build.channel ?? "stable"} release went back to ${now.newest}.`
                          : now.newest === undefined
                            ? `On the ${build.channel ?? "stable"} channel.`
                            : `The newest on ${build.channel ?? "its channel"}.`
                }
              >
                <Show when={now.updatable}>
                  <Show
                    when={now.newer || now.older}
                    fallback={
                      <button type="button" class="button small" disabled={checking()} onClick={plugin.action("check for updates", checkNow)}>
                        {checking() ? "Checking…" : "Check now"}
                      </button>
                    }
                  >
                    <button type="button" class="button small button-primary" onClick={plugin.action("ask what updating cuts off", ask)}>
                      {now.newer ? "Update to" : "Go back to"} {now.newest}
                    </button>
                  </Show>
                </Show>
                <Show when={updating()}>{(step) => <UpdateDialog step={step()} />}</Show>
              </SettingRow>
            ),
          },
          {
            text: "commit built",
            view: () => (
              <SettingRow title="Built" description={when(build.built) ?? (build.kind === "checkout" ? "From this checkout" : undefined)}>
                <Show when={build.commit} fallback={<span class="muted">Unknown</span>}>
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
            "installed where path root link",
            build.kind === "checkout" ? "Checkout" : "Installed",
            () => build.root,
            () => build.link && `As ${build.link}`,
          ),
          row("node.js runtime", "Node.js", () => build.node),
        ];
      },
    });

    slots.add(SettingsGroups, {
      id: "release.updates",
      section: SECTION,
      title: "Updates",
      entries: () => {
        const now = status();
        if (now === undefined || !now.updatable) return [];
        return [
          {
            text: "Check for updates automatically newer release notice",
            view: () => (
              <SettingRow
                title="Check for updates"
                description={`Ask every few hours whether a newer release is out on the ${now.build.channel ?? "stable"} channel.${now.error === undefined ? "" : ` The last check failed: ${now.error}`}`}
              >
                <Toggle label="Check for updates" checked={checks.value() ?? true} onChange={(on) => checks.set(on)} />
              </SettingRow>
            ),
          },
          row(
            "channel stable nightly switch",
            "Channel",
            () => now.build.channel ?? "stable",
            () => `lemma update --channel ${now.build.channel === "nightly" ? "stable" : "nightly"} switches to the other.`,
          ),
        ];
      },
    });
  },
});
