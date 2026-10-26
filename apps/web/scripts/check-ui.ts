import { recordFlake, summarizeFlakes } from "../../../scripts/flaky.ts";
import type { Flake } from "../../../scripts/flaky.ts";
import { closeRouter, inLane, stopHosts } from "./check-ui/hosts.ts";
import { browser, closePages, only, retries, saveArtifacts, server, shard, shards } from "./check-ui/shared.ts";
import { devtools } from "./check-ui/devtools.ts";
import { pages } from "./check-ui/pages.ts";
import { parts } from "./check-ui/parts.ts";
import { rail } from "./check-ui/rail.ts";
import { separate } from "./check-ui/separate.ts";
import { toggling } from "./check-ui/toggling.ts";
import { turns } from "./check-ui/turns.ts";

/**
 * The web app's replaceability, checked on the real composition: the dev
 * server in Chromium, against real hosts started from the checkout, each with
 * the scripted provider (scripts/mock-openai.ts) as its model, on a home of
 * its own seeded with projects and threads (check-ui/seed.ts). It holds the
 * invariant in apps/web/AGENTS.md at runtime, where `check-boundaries` holds
 * it in the imports:
 *
 * 1. The app boots without errors, with the plugins the domains' manifests
 *    list: their web halves bundled, and their host halves on the host.
 * 2. Every part declared in `ui/contracts.ts` has a provider.
 * 3. Every plugin that is not pinned turns off and back on, as the Plugins
 *    page does it, and the page stays up and error-free either way; only the
 *    pinned ones and what they need stay on, and the runtime is no row at all.
 *    The Plugins page needs none of them: a line its summary shows leaves with
 *    the plugin that adds it, and with `kit` off its parts are their plain
 *    fallbacks, which still filter, edit a plugin's settings, and switch `kit`
 *    back on. With every plugin off that can be, the runtime
 *    still answers, and a web half providing part of it is left out, saying so,
 *    while the app's own goes on.
 * 4. A part replaced by a lower-order item changes what renders, and the
 *    default returns when the replacement goes, or when the replacement throws
 *    (named for its plugin, the rest of the app updating on).
 * 5. A plugin's stylesheet leaves when it stops and returns once when it starts.
 * 6. What a plugin adds to the places the defaults use (header, sidebar and
 *    composer buttons, workspace bar, palette sources, inspector tabs) shows,
 *    and a plugin's Cost tab gives its share of the open thread's latest request.
 *    Typing `@` offers the project's files and a pick writes the mention; a
 *    plugin's completion source answers its own trigger, Escape and Tab work
 *    in the menu, and its rows are a replaceable part. Enter waits for
 *    suggestions on their way, and a picked folder narrows to what is in it.
 * 7. The address names the page: settings sections and their state, threads
 *    and their views survive a reload and back and forward; a page whose
 *    plugin is off says so, naming it, and returns with it; a plugin adds a
 *    page; a page that throws fails alone, and one with no route is its
 *    plugin's fault; routes in conflict are reported; a hovered
 *    thread link preloads; a deleted thread's address leaves for a new
 *    thread; an unsent prompt outlives settings and makes leaving the page ask.
 * 8. The devtools dock under the app, and each panel shows it as it runs (the
 *    host's events and its domains' streams, the channels it serves, the
 *    host's and the page's traces): a capability the runtime provides is the
 *    web app's, not a missing one.
 * 9. While a turn runs, the composer steers it, the steer showing where it
 *    will join, or with Alt queues a prompt for after it, under a header that
 *    opens and closes the queue; a queued prompt can steer it after all, or be
 *    withdrawn (its row is a replaceable part), and a steer shows in its turn. A running
 *    turn's thread left and opened again, and the agent restarting under it,
 *    leave the turn shown to its end and its prompt placed once. Up brings back
 *    prompts sent in the thread. A send that fails is retried with its request
 *    id, until the prompt is edited. Escape twice in the prompt stops a turn.
 * 10. The prompt rail has a tick per prompt; the one pointed at, or chosen with
 *    the keys, shows its prompt in a card level with it, and a click or Enter
 *    goes there, lighting it; the previous and next buttons move a turn each.
 * 11. With no provider set up, the app opens in the chat; the composer's notice
 *    opens Providers, which goes back to the chat once one connects.
 * 12. A script's calls show as they settle, and the pages tools draw (a
 *    script's and the model's own) show after the turn's work and above its
 *    answer, once each, in a sandbox that keeps them out of the app, sized to
 *    their content, and following the app's look without loading again.
 * 13. Settings › Profiles lists the default alone, as Core, the current
 *    one; a profile made in its dialog gets a row, renames in place, and goes
 *    once its dialog asks; while there are two, the settings button shows the
 *    profile the page is.
 *
 * Run it in the browser shell: `nix develop .#browser -c pnpm --filter @lemma/web-app ui:check`.
 * `--lane=<name>` runs that lane alone (given again, those lanes). `--shard=i/n`
 * runs a share of it, as CI does on two runners: of the lanes the checks run in
 * (below), every n-th from the i-th. `--retry=n` runs a lane that fails up to n
 * more times, as CI does once: its failed try leaves its traces, and a lane
 * that passes on a retry is a warning, recorded as flaky (scripts/flaky.ts).
 * `LEMMA_BROWSER=firefox` or `webkit` runs it in Playwright's builds of those
 * (`pnpm exec playwright install firefox webkit`; `PLAYWRIGHT_BROWSERS_PATH`
 * puts them elsewhere): history timing differs between engines. A failed try
 * leaves a Playwright trace and a screenshot of each of its pages, and what its
 * hosts printed, in `LEMMA_UI_ARTIFACTS` (by default a new directory under the
 * OS temp directory, named in the output); `pnpm exec playwright show-trace`
 * opens a trace.
 */

