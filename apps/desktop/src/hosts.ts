import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import { Effect } from "effect";
import { appUrl, errorMessage } from "@lemma/contracts";
import { readDiscovery } from "@lemma/contracts/discovery";
import type { Discovery, Target } from "@lemma/contracts/discovery";
import { DEFAULT_PROFILE, isDefaultProfile, profileHome, profileNameProblem, profileOf } from "@lemma/contracts/profiles";
import { callChannel, makeHostRpcHttp } from "@lemma/client";
import { CliChannels } from "@lemma/cli";
import { HOST_FLAGS } from "@lemma/host/launch";
import { STOP_WAIT_MS } from "@lemma/host/limits";
import { buildKind, hostFiles, KINDS, otherHomeProblem, resolvePaths } from "@lemma/host/paths";
import { isLoopback, ProfileChannels, profileAddress } from "@lemma/profiles";

/*
 * Each profile's host as the app holds it: found, started, stopped, or opened through the host on another machine; and
 * what the rest of the app reads of where it runs.
 */

const hostMain = fileURLToPath(import.meta.resolve("@lemma/host"));
// `pnpm start` runs from apps/desktop; INIT_CWD is where the user invoked it, and the host takes it as the project.
const project = process.env.INIT_CWD ?? homedir();
export const profileProblem = profileOf(process.env) === undefined ? undefined : profileNameProblem(profileOf(process.env)!);
export const paths = resolvePaths({ env: profileProblem === undefined ? process.env : { ...process.env, LEMMA_PROFILE: undefined }, cwd: project });
/** Never on the other kind's home (`otherHomeProblem`), neither attaching to a host there nor starting one. */
export const otherHome = otherHomeProblem(paths.root, process.env);
/** Development: the page comes from the web app's dev server (`pnpm dev`), which proxies to the first profile's host, so edits hot-reload. */
export const webUrl = process.env.LEMMA_WEB_URL;
const STARTUP_TIMEOUT_MS = 30_000;
/** What it is shown by, and the scheme of the links it opens: its kind's (`KINDS`). */
export const kind = KINDS[buildKind];

/** What the app says of its own running (a host it started that exited, a start that failed): `<root>/logs/desktop.log`. */
export const logLine = (text: string) => {
  try {
    mkdirSync(hostFiles(paths.root).logs, { recursive: true, mode: 0o700 });
    appendFileSync(join(hostFiles(paths.root).logs, "desktop.log"), `${new Date().toISOString()} ${text}\n`, { mode: 0o600 });
  } catch {
    // No log: the app runs on.
  }
};

/** Why a fetch failed: `fetch failed` says nothing, and its cause says why (refused, not found, timed out). */
export const failure = (error: unknown): string => errorMessage(error instanceof Error && error.cause instanceof Error ? error.cause : error);

/** What the app's parts decide as it runs, and read of each other. */
export const state: {
  /** The profile the app started with: its windows open first, and a link naming none is for it. Known once the host is. */
  first: string;
  /** The host on another machine the app shows, when it shows one: its machine's profiles are opened through it. */
  remote: Target | undefined;
  /** Set once the app starts quitting: nothing starts a host after that. */
  quitting: boolean;
  /** A page asked the app to open again once it quits (`lemma:relaunch`). */
  relaunching: boolean;
} = { first: paths.profile ?? DEFAULT_PROFILE, remote: undefined, quitting: false, relaunching: false };

/** The profiles whose host a page is restarting (`lemma:reload`): its exit then is no news. */
export const reloading = new Set<string>();

/** A profile's host as the app holds it. */
interface ProfileHost {
  /** A host this app started, while it runs: the app stops it when it quits. */
  child?: UtilityProcess;
  /** The host serving the profile's windows, once known. */
  served?: { readonly url: string; readonly token: string };
}
export const hosts = new Map<string, ProfileHost>();
const hostOf = (name: string): ProfileHost => {
  let held = hosts.get(name);
  if (held === undefined) hosts.set(name, (held = {}));
  return held;
};
/** Records the host now serving the profile `name`, by its address and token. */
export const serve = (name: string, host: { readonly url: string; readonly token: string }) => (hostOf(name).served = { url: host.url, token: host.token });
/** The web app at `path` of the profile's host; the first profile's comes from the dev server while developing. */
export const pageAt = (name: string, path = "/") => {
  const served = hosts.get(name)?.served;
  return served === undefined ? undefined : appUrl(name === state.first ? (webUrl ?? served.url) : served.url, path, served.token);
};
export const owns = (name: string) => hosts.get(name)?.child !== undefined;

/** A profile's name as this app keeps it: the default's under one name, whichever of its names (`core`) it was given. */
export const canonicalProfile = (name: string) => (isDefaultProfile(name) ? DEFAULT_PROFILE : name);

