import { browser, saveArtifacts, server, shard, shards } from "./check-ui/shared.ts";
import { devtools } from "./check-ui/devtools.ts";
import { parts } from "./check-ui/parts.ts";
import { rail } from "./check-ui/rail.ts";
import { separate } from "./check-ui/separate.ts";
import { toggling } from "./check-ui/toggling.ts";

/**
 * The web app's replaceability, checked on the real composition: the dev
 * server with the in-browser mock host (`?mock`), in Chromium. It holds the
 * invariant in apps/web/AGENTS.md at runtime, where `check-boundaries` holds
 * it in the imports:
 *
 * 1. The app boots without errors, with the plugins the domains' manifests
 *    list: their web halves bundled, and their host halves on the mock host.
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
 *
 * Run it in the browser shell: `nix develop .#browser -c pnpm --filter @lemma/web-app ui:check`.
 * `--shard=i/n` runs a share of it, as CI does on two runners: of the lanes the
 * checks run in (below), every n-th from the i-th.
 * `LEMMA_BROWSER=firefox` or `webkit` runs it in Playwright's builds of those
 * (`pnpm exec playwright install firefox webkit`; `PLAYWRIGHT_BROWSERS_PATH`
 * puts them elsewhere): history timing differs between engines. A failed run
 * leaves a Playwright trace and a screenshot of each open page in
 * `LEMMA_UI_ARTIFACTS` (by default a new directory under the OS temp
 * directory, named in the output); `pnpm exec playwright show-trace` opens a trace.
 */

/*
 * The checks run in lanes, all at once, each on pages of its own; a lane's checks run in order. Like a real host, the
 * mock answers after a while rather than at once (a switch on the Plugins page takes 200 ms, a reply streams), so the
 * time is mostly waiting, and the lanes wait together. Each lane is a file in check-ui/, beside what they share
 * (`shared.ts`: the dev server, the browser, and the helpers that boot and drive a page).
 */

try {
  // In this order, every other lane makes two shares that take about as long.
  const lanes = [toggling, parts, rail, devtools, separate].filter((_, at) => at % shards === shard - 1);
  const done = await Promise.all(lanes.map((lane) => lane()));
  console.log(`UI check${shards > 1 ? ` (${shard}/${shards})` : ""}: ${done.join("; ")}.`);
} catch (error) {
  await saveArtifacts();
  throw error;
} finally {
  await browser.close();
  await server.close();
}