/*
 * The checks run in lanes, AT_ONCE at a time, each on hosts and pages of its own, so what one lane does, fails, or runs
 * again is its alone; a lane's checks run in order. Each lane is a file in check-ui/, beside what they share:
 * `shared.ts` (the dev server, the browser, and the helpers that boot and drive a page), `hosts.ts` (the hosts, and the
 * router that sends each page's calls to its own), and `seed.ts` (what a host's home holds).
 */

/*
 * A lane takes well under a minute, and one run again as long more. A step that never returns
 * (Playwright waits on some calls for ever: Chromium can leave a key unanswered whose frame goes as it lands) fails its
 * try once the try has run for TRY_MINUTES, so the lane runs again on pages of its own, closing the hung try's; a hung
 * try and a retry still end before the deadline. One still running at the deadline fails the check, naming the lanes
 * still running and leaving their traces, rather than holding the job until its timeout cancels it with nothing to show.
 */
const TRY_MINUTES = 2.5;
const DEADLINE_MINUTES = 6;
/** Lanes running at once: each runs hosts and pages of its own, and a machine gives only so many processes and threads. */
const AT_ONCE = 6;
let deadline: NodeJS.Timeout | undefined;

/** `run`, or a failure once it has run for TRY_MINUTES. */
const inTime = async <A>(name: string, run: Promise<A>): Promise<A> => {
  let overdue: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        overdue = setTimeout(() => reject(new Error(`UI check: ${name} still running after ${TRY_MINUTES} minutes`)), TRY_MINUTES * 60_000);
      }),
    ]);
  } finally {
    clearTimeout(overdue);
  }
};

/** The lanes that passed only on a retry, for the job's summary. */
const flakes: Flake[] = [];

/**
 * Runs `lane`, and again after a failed try, up to `--retry` more times; one that passes on a retry is flaky. A failed
 * try leaves its traces and its hosts' logs; each try's pages close and its hosts stop when it ends.
 */
const attempt = async (lane: () => Promise<string>): Promise<string> => {
  let first: unknown;
  let tries = 1;
  let done: string;
  for (; ; tries++) {
    try {
      done = await inTime(lane.name, inLane(lane.name, lane));
      break;
    } catch (error) {
      await saveArtifacts({ lane: lane.name, try: tries });
      if (tries > retries) throw error;
      first ??= error;
      console.error(`UI check: ${lane.name} failed on try ${tries}, so runs again:`, error);
    } finally {
      await closePages(lane.name);
      await stopHosts(lane.name);
    }
  }
  if (tries > 1) flakes.push(recordFlake({ name: `ui:check ${lane.name}`, tries, error: first instanceof Error ? first.message : String(first) }));
  return done;
};

try {
  // In this order, every other lane makes two shares that take about as long.
  const all = [toggling, parts, rail, devtools, turns, separate, pages];
  const unknown = (only ?? []).filter((name) => !all.some((lane) => lane.name === name));
  if (unknown.length > 0) throw new Error(`UI check: no lane ${unknown.join(", ")}; the lanes are ${all.map((lane) => lane.name).join(", ")}`);
  const lanes = all.filter((lane) => only === undefined || only.includes(lane.name)).filter((_, at) => at % shards === shard - 1);
  const running = new Set(lanes.map((lane) => lane.name));
  const overdue = new Promise<never>((_, reject) => {
    deadline = setTimeout(
      () => reject(new Error(`UI check: still to finish after ${DEADLINE_MINUTES} minutes: ${[...running].join(", ")}`)),
      DEADLINE_MINUTES * 60_000,
    );
  });
  // Every lane runs to its end, so a failure hides none of the others'; AT_ONCE at a time, in order.
  const settled = new Map<string, PromiseSettledResult<string>>();
  const waiting = [...lanes];
  const runNext = async (): Promise<void> => {
    const lane = waiting.shift();
    if (lane === undefined) return;
    const result = await attempt(lane).then(
      (value) => ({ status: "fulfilled", value }) as const,
      (reason: unknown) => ({ status: "rejected", reason }) as const,
    );
    settled.set(lane.name, result);
    running.delete(lane.name);
    return runNext();
  };
  await Promise.race([Promise.all(Array.from({ length: AT_ONCE }, runNext)), overdue]);
  const failed = lanes.flatMap((lane) => {
    const result = settled.get(lane.name)!;
    return result.status === "rejected" ? [{ lane: lane.name, error: result.reason as unknown }] : [];
  });
  for (const { lane, error } of failed) console.error(`UI check: ${lane} failed:`, error);
  if (failed.length > 0) throw new Error(`UI check: ${failed.map(({ lane }) => lane).join(", ")} failed (above)`);
  const done = lanes.map((lane) => (settled.get(lane.name) as PromiseFulfilledResult<string>).value);
  console.log(`UI check${shards > 1 ? ` (${shard}/${shards})` : ""}: ${done.join("; ")}.`);
} catch (error) {
  await saveArtifacts();
  throw error;
} finally {
  summarizeFlakes("Flaky UI check lanes", flakes);
  clearTimeout(deadline);
  await browser.close();
  await server.close();
  await stopHosts();
  await closeRouter();
}