/** Starts a host for the profile `name` on this machine, and resolves with it once it listens. */
export const startHost = async (name: string): Promise<Discovery> => {
  const home = profileHome(paths.root, name);
  const env: Record<string, string | undefined> = { ...process.env, LEMMA_HOME: paths.root, INIT_CWD: project, LEMMA_STARTED_BY: "desktop" };
  if (name === DEFAULT_PROFILE) delete env.LEMMA_PROFILE;
  else env.LEMMA_PROFILE = name;
  const child = utilityProcess.fork(hostMain, ["--no-open"], {
    cwd: project,
    // It says the app started it, so `lemma status` names its owner and `lemma stop` leaves it to the app.
    env: env as NodeJS.ProcessEnv,
    // The host's Node.js flags, which are V8's: Electron's utility process takes them as Chromium's `--js-flags` alone.
    execArgv: ["--conditions=lemma-source", `--js-flags=${HOST_FLAGS.join(" ")}`],
    stdio: "inherit",
    serviceName: `${kind.name.toLowerCase()} host${name === DEFAULT_PROFILE ? "" : ` (${name})`}`,
  });
  const held = hostOf(name);
  held.child = child;
  let exited: number | undefined;
  child.once("exit", (code) => {
    exited = code;
    if (!state.quitting && !reloading.has(name)) logLine(`the host for ${name} (pid ${child.pid}) exited with code ${code}; its log is ${hostFiles(home).log}`);
    if (held.child === child) delete held.child;
  });
  // The transport writes transport.json once it listens; the entry is ours when it names our process.
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited !== undefined)
      throw new Error(`The host for ${name} exited with code ${exited} before it started listening; its log is ${hostFiles(home).log}.`);
    const entry = await Effect.runPromise(readDiscovery(home));
    if (entry !== undefined && entry.pid === child.pid) return entry;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`The host for ${name} did not start listening within ${STARTUP_TIMEOUT_MS / 1000}s.`);
};

/** Opens the profile `name` on the remote's machine through the remote's host (`profiles.open`), which starts it there. */
const openRemote = async (target: Target, name: string) => {
  // A loopback address may be a tunnel to that machine: it carries one port, and another profile's port on loopback is
  // this machine's, which would be handed the profile's token.
  if (isLoopback(target.url))
    throw new Error(`${target.url} is a loopback address, which may be a tunnel to another machine: open the profile "${name}" at its own address`);
  const opened = await Effect.runPromise(
    Effect.scoped(Effect.flatMap(makeHostRpcHttp(target.url, target.token), (rpc) => callChannel(rpc, ProfileChannels.open, { name }))).pipe(
      Effect.mapError((error) => new Error(error.message)),
    ),
  );
  return { url: profileAddress(target.url, opened), token: opened.token };
};

/** Each profile's host as it is being found, so two windows asking at once find one. */
const finding = new Map<string, Promise<{ readonly url: string; readonly token: string }>>();

/** The host serving the profile `name`: the one known, else one running for it, else one this app starts (or, remotely, has its machine start). */
export const ensureHost = (name: string): Promise<{ readonly url: string; readonly token: string }> => {
  const known = hosts.get(name)?.served;
  if (known !== undefined && (state.remote !== undefined || owns(name))) return Promise.resolve(known);
  const going = finding.get(name);
  if (going !== undefined) return going;
  const found = (async () => {
    if (state.quitting) throw new Error("Lemma is quitting");
    // A profile is made first (`lemma profile create`): a host started for one never made would take another's port.
    if (state.remote === undefined && name !== DEFAULT_PROFILE && !existsSync(profileHome(paths.root, name)))
      throw new Error(`There is no profile "${name}"; \`lemma profile create ${name}\` makes one`);
    const served =
      state.remote !== undefined
        ? await openRemote(state.remote, name)
        : await Effect.runPromise(readDiscovery(profileHome(paths.root, name))).then((entry) => entry ?? startHost(name));
    return serve(name, served);
  })().finally(() => finding.delete(name));
  finding.set(name, found);
  return found;
};

/** Each host's stop, once begun: a second SIGTERM would end its graceful shutdown partway. */
const exits = new WeakMap<UtilityProcess, Promise<void>>();

/** Resolves once the profile's host this app started exits, or after `STOP_WAIT_MS`; a call while it stops waits again without signalling again. */
export const stopHost = (name: string) => {
  const child = hosts.get(name)?.child;
  if (child === undefined) return Promise.resolve();
  let exited = exits.get(child);
  if (exited === undefined) {
    exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    exits.set(child, exited);
    // SIGTERM: the host shuts down its plugins and removes transport.json.
    child.kill();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([exited, new Promise<void>((resolve) => (timer = setTimeout(resolve, STOP_WAIT_MS)))]).finally(() => clearTimeout(timer));
};

/**
 * What stopping the profile's host this app started would cut off, as its plugins say (`cli.in-progress`). A host that
 * cannot say within two seconds, or at all (`cli.registry` is off), is taken to be busy: better to ask needlessly than
 * to cut off a turn unasked.
 */
export const inProgress = async (name: string): Promise<readonly string[]> => {
  const served = hosts.get(name)?.served;
  if (served === undefined) return [];
  const { url, token } = served;
  return Effect.runPromise(
    Effect.scoped(Effect.flatMap(makeHostRpcHttp(url, token), (rpc) => callChannel(rpc, CliChannels.inProgress, {}))).pipe(
      Effect.map((reports) => reports.flatMap((report) => report.items)),
      Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(["work it could not list in time"]) }),
      Effect.orElseSucceed(() => ["work it could not list (it did not answer)"]),
    ),
  );
};
